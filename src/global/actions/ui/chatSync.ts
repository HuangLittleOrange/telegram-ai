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
  calculateUnsyncedMessages,
  countMessagesInRange,
  getOldestMessageDateInRange,
  isMessageInRange,
  resolveTimeRangeBoundsSec,
} from '../../helpers/chatSync';
import {
  addActionHandler,
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
  selectChatMessages,
} from '../../selectors';

const CHAT_SYNC_BATCH_SIZE = 100;
const GET_HISTORY_PAUSE_MS = 350;
const DATA_EXPORT_PAUSE_MS = 150;
const DEFAULT_METHOD: ChatSyncMethod = 'dataExport';

const runningSyncKeys = new Set<string>();

type SyncFetchedPage = {
  messages?: ApiMessage[];
  users?: ApiUser[];
  chats?: ApiChat[];
};

function getSyncKey(chatId: string, threadId: ThreadId) {
  return `${chatId}:${String(threadId)}`;
}

function buildDefaultChatSyncState(): ChatSyncState {
  return {
    selectedMethod: DEFAULT_METHOD,
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

function parseSyncError(error: unknown, method: ChatSyncMethod) {
  const text = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';

  if (method === 'dataExport' && /TAKEOUT_INIT_DELAY/i.test(text)) {
    return 'Data Export 需要先在 Telegram 官方客户端完成授权后再使用。';
  }

  if (/FLOOD_WAIT_/i.test(text) || /wait of \d+ seconds/i.test(text)) {
    return '触发 Telegram 频率限制，请稍后继续同步。';
  }

  if (/Not connected|disconnected/i.test(text)) {
    return 'Telegram 当前未连接，请稍后重试。';
  }

  return method === 'dataExport'
    ? 'Data Export 同步失败，请检查授权状态后重试。'
    : 'GetHistory 同步失败，请稍后重试。';
}

function resolveSyncThreadId(threadId?: ThreadId) {
  return threadId || MAIN_THREAD_ID;
}

async function loadChatSyncStatsInternal(chatId: string, threadId?: ThreadId) {
  let global = getGlobal();
  const resolvedThreadId = resolveSyncThreadId(threadId);
  const syncState = getChatSyncState(global, chatId);
  const chat = selectChat(global, chatId);

  if (!chat) {
    return;
  }

  global = updateChatSyncState(global, chatId, {
    isStatsLoading: true,
  });
  setGlobal(global);

  const bounds = resolveTimeRangeBoundsSec(syncState.selectedTimeRange);
  const isSavedDialog = getIsSavedDialog(chatId, resolvedThreadId, global.currentUserId);
  const result = await callApi('searchMessagesInChat', {
    peer: chat,
    isSavedDialog,
    threadId: resolvedThreadId,
    query: '',
    limit: 1,
    minDate: bounds?.startSec,
    maxDate: bounds?.endSec,
  });

  global = getGlobal();
  const latestState = getChatSyncState(global, chatId);
  const localMessages = selectChatMessages(global, chatId);
  const syncedMessages = countMessagesInRange(localMessages, bounds);
  const totalMessages = result?.totalCount || 0;
  const unsyncedMessages = calculateUnsyncedMessages(totalMessages, syncedMessages);
  const oldestSyncedDateSec = getOldestMessageDateInRange(localMessages, bounds);

  let nextStatus = latestState.status;
  if (latestState.status === 'idle' || latestState.status === 'completed') {
    nextStatus = totalMessages > 0 && unsyncedMessages === 0 ? 'completed' : 'idle';
  }

  global = updateChatSyncState(global, chatId, {
    totalMessages,
    syncedMessages,
    unsyncedMessages,
    oldestSyncedDate: oldestSyncedDateSec ? oldestSyncedDateSec * 1000 : undefined,
    isStatsLoading: false,
    status: nextStatus,
    updatedAt: Date.now(),
  });
  setGlobal(global);
}

function mergeFetchedPage(global: GlobalState, chatId: string, page: SyncFetchedPage, selectedTimeRange?: TimeRange) {
  const bounds = resolveTimeRangeBoundsSec(selectedTimeRange);
  let nextGlobal = global;

  if (page.users?.length) {
    nextGlobal = updateUsers(nextGlobal, buildCollectionByKey(page.users, 'id'));
  }
  if (page.chats?.length) {
    nextGlobal = updateChats(nextGlobal, buildCollectionByKey(page.chats, 'id'));
  }

  const inRangeMessages = page.messages?.filter((message) => isMessageInRange(message.date, bounds)) || [];
  if (inRangeMessages.length) {
    nextGlobal = addMessages(nextGlobal, inRangeMessages);
  }

  const localMessages = selectChatMessages(nextGlobal, chatId);
  const syncedMessages = countMessagesInRange(localMessages, bounds);
  const totalMessages = getChatSyncState(nextGlobal, chatId).totalMessages || 0;
  const oldestSyncedDateSec = getOldestMessageDateInRange(localMessages, bounds);

  nextGlobal = updateChatSyncState(nextGlobal, chatId, {
    syncedMessages,
    unsyncedMessages: calculateUnsyncedMessages(totalMessages, syncedMessages),
    oldestSyncedDate: oldestSyncedDateSec ? oldestSyncedDateSec * 1000 : undefined,
    updatedAt: Date.now(),
  });

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
    updatedAt: Date.now(),
  });
});

