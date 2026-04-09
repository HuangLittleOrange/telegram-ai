import type { ApiMessage } from '../../api/types';
import type { ThreadId } from '../../types';
import type {
  GlobalState,
} from '../types';
import type {
  MessageFetchQuery,
  MessageFetchResult,
  PersonRef,
  TimeRange,
} from '../types/tabState';
import { MAIN_THREAD_ID } from '../../api/types';

import { getCurrentTabId } from '../../util/establishMultitabRole';
import { getTranslationFn } from '../../util/localization';
import { pause } from '../../util/schedulers';
import { callApi } from '../../api/gramjs';
import { loadCachedGlobal } from '../cache';
import {
  selectChat,
  selectCurrentMessageList,
  selectTabState,
  selectViewportIds,
} from '../selectors';
import { selectChatMessages } from '../selectors/messages';
import { selectSender } from '../selectors/messages';
import { selectThreadIdFromMessage, selectThreadLocalState } from '../selectors/threads';
import { getIsSavedDialog } from './chats';
import { getMessageSummaryText } from './messageSummary';
import { getPeerTitle } from './peers';

export const MESSAGE_FETCH_BATCH_SIZE = 100;
export const MESSAGE_FETCH_MAX_PAGES = 5;
export const MESSAGE_FETCH_MAX_SCANNED_MESSAGES = 500;
const TELEGRAM_REMOTE_FETCH_RETRY_ROUNDS = 3;
const TELEGRAM_REMOTE_FETCH_RETRY_MS = 250;
const TELEGRAM_REMOTE_FETCH_PAGE_THROTTLE_MS = 250;

type MessageSource = 'live' | 'cache' | 'api';

