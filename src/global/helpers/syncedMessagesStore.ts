import type { ApiMessage } from '../../api/types';
import type { ThreadId } from '../../types';
import type { GlobalState } from '../types';
import { MAIN_THREAD_ID } from '../../api/types';

import { getTranslationFn } from '../../util/localization';
import { pause } from '../../util/schedulers';
import { selectSender } from '../selectors/messages';
import { selectThreadIdFromMessage } from '../selectors/threads';
import { getPeerTitle } from './peers';
import {
  type FtsIndexRecord,
  removeMessagesByChatFromFts,
  upsertMessagesInFts,
} from './sqliteFtsStore';

type NormalizedTimeRange = {
  startSec: number;
  endSec: number;
};

type SyncedMessageRecord = {
  key: string;
  chatId: string;
  messageId: number;
  date: number;
  threadId: ThreadId;
  senderId?: string;
  message: ApiMessage;
};

type QuerySyncedMessagesArgs = {
  chatId: string;
  threadId?: ThreadId;
  timeRange?: NormalizedTimeRange;
  beforeMessageId?: number;
  senderId?: string;
  maxCount?: number;
};

type SyncedMessagesStats = {
  count: number;
  oldestDate?: number;
  newestDate?: number;
};

type SyncedMessageDaySummary = {
  dayKey: string;
  dayStartSec: number;
  count: number;
  oldestDate: number;
  newestDate: number;
};

type SyncedMessagesMigrationState = {
  version: number;
  completedAt: number;
  migratedChats: number;
  migratedMessages: number;
  indexedChats: number;
  indexedMessages: number;
};

const DB_NAME = 'tt-synced-history';
const DB_VERSION = 2;
const STORE_NAME = 'syncedMessages';
const META_STORE_NAME = 'meta';
const INDEX_CHAT_DATE = 'byChatDate';
const INDEX_CHAT_THREAD_DATE = 'byChatThreadDate';
const INDEX_CHAT_SENDER_DATE = 'byChatSenderDate';
const MIN_MESSAGE_ID = 0;
const MAX_KEY_NUMBER = Number.MAX_SAFE_INTEGER;
const MIGRATION_VERSION = 2;
const DEFAULT_BACKFILL_BATCH_SIZE = 1000;

let syncedMessagesDbPromise: Promise<IDBDatabase> | undefined;
const activeMigrationPromises = new Map<string, Promise<SyncedMessagesMigrationState>>();

function getIdbFactory() {
  return globalThis.indexedDB;
}

function buildRecordKey(chatId: string, messageId: number) {
  return `${chatId}:${messageId}`;
}

function buildMigrationMetaKey(currentUserId: string | undefined) {
  return `migration:${MIGRATION_VERSION}:${currentUserId || 'unknown-user'}`;
}

function resolveStoredSenderId(global: GlobalState, message: ApiMessage) {
  if (message.senderId) {
    return String(message.senderId);
  }

  if (message.isOutgoing) {
    return global.currentUserId;
  }

  const sender = selectSender(global, message);
  return sender?.id ? String(sender.id) : undefined;
}

