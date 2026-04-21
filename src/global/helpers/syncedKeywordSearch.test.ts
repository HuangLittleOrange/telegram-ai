jest.mock('./sqliteFtsStore', () => ({
  searchMessageIdsByKeywordFts: jest.fn(),
}));

jest.mock('./syncedMessagesStore', () => ({
  getSyncedMessagesByIds: jest.fn(),
  querySyncedMessages: jest.fn(),
}));

import { searchSyncedRecordsByKeyword } from './syncedKeywordSearch';

const { searchMessageIdsByKeywordFts } = jest.requireMock('./sqliteFtsStore');
const { getSyncedMessagesByIds, querySyncedMessages } = jest.requireMock('./syncedMessagesStore');

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

describe('syncedKeywordSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('falls back to deep local scan when FTS ids are stale', async () => {
    searchMessageIdsByKeywordFts.mockResolvedValue([101, 102]);
    getSyncedMessagesByIds.mockResolvedValue([]);
    querySyncedMessages.mockResolvedValue([
      makeRecord(201, 1_776_000_500, 'dengdeng hit'),
      makeRecord(202, 1_776_000_400, 'other'),
    ]);

    const result = await searchSyncedRecordsByKeyword({
      chatId: 'chat-1',
      threadId: -1,
      keyword: 'dengdeng',
      maxCount: 100,
      filterFallbackRecord: (record) => (
        String(record.message.content?.text?.text || '').toLowerCase().includes('dengdeng')
      ),
    });

    expect(querySyncedMessages).toHaveBeenCalledTimes(1);
    expect(querySyncedMessages.mock.calls[0]?.[0]).toMatchObject({
      chatId: 'chat-1',
      threadId: -1,
      maxCount: 800,
    });
    expect(result.map((record: { messageId: number }) => record.messageId)).toEqual([201]);
  });

  it('retries without sender filter when sender-specific fallback yields nothing', async () => {
    searchMessageIdsByKeywordFts.mockResolvedValue(undefined);
    querySyncedMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeRecord(301, 1_776_000_700, 'dengdeng'),
      ]);

    const result = await searchSyncedRecordsByKeyword({
      chatId: 'chat-1',
      threadId: -1,
      keyword: 'dengdeng',
      senderId: 'sender-1',
      maxCount: 100,
    });

    expect(querySyncedMessages).toHaveBeenCalledTimes(2);
    expect(querySyncedMessages.mock.calls[0]?.[0]).toMatchObject({
      senderId: 'sender-1',
    });
    expect(querySyncedMessages.mock.calls[1]?.[0]).toMatchObject({
      senderId: undefined,
    });
    expect(result.map((record: { messageId: number }) => record.messageId)).toEqual([301]);
  });

  it('continues fallback paging until matches are found deeper in history', async () => {
    searchMessageIdsByKeywordFts.mockResolvedValue(undefined);
    querySyncedMessages
      .mockResolvedValueOnce([
        makeRecord(500, 1_776_000_900, 'other-1'),
        makeRecord(499, 1_776_000_800, 'other-2'),
      ])
      .mockResolvedValueOnce([
        makeRecord(498, 1_776_000_700, 'dengdeng deep hit'),
      ]);

    const result = await searchSyncedRecordsByKeyword({
      chatId: 'chat-1',
      threadId: -1,
      keyword: 'dengdeng',
      maxCount: 10,
      fallbackScanLimit: 2,
      filterFallbackRecord: (record) => (
        String(record.message.content?.text?.text || '').toLowerCase().includes('dengdeng')
      ),
    });

    expect(querySyncedMessages).toHaveBeenCalledTimes(2);
    expect(querySyncedMessages.mock.calls[1]?.[0]).toMatchObject({
      beforeMessageId: 499,
      maxCount: 2,
    });
    expect(result.map((record: { messageId: number }) => record.messageId)).toEqual([498]);
  });

  it('returns empty and skips storage queries when keyword is blank', async () => {
    const result = await searchSyncedRecordsByKeyword({
      chatId: 'chat-1',
      threadId: -1,
      keyword: '   ',
      maxCount: 100,
    });

    expect(result).toEqual([]);
    expect(searchMessageIdsByKeywordFts).not.toHaveBeenCalled();
    expect(querySyncedMessages).not.toHaveBeenCalled();
  });
});
