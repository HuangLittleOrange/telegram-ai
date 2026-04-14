import type { ApiChat, ApiMessage, ApiUser } from '../../../api/types';
import type { ThreadId } from '../../../types';
import type {
  ActionReturnType,
  ChatSyncMethod,
  ChatSyncState,
  GlobalState,
  TimeRange,
} from '../../types';
import { MAIN_THREAD_ID } from '../../../api/types';

import { buildCollectionByKey } from '../../../util/iteratees';
import { pause } from '../../../util/schedulers';
import { callApi } from '../../../api/gramjs';
import { forceUpdateCache } from '../../cache';
import { getIsSavedDialog } from '../../helpers';
import {
  buildPersistedSyncSnapshot,
  resolveFinalChatSyncStatus,
  resolveTimeRangeBoundsSec,
} from '../../helpers/chatSync';
import {
  getSyncedMessagesStats,
  persistSyncedMessagesForChat,
} from '../../helpers/syncedMessagesStore';
import {
  addActionHandler,
  execAfterActions,
  getGlobal,
  setGlobal,
} from '../../index';
import {
  addMessages,
  updateChats,
  updateUsers,
} from '../../reducers';
import {
  selectChat,
} from '../../selectors';

const CHAT_SYNC_BATCH_SIZE = 100;
const GET_HISTORY_PAUSE_MS = 350;
const DATA_EXPORT_PAUSE_MS = 150;
const SYNC_PAGE_TIMEOUT_MS = 25000;
const SYNC_NO_PROGRESS_TIMEOUT_MS = 45000;
const MAX_TAKEOUT_RECOVERY_ATTEMPTS = 2;
const DEFAULT_METHOD: ChatSyncMethod = 'dataExport';

const runningSyncKeys = new Set<string>();

type SyncFetchedPage = {
  messages?: ApiMessage[];
  users?: ApiUser[];
  chats?: ApiChat[];
  count?: number;
};

type ParsedSyncError = {
  message: string;
  errorCode?: string;
  errorDetail?: string;
  requiresTakeoutAuthorization?: boolean;
  takeoutInitDelaySeconds?: number;
};

type TakeoutMessageRange = {
  minId: number;
  maxId: number;
};

function getOldestDateSecFromMessages(messages?: ApiMessage[]) {
  if (!messages?.length) {
    return undefined;
  }

  const dateValues = messages
    .map((message) => message.date)
    .filter((date): date is number => Number.isFinite(date));

  if (!dateValues.length) {
    return undefined;
  }

  return Math.min(...dateValues);
}

function getNextCursorMessageId(messages?: ApiMessage[]) {
  if (!messages?.length) {
    return undefined;
  }

  const ids = messages
    .map((message) => message.id)
    .filter((id): id is number => Number.isFinite(id) && id > 0);

  if (!ids.length) {
    return undefined;
  }

  return Math.min(...ids);
}

function normalizeTakeoutRanges(ranges?: TakeoutMessageRange[]) {
  if (!ranges?.length) {
    return [];
  }

  return ranges
    .filter((range) => (
      Number.isFinite(range.minId)
      && Number.isFinite(range.maxId)
      && range.maxId >= range.minId
    ))
    .sort((a, b) => b.maxId - a.maxId);
}

function resolveTakeoutRangeIndex(ranges: TakeoutMessageRange[], cursorMessageId?: number) {
  if (!ranges.length || cursorMessageId === undefined) {
    return 0;
  }

  const inRangeIndex = ranges.findIndex((range) => (
    cursorMessageId >= range.minId && cursorMessageId <= range.maxId
  ));
  if (inRangeIndex >= 0) {
    return inRangeIndex;
  }

  const newerRangeIndex = ranges.findIndex((range) => cursorMessageId > range.maxId);
  if (newerRangeIndex >= 0) {
    return newerRangeIndex;
  }

  return ranges.length - 1;
}

function getSyncKey(chatId: string, threadId: ThreadId) {
  return `${chatId}:${String(threadId)}`;
}

function buildDefaultChatSyncState(): ChatSyncState {
  return {
    selectedMethod: DEFAULT_METHOD,
    hasSyncedOnce: false,
    hasAccurateScopedTotalMessages: false,
    syncedMessages: 0,
    unsyncedMessages: 0,
    status: 'idle',
  };
}

function getChatSyncState(global: GlobalState, chatId: string): ChatSyncState {
  return global.chatSync.byChatId[chatId] || buildDefaultChatSyncState();
}

function updateChatSyncState(global: GlobalState, chatId: string, patch: Partial<ChatSyncState>): GlobalState {
  const current = getChatSyncState(global, chatId);

  return {
    ...global,
    chatSync: {
      ...global.chatSync,
      byChatId: {
        ...global.chatSync.byChatId,
        [chatId]: {
          ...current,
          ...patch,
        },
      },
    },
  };
}

