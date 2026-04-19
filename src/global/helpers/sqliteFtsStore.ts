import sqlWasmPath from 'sql.js/dist/sql-wasm.wasm';

import { MAIN_THREAD_ID } from '../../api/types';

import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { MAIN_IDB_STORE } from '../../util/browser/idb';

type FtsIndexRecord = {
  chatId: string;
  messageId: number;
  threadId: number | string;
  date: number;
  senderId?: string;
  sender?: string;
  text: string;
};

type FtsSearchArgs = {
  chatId: string;
  keyword: string;
  threadId?: number | string;
  senderId?: string;
  startSec?: number;
  endSec?: number;
  beforeMessageId?: number;
  limit: number;
};

type FtsDeleteArgs = {
  chatId: string;
  threadId?: number | string;
};

type FtsEngine = {
  upsert: (records: FtsIndexRecord[]) => Promise<void>;
  search: (args: FtsSearchArgs) => Promise<number[]>;
  removeByChat: (args: FtsDeleteArgs) => Promise<void>;
};

const WEB_FTS_DB_BINARY_KEY = 'history_fts_sqlite_binary_v1';
const TAURI_FTS_DB_URL = 'sqlite:history_fts.db';
const WEB_PERSIST_DEBOUNCE_MS = 1200;
const IS_TEST_ENV = typeof process !== 'undefined'
  && (process.env?.APP_ENV === 'test' || process.env?.NODE_ENV === 'test');

let enginePromise: Promise<FtsEngine | undefined> | undefined;
let webPersistTimeout: number | undefined;
let webPersistInFlight = false;

const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  chat_id UNINDEXED,
  message_id UNINDEXED,
  thread_id UNINDEXED,
  date UNINDEXED,
  sender_id UNINDEXED,
  sender,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const UPSERT_DELETE_SQL = `
DELETE FROM history_fts
WHERE chat_id = ? AND message_id = ?;
`;

const UPSERT_INSERT_SQL = `
INSERT INTO history_fts (
  chat_id,
  message_id,
  thread_id,
  date,
  sender_id,
  sender,
  text
) VALUES (?, ?, ?, ?, ?, ?, ?);
`;

function buildMatchQuery(keyword: string) {
  const tokens = keyword
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (!tokens.length) {
    return undefined;
  }

  return tokens
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' AND ');
}

function toPositiveLimit(limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 100;
  }

  return Math.max(1, Math.floor(limit));
}

function shouldFilterByThreadId(threadId: number | string | undefined) {
  return threadId !== undefined && threadId !== MAIN_THREAD_ID;
}

function buildDeleteByChatStatement(args: FtsDeleteArgs) {
  const whereChunks = ['chat_id = ?'];
  const params: unknown[] = [args.chatId];

  if (shouldFilterByThreadId(args.threadId)) {
    whereChunks.push('thread_id = ?');
    params.push(String(args.threadId));
  }

  return {
    sql: `DELETE FROM history_fts WHERE ${whereChunks.join(' AND ')};`,
    params,
  };
}

function normalizeMessageIds(rows: Record<string, unknown>[]) {
  const ids = rows
    .map((row) => Number(row.message_id))
    .filter((id) => Number.isFinite(id) && id > 0);

  const unique = new Set<number>();
  ids.forEach((id) => unique.add(id));

  return Array.from(unique);
}

function scheduleWebDbPersist(save: () => Promise<void>) {
  if (webPersistInFlight) {
    return;
  }

  if (webPersistTimeout) {
    clearTimeout(webPersistTimeout);
  }

  webPersistTimeout = self.setTimeout(() => {
    webPersistTimeout = undefined;
    webPersistInFlight = true;
    void save()
      .catch(() => undefined)
      .finally(() => {
        webPersistInFlight = false;
      });
  }, WEB_PERSIST_DEBOUNCE_MS);
}

