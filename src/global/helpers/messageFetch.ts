import type { ApiMessage } from '../../api/types';
import type { ThreadId } from '../../types';
import type {
  GlobalState,
} from '../types';
import type {
  MessageFetchQuery,
  MessageFetchResult,
  PersonRef,
} from '../types/tabState';
import { MAIN_THREAD_ID } from '../../api/types';

import { getCurrentTabId } from '../../util/establishMultitabRole';
import { getTranslationFn } from '../../util/localization';
import {
  selectCurrentMessageList,
  selectTabState,
} from '../selectors';
import { selectSender } from '../selectors/messages';
import { selectThreadIdFromMessage, selectThreadLocalState } from '../selectors/threads';
import { getMessageSummaryText } from './messageSummary';
import { getPeerTitle } from './peers';
import { searchSyncedRecordsByKeyword } from './syncedKeywordSearch';
import {
  querySyncedMessages,
} from './syncedMessagesStore';

export const MESSAGE_FETCH_MAX_SCANNED_MESSAGES = 500;

type MessageSource = 'live' | 'cache' | 'api' | 'store';

type MessageFetchScope = {
  chatId: string;
  threadId: ThreadId;
};

type CandidateMessage = {
  message: ApiMessage;
  state: GlobalState;
  source: MessageSource;
};

type NormalizedTimeRange = {
  startSec: number;
  endSec: number;
};

type QueryTimeRange =
  | {
    mode: 'custom';
    startAt: number;
    endAt: number;
  }
  | {
    mode: 'preset';
    value: 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth';
  };

function emptyResult(summary?: string): MessageFetchResult {
  return {
    messages: [],
    total: 0,
    truncated: false,
    evidenceIds: [],
    summary,
  };
}

function normalizeString(value: string | undefined) {
  return value?.trim().toLowerCase();
}

function normalizeKeyword(value: string | undefined) {
  return value?.trim();
}

function compareMessagesDesc(left: ApiMessage, right: ApiMessage) {
  if (left.date !== right.date) {
    return right.date - left.date;
  }

  return right.id - left.id;
}

function compareMessagesAsc(left: ApiMessage, right: ApiMessage) {
  if (left.date !== right.date) {
    return left.date - right.date;
  }

  return left.id - right.id;
}