function isOutdatedGlobalError(error: unknown) {
  const text = extractSyncErrorText(error);
  return /TeactN\.setGlobal|Attempt to set an outdated global|outdated global/i.test(text);
}

function applyChatSyncStatePatch(chatId: string, patch: Partial<ChatSyncState>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let global = getGlobal();
    global = updateChatSyncState(global, chatId, patch);
    try {
      setGlobal(global, { forceOutdated: true });
      return global;
    } catch (error) {
      if (!isOutdatedGlobalError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError;
}

function applyGlobalMutation(mutator: (global: GlobalState) => GlobalState) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let global = getGlobal();
    global = mutator(global);
    try {
      setGlobal(global, { forceOutdated: true });
      return global;
    } catch (error) {
      if (!isOutdatedGlobalError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError;
}

function extractSyncErrorText(error: unknown) {
  const chunks: string[] = [];

  if (error instanceof Error) {
    if (error.message) {
      chunks.push(error.message);
    }
  }

  if (typeof error === 'string') {
    chunks.push(error);
  }

  if (error && typeof error === 'object') {
    const withFields = error as { message?: unknown; errorMessage?: unknown; code?: unknown };

    if (typeof withFields.errorMessage === 'string') {
      chunks.push(withFields.errorMessage);
    }
    if (typeof withFields.message === 'string') {
      chunks.push(withFields.message);
    }
    if (typeof withFields.code === 'number' || typeof withFields.code === 'string') {
      chunks.push(String(withFields.code));
    }
  }

  return chunks.join(' | ');
}

function stringifySyncError(error: unknown) {
  if (error === undefined) {
    return undefined;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.stack || error.message;
  }

  if (typeof error === 'object') {
    if (!error) {
      return undefined;
    }

    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') {
        return json;
      }
    } catch (e) {
      void e;
    }
  }

  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }

  if (typeof error === 'symbol') {
    return error.description || 'symbol';
  }

  if (typeof error === 'function') {
    return error.name || 'function';
  }

  return undefined;
}

function normalizeSyncErrorCode(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || !/^[a-z0-9_-]{2,64}$/i.test(trimmed)) {
    return undefined;
  }

  return trimmed.toUpperCase();
}