function resolveStoredSenderSearchText(global: GlobalState, message: ApiMessage) {
  const sender = selectSender(global, message);
  const senderId = resolveStoredSenderId(global, message);
  const senderTitle = sender ? getPeerTitle(getTranslationFn(), sender) : undefined;
  const usernames = sender?.usernames
    ?.map((item) => item.username?.trim())
    .filter((value): value is string => Boolean(value));

  const chunks = [
    senderId,
    senderTitle,
    ...(usernames || []),
    ...(usernames || []).map((username) => `@${username}`),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return chunks.join(' ');
}

function extractRecordText(message: ApiMessage) {
  const textContent = message.content as Record<string, unknown>;
  const textPart = (textContent.text as { text?: string } | undefined)?.text || '';
  const documentName = (textContent.document as { fileName?: string } | undefined)?.fileName || '';
  const pollQuestion = (textContent.poll as { summary?: { question?: { text?: string } } } | undefined)
    ?.summary?.question?.text || '';

  const chunks = [textPart, documentName, pollQuestion]
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return chunks.join('\n');
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionToPromise(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

async function getSyncedMessagesDatabase() {
  const indexedDb = getIdbFactory();
  if (!indexedDb) {
    throw new Error('IndexedDB is not available');
  }

  if (!syncedMessagesDbPromise) {
    syncedMessagesDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction!.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        if (!database.objectStoreNames.contains(META_STORE_NAME)) {
          database.createObjectStore(META_STORE_NAME);
        }

        if (!store.indexNames.contains(INDEX_CHAT_DATE)) {
          store.createIndex(INDEX_CHAT_DATE, ['chatId', 'date', 'messageId'], { unique: false });
        }
        if (!store.indexNames.contains(INDEX_CHAT_THREAD_DATE)) {
          store.createIndex(INDEX_CHAT_THREAD_DATE, ['chatId', 'threadId', 'date', 'messageId'], { unique: false });
        }
        if (!store.indexNames.contains(INDEX_CHAT_SENDER_DATE)) {
          store.createIndex(INDEX_CHAT_SENDER_DATE, ['chatId', 'senderId', 'date', 'messageId'], { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        syncedMessagesDbPromise = undefined;
        reject(request.error || new Error('Failed to open synced message store'));
      };
      request.onblocked = () => reject(new Error('Synced message store upgrade blocked'));
    });
  }

  return syncedMessagesDbPromise;
}

function normalizeMaxCount(maxCount?: number) {
  if (!Number.isFinite(maxCount) || !maxCount || maxCount <= 0) {
    return MAX_KEY_NUMBER;
  }

  return Math.max(1, Math.floor(maxCount));
}

function buildQueryRange(args: QuerySyncedMessagesArgs) {
  const { chatId, senderId, threadId, timeRange } = args;
  const startDate = timeRange?.startSec ?? 0;
  const endDate = timeRange ? Math.max(startDate, timeRange.endSec - 1) : MAX_KEY_NUMBER;

  if (senderId) {
    return {
      indexName: INDEX_CHAT_SENDER_DATE,
      keyRange: IDBKeyRange.bound(
        [chatId, senderId, startDate, MIN_MESSAGE_ID],
        [chatId, senderId, endDate, MAX_KEY_NUMBER],
      ),
    };
  }

  if (threadId !== undefined && threadId !== MAIN_THREAD_ID) {
    return {
      indexName: INDEX_CHAT_THREAD_DATE,
      keyRange: IDBKeyRange.bound(
        [chatId, threadId, startDate, MIN_MESSAGE_ID],
        [chatId, threadId, endDate, MAX_KEY_NUMBER],
      ),
    };
  }

  return {
    indexName: INDEX_CHAT_DATE,
    keyRange: IDBKeyRange.bound(
      [chatId, startDate, MIN_MESSAGE_ID],
      [chatId, endDate, MAX_KEY_NUMBER],
    ),
  };
}

function normalizeRecord(message: ApiMessage, chatId: string, global: GlobalState): SyncedMessageRecord | undefined {
  if (!Number.isFinite(message.id) || message.id <= 0 || !Number.isFinite(message.date)) {
    return undefined;
  }

  return {
    key: buildRecordKey(chatId, message.id),
    chatId,
    messageId: message.id,
    date: message.date,
    threadId: selectThreadIdFromMessage(global, message),
    senderId: resolveStoredSenderId(global, message),
    message,
  };
}

function getLocalDaySummary(dateSec: number) {
  const date = new Date(dateSec * 1000);
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const year = dayStart.getFullYear();
  const month = String(dayStart.getMonth() + 1).padStart(2, '0');
  const day = String(dayStart.getDate()).padStart(2, '0');

  return {
    dayKey: `${year}-${month}-${day}`,
    dayStartSec: Math.floor(dayStart.getTime() / 1000),
  };
}

function toFtsRecord(global: GlobalState, record: SyncedMessageRecord): FtsIndexRecord {
  const text = extractRecordText(record.message);
  const senderSearchText = resolveStoredSenderSearchText(global, record.message);

  return {
    chatId: record.chatId,
    messageId: record.messageId,
    threadId: record.threadId,
    date: record.date,
    senderId: record.senderId,
    sender: senderSearchText || record.senderId,
    text,
  };
}

function toFtsRecordFromStoredRecord(record: SyncedMessageRecord): FtsIndexRecord | undefined {
  if (!record.chatId || !Number.isFinite(record.messageId) || record.messageId <= 0) {
    return undefined;
  }

  const date = Number.isFinite(record.date)
    ? record.date
    : record.message?.date;
  if (!Number.isFinite(date) || date <= 0) {
    return undefined;
  }

  const text = extractRecordText(record.message);

  return {
    chatId: record.chatId,
    messageId: record.messageId,
    threadId: record.threadId ?? MAIN_THREAD_ID,
    date,
    senderId: record.senderId,
    sender: record.senderId,
    text,
  };
}

async function readSyncedMessagesBatch(afterKey: string | undefined, limit: number) {
  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const keyRange = afterKey ? IDBKeyRange.lowerBound(afterKey, true) : undefined;
  const records: SyncedMessageRecord[] = [];
  let lastKey: string | undefined;

  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor(keyRange, 'next');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      const record = cursor.value as SyncedMessageRecord;
      if (record) {
        records.push(record);
      }

      const primaryKey = cursor.primaryKey;
      lastKey = typeof primaryKey === 'string' ? primaryKey : record?.key;
      if (records.length >= limit) {
        resolve();
        return;
      }

      cursor.continue();
    };

    request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });

  await transactionToPromise(transaction);

  return {
    records,
    lastKey,
  };
}