addActionHandler('setChatSyncTimeRange', (global, actions, payload): ActionReturnType => {
  const resolvedGlobal = updateChatSyncState(global, payload.chatId, {
    selectedTimeRange: payload.timeRange,
    cursorMessageId: undefined,
    error: undefined,
    updatedAt: Date.now(),
  });

  const existing = getChatSyncState(global, payload.chatId);
  const threadId = resolveSyncThreadId(undefined);
  if (existing.status === 'syncing') {
    actions.pauseChatSync({ chatId: payload.chatId, threadId });
  }

  void loadChatSyncStatsInternal(payload.chatId, threadId);

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
    cursorMessageId: undefined,
    error: undefined,
    takeoutId: undefined,
    updatedAt: Date.now(),
  });

  void loadChatSyncStatsInternal(payload.chatId, resolvedThreadId);
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
  try {
    await loadChatSyncStatsInternal(payload.chatId, resolvedThreadId);

    global = getGlobal();
    const chat = selectChat(global, payload.chatId);
    if (!chat) {
      return;
    }

    const syncState = getChatSyncState(global, payload.chatId);
    const syncMethod = syncState.selectedMethod;
    const selectedTimeRange = syncState.selectedTimeRange;
    const bounds = resolveTimeRangeBoundsSec(selectedTimeRange);
    const isSavedDialog = getIsSavedDialog(payload.chatId, resolvedThreadId, global.currentUserId);

    global = updateChatSyncState(global, payload.chatId, {
      status: 'syncing',
      error: undefined,
      updatedAt: Date.now(),
    });
    setGlobal(global);

    if (syncMethod === 'dataExport') {
      const takeoutSession = await callApi('initTakeoutSessionForSync');
      takeoutId = takeoutSession?.takeoutId;
      if (!takeoutId) {
        throw new Error('TAKEOUT_INIT_DELAY');
      }

      takeoutSessionStarted = true;
      global = getGlobal();
      global = updateChatSyncState(global, payload.chatId, { takeoutId });
      setGlobal(global);
    }

    let cursorMessageId = syncState.cursorMessageId;
    if (!cursorMessageId) {
      cursorMessageId = await resolveInitialCursor(chat, selectedTimeRange);
    }

    while (runningSyncKeys.has(key)) {
      const page = (syncMethod === 'dataExport' && takeoutId
        ? await callApi('fetchMessagesWithTakeout', {
          chat,
          takeoutId,
          threadId: resolvedThreadId,
          offsetId: cursorMessageId,
          addOffset: 0,
          limit: CHAT_SYNC_BATCH_SIZE,
          isSavedDialog,
        })
        : await callApi('fetchMessages', {
          chat,
          threadId: resolvedThreadId,
          offsetId: cursorMessageId,
          addOffset: 0,
          limit: CHAT_SYNC_BATCH_SIZE,
          isSavedDialog,
        })) as SyncFetchedPage | undefined;

      if (!page?.messages?.length) {
        takeoutSuccess = true;
        break;
      }

      const oldestPageDate = Math.min(...page.messages.map((message) => message.date));
      const nextCursorMessageId = Math.min(...page.messages.map((message) => message.id));
      if (Number.isFinite(nextCursorMessageId)) {
        cursorMessageId = nextCursorMessageId;
      }

      global = getGlobal();
      global = mergeFetchedPage(global, payload.chatId, page, selectedTimeRange);
      global = updateChatSyncState(global, payload.chatId, {
        cursorMessageId,
      });
      setGlobal(global);
      forceUpdateCache();

      const currentSyncState = getChatSyncState(global, payload.chatId);
      if (
        currentSyncState.totalMessages
        && currentSyncState.syncedMessages >= currentSyncState.totalMessages
      ) {
        takeoutSuccess = true;
        break;
      }

      if (bounds && oldestPageDate < bounds.startSec) {
        takeoutSuccess = true;
        break;
      }

      await pause(syncMethod === 'dataExport' ? DATA_EXPORT_PAUSE_MS : GET_HISTORY_PAUSE_MS);
    }
  } catch (error) {
    global = getGlobal();
    const currentState = getChatSyncState(global, payload.chatId);
    global = updateChatSyncState(global, payload.chatId, {
      status: 'error',
      error: parseSyncError(error, currentState.selectedMethod),
      updatedAt: Date.now(),
    });
    setGlobal(global);
  } finally {
    runningSyncKeys.delete(key);

    if (takeoutSessionStarted) {
      await callApi('finishTakeoutSessionForSync', { success: takeoutSuccess });
    }

    global = getGlobal();
    const currentState = getChatSyncState(global, payload.chatId);
    const nextStatus = currentState.status === 'paused' || currentState.status === 'error'
      ? currentState.status
      : (takeoutSuccess ? 'completed' : 'paused');

    global = updateChatSyncState(global, payload.chatId, {
      status: nextStatus,
      takeoutId: undefined,
      updatedAt: Date.now(),
    });
    setGlobal(global);

    await loadChatSyncStatsInternal(payload.chatId, resolvedThreadId);
  }
});
