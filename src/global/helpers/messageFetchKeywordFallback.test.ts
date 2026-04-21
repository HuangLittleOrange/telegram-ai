const mockMainThreadId = -1;

jest.mock('../../util/establishMultitabRole', () => ({
  getCurrentTabId: jest.fn(() => 1),
}));

jest.mock('../../util/localization', () => ({
  getTranslationFn: jest.fn(() => (value: string) => value),
}));

jest.mock('../selectors', () => ({
  selectCurrentMessageList: jest.fn(() => ({
    chatId: 'chat-1',
    threadId: mockMainThreadId,
    type: 'thread',
  })),
  selectTabState: jest.fn(() => ({
    aiAssistant: {
      contextLimit: 40,
    },
  })),
}));

jest.mock('../selectors/messages', () => ({
  selectSender: jest.fn(() => undefined),
}));

jest.mock('../selectors/threads', () => ({
  selectThreadIdFromMessage: jest.fn(() => mockMainThreadId),
  selectThreadLocalState: jest.fn(() => undefined),
}));

jest.mock('./messageSummary', () => ({
  getMessageSummaryText: jest.fn((_: any, message: { content?: { text?: { text?: string } } }) => (
    message.content?.text?.text || ''
  )),
}));

jest.mock('./peers', () => ({
  getPeerTitle: jest.fn(() => ''),
}));

jest.mock('./syncedKeywordSearch', () => ({
  searchSyncedRecordsByKeyword: jest.fn(),
}));

import { runMessageFetch } from './messageFetch';

const { searchSyncedRecordsByKeyword } = jest.requireMock('./syncedKeywordSearch');

function makeSyncedRecord(messageId: number, date: number, text: string) {
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

describe('messageFetch keyword fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters keyword query results from shared synced keyword helper', async () => {
    searchSyncedRecordsByKeyword.mockResolvedValue([
      makeSyncedRecord(201, 1_776_000_800, 'Dengdeng: 这里有更新'),
      makeSyncedRecord(202, 1_776_000_700, '无关内容'),
    ]);

    const result = await runMessageFetch({
      currentUserId: 'me',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any, {
      mode: 'keyword',
      keyword: 'dengdeng',
      limit: 100,
    }, 1);

    expect(searchSyncedRecordsByKeyword).toHaveBeenCalledTimes(1);
    expect(searchSyncedRecordsByKeyword.mock.calls[0]?.[0]).toMatchObject({
      chatId: 'chat-1',
      threadId: mockMainThreadId,
      maxCount: 100,
      keyword: 'dengdeng',
    });
    expect(result.messages.map((item: { messageId: number }) => item.messageId)).toEqual([201]);
  });

  it('returns empty result when keyword has no matches', async () => {
    searchSyncedRecordsByKeyword.mockResolvedValue([]);

    const result = await runMessageFetch({
      currentUserId: 'me',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any, {
      mode: 'keyword',
      keyword: 'dengdeng',
      limit: 100,
    }, 1);

    expect(result.total).toBe(0);
    expect(result.messages).toEqual([]);
  });
});
