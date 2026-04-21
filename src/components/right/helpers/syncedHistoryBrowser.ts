import type { ApiMessage } from '../../../api/types';
import type { TimeRangeBoundsSec } from '../../../global/helpers/chatSync';
import type { GlobalState } from '../../../global/types';
import type { ThreadId } from '../../../types';

import { getMessageSummaryText } from '../../../global/helpers/messageSummary';
import { getPeerTitle } from '../../../global/helpers/peers';
import { searchSyncedRecordsByKeyword } from '../../../global/helpers/syncedKeywordSearch';
import {
  listSyncedMessageDays,
  querySyncedMessages,
} from '../../../global/helpers/syncedMessagesStore';
import { selectSender } from '../../../global/selectors/messages';
import { getTranslationFn } from '../../../util/localization';

export type SyncedHistoryDayItem = {
  dayKey: string;
  dayStartSec: number;
  count: number;
  label: string;
};

export type SyncedHistoryMessageItem = {
  messageId: number;
  date: number;
  dayKey: string;
  dayStartSec: number;
  dayLabel: string;
  timeText: string;
  sender: string;
  text: string;
};

function resolveMessageSenderLabel(global: GlobalState, message: ApiMessage) {
  if (message.isOutgoing || (message.senderId && String(message.senderId) === global.currentUserId)) {
    return '我';
  }

  const sender = selectSender(global, message);
  if (sender) {
    return getPeerTitle(getTranslationFn(), sender) || String(sender.id);
  }

  return message.senderId ? String(message.senderId) : '未知用户';
}

function formatDayLabel(dayStartSec: number) {
  const day = new Date(dayStartSec * 1000);
  const year = day.getFullYear();
  const month = String(day.getMonth() + 1).padStart(2, '0');
  const date = String(day.getDate()).padStart(2, '0');

  return `${year}-${month}-${date}`;
}

function resolveDayInfo(dateSec: number) {
  const date = new Date(dateSec * 1000);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const year = dayStart.getFullYear();
  const month = String(dayStart.getMonth() + 1).padStart(2, '0');
  const day = String(dayStart.getDate()).padStart(2, '0');
  const dayStartSec = Math.floor(dayStart.getTime() / 1000);

  return {
    dayKey: `${year}-${month}-${day}`,
    dayStartSec,
    dayLabel: formatDayLabel(dayStartSec),
  };
}

function mapSyncedHistoryMessageItem(global: GlobalState, messageId: number, date: number, message: ApiMessage) {
  const summary = getMessageSummaryText(getTranslationFn(), message, undefined, true, 500).trim();
  const dayInfo = resolveDayInfo(date);

  return {
    messageId,
    date,
    ...dayInfo,
    timeText: new Date(date * 1000).toLocaleTimeString(),
    sender: resolveMessageSenderLabel(global, message),
    text: summary || '暂不支持预览这条消息',
  };
}

export async function loadSyncedHistoryDays(args: {
  chatId: string;
  threadId: ThreadId;
  timeRange?: TimeRangeBoundsSec;
}) {
  const days = await listSyncedMessageDays(args);

  return days
    .slice()
    .sort((left, right) => right.dayStartSec - left.dayStartSec)
    .map((day) => ({
      dayKey: day.dayKey,
      dayStartSec: day.dayStartSec,
      count: day.count,
      label: formatDayLabel(day.dayStartSec),
    }));
}

export async function loadSyncedHistoryMessages(args: {
  global: GlobalState;
  chatId: string;
  threadId: ThreadId;
  dayStartSec: number;
}) {
  const { global, chatId, threadId, dayStartSec } = args;
  const records = await querySyncedMessages({
    chatId,
    threadId,
    timeRange: {
      startSec: dayStartSec,
      endSec: dayStartSec + 24 * 60 * 60,
    },
    maxCount: Number.MAX_SAFE_INTEGER,
  });

  return records
    .slice()
    .sort((left, right) => (
      left.date !== right.date ? left.date - right.date : left.messageId - right.messageId
    ))
    .map(({ message, messageId, date }) => mapSyncedHistoryMessageItem(global, messageId, date, message));
}

export async function loadSyncedHistorySearchMessages(args: {
  global: GlobalState;
  chatId: string;
  threadId: ThreadId;
  keyword: string;
  timeRange?: TimeRangeBoundsSec;
  maxCount?: number;
}) {
  const {
    global,
    chatId,
    keyword,
    threadId,
    timeRange,
    maxCount = 200,
  } = args;
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    return [];
  }
  const lowerKeyword = normalizedKeyword.toLowerCase();

  const matchesKeyword = (message: SyncedHistoryMessageItem) => {
    return (
      message.text.toLowerCase().includes(lowerKeyword)
      || message.sender.toLowerCase().includes(lowerKeyword)
      || message.dayKey.toLowerCase().includes(lowerKeyword)
      || message.dayLabel.toLowerCase().includes(lowerKeyword)
      || message.timeText.toLowerCase().includes(lowerKeyword)
    );
  };

  const records = await searchSyncedRecordsByKeyword({
    chatId,
    keyword: normalizedKeyword,
    threadId,
    timeRange,
    maxCount,
    filterFallbackRecord: (record) => {
      const item = mapSyncedHistoryMessageItem(global, record.messageId, record.date, record.message);
      return matchesKeyword(item);
    },
  });

  return records
    .map(({ message, messageId, date }) => mapSyncedHistoryMessageItem(global, messageId, date, message))
    .sort((left, right) => (
      right.date !== left.date ? right.date - left.date : right.messageId - left.messageId
    ))
    .slice(0, maxCount);
}
