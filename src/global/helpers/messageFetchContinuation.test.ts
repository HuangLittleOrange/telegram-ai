jest.mock('../cache', () => ({
  loadCachedGlobal: jest.fn(() => undefined),
}));

jest.mock('../../api/gramjs', () => ({
  callApi: jest.fn(() => {
    throw new Error('callApi should not be called in continuation tests');
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
    threadId: -1,
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
  selectThreadIdFromMessage: jest.fn(() => -1),
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

import { runMessageFetchWithContinuation } from './messageFetch';

describe('messageFetch continuation', () => {
  it('returns the first truncated recent page without auto-continuing', async () => {
    const fetchOnce = jest
      .fn()
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 300,
            sender: 'A',
            date: 3000,
            text: 'm300',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 299,
            sender: 'A',
            date: 2990,
            text: 'm299',
          },
        ],
        total: 2,
        truncated: true,
        evidenceIds: [300, 299],
        sourceMessages: [
          { id: 300 },
          { id: 299 },
        ],
        nextBeforeMessageId: 299,
        summary: 'first page',
      })
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 298,
            sender: 'A',
            date: 2980,
            text: 'm298',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 297,
            sender: 'A',
            date: 2970,
            text: 'm297',
          },
        ],
        total: 2,
        truncated: false,
        evidenceIds: [298, 297],
        sourceMessages: [
          { id: 298 },
          { id: 297 },
        ],
        nextBeforeMessageId: 297,
        summary: 'second page',
      });

    const result = await runMessageFetchWithContinuation({
      query: {
        mode: 'recent',
        limit: 2,
      },
      fetchOnce,
      maxRounds: 2,
    });

    expect(fetchOnce).toHaveBeenCalledTimes(1);
    expect(fetchOnce.mock.calls[0][0]).toEqual(expect.objectContaining({
      mode: 'recent',
      limit: 2,
    }));
    expect(result.messages.map((item) => item.messageId)).toEqual([300, 299]);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.nextBeforeMessageId).toBe(299);
  });

  it('does not auto-continue a complete range result', async () => {
    const fetchOnce = jest.fn().mockResolvedValueOnce({
      messages: [
        {
          chatId: 'chat-1',
          threadId: -1,
          messageId: 299,
          sender: 'A',
          date: 2990,
          text: 'm299',
        },
        {
          chatId: 'chat-1',
          threadId: -1,
          messageId: 300,
          sender: 'A',
          date: 3000,
          text: 'm300',
        },
      ],
      total: 2,
      truncated: false,
      evidenceIds: [299, 300],
      sourceMessages: [
        { id: 299 },
        { id: 300 },
      ],
      nextBeforeMessageId: 299,
      summary: 'complete range',
    });

    const result = await runMessageFetchWithContinuation({
      query: {
        mode: 'range',
        timeRange: {
          mode: 'custom',
          startAt: 2970 * 1000,
          endAt: 3010 * 1000,
        },
        limit: 2,
      },
      fetchOnce,
      maxRounds: 3,
    });

    expect(fetchOnce).toHaveBeenCalledTimes(1);
    expect(result.messages.map((item) => item.messageId)).toEqual([299, 300]);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.nextBeforeMessageId).toBe(299);
  });

  it('continues a truncated range result', async () => {
    const fetchOnce = jest
      .fn()
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 300,
            sender: 'A',
            date: 3000,
            text: 'm300',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 299,
            sender: 'A',
            date: 2990,
            text: 'm299',
          },
        ],
        total: 2,
        truncated: true,
        evidenceIds: [300, 299],
        sourceMessages: [
          { id: 300 } as any,
          { id: 299 } as any,
        ],
        nextBeforeMessageId: 299,
        summary: 'first page',
      })
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 298,
            sender: 'A',
            date: 2980,
            text: 'm298',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 297,
            sender: 'A',
            date: 2970,
            text: 'm297',
          },
        ],
        total: 2,
        truncated: false,
        evidenceIds: [298, 297],
        sourceMessages: [
          { id: 298 } as any,
          { id: 297 } as any,
        ],
        nextBeforeMessageId: 297,
        summary: 'final page',
      });

    const result = await runMessageFetchWithContinuation({
      query: {
        mode: 'range',
        timeRange: {
          mode: 'custom',
          startAt: 2970 * 1000,
          endAt: 3010 * 1000,
        },
        limit: 2,
      },
      fetchOnce,
      maxRounds: 4,
    });

    expect(fetchOnce).toHaveBeenCalledTimes(2);
    expect(result.messages.map((item) => item.messageId)).toEqual([297, 298, 299, 300]);
    expect(result.total).toBe(4);
    expect(result.nextBeforeMessageId).toBe(297);
  });

  it('emits each fetched page so callers can cache remote results immediately', async () => {
    const fetchOnce = jest
      .fn()
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 300,
            sender: 'A',
            date: 3000,
            text: 'm300',
          },
        ],
        total: 1,
        truncated: false,
        evidenceIds: [300],
        sourceMessages: [{ id: 300 } as any],
        nextBeforeMessageId: 300,
        summary: 'page 1',
      })
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 299,
            sender: 'A',
            date: 2990,
            text: 'm299',
          },
        ],
        total: 1,
        truncated: false,
        evidenceIds: [299],
        sourceMessages: [{ id: 299 } as any],
        nextBeforeMessageId: 299,
        summary: 'page 2',
      })
      .mockResolvedValueOnce({
        messages: [],
        total: 0,
        truncated: false,
        evidenceIds: [],
        sourceMessages: [],
        summary: 'done',
      });
    const onPageFetched = jest.fn();

    const result = await runMessageFetchWithContinuation({
      query: {
        mode: 'range',
        timeRange: {
          mode: 'custom',
          startAt: 2980 * 1000,
          endAt: 3010 * 1000,
        },
        limit: 2,
      },
      fetchOnce,
      onPageFetched,
      maxRounds: 3,
    });

    expect(fetchOnce).toHaveBeenCalledTimes(1);
    expect(onPageFetched).toHaveBeenCalledTimes(1);
    expect(onPageFetched.mock.calls[0][0].messages.map((item: any) => item.messageId)).toEqual([300]);
    expect(result.total).toBe(1);
    expect(result.messages.map((item) => item.messageId)).toEqual([300]);
  });

  it('keeps paginating when an intermediate page is fully duplicated but the cursor advances', async () => {
    const fetchOnce = jest
      .fn()
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 300,
            sender: 'A',
            date: 3000,
            text: 'm300',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 299,
            sender: 'A',
            date: 2990,
            text: 'm299',
          },
        ],
        total: 2,
        truncated: true,
        evidenceIds: [300, 299],
        sourceMessages: [
          { id: 300 } as any,
          { id: 299 } as any,
        ],
        nextBeforeMessageId: 299,
        summary: 'first page',
      })
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 300,
            sender: 'A',
            date: 3000,
            text: 'm300',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 299,
            sender: 'A',
            date: 2990,
            text: 'm299',
          },
        ],
        total: 2,
        truncated: true,
        evidenceIds: [300, 299],
        sourceMessages: [
          { id: 300 } as any,
          { id: 299 } as any,
        ],
        nextBeforeMessageId: 297,
        summary: 'duplicate page',
      })
      .mockResolvedValueOnce({
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 298,
            sender: 'A',
            date: 2980,
            text: 'm298',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 297,
            sender: 'A',
            date: 2970,
            text: 'm297',
          },
        ],
        total: 2,
        truncated: false,
        evidenceIds: [298, 297],
        sourceMessages: [
          { id: 298 } as any,
          { id: 297 } as any,
        ],
        nextBeforeMessageId: 297,
        summary: 'final page',
      })
      .mockResolvedValueOnce({
        messages: [],
        total: 0,
        truncated: false,
        evidenceIds: [],
        sourceMessages: [],
        summary: 'done',
      });

    const result = await runMessageFetchWithContinuation({
      query: {
        mode: 'range',
        timeRange: {
          mode: 'custom',
          startAt: 2970 * 1000,
          endAt: 3010 * 1000,
        },
        limit: 2,
      },
      fetchOnce,
      maxRounds: 4,
    });

    expect(fetchOnce).toHaveBeenCalledTimes(3);
    expect(result.messages.map((item) => item.messageId)).toEqual([297, 298, 299, 300]);
    expect(result.total).toBe(4);
    expect(result.nextBeforeMessageId).toBe(297);
  });
});
