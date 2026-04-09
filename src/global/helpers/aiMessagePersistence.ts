import type { ApiMessage } from '../../api/types';
import type { ThreadId } from '../../types';
import type { RequiredGlobalState } from '../types';
import type { MessageFetchQuery, MessageFetchResult, TimeRange } from '../types/tabState';

type PersistFetchedMessagesArgs = {
  messages?: ApiMessage[];
  chatId?: string;
  threadId?: ThreadId;
  getGlobal: () => RequiredGlobalState;
  setGlobal: (global: RequiredGlobalState) => void;
  forceUpdateCache: () => void;
  addMessages: (global: RequiredGlobalState, messages: ApiMessage[]) => RequiredGlobalState;
};

type PersistFetchedRangeCoverageArgs = {
  query: MessageFetchQuery;
  result: MessageFetchResult;
  chatId?: string;
  threadId?: ThreadId;
  getGlobal: () => RequiredGlobalState;
  setGlobal: (global: RequiredGlobalState) => void;
  forceUpdateCache: () => void;
};

function normalizeRangeCoverage(timeRange: TimeRange) {
  if (timeRange.mode === 'custom') {
    return {
      startAt: timeRange.startAt,
      endAt: timeRange.endAt,
    };
  }

  const now = Date.now();
  const date = new Date(now);
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const dayOfWeek = date.getDay();
  const weekStartsOnMondayOffset = (dayOfWeek + 6) % 7;

  if (timeRange.value === 'today') {
    return { startAt: startOfDay, endAt: startOfDay + dayMs };
  }

  if (timeRange.value === 'yesterday') {
    return { startAt: startOfDay - dayMs, endAt: startOfDay };
  }

  if (timeRange.value === 'thisWeek') {
    const startAt = startOfDay - weekStartsOnMondayOffset * dayMs;
    return { startAt, endAt: startAt + 7 * dayMs };
  }

  if (timeRange.value === 'lastWeek') {
    const endAt = startOfDay - weekStartsOnMondayOffset * dayMs;
    return { startAt: endAt - 7 * dayMs, endAt };
  }

  const startAt = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const endAt = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
  return { startAt, endAt };
}

export function persistFetchedMessages({
  messages,
  chatId,
  threadId,
  getGlobal,
  setGlobal,
  forceUpdateCache,
  addMessages,
}: PersistFetchedMessagesArgs): RequiredGlobalState {
  const currentGlobal = getGlobal();
  if (!messages?.length) {
    return currentGlobal;
  }

  let nextGlobal = addMessages(currentGlobal, messages);
  if (chatId && threadId !== undefined) {
    const thread = nextGlobal.messages.byChatId[chatId]?.threadsById?.[threadId];
    if (thread?.localState) {
      const fetchedIds = messages
        .map((message) => message.id)
        .filter((id): id is number => Number.isFinite(id));
      const listedIds = [...(thread.localState.listedIds || []), ...fetchedIds].sort((a, b) => a - b);
      const uniqueListedIds = listedIds.filter((id, index) => index === 0 || listedIds[index - 1] !== id);
      nextGlobal = {
        ...nextGlobal,
        messages: {
          ...nextGlobal.messages,
          byChatId: {
            ...nextGlobal.messages.byChatId,
            [chatId]: {
              ...nextGlobal.messages.byChatId[chatId],
              threadsById: {
                ...nextGlobal.messages.byChatId[chatId].threadsById,
                [threadId]: {
                  ...thread,
                  localState: {
                    ...thread.localState,
                    listedIds: uniqueListedIds,
                    lastViewportIds: uniqueListedIds,
                  },
                },
              },
            },
          },
        },
      };
    }
  }
  const global = nextGlobal;
  setGlobal(global);
  forceUpdateCache();
  return global;
}

export function persistFetchedRangeCoverage({
  query,
  result,
  chatId,
  threadId,
  getGlobal,
  setGlobal,
  forceUpdateCache,
}: PersistFetchedRangeCoverageArgs): RequiredGlobalState {
  const currentGlobal = getGlobal();
  if (query.mode !== 'range' || result.truncated || !chatId || threadId === undefined) {
    return currentGlobal;
  }

  const thread = currentGlobal.messages.byChatId[chatId]?.threadsById?.[threadId];
  if (!thread?.localState) {
    return currentGlobal;
  }

  const nextCoverage = {
    ...normalizeRangeCoverage(query.timeRange),
    completedAt: Date.now(),
  };
  const previousCoverages = thread.localState.fetchedMessageRangeCoverages || [];
  const mergedCoverages = previousCoverages
    .filter(({ startAt, endAt }) => !(startAt === nextCoverage.startAt && endAt === nextCoverage.endAt))
    .concat(nextCoverage)
    .sort((left, right) => left.startAt - right.startAt);

  const nextGlobal = {
    ...currentGlobal,
    messages: {
      ...currentGlobal.messages,
      byChatId: {
        ...currentGlobal.messages.byChatId,
        [chatId]: {
          ...currentGlobal.messages.byChatId[chatId],
          threadsById: {
            ...currentGlobal.messages.byChatId[chatId].threadsById,
            [threadId]: {
              ...thread,
              localState: {
                ...thread.localState,
                fetchedMessageRangeCoverages: mergedCoverages,
              },
            },
          },
        },
      },
    },
  };

  const global = nextGlobal;
  setGlobal(global);
  forceUpdateCache();
  return global;
}
