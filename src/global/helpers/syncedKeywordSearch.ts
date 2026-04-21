import type { ThreadId } from '../../types';

import { searchMessageIdsByKeywordFts } from './sqliteFtsStore';
import {
  getSyncedMessagesByIds,
  type NormalizedTimeRange,
  querySyncedMessages,
  type SyncedMessageRecord,
} from './syncedMessagesStore';

type SearchSyncedRecordsByKeywordArgs = {
  chatId: string;
  threadId: ThreadId;
  keyword: string;
  timeRange?: NormalizedTimeRange;
  beforeMessageId?: number;
  senderId?: string;
  maxCount?: number;
  fallbackScanLimit?: number;
  filterFallbackRecord?: (record: SyncedMessageRecord) => boolean;
};

function compareRecordDesc(left: SyncedMessageRecord, right: SyncedMessageRecord) {
  if (left.date !== right.date) {
    return right.date - left.date;
  }

  return right.messageId - left.messageId;
}

function sortRecordsDesc(records: SyncedMessageRecord[]) {
  return records.sort(compareRecordDesc);
}

function normalizePositiveCount(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

export async function searchSyncedRecordsByKeyword(args: SearchSyncedRecordsByKeywordArgs) {
  const normalizedKeyword = args.keyword.trim();
  if (!normalizedKeyword) {
    return [];
  }

  const maxCount = normalizePositiveCount(args.maxCount, 200);
  const fallbackScanLimit = normalizePositiveCount(
    args.fallbackScanLimit,
    Math.min(5000, Math.max(800, maxCount * 8)),
  );
  const maxFallbackScanned = Math.max(fallbackScanLimit * 10, maxCount * 40);

  const readFallbackRecordsBySender = async (senderId?: string) => {
    const collectedByMessageId = new Map<number, SyncedMessageRecord>();
    let nextBeforeMessageId = args.beforeMessageId;
    let scannedCount = 0;

    while (collectedByMessageId.size < maxCount && scannedCount < maxFallbackScanned) {
      const batch = await querySyncedMessages({
        chatId: args.chatId,
        threadId: args.threadId,
        timeRange: args.timeRange,
        beforeMessageId: nextBeforeMessageId,
        senderId,
        maxCount: fallbackScanLimit,
      });
      if (!batch.length) {
        break;
      }

      scannedCount += batch.length;
      const filteredBatch = args.filterFallbackRecord
        ? batch.filter(args.filterFallbackRecord)
        : batch;
      filteredBatch.forEach((record) => {
        collectedByMessageId.set(record.messageId, record);
      });

      if (collectedByMessageId.size >= maxCount) {
        break;
      }

      const oldestMessageId = batch[batch.length - 1]?.messageId;
      if (!oldestMessageId || (nextBeforeMessageId && oldestMessageId >= nextBeforeMessageId)) {
        break;
      }

      nextBeforeMessageId = oldestMessageId;
      if (batch.length < fallbackScanLimit) {
        break;
      }
    }

    return sortRecordsDesc(Array.from(collectedByMessageId.values()))
      .slice(0, maxCount);
  };

  const readFallbackRecords = async () => {
    let records = await readFallbackRecordsBySender(args.senderId);
    if (!records.length && args.senderId) {
      records = await readFallbackRecordsBySender(undefined);
    }

    return records;
  };

  const ftsLookupLimit = Math.min(5000, Math.max(maxCount, maxCount * 8));
  const matchedIds = await searchMessageIdsByKeywordFts({
    chatId: args.chatId,
    keyword: normalizedKeyword,
    threadId: args.threadId,
    senderId: args.senderId,
    startSec: args.timeRange?.startSec,
    endSec: args.timeRange?.endSec,
    beforeMessageId: args.beforeMessageId,
    limit: ftsLookupLimit,
  });

  if (matchedIds?.length) {
    const ftsRecords = sortRecordsDesc(await getSyncedMessagesByIds(args.chatId, matchedIds))
      .slice(0, maxCount);
    const shouldFallback = ftsRecords.length < Math.min(matchedIds.length, maxCount);

    if (!shouldFallback) {
      return ftsRecords;
    }

    const fallbackRecords = await readFallbackRecords();
    if (!ftsRecords.length) {
      return fallbackRecords;
    }

    const mergedByMessageId = new Map<number, SyncedMessageRecord>();
    ftsRecords.forEach((record) => mergedByMessageId.set(record.messageId, record));
    fallbackRecords.forEach((record) => mergedByMessageId.set(record.messageId, record));

    return sortRecordsDesc(Array.from(mergedByMessageId.values()))
      .slice(0, maxCount);
  }

  return readFallbackRecords();
}

export type { SearchSyncedRecordsByKeywordArgs };