export async function persistSyncedMessagesForChat(
  global: GlobalState,
  chatId: string,
  messages?: ApiMessage[],
) {
  if (!messages?.length || !getIdbFactory()) {
    return;
  }

  const records = messages
    .map((message) => normalizeRecord(message, chatId, global))
    .filter((record): record is SyncedMessageRecord => Boolean(record));

  if (!records.length) {
    return;
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);

  records.forEach((record) => {
    store.put(record);
  });

  await transactionToPromise(transaction);
  await upsertMessagesInFts(records.map((record) => toFtsRecord(global, record)))
    .catch(() => undefined);
}

export async function querySyncedMessages(args: QuerySyncedMessagesArgs): Promise<SyncedMessageRecord[]> {
  if (!getIdbFactory()) {
    return [];
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const { indexName, keyRange } = buildQueryRange(args);
  const index = store.index(indexName);
  const maxCount = normalizeMaxCount(args.maxCount);
  const beforeMessageId = args.beforeMessageId;
  const records: SyncedMessageRecord[] = [];

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(keyRange, 'prev');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      const record = cursor.value as SyncedMessageRecord;
      if (beforeMessageId && record.messageId >= beforeMessageId) {
        cursor.continue();
        return;
      }

      records.push(record);
      if (records.length >= maxCount) {
        resolve();
        return;
      }

      cursor.continue();
    };

    request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });

  return records;
}

async function readBoundaryRecord(
  index: IDBIndex,
  keyRange: IDBKeyRange,
  direction: IDBCursorDirection,
): Promise<SyncedMessageRecord | undefined> {
  return new Promise((resolve, reject) => {
    const request = index.openCursor(keyRange, direction);

    request.onsuccess = () => {
      const cursor = request.result;
      resolve(cursor ? cursor.value as SyncedMessageRecord : undefined);
    };

    request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
  });
}

