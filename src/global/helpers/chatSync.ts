import type { TimeRange } from '../types/tabState';

export type TimeRangeBoundsSec = {
  startSec: number;
  endSec: number;
};

type PersistedSyncSnapshotArgs = {
  persistedCount: number;
  oldestDateSec?: number;
  newestDateSec?: number;
  baselineTotalMessages?: number;
  isTotalKnown?: boolean;
};

type PersistedSyncSnapshot = {
  syncedMessages: number;
  totalMessages?: number;
  unsyncedMessages: number;
  oldestSyncedDate?: number;
  newestSyncedDate?: number;
};

type ResolveFinalSyncStatusArgs = {
  currentStatus: 'idle' | 'syncing' | 'paused' | 'completed' | 'error';
  takeoutSuccess: boolean;
  hadRuntimeError?: boolean;
};

export function resolveTimeRangeBoundsSec(timeRange?: TimeRange): TimeRangeBoundsSec | undefined {
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
      endSec: Math.floor(endOfDay.getTime() / 1000),
    };
  }

  if (timeRange.value === 'yesterday') {
    const yesterdayStart = new Date(startOfDay);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    return {
      startSec: Math.floor(yesterdayStart.getTime() / 1000),
      endSec: Math.floor(startOfDay.getTime() / 1000),
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
      endSec: Math.floor(nextWeekStart.getTime() / 1000),
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
      endSec: Math.floor(currentWeekStart.getTime() / 1000),
    };
  }

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return {
    startSec: Math.floor(monthStart.getTime() / 1000),
    endSec: Math.floor(nextMonthStart.getTime() / 1000),
  };
}

export function calculateUnsyncedMessages(totalMessages: number, syncedMessages: number): number {
  return Math.max(0, totalMessages - syncedMessages);
}

export function resolveFinalChatSyncStatus({
  currentStatus,
  takeoutSuccess,
  hadRuntimeError,
}: ResolveFinalSyncStatusArgs): ResolveFinalSyncStatusArgs['currentStatus'] {
  if (currentStatus === 'paused' || currentStatus === 'error') {
    return currentStatus;
  }

  if (takeoutSuccess) {
    return 'completed';
  }

  if (hadRuntimeError) {
    return 'error';
  }

  return currentStatus === 'syncing' ? 'paused' : currentStatus;
}

export function buildPersistedSyncSnapshot({
  persistedCount,
  oldestDateSec,
  newestDateSec,
  baselineTotalMessages,
  isTotalKnown = true,
}: PersistedSyncSnapshotArgs): PersistedSyncSnapshot {
  const syncedMessages = Math.max(0, persistedCount || 0);
  const totalMessages = isTotalKnown
    ? Math.max(baselineTotalMessages || 0, syncedMessages)
    : undefined;

  if (!syncedMessages) {
    return {
      syncedMessages: 0,
      totalMessages,
      unsyncedMessages: totalMessages === undefined ? 0 : calculateUnsyncedMessages(totalMessages, 0),
    };
  }

  return {
    syncedMessages,
    totalMessages,
    unsyncedMessages: totalMessages === undefined ? 0 : calculateUnsyncedMessages(totalMessages, syncedMessages),
    oldestSyncedDate: oldestDateSec ? oldestDateSec * 1000 : undefined,
    newestSyncedDate: newestDateSec ? newestDateSec * 1000 : undefined,
  };
}