type MessageFetchScope = {
  chatId: string;
  apiChatId: string;
  threadId: ThreadId;
  isSavedDialog: boolean;
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

type MessageFetchProgressOptions = {
  onRemotePageFetched?: (result: MessageFetchResult) => void | Promise<void>;
  onRemoteFloodWait?: (seconds: number) => void | Promise<void>;
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

function normalizeTimeRange(timeRange: TimeRange | undefined): NormalizedTimeRange | undefined {
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
  const isSavedDialog = getIsSavedDialog(chatId, threadId, global.currentUserId);

  return {
    chatId,
    apiChatId: isSavedDialog ? String(threadId) : chatId,
    threadId,
    isSavedDialog,
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
    maxPages: Math.max(
      MESSAGE_FETCH_MAX_PAGES,
      Math.ceil(normalizedLimit / MESSAGE_FETCH_BATCH_SIZE) + 1,
    ),
    maxScannedMessages: Math.max(
      MESSAGE_FETCH_MAX_SCANNED_MESSAGES,
      normalizedLimit * 5,
    ),
  };
}

function getCandidateIds(global: GlobalState, scope: MessageFetchScope, tabId: number) {
  const viewportIds = selectViewportIds(global, scope.chatId, scope.threadId, tabId);
  if (viewportIds?.length) {
    return viewportIds;
  }

  const threadState = selectThreadLocalState(global, scope.chatId, scope.threadId);
  if (threadState?.listedIds?.length) {
    return threadState.listedIds;
  }

  if (threadState?.lastViewportIds?.length) {
    return threadState.lastViewportIds;
  }

  const messagesById = selectChatMessages(global, scope.chatId);
  return messagesById ? Object.keys(messagesById).map(Number).sort((a, b) => a - b) : [];
}

function isInScope(global: GlobalState, scope: MessageFetchScope, message: ApiMessage, source: MessageSource) {
  if (source === 'api') {
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

  return normalizeString(getPeerTitle(getTranslationFn(), sender))
    === normalizeString(person.title);
}

function matchesTimeRange(message: ApiMessage, timeRange: NormalizedTimeRange | undefined) {
  if (!timeRange) {
    return true;
  }

  return message.date >= timeRange.startSec && message.date < timeRange.endSec;
}

function isPageEntirelyBeforeTimeRange(
  messages: ApiMessage[],
  timeRange: NormalizedTimeRange | undefined,
) {
  if (!timeRange || !messages.length) {
    return false;
  }

  const newestMessageDate = Math.max(...messages.map((message) => message.date));
  return newestMessageDate < timeRange.startSec;
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
  const sender = resolveMessageSenderLabel(global, message);
  const haystack = normalizeString(`${summaryText} ${sender}`);
  return Boolean(haystack?.includes(normalizeString(normalizedKeyword) || ''));
}

function mergeFetchedPeers(baseGlobal: GlobalState, fetched: {
  users?: Array<{ id: string }>;
  chats?: Array<{ id: string }>;
}) {
  if (!fetched.users?.length && !fetched.chats?.length) {
    return baseGlobal;
  }

  return {
    ...baseGlobal,
    users: {
      ...baseGlobal.users,
      byId: {
        ...baseGlobal.users.byId,
        ...(fetched.users || []).reduce<Record<string, any>>((acc, user) => {
          acc[user.id] = user;
          return acc;
        }, {}),
      },
    },
    chats: {
      ...baseGlobal.chats,
      byId: {
        ...baseGlobal.chats.byId,
        ...(fetched.chats || []).reduce<Record<string, any>>((acc, chat) => {
          acc[chat.id] = chat;
          return acc;
        }, {}),
      },
    },
  } as GlobalState;
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

function sortCandidateMessagesDesc(candidates: CandidateMessage[]) {
  return candidates.sort((left, right) => compareMessagesDesc(left.message, right.message));
}

function sortCandidateMessagesAsc(candidates: CandidateMessage[]) {
  return candidates.sort((left, right) => compareMessagesAsc(left.message, right.message));
}

function buildSummary(
  query: MessageFetchQuery,
  count: number,
  truncated: boolean,
  hasRemoteHistory: boolean,
  remoteOnly: boolean,
) {
  const modeLabel = query.mode === 'person'
    ? '按人'
    : query.mode === 'keyword'
      ? '按关键词'
      : query.mode === 'range'
        ? '按时间'
        : '最近 N';

  const remoteFallbackLabel = remoteOnly
    ? '（Telegram 未连接，远端历史不可用）'
    : '（Telegram 未连接，仅返回本地消息）';

  return `${modeLabel}获取到 ${count} 条消息${truncated ? '（已截断）' : ''}${hasRemoteHistory ? '' : remoteFallbackLabel}`;
}

function isTelegramConnectionError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : (error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message)
      : String(error));
  return message.includes('Not connected')
    || message.includes('Cannot send requests while disconnected');
}

function getTelegramFloodWaitMs(error: unknown) {
  const secondsFromField = error
    && typeof error === 'object'
    && 'seconds' in error
    && typeof (error as { seconds?: unknown }).seconds === 'number'
      ? (error as { seconds: number }).seconds
      : undefined;

  if (secondsFromField && secondsFromField > 0) {
    return secondsFromField * 1000;
  }

  const errorMessage = error
    && typeof error === 'object'
    && 'errorMessage' in error
    ? String((error as { errorMessage?: unknown }).errorMessage)
    : '';

  const message = error instanceof Error
    ? error.message
    : (error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message)
      : String(error));

  const floodMatch = errorMessage.match(/FLOOD_WAIT_(\d+)/i)
    || message.match(/FLOOD_WAIT_(\d+)/i)
    || message.match(/A wait of (\d+) seconds is required/i);

  const seconds = floodMatch ? Number(floodMatch[1]) : undefined;
  return seconds && seconds > 0 ? seconds * 1000 : undefined;
}

async function fetchPageWithRetry<T>(
  fetchPage: () => Promise<T | undefined>,
  options?: {
    onFloodWait?: (seconds: number) => void | Promise<void>;
  },
): Promise<{ page: T | undefined; connectionError?: boolean }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < TELEGRAM_REMOTE_FETCH_RETRY_ROUNDS; attempt += 1) {
    try {
      return {
        page: await fetchPage(),
      };
    } catch (error) {
      lastError = error;

      const floodWaitMs = getTelegramFloodWaitMs(error);
      if (floodWaitMs) {
        await options?.onFloodWait?.(Math.ceil(floodWaitMs / 1000));
        await pause(floodWaitMs);
        continue;
      }

      if (!isTelegramConnectionError(error)) {
        throw error;
      }

      if (attempt < TELEGRAM_REMOTE_FETCH_RETRY_ROUNDS - 1) {
        await pause(TELEGRAM_REMOTE_FETCH_RETRY_MS);
        continue;
      }

      return {
        page: undefined,
        connectionError: true,
      };
    }
  }

  return {
    page: undefined,
    connectionError: isTelegramConnectionError(lastError),
  };
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