export async function getSyncedMessagesStats(args: QuerySyncedMessagesArgs): Promise<SyncedMessagesStats> {
  if (!getIdbFactory()) {
    return {
      count: 0,
    };
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const { indexName, keyRange } = buildQueryRange(args);
  const index = store.index(indexName);

  const countRequest = index.count(keyRange);
  const countPromise = requestToPromise(countRequest);
  const oldestPromise = readBoundaryRecord(index, keyRange, 'next');
  const newestPromise = readBoundaryRecord(index, keyRange, 'prev');

  const [count, oldestRecord, newestRecord] = await Promise.all([
    countPromise,
    oldestPromise,
    newestPromise,
  ]);

  await transactionToPromise(transaction);

  return {
    count,
    oldestDate: oldestRecord?.date,
    newestDate: newestRecord?.date,
  };
}

export async function listSyncedMessageDays(args: QuerySyncedMessagesArgs): Promise<SyncedMessageDaySummary[]> {
  if (!getIdbFactory()) {
    return [];
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const { indexName, keyRange } = buildQueryRange(args);
  const index = store.index(indexName);
  const beforeMessageId = args.beforeMessageId;
  const days: SyncedMessageDaySummary[] = [];
  const dayByKey = new Map<string, SyncedMessageDaySummary>();

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(keyRange, 'prev');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      const record = cursor.value as SyncedMessageRecord;
      if (beforeMessageId && record.messageId >= beforeMessageId) {
        cursor.continue();
        return;
      }

      const { dayKey, dayStartSec } = getLocalDaySummary(record.date);
      const existing = dayByKey.get(dayKey);

      if (existing) {
        existing.count += 1;
        existing.oldestDate = Math.min(existing.oldestDate, record.date);
        existing.newestDate = Math.max(existing.newestDate, record.date);
      } else {
        const summary: SyncedMessageDaySummary = {
          dayKey,
          dayStartSec,
          count: 1,
          oldestDate: record.date,
          newestDate: record.date,
        };
        dayByKey.set(dayKey, summary);
        days.push(summary);
      }

      cursor.continue();
    };

    request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });

  await transactionToPromise(transaction);

  return days
    .slice()
    .sort((left, right) => right.dayStartSec - left.dayStartSec);
}

export async function clearSyncedMessagesStore() {
  if (!getIdbFactory()) {
    return;
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction([STORE_NAME, META_STORE_NAME], 'readwrite');
  transaction.objectStore(STORE_NAME).clear();
  transaction.objectStore(META_STORE_NAME).clear();
  await transactionToPromise(transaction);
}

export async function clearSyncedMessagesForChat(args: {
  chatId: string;
  threadId?: ThreadId;
}) {
  if (!getIdbFactory()) {
    return;
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const { indexName, keyRange } = buildQueryRange({
    chatId: args.chatId,
    threadId: args.threadId,
  });
  const index = store.index(indexName);
  let deletedCount = 0;

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(keyRange, 'next');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      cursor.delete();
      deletedCount += 1;
      cursor.continue();
    };

    request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });

  await transactionToPromise(transaction);

  let ftsCleared = true;
  try {
    await removeMessagesByChatFromFts({
      chatId: args.chatId,
      threadId: args.threadId,
    });
  } catch (error) {
    ftsCleared = false;
    // Keep primary IndexedDB clear successful even when FTS cleanup fails.
    // Search layer will fall back to non-FTS path when needed.
    // eslint-disable-next-line no-console
    console.error('[syncedMessagesStore] Failed to clear FTS records for chat', args.chatId, error);
  }

  return {
    deletedCount,
    ftsCleared,
  };
}