async function createWebEngine(): Promise<FtsEngine | undefined> {
  try {
    const sqlJs = await import('sql.js');
    const initSqlJs = sqlJs.default as (args?: { locateFile?: (file: string) => string }) => Promise<any>;
    const SQL = await initSqlJs({
      locateFile: (file) => (file.endsWith('.wasm') ? sqlWasmPath : file),
    });
    const binary = await MAIN_IDB_STORE.get<Uint8Array>(WEB_FTS_DB_BINARY_KEY);
    const db = binary ? new SQL.Database(binary) : new SQL.Database();

    db.run(FTS_SCHEMA_SQL);

    const persist = async () => {
      const exported = db.export();
      await MAIN_IDB_STORE.set(WEB_FTS_DB_BINARY_KEY, exported);
    };

    const selectRows = (sql: string, params: unknown[]) => {
      const statement = db.prepare(sql, params);
      const rows: Record<string, unknown>[] = [];
      try {
        while (statement.step()) {
          rows.push(statement.getAsObject());
        }
      } finally {
        statement.free();
      }

      return rows;
    };

    return {
      upsert: (records) => {
        if (!records.length) {
          return Promise.resolve();
        }

        db.run('BEGIN');
        try {
          records.forEach((record) => {
            db.run(UPSERT_DELETE_SQL, [record.chatId, record.messageId]);
            db.run(UPSERT_INSERT_SQL, [
              record.chatId,
              record.messageId,
              record.threadId,
              record.date,
              record.senderId || '',
              record.sender || '',
              record.text,
            ]);
          });
          db.run('COMMIT');
        } catch (error) {
          db.run('ROLLBACK');
          throw error;
        }

        scheduleWebDbPersist(persist);
        return Promise.resolve();
      },
      search: (args) => {
        const matchQuery = buildMatchQuery(args.keyword);
        if (!matchQuery) {
          return Promise.resolve([]);
        }

        const whereChunks = [
          'history_fts MATCH ?',
          'chat_id = ?',
        ];
        const params: unknown[] = [matchQuery, args.chatId];

        if (shouldFilterByThreadId(args.threadId)) {
          whereChunks.push('thread_id = ?');
          params.push(String(args.threadId));
        }

        if (args.senderId) {
          whereChunks.push('sender_id = ?');
          params.push(args.senderId);
        }

        if (args.startSec !== undefined) {
          whereChunks.push('date >= ?');
          params.push(args.startSec);
        }
        if (args.endSec !== undefined) {
          whereChunks.push('date < ?');
          params.push(args.endSec);
        }
        if (args.beforeMessageId !== undefined) {
          whereChunks.push('message_id < ?');
          params.push(args.beforeMessageId);
        }

        params.push(toPositiveLimit(args.limit));

        const rows = selectRows(`
SELECT message_id AS message_id
FROM history_fts
WHERE ${whereChunks.join(' AND ')}
ORDER BY date DESC, message_id DESC
LIMIT ?;
`, params);

        return Promise.resolve(normalizeMessageIds(rows));
      },
      removeByChat: (args) => {
        const statement = buildDeleteByChatStatement(args);
        db.run(statement.sql, statement.params);
        scheduleWebDbPersist(persist);
        return Promise.resolve();
      },
    };
  } catch {
    return undefined;
  }
}

async function createTauriEngine(): Promise<FtsEngine | undefined> {
  try {
    const sqlPlugin = await import('@tauri-apps/plugin-sql');
    const Database = sqlPlugin.default as {
      load: (path: string) => Promise<{
        execute: (sql: string, params?: unknown[]) => Promise<unknown>;
        select: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
      }>;
    };
    const db = await Database.load(TAURI_FTS_DB_URL);

    await db.execute(FTS_SCHEMA_SQL);

    return {
      upsert: async (records) => {
        if (!records.length) {
          return;
        }

        await db.execute('BEGIN');
        try {
          for (const record of records) {
            await db.execute(UPSERT_DELETE_SQL, [record.chatId, record.messageId]);
            await db.execute(UPSERT_INSERT_SQL, [
              record.chatId,
              record.messageId,
              String(record.threadId),
              record.date,
              record.senderId || '',
              record.sender || '',
              record.text,
            ]);
          }
          await db.execute('COMMIT');
        } catch (error) {
          await db.execute('ROLLBACK');
          throw error;
        }
      },
      search: async (args) => {
        const matchQuery = buildMatchQuery(args.keyword);
        if (!matchQuery) {
          return [];
        }

        const whereChunks = [
          'history_fts MATCH ?',
          'chat_id = ?',
        ];
        const params: unknown[] = [matchQuery, args.chatId];

        if (shouldFilterByThreadId(args.threadId)) {
          whereChunks.push('thread_id = ?');
          params.push(String(args.threadId));
        }

        if (args.senderId) {
          whereChunks.push('sender_id = ?');
          params.push(args.senderId);
        }

        if (args.startSec !== undefined) {
          whereChunks.push('date >= ?');
          params.push(args.startSec);
        }
        if (args.endSec !== undefined) {
          whereChunks.push('date < ?');
          params.push(args.endSec);
        }
        if (args.beforeMessageId !== undefined) {
          whereChunks.push('message_id < ?');
          params.push(args.beforeMessageId);
        }

        params.push(toPositiveLimit(args.limit));

        const rows = await db.select<Record<string, unknown>>(`
SELECT message_id AS message_id
FROM history_fts
WHERE ${whereChunks.join(' AND ')}
ORDER BY date DESC, message_id DESC
LIMIT ?;
`, params);

        return normalizeMessageIds(rows);
      },
      removeByChat: async (args) => {
        const statement = buildDeleteByChatStatement(args);
        await db.execute(statement.sql, statement.params);
      },
    };
  } catch {
    return undefined;
  }
}

async function getEngine() {
  if (IS_TEST_ENV || typeof fetch === 'undefined') {
    return undefined;
  }

  if (!enginePromise) {
    enginePromise = (IS_TAURI ? createTauriEngine() : createWebEngine())
      .catch(() => undefined);
  }

  return enginePromise;
}

export async function upsertMessagesInFts(records: FtsIndexRecord[]) {
  if (!records.length) {
    return;
  }

  const engine = await getEngine();
  if (!engine) {
    return;
  }

  await engine.upsert(records);
}

export async function searchMessageIdsByKeywordFts(args: FtsSearchArgs) {
  if (!args.keyword.trim()) {
    return undefined;
  }

  const engine = await getEngine();
  if (!engine) {
    return undefined;
  }

  return engine.search(args);
}

export async function removeMessagesByChatFromFts(args: FtsDeleteArgs) {
  const engine = await getEngine();
  if (!engine) {
    return;
  }

  await engine.removeByChat(args);
}

export type { FtsDeleteArgs, FtsIndexRecord, FtsSearchArgs };
