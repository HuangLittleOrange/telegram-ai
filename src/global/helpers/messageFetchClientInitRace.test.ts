const mockMainThreadId = -1;

jest.mock('../cache', () => ({
  loadCachedGlobal: jest.fn(() => undefined),
}));

jest.mock('../../api/gramjs', () => ({
  callApi: jest.fn(() => {
    throw new Error('callApi should not be called in client init race tests');
  }),
}));

jest.mock('../../util/establishMultitabRole', () => ({
  getCurrentTabId: jest.fn(() => 1),
}));

jest.mock('../../util/localization', () => ({
  getTranslationFn: jest.fn(() => (value: string) => value),
}));

jest.mock('../../util/schedulers', () => ({
  pause: jest.fn(() => undefined),
}));

jest.mock('../selectors', () => ({
  selectChat: jest.fn(() => undefined),
  selectCurrentMessageList: jest.fn(() => ({
    chatId: 'chat-1',
    threadId: mockMainThreadId,
    type: 'thread',
  })),
  selectTabState: jest.fn(() => ({
    aiAssistant: {
      contextLimit: 50,
    },
  })),
  selectViewportIds: jest.fn(() => undefined),
}));

jest.mock('../selectors/messages', () => ({
  selectChatMessages: jest.fn(() => ({})),
  selectSender: jest.fn(() => undefined),
}));

jest.mock('../selectors/threads', () => ({
  selectThreadIdFromMessage: jest.fn(() => mockMainThreadId),
  selectThreadLocalState: jest.fn(() => undefined),
}));

jest.mock('./chats', () => ({
  getIsSavedDialog: jest.fn(() => false),
}));

jest.mock('./messageSummary', () => ({
  getMessageSummaryText: jest.fn(() => undefined),
}));

jest.mock('./peers', () => ({
  getPeerTitle: jest.fn(() => 'chat-1'),
}));

import { runMessageFetch, runMessageFetchWithContinuation } from './messageFetch';

const { callApi } = jest.requireMock('../../api/gramjs');

describe('messageFetch client init race', () => {
  it('falls back locally when connectionState is ready but the gramjs client is not initialized', async () => {
    const pageResults: Array<{ total: number; summary?: string }> = [];
    callApi.mockRejectedValue(new Error('Not connected'));
    const selectChat = jest.requireMock('../selectors').selectChat as jest.Mock;
    selectChat.mockReturnValue({
      id: 'chat-1',
      accessHash: 'hash-1',
    });
    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 50,
          },
        },
      },
    } as any;

    const result = await runMessageFetchWithContinuation({
      query: {
        mode: 'range',
        timeRange: {
          mode: 'custom',
          startAt: 1770000000000,
          endAt: 1770100000000,
        },
        limit: 10,
      },
      fetchOnce: (query) => runMessageFetch(global, query, 1),
      onPageFetched: (page) => {
        pageResults.push({
          total: page.total,
          summary: page.summary,
        });
      },
    });

    expect(callApi).toHaveBeenCalled();
    expect(result.total).toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.summary).toContain('Telegram 未连接');
    expect(pageResults).toHaveLength(1);
    expect(pageResults[0]).toEqual(expect.objectContaining({
      total: 0,
      summary: expect.stringContaining('Telegram 未连接'),
    }));
  });
});
