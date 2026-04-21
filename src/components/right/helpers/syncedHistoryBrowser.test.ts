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

jest.mock('../../../global/helpers/syncedKeywordSearch', () => ({
  searchSyncedRecordsByKeyword: jest.fn(),
}));

jest.mock('../../../global/helpers/syncedMessagesStore', () => ({
  listSyncedMessageDays: jest.fn(),
  querySyncedMessages: jest.fn(),
}));

const { searchSyncedRecordsByKeyword } = jest.requireMock('../../../global/helpers/syncedKeywordSearch');

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

  it('maps keyword search results returned by shared synced keyword helper', async () => {
    searchSyncedRecordsByKeyword.mockResolvedValue([
      makeRecord(201, 1_776_000_500, '借贷方案还在提议阶段'),
    ]);

    const result = await loadSyncedHistorySearchMessages({
      global,
      chatId: 'chat-1',
      threadId: 1,
      keyword: '借贷',
      maxCount: 200,
    });

    expect(searchSyncedRecordsByKeyword).toHaveBeenCalledTimes(1);
    expect(searchSyncedRecordsByKeyword.mock.calls[0]?.[0]).toMatchObject({
      chatId: 'chat-1',
      threadId: 1,
      keyword: '借贷',
      maxCount: 200,
    });
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe(201);
  });

  it('returns empty list when shared helper yields no records', async () => {
    searchSyncedRecordsByKeyword.mockResolvedValue([]);

    const result = await loadSyncedHistorySearchMessages({
      global,
      chatId: 'chat-1',
      threadId: 1,
      keyword: '关键字',
      maxCount: 200,
    });

    expect(result).toEqual([]);
  });
});