function normalizeTimeRange(timeRange: QueryTimeRange | undefined): NormalizedTimeRange | undefined {
  if (!timeRange) {
    return undefined;
  }

  if (timeRange.mode === 'custom') {
    return {
      startSec: Math.floor(timeRange.startAt / 1000),
      endSec: Math.ceil(timeRange.endAt / 1000),
    };
  }

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  if (timeRange.value === 'today') {
    return {
      startSec: Math.floor(startOfDay.getTime() / 1000),
      endSec: Math.ceil(endOfDay.getTime() / 1000),
    };
  }

  if (timeRange.value === 'yesterday') {
    const yesterdayStart = new Date(startOfDay);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    return {
      startSec: Math.floor(yesterdayStart.getTime() / 1000),
      endSec: Math.ceil(startOfDay.getTime() / 1000),
    };
  }

  if (timeRange.value === 'thisWeek') {
    const weekStart = new Date(startOfDay);
    const day = weekStart.getDay();
    const daysSinceMonday = (day + 6) % 7;
    weekStart.setDate(weekStart.getDate() - daysSinceMonday);

    const nextWeekStart = new Date(weekStart);
    nextWeekStart.setDate(nextWeekStart.getDate() + 7);

    return {
      startSec: Math.floor(weekStart.getTime() / 1000),
      endSec: Math.ceil(nextWeekStart.getTime() / 1000),
    };
  }

  if (timeRange.value === 'lastWeek') {
    const currentWeekStart = new Date(startOfDay);
    const day = currentWeekStart.getDay();
    const daysSinceMonday = (day + 6) % 7;
    currentWeekStart.setDate(currentWeekStart.getDate() - daysSinceMonday);

    const lastWeekStart = new Date(currentWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    return {
      startSec: Math.floor(lastWeekStart.getTime() / 1000),
      endSec: Math.ceil(currentWeekStart.getTime() / 1000),
    };
  }

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return {
    startSec: Math.floor(monthStart.getTime() / 1000),
    endSec: Math.ceil(nextMonthStart.getTime() / 1000),
  };
}

function resolveScope(global: GlobalState, tabId: number): MessageFetchScope | undefined {
  const currentMessageList = selectCurrentMessageList(global, tabId);
  if (!currentMessageList?.chatId) {
    return undefined;
  }

  const chatId = currentMessageList.chatId;
  const threadId = currentMessageList.threadId || MAIN_THREAD_ID;

  return {
    chatId,
    threadId,
  };
}

function getRequestedLimit(
  global: GlobalState,
  query: MessageFetchQuery,
  tabId: number,
) {
  const contextLimit = selectTabState(global, tabId).aiAssistant.contextLimit;
  const fallback = Number.isFinite(contextLimit) && contextLimit > 0
    ? contextLimit
    : MESSAGE_FETCH_MAX_SCANNED_MESSAGES;
  const requested = query.limit && query.limit > 0 ? query.limit : fallback;

  return Math.max(1, Math.floor(requested));
}

function getFetchBudget(limit: number) {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return {
    maxScannedMessages: Math.max(
      MESSAGE_FETCH_MAX_SCANNED_MESSAGES,
      normalizedLimit * 5,
    ),
  };
}

function isInScope(global: GlobalState, scope: MessageFetchScope, message: ApiMessage, source: MessageSource) {
  if (source === 'api') {
    return true;
  }

  // In regular chats, the main thread should cover the whole conversation,
  // including reply chains that may be represented with per-message thread ids.
  if (scope.threadId === MAIN_THREAD_ID) {
    return true;
  }

  return selectThreadIdFromMessage(global, message) === scope.threadId;
}

function resolveMessageSenderId(global: GlobalState, message: ApiMessage) {
  if (message.senderId) {
    return String(message.senderId);
  }

  if (message.isOutgoing) {
    return global.currentUserId;
  }

  const sender = selectSender(global, message);
  return sender?.id ? String(sender.id) : undefined;
}

function resolveMessageSenderLabel(global: GlobalState, message: ApiMessage) {
  const lang = getTranslationFn();
  if (message.isOutgoing || resolveMessageSenderId(global, message) === global.currentUserId) {
    return '我';
  }

  const sender = selectSender(global, message);
  if (sender) {
    return getPeerTitle(lang, sender) || String(sender.id);
  }

  return resolveMessageSenderId(global, message) || '未知用户';
}

function resolveMessageSenderKeywordText(global: GlobalState, message: ApiMessage) {
  const senderLabel = resolveMessageSenderLabel(global, message);
  const sender = selectSender(global, message);
  const usernames = sender?.usernames
    ?.map((item) => item.username?.trim())
    .filter((value): value is string => Boolean(value));

  const keywordChunks = [
    senderLabel,
    ...(usernames || []),
    ...(usernames || []).map((username) => `@${username}`),
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  return keywordChunks.join(' ');
}

function matchesPerson(global: GlobalState, message: ApiMessage, person: PersonRef) {
  const senderId = resolveMessageSenderId(global, message);
  if (!senderId) {
    return false;
  }

  if (normalizeString(senderId) === normalizeString(person.peerId)) {
    return true;
  }

  const sender = selectSender(global, message);
  if (!sender || !person.title) {
    return false;
  }

  const normalizedSenderTitle = normalizeString(getPeerTitle(getTranslationFn(), sender));
  const normalizedPersonTitle = normalizeString(person.title);
  const normalizedPersonPeerId = normalizeString(person.peerId);

  if (normalizedSenderTitle && normalizedPersonTitle && normalizedSenderTitle.includes(normalizedPersonTitle)) {
    return true;
  }

  return Boolean(
    normalizedSenderTitle
    && normalizedPersonPeerId
    && normalizedSenderTitle.includes(normalizedPersonPeerId),
  );
}

function matchesTimeRange(message: ApiMessage, timeRange: NormalizedTimeRange | undefined) {
  if (!timeRange) {
    return true;
  }

  return message.date >= timeRange.startSec && message.date < timeRange.endSec;
}

function hasPersistedRangeCoverage(
  coverages: Array<{ startAt: number; endAt: number }> | undefined,
  timeRange: NormalizedTimeRange | undefined,
) {
  if (!timeRange || !coverages?.length) {
    return false;
  }

  const requestedStartAt = timeRange.startSec * 1000;
  const requestedEndAt = timeRange.endSec * 1000;

  return coverages.some(({ startAt, endAt }) => startAt <= requestedStartAt && endAt >= requestedEndAt);
}

function matchesKeyword(global: GlobalState, message: ApiMessage, keyword: string) {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    return true;
  }

  const lang = getTranslationFn();
  const summaryText = getMessageSummaryText(lang, message, undefined, true, 500).trim();
  const senderKeywordText = resolveMessageSenderKeywordText(global, message);
  const haystack = normalizeString(`${summaryText} ${senderKeywordText}`);
  return Boolean(haystack?.includes(normalizeString(normalizedKeyword) || ''));
}

function buildMessageRecord(scope: MessageFetchScope, global: GlobalState, message: ApiMessage) {
  const lang = getTranslationFn();
  const summaryText = getMessageSummaryText(lang, message, undefined, true, 500);
  return {
    chatId: scope.chatId,
    threadId: scope.threadId,
    messageId: message.id,
    sender: resolveMessageSenderLabel(global, message),
    date: message.date,
    text: (summaryText || '').trim(),
  };
}

function toCandidate(message: ApiMessage, state: GlobalState, source: MessageSource): CandidateMessage {
  return {
    message,
    state,
    source,
  };
}

function sortCandidateMessagesAsc(candidates: CandidateMessage[]) {
  return candidates.sort((left, right) => compareMessagesAsc(left.message, right.message));
}

function sortCandidateMessagesDesc(candidates: CandidateMessage[]) {
  return candidates.sort((left, right) => compareMessagesDesc(left.message, right.message));
}

function buildSummary(
  query: MessageFetchQuery,
  count: number,
  truncated: boolean,
) {
  const modeLabel = query.mode === 'person'
    ? '按人'
    : query.mode === 'keyword'
      ? '按关键词'
      : query.mode === 'range'
        ? '按时间'
        : '最近 N';

  return `${modeLabel}获取到 ${count} 条消息${truncated ? '（已截断）' : ''}（仅本地已同步消息）`;
}

export function describeMessageFetchQuery(query: MessageFetchQuery) {
  if (query.mode === 'person') {
    return `按人读取：${query.person.title || query.person.peerId}`;
  }

  if (query.mode === 'keyword') {
    return `按关键词读取：${query.keyword.trim()}`;
  }

  if (query.mode === 'range') {
    if (query.timeRange.mode === 'preset') {
      const presetLabels: Record<'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth', string> = {
        today: '今天',
        yesterday: '昨天',
        thisWeek: '本周',
        lastWeek: '上周',
        thisMonth: '本月',
      };

      return `按时间读取：${presetLabels[query.timeRange.value]}`;
    }

    return '按时间读取：自定义范围';
  }

  return `读取最近 ${query.limit} 条消息`;
}

export async function runMessageFetch(
  global: GlobalState,
  query: MessageFetchQuery,
  ...[tabId = getCurrentTabId(), _progressOptions]: [number?, unknown?]
): Promise<MessageFetchResult> {
  const resolvedTabId = tabId || getCurrentTabId();
  const scope = resolveScope(global, resolvedTabId);
  if (!scope) {
    return emptyResult();
  }

  const timeRange = normalizeTimeRange('timeRange' in query ? query.timeRange : undefined);
  const queryPerson = 'person' in query ? query.person : undefined;
  const queryKeyword = 'keyword' in query ? normalizeKeyword(query.keyword) : undefined;
  const requestedLimit = getRequestedLimit(global, query, resolvedTabId);
  const limit = query.mode === 'range'
    ? Number.MAX_SAFE_INTEGER
    : requestedLimit;
  const fetchBudget = query.mode === 'range'
    ? {
      maxPages: Number.MAX_SAFE_INTEGER,
      maxScannedMessages: Number.MAX_SAFE_INTEGER,
    }
    : getFetchBudget(limit);
  const seenMessageIds = new Set<number>();
  const matchedCandidates: CandidateMessage[] = [];
  let scannedCount = 0;
  let truncated = false;

  const readPersistedCandidates = async () => {
    const defaultMaxCount = query.mode === 'range'
      ? Number.MAX_SAFE_INTEGER
      : fetchBudget.maxScannedMessages;
    const buildArgs = (senderId?: string, maxCount = defaultMaxCount) => ({
      chatId: scope.chatId,
      threadId: scope.threadId,
      timeRange,
      beforeMessageId: query.beforeMessageId,
      senderId,
      maxCount,
    });
    const readSyncedRecords = async (maxCount = defaultMaxCount) => {
      let records = await querySyncedMessages(buildArgs(queryPerson?.peerId, maxCount));
      if (!records.length && queryPerson?.peerId) {
        records = await querySyncedMessages(buildArgs(undefined, maxCount));
      }

      return records;
    };

    if (queryKeyword) {
      const records = await searchSyncedRecordsByKeyword({
        chatId: scope.chatId,
        keyword: queryKeyword,
        threadId: scope.threadId,
        senderId: queryPerson?.peerId,
        timeRange,
        beforeMessageId: query.beforeMessageId,
        maxCount: limit,
        filterFallbackRecord: (record) => matchesKeyword(global, record.message, queryKeyword),
      });

      return sortCandidateMessagesDesc(records
        .map(({ message }) => toCandidate(message, global, 'store')));
    }

    const records = await readSyncedRecords();

    return sortCandidateMessagesDesc(records
      .map(({ message }) => toCandidate(message, global, 'store')),
    );
  };

  const pushCandidate = (candidate: CandidateMessage) => {
    if (seenMessageIds.has(candidate.message.id)) {
      return;
    }

    if (scannedCount >= fetchBudget.maxScannedMessages) {
      truncated = true;
      return;
    }

    seenMessageIds.add(candidate.message.id);
    scannedCount += 1;

    if (!isInScope(candidate.state, scope, candidate.message, candidate.source)) {
      return;
    }

    const withinTimeRange = matchesTimeRange(candidate.message, timeRange);
    if (!withinTimeRange) {
      return;
    }

    if (queryPerson && !matchesPerson(candidate.state, candidate.message, queryPerson)) {
      return;
    }

    if (queryKeyword && !matchesKeyword(candidate.state, candidate.message, queryKeyword)) {
      return;
    }

    matchedCandidates.push(candidate);
    if (matchedCandidates.length >= limit) {
      truncated = true;
    }
  };

  const liveThreadState = selectThreadLocalState(global, scope.chatId, scope.threadId);
  const localSeedCandidates = await readPersistedCandidates();
  localSeedCandidates.forEach((candidate) => {
    if (!truncated) {
      pushCandidate(candidate);
    }
  });

  const buildResult = (): MessageFetchResult => {
    const hasCompleteLocalRangeCoverage = query.mode === 'range'
      && hasPersistedRangeCoverage(
        [
          ...(liveThreadState?.fetchedMessageRangeCoverages || []),
        ],
        timeRange,
      );
    const finalCandidates = sortCandidateMessagesAsc(matchedCandidates.slice(0, limit));
    const messages = finalCandidates.map(({ message, state }) => buildMessageRecord(scope, state, message));
    const evidenceIds = messages.map(({ messageId }) => messageId);
    const shouldContinue = truncated && !hasCompleteLocalRangeCoverage;
    const nextBeforeMessageId = shouldContinue ? finalCandidates[0]?.message.id : undefined;

    return {
      messages,
      total: messages.length,
      truncated,
      evidenceIds,
      sourceMessages: finalCandidates.map(({ message }) => message),
      nextBeforeMessageId,
      summary: buildSummary(query, messages.length, truncated),
    };
  };

  return buildResult();
}

export async function runMessageFetchWithContinuation(
  args: {
    query: MessageFetchQuery;
    fetchOnce: (query: MessageFetchQuery) => Promise<MessageFetchResult>;
    onPageFetched?: (result: MessageFetchResult) => void | Promise<void>;
    maxRounds?: number;
  },
): Promise<MessageFetchResult> {
  const { query, fetchOnce, onPageFetched } = args;
  if (query.mode !== 'range') {
    const result = await fetchOnce(query);
    await onPageFetched?.(result);
    return result;
  }

  if (!normalizeTimeRange(query.timeRange)) {
    const result = await fetchOnce(query);
    await onPageFetched?.(result);
    return result;
  }

  const combinedMessages: MessageFetchResult['messages'] = [];
  const combinedSourceMessages: ApiMessage[] = [];
  const seenMessageIds = new Set<number>();
  const currentQuery: Extract<MessageFetchQuery, { mode: 'range' }> = { ...query };
  let truncated = false;
  let summary: string | undefined;
  let previousCursorId: number | undefined;

  while (true) {
    const result = await fetchOnce(currentQuery);
    await onPageFetched?.(result);
    summary = result.summary;
    truncated = result.truncated;

    result.messages.forEach((message, index) => {
      const sourceMessage = result.sourceMessages?.[index];
      if (seenMessageIds.has(message.messageId)) {
        return;
      }

      seenMessageIds.add(message.messageId);
      combinedMessages.push(message);
      if (sourceMessage) {
        combinedSourceMessages.push(sourceMessage);
      }
    });

    const nextCursorId = result.nextBeforeMessageId;
    if (!truncated) {
      break;
    }

    const canContinue = Boolean(nextCursorId)
      && nextCursorId !== previousCursorId;

    if (!canContinue || !nextCursorId) {
      break;
    }

    previousCursorId = nextCursorId;
    currentQuery.beforeMessageId = nextCursorId;
  }

  const sortedMessages = [...combinedMessages].sort((left, right) => {
    if (left.date !== right.date) {
      return left.date - right.date;
    }

    return left.messageId - right.messageId;
  });
  const sortedSourceMessages = sortedMessages
    .map((message) => combinedSourceMessages.find((sourceMessage) => sourceMessage.id === message.messageId))
    .filter((message): message is ApiMessage => Boolean(message));

  return {
    messages: sortedMessages,
    total: sortedMessages.length,
    truncated,
    evidenceIds: sortedMessages.map(({ messageId }) => messageId),
    sourceMessages: sortedSourceMessages,
    nextBeforeMessageId: sortedMessages[0]?.messageId,
    summary,
  };
}
