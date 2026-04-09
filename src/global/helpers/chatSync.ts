import type { ApiMessage } from '../../api/types';
import type { TimeRange } from '../types/tabState';

export type TimeRangeBoundsSec = {
  startSec: number;
  endSec: number;
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

export function isMessageInRange(
  messageDateSec: number,
  bounds?: TimeRangeBoundsSec,
): boolean {
  if (!bounds) {
    return true;
  }

  return messageDateSec >= bounds.startSec && messageDateSec < bounds.endSec;
}

export function countMessagesInRange(
  messagesById?: Record<number, ApiMessage>,
  bounds?: TimeRangeBoundsSec,
): number {
  if (!messagesById) {
    return 0;
  }

  const messages = Object.values(messagesById);
  if (!messages.length) {
    return 0;
  }

  return messages.reduce((count, message) => (
    isMessageInRange(message.date, bounds) ? count + 1 : count
  ), 0);
}

export function getOldestMessageDateInRange(
  messagesById?: Record<number, ApiMessage>,
  bounds?: TimeRangeBoundsSec,
): number | undefined {
  if (!messagesById) {
    return undefined;
  }

  let oldestDateSec: number | undefined;
  Object.values(messagesById).forEach((message) => {
    if (!isMessageInRange(message.date, bounds)) {
      return;
    }

    if (oldestDateSec === undefined || message.date < oldestDateSec) {
      oldestDateSec = message.date;
    }
  });

  return oldestDateSec;
}

export function calculateUnsyncedMessages(totalMessages: number, syncedMessages: number): number {
  return Math.max(0, totalMessages - syncedMessages);
}
