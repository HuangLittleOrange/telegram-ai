import type { ApiMessage } from '../../../api/types';
import type { TimeRangeBoundsSec } from '../../../global/helpers/chatSync';
import type { GlobalState } from '../../../global/types';
import type { ThreadId } from '../../../types';

import { getMessageSummaryText } from '../../../global/helpers/messageSummary';
import { getPeerTitle } from '../../../global/helpers/peers';
import { searchMessageIdsByKeywordFts } from '../../../global/helpers/sqliteFtsStore';
import {
  getSyncedMessagesByIds,
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
  return new Date(dayStartSec * 1000).toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
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

  return days.map((day) => ({
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

  const messageIds = await searchMessageIdsByKeywordFts({
    chatId,
    keyword: normalizedKeyword,
    threadId,
    startSec: timeRange?.startSec,
    endSec: timeRange?.endSec,
    limit: maxCount,
  });

  if (messageIds?.length) {
    const records = await getSyncedMessagesByIds(chatId, messageIds);

    return records
      .map(({ message, messageId, date }) => mapSyncedHistoryMessageItem(global, messageId, date, message))
      .sort((left, right) => (
        right.date !== left.date ? right.date - left.date : right.messageId - left.messageId
      ));
  }

  const records = await querySyncedMessages({
    chatId,
    threadId,
    timeRange,
    maxCount: 5000,
  });

  const lowerKeyword = normalizedKeyword.toLowerCase();

  return records
    .map(({ message, messageId, date }) => mapSyncedHistoryMessageItem(global, messageId, date, message))
    .filter((message) => (
      message.text.toLowerCase().includes(lowerKeyword)
      || message.sender.toLowerCase().includes(lowerKeyword)
      || message.dayKey.toLowerCase().includes(lowerKeyword)
      || message.dayLabel.toLowerCase().includes(lowerKeyword)
      || message.timeText.toLowerCase().includes(lowerKeyword)
    ))
    .sort((left, right) => (
      right.date !== left.date ? right.date - left.date : right.messageId - left.messageId
    ))
    .slice(0, maxCount);
}