async function searchKeywordMessages(
  baseGlobal: GlobalState,
  scope: MessageFetchScope,
  keyword: string,
  cursorId: number | undefined,
) {
  const chat = selectChat(baseGlobal, scope.apiChatId);
  if (!chat) {
    return undefined;
  }

  return callApi('searchMessagesInChat', {
    peer: chat,
    isSavedDialog: scope.isSavedDialog,
    query: keyword,
    threadId: scope.threadId,
    ...(cursorId ? {
      offsetId: cursorId,
      addOffset: 0,
    } : undefined),
    limit: MESSAGE_FETCH_BATCH_SIZE,
  });
}

async function fetchOlderMessages(
  baseGlobal: GlobalState,
  scope: MessageFetchScope,
  cursorId: number | undefined,
) {
  const chat = selectChat(baseGlobal, scope.apiChatId);
  if (!chat) {
    return undefined;
  }

  return callApi('fetchMessages', {
    chat,
    threadId: scope.threadId,
    ...(cursorId ? {
      offsetId: cursorId,
      addOffset: 0,
    } : undefined),
    limit: MESSAGE_FETCH_BATCH_SIZE,
    isSavedDialog: scope.isSavedDialog,
  });
}

export async function runMessageFetch(
  global: GlobalState,
  query: MessageFetchQuery,
  ...[tabId = getCurrentTabId(), progressOptions]: [number?, MessageFetchProgressOptions?]
): Promise<MessageFetchResult> {
  const resolvedTabId = tabId || getCurrentTabId();
  const scope = resolveScope(global, resolvedTabId);
  if (!scope) {
    return emptyResult();
  }

  const cachedGlobal = await loadCachedGlobal();
  const timeRange = normalizeTimeRange('timeRange' in query ? query.timeRange : undefined);
  const queryPerson = 'person' in query ? query.person : undefined;
  const queryKeyword = 'keyword' in query ? normalizeKeyword(query.keyword) : undefined;
  const queryBeforeMessageId = 'beforeMessageId' in query ? query.beforeMessageId : undefined;
  const remoteOnly = 'remoteOnly' in query ? Boolean(query.remoteOnly) : false;
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
  let pagesFetched = 0;
  let truncated = false;
  let shouldAttemptRemote = remoteOnly || global.connectionState === 'connectionStateReady';
  let hasRemoteHistory = shouldAttemptRemote;
  let remoteFetchInterrupted = false;
  const onRemotePageFetched = progressOptions?.onRemotePageFetched;
  const onRemoteFloodWait = progressOptions?.onRemoteFloodWait;

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

  const liveIds = getCandidateIds(global, scope, resolvedTabId);
  const liveMessagesById = selectChatMessages(global, scope.chatId) || {};
  const liveCandidates = liveIds
    .map((messageId) => liveMessagesById[messageId])
    .filter((message): message is ApiMessage => Boolean(message))
    .map((message) => toCandidate(message, global, 'live'));
  sortCandidateMessagesDesc(liveCandidates);

  const cachedMessagesById = cachedGlobal ? selectChatMessages(cachedGlobal, scope.chatId) || {} : {};
  const cachedThreadState = cachedGlobal
    ? selectThreadLocalState(cachedGlobal, scope.chatId, scope.threadId)
    : undefined;
  const liveThreadState = selectThreadLocalState(global, scope.chatId, scope.threadId);
  const cachedIds = cachedThreadState?.listedIds?.length
    ? cachedThreadState.listedIds
    : cachedThreadState?.lastViewportIds?.length
      ? cachedThreadState.lastViewportIds
      : Object.keys(cachedMessagesById).map(Number);

  const cachedCandidates = cachedIds
    .map((messageId) => cachedMessagesById[messageId])
    .filter((message): message is ApiMessage => Boolean(message))
    .map((message) => toCandidate(message, cachedGlobal as GlobalState, 'cache'));
  sortCandidateMessagesDesc(cachedCandidates);

  const localSeedCandidates = [...liveCandidates, ...cachedCandidates];
  if (!remoteOnly) {
    localSeedCandidates.forEach((candidate) => {
      if (!truncated) {
        pushCandidate(candidate);
      }
    });
  }

  const hasCompleteLocalRangeCoverage = !remoteOnly
    && query.mode === 'range'
    && hasPersistedRangeCoverage(
      [
        ...(liveThreadState?.fetchedMessageRangeCoverages || []),
        ...(cachedThreadState?.fetchedMessageRangeCoverages || []),
      ],
      timeRange,
    );

  if (hasCompleteLocalRangeCoverage) {
    shouldAttemptRemote = false;
    hasRemoteHistory = false;
  }

  const buildResult = (): MessageFetchResult => {
    const finalSourceCandidates = matchedCandidates.length
      ? matchedCandidates
      : remoteOnly
        ? []
        : localSeedCandidates;
    const finalCandidates = sortCandidateMessagesAsc(finalSourceCandidates.slice(0, limit));
    const messages = finalCandidates.map(({ message, state }) => buildMessageRecord(scope, state, message));
    const evidenceIds = messages.map(({ messageId }) => messageId);
    const nextBeforeMessageId = remoteFetchInterrupted ? undefined : finalCandidates[0]?.message.id;

    return {
      messages,
      total: messages.length,
      truncated,
      evidenceIds,
      sourceMessages: finalCandidates.map(({ message }) => message),
      nextBeforeMessageId,
      summary: buildSummary(query, messages.length, truncated, hasRemoteHistory, remoteOnly),
    };
  };

  const buildPageResult = (
    pageCandidates: CandidateMessage[],
    nextBeforeMessageId?: number,
  ): MessageFetchResult => {
    const finalCandidates = sortCandidateMessagesAsc(pageCandidates.slice());
    const messages = finalCandidates.map(({ message, state }) => buildMessageRecord(scope, state, message));
    return {
      messages,
      total: messages.length,
      truncated: false,
      evidenceIds: messages.map(({ messageId }) => messageId),
      sourceMessages: finalCandidates.map(({ message }) => message),
      nextBeforeMessageId,
      summary: buildSummary(query, messages.length, false, hasRemoteHistory, remoteOnly),
    };
  };

  if (!shouldAttemptRemote) {
    return buildResult();
  }

  if (queryKeyword) {
    const initialCursorId = queryBeforeMessageId
      || (matchedCandidates.length
        ? Math.min(...matchedCandidates.map(({ message }) => message.id))
        : Math.min(
          ...[
            ...liveCandidates.map(({ message }) => message.id),
            ...cachedCandidates.map(({ message }) => message.id),
          ].filter((id) => Number.isFinite(id)),
        ));
    let keywordCursorId: number | undefined = Number.isFinite(initialCursorId)
      ? initialCursorId
      : undefined;
    let previousKeywordCursorId: number | undefined;

    while (
      !truncated
      && pagesFetched < fetchBudget.maxPages
      && scannedCount < fetchBudget.maxScannedMessages
    ) {
      const { page, connectionError } = await fetchPageWithRetry(() => searchKeywordMessages(
        global,
        scope,
        queryKeyword,
        Number.isFinite(keywordCursorId) ? keywordCursorId : undefined,
      ), {
        onFloodWait: onRemoteFloodWait,
      });
      if (connectionError) {
        remoteFetchInterrupted = true;
        if (pagesFetched === 0) {
          hasRemoteHistory = false;
        }
        break;
      }
      pagesFetched += 1;

      if (!page?.messages?.length) {
        break;
      }

      const pageCandidates = page.messages
        .map((message) => toCandidate(message, global, 'api'))
        .sort((left, right) => compareMessagesDesc(left.message, right.message));
      const matchedPageCandidates: CandidateMessage[] = [];

      for (const candidate of pageCandidates) {
        if (truncated) {
          break;
        }

        const matchedBefore = matchedCandidates.length;
        pushCandidate(candidate);
        if (matchedCandidates.length > matchedBefore) {
          matchedPageCandidates.push(candidate);
        }
      }

      const pageIds = page.messages.map(({ id }) => id).filter((id) => Number.isFinite(id));
      if (!pageIds.length) {
        break;
      }

      const nextKeywordCursorId = page.nextOffsetId && Number.isFinite(page.nextOffsetId)
        ? page.nextOffsetId
        : Math.min(...pageIds);

      await onRemotePageFetched?.(buildPageResult(
        matchedPageCandidates,
        Number.isFinite(nextKeywordCursorId) ? nextKeywordCursorId : undefined,
      ));

      if (
        previousKeywordCursorId !== undefined
        && nextKeywordCursorId >= previousKeywordCursorId
      ) {
        break;
      }

      previousKeywordCursorId = nextKeywordCursorId;
      keywordCursorId = nextKeywordCursorId;
      await pause(TELEGRAM_REMOTE_FETCH_PAGE_THROTTLE_MS);
    }
  } else {
    const shouldStartFromLatest = query.mode === 'range' && !Number.isFinite(queryBeforeMessageId);
    const initialCursorId = shouldStartFromLatest
      ? undefined
      : (queryBeforeMessageId
        || (
          matchedCandidates.length
            ? Math.min(...matchedCandidates.map(({ message }) => message.id))
            : Math.min(
              ...[
                ...liveCandidates.map(({ message }) => message.id),
                ...cachedCandidates.map(({ message }) => message.id),
              ].filter((id) => Number.isFinite(id)),
            )
        ));

    let cursorId: number | undefined = Number.isFinite(initialCursorId) ? initialCursorId : undefined;
    let previousCursorId: number | undefined;

    while (
      !truncated
      && pagesFetched < fetchBudget.maxPages
      && scannedCount < fetchBudget.maxScannedMessages
    ) {
      const { page, connectionError } = await fetchPageWithRetry(() => fetchOlderMessages(
        global,
        scope,
        cursorId,
      ), {
        onFloodWait: onRemoteFloodWait,
      });
      if (connectionError) {
        remoteFetchInterrupted = true;
        if (pagesFetched === 0) {
          hasRemoteHistory = false;
        }
        break;
      }
      pagesFetched += 1;

      if (!page?.messages?.length) {
        break;
      }

      const apiState = mergeFetchedPeers(global, page);
      const pageCandidates = page.messages
        .map((message) => toCandidate(message, apiState, 'api'))
        .sort((left, right) => compareMessagesDesc(left.message, right.message));
      const matchedPageCandidates: CandidateMessage[] = [];

      for (const candidate of pageCandidates) {
        if (truncated) {
          break;
        }

        const matchedBefore = matchedCandidates.length;
        pushCandidate(candidate);
        if (matchedCandidates.length > matchedBefore) {
          matchedPageCandidates.push(candidate);
        }
      }

      const pageIds = page.messages.map(({ id }) => id).filter((id) => Number.isFinite(id));
      if (!pageIds.length) {
        break;
      }

      const nextCursorId = Math.min(...pageIds);
      await onRemotePageFetched?.(buildPageResult(
        matchedPageCandidates,
        Number.isFinite(nextCursorId) ? nextCursorId : undefined,
      ));

      if (isPageEntirelyBeforeTimeRange(page.messages, timeRange)) {
        break;
      }

      if (
        previousCursorId !== undefined
        && nextCursorId >= previousCursorId
      ) {
        break;
      }

      previousCursorId = nextCursorId;
      cursorId = nextCursorId;
      await pause(TELEGRAM_REMOTE_FETCH_PAGE_THROTTLE_MS);
    }
  }

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
  let currentQuery: Extract<MessageFetchQuery, { mode: 'range' }> = query;
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