export async function getSyncedMessageById(chatId: string, messageId: number) {
  if (!getIdbFactory()) {
    return undefined;
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const result = await requestToPromise(store.get(buildRecordKey(chatId, messageId)));
  await transactionToPromise(transaction);
  return result as SyncedMessageRecord | undefined;
}

export async function getSyncedMessagesByIds(chatId: string, messageIds: number[]) {
  if (!getIdbFactory() || !messageIds.length) {
    return [];
  }

  const uniqueIds = Array.from(new Set(
    messageIds.filter((id) => Number.isFinite(id) && id > 0),
  ));
  if (!uniqueIds.length) {
    return [];
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);

  const byId = new Map<number, SyncedMessageRecord>();
  await Promise.all(
    uniqueIds.map(async (messageId) => {
      const record = await requestToPromise(
        store.get(buildRecordKey(chatId, messageId)),
      ) as SyncedMessageRecord | undefined;
      if (record) {
        byId.set(record.messageId, record);
      }
    }),
  );

  await transactionToPromise(transaction);

  return messageIds
    .map((messageId) => byId.get(messageId))
    .filter((record): record is SyncedMessageRecord => Boolean(record));
}

async function loadMigrationState(currentUserId: string | undefined) {
  if (!getIdbFactory()) {
    return undefined;
  }

  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(META_STORE_NAME, 'readonly');
  const state = await requestToPromise(
    transaction.objectStore(META_STORE_NAME).get(buildMigrationMetaKey(currentUserId)),
  );
  await transactionToPromise(transaction);
  return state as SyncedMessagesMigrationState | undefined;
}

async function saveMigrationState(currentUserId: string | undefined, state: SyncedMessagesMigrationState) {
  const database = await getSyncedMessagesDatabase();
  const transaction = database.transaction(META_STORE_NAME, 'readwrite');
  transaction.objectStore(META_STORE_NAME).put(state, buildMigrationMetaKey(currentUserId));
  await transactionToPromise(transaction);
}

export async function backfillSyncedMessagesFromGlobal(
  global: GlobalState,
  batchSize = DEFAULT_BACKFILL_BATCH_SIZE,
) {
  if (!getIdbFactory()) {
    return {
      migratedChats: 0,
      migratedMessages: 0,
    };
  }

  let migratedChats = 0;
  let migratedMessages = 0;
  const normalizedBatchSize = Math.max(1, Math.floor(batchSize));

  for (const [chatId, chatMessages] of Object.entries(global.messages.byChatId || {})) {
    const messages = Object.values(chatMessages.byId || {})
      .filter((message): message is ApiMessage => Boolean(message));

    if (!messages.length) {
      continue;
    }

    migratedChats += 1;
    for (let index = 0; index < messages.length; index += normalizedBatchSize) {
      const batch = messages.slice(index, index + normalizedBatchSize);
      migratedMessages += batch.length;
      await persistSyncedMessagesForChat(global, chatId, batch);
      await pause(0);
    }
  }

  return {
    migratedChats,
    migratedMessages,
  };
}

export async function backfillFtsFromSyncedMessages(
  batchSize = DEFAULT_BACKFILL_BATCH_SIZE,
) {
  if (!getIdbFactory()) {
    return {
      indexedChats: 0,
      indexedMessages: 0,
    };
  }

  const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
  const indexedChats = new Set<string>();
  let indexedMessages = 0;
  let afterKey: string | undefined;

  // Iterate in pages to avoid loading all records into memory at once.
  while (true) {
    const { records, lastKey } = await readSyncedMessagesBatch(afterKey, normalizedBatchSize);
    if (!records.length) {
      break;
    }

    const ftsRecords = records
      .map((record) => toFtsRecordFromStoredRecord(record))
      .filter((record): record is FtsIndexRecord => Boolean(record));
    if (ftsRecords.length) {
      await upsertMessagesInFts(ftsRecords).catch(() => undefined);
      ftsRecords.forEach(({ chatId }) => indexedChats.add(chatId));
      indexedMessages += ftsRecords.length;
    }

    if (!lastKey || records.length < normalizedBatchSize) {
      break;
    }

    afterKey = lastKey;
    await pause(0);
  }

  return {
    indexedChats: indexedChats.size,
    indexedMessages,
  };
}

export async function ensureSyncedMessagesMigration(global: GlobalState) {
  if (!getIdbFactory()) {
    return undefined;
  }

  const currentUserId = global.currentUserId;
  const activeKey = buildMigrationMetaKey(currentUserId);
  const existingPromise = activeMigrationPromises.get(activeKey);
  if (existingPromise) {
    return existingPromise;
  }

  const migrationPromise = (async () => {
    const existingState = await loadMigrationState(currentUserId);
    if (existingState?.version === MIGRATION_VERSION) {
      return existingState;
    }

    const { migratedChats, migratedMessages } = await backfillSyncedMessagesFromGlobal(global);
    const { indexedChats, indexedMessages } = await backfillFtsFromSyncedMessages();
    const nextState: SyncedMessagesMigrationState = {
      version: MIGRATION_VERSION,
      completedAt: Date.now(),
      migratedChats,
      migratedMessages,
      indexedChats,
      indexedMessages,
    };
    await saveMigrationState(currentUserId, nextState);
    return nextState;
  })();

  activeMigrationPromises.set(activeKey, migrationPromise);

  try {
    return await migrationPromise;
  } finally {
    activeMigrationPromises.delete(activeKey);
  }
}

export type {
  NormalizedTimeRange,
  SyncedMessageDaySummary,
  SyncedMessageRecord,
  SyncedMessagesMigrationState,
};