function extractSyncErrorCode(error: unknown, text: string) {
  if (error && typeof error === 'object') {
    const withFields = error as { code?: unknown; errorCode?: unknown };
    const explicitCode = normalizeSyncErrorCode(withFields.errorCode ?? withFields.code);
    if (explicitCode) {
      return explicitCode;
    }
  }

  const explicitCodePattern = new RegExp([
    'TAKEOUT_INIT_DELAY_\\d+',
    'TAKEOUT_REQUIRED',
    'TAKEOUT_INVALID',
    'FLOOD_WAIT_\\d+',
    'SYNC_CURSOR_STALLED',
    'SYNC_REQUEST_TIMEOUT',
    'SYNC_NO_PROGRESS',
    'AUTH_KEY_PERM_EMPTY',
    'TEMP_AUTH_KEY',
    'SESSION_REVOKED',
  ].join('|'), 'i');
  const explicitMatch = text.match(explicitCodePattern);
  if (explicitMatch?.[1]) {
    return explicitMatch[1].toUpperCase();
  }

  const bracketCodeMatch = text.match(/\[(\d{3}\s+)?([A-Z][A-Z0-9_]{3,})\]/i);
  if (bracketCodeMatch?.[2]) {
    return bracketCodeMatch[2].toUpperCase();
  }

  const rpcCodeMatch = text.match(/(?:RPCError|error)\s*[:\-\s(]*([A-Z][A-Z0-9_]{3,})\b/i);
  if (rpcCodeMatch?.[1]) {
    return rpcCodeMatch[1].toUpperCase();
  }

  const floodWaitMatch = text.match(/wait of (\d+) seconds/i);
  if (floodWaitMatch?.[1]) {
    return `FLOOD_WAIT_${floodWaitMatch[1]}`;
  }

  if (/Not connected|disconnected/i.test(text)) {
    return 'NOT_CONNECTED';
  }

  if (
    /InitTakeoutSession|FinishTakeoutSession|InvokeWithTakeout/i.test(text)
    && /not a constructor|not a function|is undefined/i.test(text)
  ) {
    return 'TAKEOUT_API_MISSING';
  }

  if (/TAKEOUT_INIT_DELAY/i.test(text)) {
    return 'TAKEOUT_INIT_DELAY';
  }

  if (/takeout/i.test(text)) {
    return 'TAKEOUT_AUTH_REQUIRED';
  }

  return undefined;
}

function parseTakeoutDelaySeconds(text: string) {
  const matched = text.match(/TAKEOUT_INIT_DELAY_(\d+)/i)
    || text.match(/wait\s+(\d+)\s+seconds?\s+before initializing takeout/i)
    || text.match(/begin downloading your data in (\d+) seconds/i)
    || text.match(/in\s+(\d+)\s+seconds/i);

  if (!matched?.[1]) {
    return undefined;
  }

  const seconds = Number(matched[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function formatDurationForSync(seconds: number) {
  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!remainingMinutes) {
    return `${hours} 小时`;
  }

  return `${hours} 小时 ${remainingMinutes} 分钟`;
}

function parseSyncError(error: unknown, method: ChatSyncMethod): ParsedSyncError {
  const text = extractSyncErrorText(error);
  const fallbackDetail = stringifySyncError(error);
  const errorDetail = text || fallbackDetail;
  const extractedCode = extractSyncErrorCode(error, text);
  const preferredCode = extractedCode && extractedCode !== 'UNKNOWN_SYNC_ERROR'
    ? extractedCode
    : undefined;
  const takeoutDelaySeconds = parseTakeoutDelaySeconds(text);
  const hasTakeoutDelay = /TAKEOUT_INIT_DELAY/i.test(text) || takeoutDelaySeconds !== undefined;
  const hasTakeoutAuthorizationError = /TAKEOUT_REQUIRED|TAKEOUT_INVALID|takeout session/i.test(text);
  const hasTakeoutConstructorError = /InitTakeoutSession|FinishTakeoutSession|InvokeWithTakeout/i.test(text)
    && /not a constructor|not a function|is undefined/i.test(text);

  if (method === 'dataExport' && hasTakeoutConstructorError) {
    return {
      message: '当前客户端缺少 Data Export 接口定义，请刷新页面后重试。',
      errorCode: preferredCode || 'TAKEOUT_API_MISSING',
      errorDetail,
    };
  }

  if (method === 'dataExport' && (hasTakeoutDelay || hasTakeoutAuthorizationError || /takeout/i.test(text))) {
    const waitText = takeoutDelaySeconds ? `请等待约 ${formatDurationForSync(takeoutDelaySeconds)} 后重试。` : '请稍后重试。';
    return {
      message: `Data Export 需要在 Telegram 官方客户端确认导出请求，${waitText}`,
      errorCode: preferredCode || 'TAKEOUT_AUTH_REQUIRED',
      errorDetail,
      requiresTakeoutAuthorization: true,
      takeoutInitDelaySeconds: takeoutDelaySeconds,
    };
  }

  if (/FLOOD_WAIT_/i.test(text) || /wait of \d+ seconds/i.test(text)) {
    return {
      message: '触发 Telegram 频率限制，请稍后继续同步。',
      errorCode: preferredCode || 'FLOOD_WAIT',
      errorDetail,
    };
  }

  if (/Not connected|disconnected/i.test(text)) {
    return {
      message: 'Telegram 当前未连接，请稍后重试。',
      errorCode: preferredCode || 'NOT_CONNECTED',
      errorDetail,
    };
  }

  if (/TeactN\.setGlobal|Attempt to set an outdated global|outdated global/i.test(text)) {
    return {
      message: '同步状态更新发生并发冲突，请点击继续同步重试。',
      errorCode: preferredCode || 'SYNC_STATE_OUTDATED',
      errorDetail,
    };
  }

  if (/SYNC_CURSOR_STALLED/i.test(text)) {
    return {
      message: '同步游标未继续向更早消息推进，请点击继续同步重试。',
      errorCode: preferredCode || 'SYNC_CURSOR_STALLED',
      errorDetail,
    };
  }

  if (/SYNC_REQUEST_TIMEOUT/i.test(text)) {
    return {
      message: '同步请求超时，网络或 Telegram 响应较慢，请继续同步重试。',
      errorCode: preferredCode || 'SYNC_REQUEST_TIMEOUT',
      errorDetail,
    };
  }

  if (/SYNC_NO_PROGRESS/i.test(text)) {
    return {
      message: '同步已超过 45 秒无进展，建议暂停后继续同步。',
      errorCode: preferredCode || 'SYNC_NO_PROGRESS',
      errorDetail,
    };
  }

  return {
    message: method === 'dataExport'
      ? 'Data Export 同步失败，请检查授权状态后重试。'
      : 'GetHistory 同步失败，请稍后重试。',
    errorCode: extractedCode || 'UNKNOWN_SYNC_ERROR',
    errorDetail,
  };
}

function resolveSyncThreadId(threadId?: ThreadId) {
  void threadId;
  return MAIN_THREAD_ID;
}

function getStartOfTodayTimestampMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function clampCustomRangeEndToToday(endAt: number) {
  const startOfToday = getStartOfTodayTimestampMs();
  const now = Date.now();
  return Math.min(now, Math.max(startOfToday, endAt));
}

function normalizeSyncTimeRange(timeRange?: TimeRange) {
  if (!timeRange || timeRange.mode === 'preset') {
    return timeRange;
  }

  return {
    ...timeRange,
    // Keep custom range as "startAt -> now" so new messages on following days
    // are included without forcing users to reselect time.
    endAt: clampCustomRangeEndToToday(Date.now()),
  };
}

async function loadPersistedSyncStats(args: {
  chatId: string;
  threadId: ThreadId;
  bounds?: ReturnType<typeof resolveTimeRangeBoundsSec>;
}) {
  const { chatId, threadId, bounds } = args;
  const persistedStats = await getSyncedMessagesStats({
    chatId,
    threadId,
    timeRange: bounds,
  });

  return {
    syncedMessages: persistedStats.count,
    oldestSyncedDate: persistedStats.oldestDate ? persistedStats.oldestDate * 1000 : undefined,
    newestSyncedDate: persistedStats.newestDate ? persistedStats.newestDate * 1000 : undefined,
  };
}

function isRecoverableDataExportError(error: unknown) {
  const text = extractSyncErrorText(error);
  return (
    /SYNC_REQUEST_TIMEOUT/i.test(text)
    || /Not connected|disconnected|CONNECTION/i.test(text)
    || /TAKEOUT_REQUIRED|TAKEOUT_INVALID|TAKEOUT_INIT_DELAY|takeout/i.test(text)
    || /AUTH_KEY_PERM_EMPTY|TEMP_AUTH_KEY|SESSION_REVOKED/i.test(text)
  );
}

async function withSyncTimeout<T>(promise: Promise<T>, timeoutMs: number, errorCode: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(errorCode));
    }, timeoutMs);

    promise.then((result) => {
      window.clearTimeout(timer);
      resolve(result);
    }).catch((error) => {
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

async function loadChatSyncStatsInternal(chatId: string, threadId?: ThreadId) {
  let global = getGlobal();
  const resolvedThreadId = resolveSyncThreadId(threadId);
  let syncState = getChatSyncState(global, chatId);
  const chat = selectChat(global, chatId);

  if (!chat) {
    return;
  }

  const normalizedTimeRange = normalizeSyncTimeRange(syncState.selectedTimeRange);
  if (
    syncState.selectedTimeRange?.mode === 'custom'
    && normalizedTimeRange?.mode === 'custom'
    && normalizedTimeRange.endAt !== syncState.selectedTimeRange.endAt
  ) {
    global = applyChatSyncStatePatch(chatId, {
      selectedTimeRange: normalizedTimeRange,
    });
    syncState = getChatSyncState(global, chatId);
  }

  global = applyChatSyncStatePatch(chatId, {
    isStatsLoading: true,
  });

  const bounds = resolveTimeRangeBoundsSec(normalizedTimeRange);
  const isCustomRangeSync = normalizedTimeRange?.mode === 'custom';
  const isSavedDialog = getIsSavedDialog(chatId, resolvedThreadId, global.currentUserId);
  const remoteConversationTotalMessages = (await callApi('fetchMessages', {
    chat,
    threadId: resolvedThreadId,
    offsetId: undefined,
    addOffset: 0,
    limit: 1,
    isSavedDialog,
  }))?.count;
  const remoteScopedTotalMessages = isCustomRangeSync
    ? (syncState.hasAccurateScopedTotalMessages && syncState.scopedTotalMessages !== undefined
      ? syncState.scopedTotalMessages
      : (bounds ? (await callApi('countMessagesInChatRange', {
        chat,
        threadId: resolvedThreadId,
        isSavedDialog,
        startDate: bounds.startSec,
        endDate: bounds.endSec,
        limit: CHAT_SYNC_BATCH_SIZE,
      }))?.totalCount : undefined))
    : remoteConversationTotalMessages;

  global = getGlobal();
  const latestState = getChatSyncState(global, chatId);
  const persistedStats = await loadPersistedSyncStats({
    chatId,
    threadId: resolvedThreadId,
    bounds,
  });
  const isScopedTotalKnown = remoteScopedTotalMessages !== undefined
    || latestState.hasAccurateScopedTotalMessages
    || (isCustomRangeSync && latestState.status === 'completed');
  const snapshot = buildPersistedSyncSnapshot({
    persistedCount: persistedStats.syncedMessages,
    oldestDateSec: persistedStats.oldestSyncedDate
      ? Math.floor(persistedStats.oldestSyncedDate / 1000)
      : undefined,
    newestDateSec: persistedStats.newestSyncedDate
      ? Math.floor(persistedStats.newestSyncedDate / 1000)
      : undefined,
    baselineTotalMessages: isScopedTotalKnown
      ? Math.max(remoteScopedTotalMessages || 0, latestState.scopedTotalMessages || 0)
      : undefined,
    isTotalKnown: isScopedTotalKnown,
  });
  const conversationTotalMessages = remoteConversationTotalMessages !== undefined
    ? Math.max(remoteConversationTotalMessages, latestState.totalMessages || 0)
    : latestState.totalMessages;

  let nextStatus = latestState.status;
  if (isCustomRangeSync) {
    if (latestState.status === 'completed') {
      nextStatus = 'completed';
    } else if (latestState.status === 'idle') {
      nextStatus = 'idle';
    }
  } else if (latestState.status === 'idle' || latestState.status === 'completed') {
    nextStatus = (snapshot.totalMessages || 0) > 0 && snapshot.unsyncedMessages === 0 ? 'completed' : 'idle';
  }

  global = applyChatSyncStatePatch(chatId, {
    hasSyncedOnce: latestState.hasSyncedOnce || snapshot.syncedMessages > 0,
    hasAccurateScopedTotalMessages: isScopedTotalKnown,
    totalMessages: conversationTotalMessages,
    scopedTotalMessages: snapshot.totalMessages,
    syncedMessages: snapshot.syncedMessages,
    unsyncedMessages: snapshot.unsyncedMessages,
    oldestSyncedDate: snapshot.oldestSyncedDate,
    newestSyncedDate: snapshot.newestSyncedDate,
    isStatsLoading: false,
    status: nextStatus,
    updatedAt: Date.now(),
  });
}

async function refreshPersistedSyncState(args: {
  chatId: string;
  threadId: ThreadId;
  selectedTimeRange?: TimeRange;
  scopedTotalMessages?: number;
  forceKnownTotal?: boolean;
}) {
  const {
    chatId,
    threadId,
    selectedTimeRange,
    scopedTotalMessages,
    forceKnownTotal,
  } = args;
  const bounds = resolveTimeRangeBoundsSec(selectedTimeRange);
  const isCustomRangeSync = selectedTimeRange?.mode === 'custom';
  const persistedStats = await loadPersistedSyncStats({
    chatId,
    threadId,
    bounds,
  });
  const currentGlobal = getGlobal();
  const currentState = getChatSyncState(currentGlobal, chatId);
  const isTotalKnown = forceKnownTotal || !isCustomRangeSync;
  const snapshot = buildPersistedSyncSnapshot({
    persistedCount: persistedStats.syncedMessages,
    oldestDateSec: persistedStats.oldestSyncedDate
      ? Math.floor(persistedStats.oldestSyncedDate / 1000)
      : undefined,
    newestDateSec: persistedStats.newestSyncedDate
      ? Math.floor(persistedStats.newestSyncedDate / 1000)
      : undefined,
    baselineTotalMessages: isTotalKnown
      ? Math.max(scopedTotalMessages || 0, currentState.scopedTotalMessages || 0)
      : undefined,
    isTotalKnown,
  });

  applyChatSyncStatePatch(chatId, {
    hasSyncedOnce: currentState.hasSyncedOnce || snapshot.syncedMessages > 0,
    hasAccurateScopedTotalMessages: isTotalKnown,
    totalMessages: currentState.totalMessages,
    scopedTotalMessages: snapshot.totalMessages,
    syncedMessages: snapshot.syncedMessages,
    unsyncedMessages: snapshot.unsyncedMessages,
    oldestSyncedDate: snapshot.oldestSyncedDate,
    newestSyncedDate: snapshot.newestSyncedDate,
    updatedAt: Date.now(),
  });
}

function mergeFetchedPage(global: GlobalState, page: SyncFetchedPage) {
  let nextGlobal = global;

  if (page.users?.length) {
    nextGlobal = updateUsers(nextGlobal, buildCollectionByKey(page.users, 'id'));
  }
  if (page.chats?.length) {
    nextGlobal = updateChats(nextGlobal, buildCollectionByKey(page.chats, 'id'));
  }

  if (page.messages?.length) {
    nextGlobal = addMessages(nextGlobal, page.messages);
  }

  return nextGlobal;
}

async function resolveInitialCursor(chat: ApiChat, selectedTimeRange?: TimeRange) {
  const bounds = resolveTimeRangeBoundsSec(selectedTimeRange);
  if (!bounds) {
    return undefined;
  }

  return callApi('findFirstMessageIdAfterDate', {
    chat,
    timestamp: bounds.endSec,
  });
}

addActionHandler('loadChatSyncStats', async (_global, _actions, payload): Promise<void> => {
  await loadChatSyncStatsInternal(payload.chatId, payload.threadId);
});

addActionHandler('setChatSyncMethod', (global, _actions, payload): ActionReturnType => {
  return updateChatSyncState(global, payload.chatId, {
    selectedMethod: payload.method,
    error: undefined,
    errorCode: undefined,
    errorDetail: undefined,
    requiresTakeoutAuthorization: undefined,
    takeoutInitDelaySeconds: undefined,
    updatedAt: Date.now(),
  });
});

addActionHandler('setChatSyncTimeRange', (global, actions, payload): ActionReturnType => {
  const threadId = resolveSyncThreadId(undefined);
  const existing = getChatSyncState(global, payload.chatId);
  const normalizedTimeRange = normalizeSyncTimeRange(payload.timeRange);

  const resolvedGlobal = updateChatSyncState(global, payload.chatId, {
    selectedTimeRange: normalizedTimeRange,
    hasSyncedOnce: false,
    hasAccurateScopedTotalMessages: false,
    scopedTotalMessages: undefined,
    syncedMessages: 0,
    unsyncedMessages: 0,
    oldestSyncedDate: undefined,
    newestSyncedDate: undefined,
    lastProgressAt: undefined,
    status: 'idle',
    cursorMessageId: undefined,
    error: undefined,
    errorCode: undefined,
    errorDetail: undefined,
    requiresTakeoutAuthorization: undefined,
    takeoutInitDelaySeconds: undefined,
    updatedAt: Date.now(),
  });

  if (existing.status === 'syncing') {
    actions.pauseChatSync({ chatId: payload.chatId, threadId });
  }

  // Defer follow-up stats refresh to avoid setting outdated global within the same action cycle.
  execAfterActions(() => {
    void loadChatSyncStatsInternal(payload.chatId, threadId);
  });

  return resolvedGlobal;
});

addActionHandler('pauseChatSync', (global, _actions, payload): ActionReturnType => {
  const resolvedThreadId = resolveSyncThreadId(payload.threadId);
  const key = getSyncKey(payload.chatId, resolvedThreadId);
  runningSyncKeys.delete(key);
  void callApi('abortChatRequests', {
    chatId: payload.chatId,
    threadId: resolvedThreadId,
  });

  return updateChatSyncState(global, payload.chatId, {
    status: 'paused',
    updatedAt: Date.now(),
  });
});

addActionHandler('resetChatSync', (global, _actions, payload): ActionReturnType => {
  const resolvedThreadId = resolveSyncThreadId(payload.threadId);
  runningSyncKeys.delete(getSyncKey(payload.chatId, resolvedThreadId));
  void callApi('abortChatRequests', {
    chatId: payload.chatId,
    threadId: resolvedThreadId,
  });

  const nextGlobal = updateChatSyncState(global, payload.chatId, {
    status: 'idle',
    hasSyncedOnce: false,
    hasAccurateScopedTotalMessages: false,
    scopedTotalMessages: undefined,
    syncedMessages: 0,
    unsyncedMessages: 0,
    oldestSyncedDate: undefined,
    newestSyncedDate: undefined,
    lastProgressAt: undefined,
    cursorMessageId: undefined,
    error: undefined,
    errorCode: undefined,
    errorDetail: undefined,
    takeoutId: undefined,
    requiresTakeoutAuthorization: undefined,
    takeoutInitDelaySeconds: undefined,
    updatedAt: Date.now(),
  });

  // Defer stats refresh to keep state writes ordered within TeactN action processing.
  execAfterActions(() => {
    void loadChatSyncStatsInternal(payload.chatId, resolvedThreadId);
  });

  return nextGlobal;
});

addActionHandler('startChatSync', async (_global, _actions, payload): Promise<void> => {
  const resolvedThreadId = resolveSyncThreadId(payload.threadId);
  const key = getSyncKey(payload.chatId, resolvedThreadId);
  if (runningSyncKeys.has(key)) {
    return;
  }

  runningSyncKeys.add(key);

  let global: GlobalState;
  let takeoutSessionStarted = false;
  let takeoutSuccess = false;
  let takeoutId: string | undefined;
  let takeoutRanges: TakeoutMessageRange[] = [];
  let activeTakeoutRangeIndex = 0;
  let stalledPageCount = 0;
  let takeoutRecoveryAttempts = 0;
  let selectedSyncMethod: ChatSyncMethod = DEFAULT_METHOD;
  let runtimeSyncError: unknown;
  try {
    await loadChatSyncStatsInternal(payload.chatId, resolvedThreadId);

    global = getGlobal();
    const chat = selectChat(global, payload.chatId);
    if (!chat) {
      return;
    }

    let syncState = getChatSyncState(global, payload.chatId);
    const syncMethod = syncState.selectedMethod;
    selectedSyncMethod = syncMethod;
    const selectedTimeRange = normalizeSyncTimeRange(syncState.selectedTimeRange);
    if (
      syncState.selectedTimeRange?.mode === 'custom'
      && selectedTimeRange?.mode === 'custom'
      && selectedTimeRange.endAt !== syncState.selectedTimeRange.endAt
    ) {
      global = applyChatSyncStatePatch(payload.chatId, {
        selectedTimeRange,
      });
      syncState = getChatSyncState(global, payload.chatId);
    }
    const bounds = resolveTimeRangeBoundsSec(selectedTimeRange);
    const isSavedDialog = getIsSavedDialog(payload.chatId, resolvedThreadId, global.currentUserId);

    global = applyChatSyncStatePatch(payload.chatId, {
      status: 'syncing',
      lastProgressAt: Date.now(),
      error: undefined,
      errorCode: undefined,
      errorDetail: undefined,
      requiresTakeoutAuthorization: undefined,
      takeoutInitDelaySeconds: undefined,
      updatedAt: Date.now(),
    });

    if (syncMethod === 'dataExport') {
      const takeoutSession = await callApi('initTakeoutSessionForSync');
      takeoutId = takeoutSession?.takeoutId;
      if (!takeoutId) {
        throw new Error('TAKEOUT_INIT_DELAY');
      }

      takeoutSessionStarted = true;
      global = applyChatSyncStatePatch(payload.chatId, { takeoutId });

      takeoutRanges = normalizeTakeoutRanges(await callApi('getTakeoutSplitRangesForSync'));
      global = getGlobal();
    }

    let cursorMessageId = syncState.cursorMessageId;
    if (bounds) {
      cursorMessageId = undefined;
    }
    if (!cursorMessageId) {
      if (!bounds && syncState.oldestSyncedDate) {
        const oldestSyncedDateSec = Math.floor(syncState.oldestSyncedDate / 1000);
        cursorMessageId = await callApi('findFirstMessageIdAfterDate', {
          chat,
          timestamp: oldestSyncedDateSec,
        });
      }
    }
    if (!cursorMessageId) {
      cursorMessageId = await resolveInitialCursor(chat, selectedTimeRange);
    }
    if (takeoutRanges.length) {
      activeTakeoutRangeIndex = resolveTakeoutRangeIndex(takeoutRanges, cursorMessageId);
    }

    while (runningSyncKeys.has(key)) {
      global = getGlobal();
      const liveSyncState = getChatSyncState(global, payload.chatId);
      if (
        liveSyncState.status === 'syncing'
        && liveSyncState.lastProgressAt
        && Date.now() - liveSyncState.lastProgressAt > SYNC_NO_PROGRESS_TIMEOUT_MS
      ) {
        throw new Error('SYNC_NO_PROGRESS');
      }

      const currentTakeoutRange = takeoutRanges.length ? takeoutRanges[activeTakeoutRangeIndex] : undefined;
      const pageRequest = syncMethod === 'dataExport' && takeoutId
        ? callApi('fetchMessagesWithTakeout', {
          chat,
          takeoutId,
          range: currentTakeoutRange,
          threadId: resolvedThreadId,
          offsetId: cursorMessageId,
          addOffset: 0,
          limit: CHAT_SYNC_BATCH_SIZE,
          isSavedDialog,
        })
        : callApi('fetchMessages', {
          chat,
          threadId: resolvedThreadId,
          offsetId: cursorMessageId,
          addOffset: 0,
          limit: CHAT_SYNC_BATCH_SIZE,
          isSavedDialog,
        });
      let page: SyncFetchedPage | undefined;
      try {
        page = await withSyncTimeout(
          pageRequest as Promise<SyncFetchedPage | undefined>,
          SYNC_PAGE_TIMEOUT_MS,
          'SYNC_REQUEST_TIMEOUT',
        );
      } catch (error) {
        const shouldRecoverTakeout = (
          syncMethod === 'dataExport'
          && takeoutSessionStarted
          && takeoutRecoveryAttempts < MAX_TAKEOUT_RECOVERY_ATTEMPTS
          && isRecoverableDataExportError(error)
        );

        if (!shouldRecoverTakeout) {
          throw error;
        }

        const recoveredTakeoutSession = await callApi('initTakeoutSessionForSync');
        const recoveredTakeoutId = recoveredTakeoutSession?.takeoutId;

        if (!recoveredTakeoutId) {
          throw error;
        }

        takeoutId = recoveredTakeoutId;
        takeoutRecoveryAttempts += 1;
        global = applyChatSyncStatePatch(payload.chatId, {
          takeoutId,
          error: undefined,
          errorCode: undefined,
          errorDetail: undefined,
          requiresTakeoutAuthorization: undefined,
          takeoutInitDelaySeconds: undefined,
          updatedAt: Date.now(),
        });
        continue;
      }

      if (!page?.messages?.length) {
        if (takeoutRanges.length && activeTakeoutRangeIndex < takeoutRanges.length - 1) {
          activeTakeoutRangeIndex += 1;
          cursorMessageId = undefined;
          stalledPageCount = 0;

          global = applyChatSyncStatePatch(payload.chatId, {
            cursorMessageId: undefined,
            lastProgressAt: Date.now(),
          });
          continue;
        }

        takeoutSuccess = true;
        break;
      }

      takeoutRecoveryAttempts = 0;

      const oldestPageDate = getOldestDateSecFromMessages(page.messages);
      const nextCursorMessageId = getNextCursorMessageId(page.messages);
      let didAdvanceCursor = false;
      if (nextCursorMessageId !== undefined) {
        // Ensure the next page strictly moves backward to older messages.
        const previousCursorMessageId = cursorMessageId;
        const nextCursor = nextCursorMessageId > 1 ? nextCursorMessageId - 1 : nextCursorMessageId;
        const didAdvance = previousCursorMessageId === undefined || nextCursor < previousCursorMessageId;

        if (didAdvance) {
          cursorMessageId = nextCursor;
          didAdvanceCursor = true;
          stalledPageCount = 0;
        } else if (nextCursor <= 1 && previousCursorMessageId !== undefined && previousCursorMessageId <= 1) {
          takeoutSuccess = true;
          break;
        } else {
          stalledPageCount += 1;
          if (stalledPageCount >= 3) {
            throw new Error('SYNC_CURSOR_STALLED');
          }
        }
      }

      const pageSyncPatch: Partial<ChatSyncState> = {
        cursorMessageId,
      };
      if (didAdvanceCursor) {
        pageSyncPatch.lastProgressAt = Date.now();
      }
      global = applyGlobalMutation((currentGlobal) => {
        const mergedGlobal = mergeFetchedPage(currentGlobal, page);
        return updateChatSyncState(mergedGlobal, payload.chatId, pageSyncPatch);
      });
      forceUpdateCache();
      await persistSyncedMessagesForChat(global, payload.chatId, page.messages);
      await refreshPersistedSyncState({
        chatId: payload.chatId,
        threadId: resolvedThreadId,
        selectedTimeRange,
      });

      if (bounds && oldestPageDate !== undefined && oldestPageDate < bounds.startSec) {
        takeoutSuccess = true;
        break;
      }

      await pause(syncMethod === 'dataExport' ? DATA_EXPORT_PAUSE_MS : GET_HISTORY_PAUSE_MS);
    }
  } catch (error) {
    runtimeSyncError = error;
    global = getGlobal();
    const currentState = getChatSyncState(global, payload.chatId);
    const parsedError = parseSyncError(error, currentState.selectedMethod);
    global = applyChatSyncStatePatch(payload.chatId, {
      status: 'error',
      error: parsedError.message,
      errorCode: parsedError.errorCode,
      errorDetail: parsedError.errorDetail,
      requiresTakeoutAuthorization: parsedError.requiresTakeoutAuthorization,
      takeoutInitDelaySeconds: parsedError.takeoutInitDelaySeconds,
      updatedAt: Date.now(),
    });
  } finally {
    runningSyncKeys.delete(key);

    if (takeoutSessionStarted) {
      await callApi('finishTakeoutSessionForSync', { success: takeoutSuccess });
    }

    global = getGlobal();
    const currentState = getChatSyncState(global, payload.chatId);
    const nextStatus = resolveFinalChatSyncStatus({
      currentStatus: currentState.status,
      takeoutSuccess,
      hadRuntimeError: Boolean(runtimeSyncError),
    });
    const fallbackError = nextStatus === 'error' && currentState.status !== 'error'
      ? parseSyncError(runtimeSyncError || new Error('SYNC_INTERRUPTED'), selectedSyncMethod)
      : undefined;

    const statusPatch: Partial<ChatSyncState> = {
      status: nextStatus,
      takeoutId: undefined,
      updatedAt: Date.now(),
    };
    if (nextStatus !== 'error') {
      statusPatch.error = undefined;
      statusPatch.errorCode = undefined;
      statusPatch.errorDetail = undefined;
      statusPatch.requiresTakeoutAuthorization = undefined;
      statusPatch.takeoutInitDelaySeconds = undefined;
    } else if (fallbackError) {
      statusPatch.error = fallbackError.message;
      statusPatch.errorCode = fallbackError.errorCode;
      statusPatch.errorDetail = fallbackError.errorDetail;
      statusPatch.requiresTakeoutAuthorization = fallbackError.requiresTakeoutAuthorization;
      statusPatch.takeoutInitDelaySeconds = fallbackError.takeoutInitDelaySeconds;
    }

    global = applyChatSyncStatePatch(payload.chatId, statusPatch);

    if (nextStatus === 'completed') {
      global = getGlobal();
      await refreshPersistedSyncState({
        chatId: payload.chatId,
        threadId: resolvedThreadId,
        selectedTimeRange: getChatSyncState(global, payload.chatId).selectedTimeRange,
        forceKnownTotal: true,
      });
      global = applyChatSyncStatePatch(payload.chatId, {
        hasSyncedOnce: true,
        status: 'completed',
        updatedAt: Date.now(),
      });
      forceUpdateCache();
    } else {
      await loadChatSyncStatsInternal(payload.chatId, resolvedThreadId);
    }
  }
});
