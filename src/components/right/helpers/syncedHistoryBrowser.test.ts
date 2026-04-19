import type { GlobalState } from '../../../global/types';

import { loadSyncedHistorySearchMessages } from './syncedHistoryBrowser';

jest.mock('../../../global/helpers/messageSummary', () => ({
  getMessageSummaryText: jest.fn((_lang, message) => message.content?.text?.text || ''),
}));

jest.mock('../../../global/helpers/peers', () => ({
  getPeerTitle: jest.fn(() => ''),
}));

jest.mock('../../../global/selectors/messages', () => ({
  selectSender: jest.fn(() => undefined),
}));

jest.mock('../../../util/localization', () => ({
  getTranslationFn: jest.fn(() => (key: string) => key),
}));

jest.mock('../../../global/helpers/sqliteFtsStore', () => ({
  searchMessageIdsByKeywordFts: jest.fn(),
}));

jest.mock('../../../global/helpers/syncedMessagesStore', () => ({
  getSyncedMessagesByIds: jest.fn(),
  listSyncedMessageDays: jest.fn(),
  querySyncedMessages: jest.fn(),
}));

const { searchMessageIdsByKeywordFts } = jest.requireMock('../../../global/helpers/sqliteFtsStore');

const {
  getSyncedMessagesByIds,
  querySyncedMessages,
} = jest.requireMock('../../../global/helpers/syncedMessagesStore');

function makeRecord(messageId: number, date: number, text: string) {
  return {
    messageId,
    date,
    message: {
      id: messageId,
      date,
      senderId: 'user-1',
      isOutgoing: false,
      content: {
        text: {
          text,
        },
      },
    },
  };
}

describe('syncedHistoryBrowser search fallback', () => {
  const global = {
    currentUserId: 'me',
  } as GlobalState;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('falls back to indexeddb keyword scan when fts ids are stale', async () => {
    searchMessageIdsByKeywordFts.mockResolvedValue([101, 102]);
    getSyncedMessagesByIds.mockResolvedValue([]);
    querySyncedMessages.mockResolvedValue([
      makeRecord(201, 1_776_000_500, '借贷方案还在提议阶段'),
    ]);

    const result = await loadSyncedHistorySearchMessages({
      global,
      chatId: 'chat-1',
      threadId: 1,
      keyword: '借贷',
      maxCount: 200,
    });

    expect(querySyncedMessages).toHaveBeenCalledTimes(1);
    expect(querySyncedMessages.mock.calls[0]?.[0]).toMatchObject({
      chatId: 'chat-1',
      threadId: 1,
      maxCount: 1600,
    });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe(201);
  });

  it('keeps fast path when fts ids can be resolved', async () => {
    searchMessageIdsByKeywordFts.mockResolvedValue([301]);
    getSyncedMessagesByIds.mockResolvedValue([
      makeRecord(301, 1_776_000_800, '这里是关键字命中结果'),
    ]);
    querySyncedMessages.mockResolvedValue([]);

    const result = await loadSyncedHistorySearchMessages({
      global,
      chatId: 'chat-1',
      threadId: 1,
      keyword: '关键字',
      maxCount: 200,
    });

    expect(querySyncedMessages).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe(301);
  });
});
