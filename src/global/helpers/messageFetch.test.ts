const mockMainThreadId = -1;

jest.mock('../cache', () => ({
  loadCachedGlobal: jest.fn(async () => undefined),
}));

jest.mock('../../api/gramjs', () => ({
  callApi: jest.fn(async () => {
    throw new Error('callApi should be mocked in messageFetch tests');
  }),
}));

jest.mock('../../util/schedulers', () => ({
  pause: jest.fn(async () => undefined),
}));

jest.mock('../../util/establishMultitabRole', () => ({
  getCurrentTabId: jest.fn(() => 1),
}));

jest.mock('../../util/localization', () => ({
  getTranslationFn: jest.fn(() => ((value: string) => value)),
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
      contextLimit: 40,
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

import { runMessageFetch } from './messageFetch';

const { callApi } = jest.requireMock('../../api/gramjs') as {
  callApi: jest.Mock;
};
const { pause } = jest.requireMock('../../util/schedulers') as {
  pause: jest.Mock;
};

describe('messageFetch', () => {
  beforeEach(() => {
    callApi.mockReset();
    pause.mockReset();
    pause.mockResolvedValue(undefined);
    const selectChat = jest.requireMock('../selectors').selectChat as jest.Mock;
    selectChat.mockReturnValue({
      id: 'chat-1',
      accessHash: 'hash-1',
    });
    const selectChatMessages = jest.requireMock('../selectors/messages').selectChatMessages as jest.Mock;
    selectChatMessages.mockReturnValue({});
    const selectThreadLocalState = jest.requireMock('../selectors/threads').selectThreadLocalState as jest.Mock;
    selectThreadLocalState.mockReturnValue(undefined);
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;
    getMessageSummaryText.mockReturnValue(undefined);
  });

  it('returns local results without touching gramjs when Telegram is not ready', async () => {
    const global = {
      connectionState: 'connectionStateConnecting',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'recent',
      limit: 10,
    }, 1);

    expect(result.messages).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.summary).toContain('Telegram 未连接');
    expect(callApi).not.toHaveBeenCalled();
  });

  it('uses the worker API path for remoteOnly history fetches even if connectionState is stale', async () => {
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;
    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);
    callApi.mockResolvedValueOnce({
      messages: [
        {
          id: 10,
          chatId: 'chat-1',
          date: 1770000000,
          isOutgoing: false,
          senderId: 'user-1',
          content: {},
        },
      ],
      users: [],
      chats: [],
    });

    const global = {
      connectionState: 'connectionStateConnecting',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1769990000000,
        endAt: 1770010000000,
      },
      limit: 10,
      remoteOnly: true,
    }, 1);

    expect(callApi).toHaveBeenCalledWith('fetchMessages', expect.objectContaining({
      chat: expect.objectContaining({ id: 'chat-1' }),
      threadId: mockMainThreadId,
      limit: 100,
      isSavedDialog: false,
    }));
    expect(result.messages.map((item) => item.messageId)).toEqual([10]);
    expect(result.total).toBe(1);
    expect(result.summary).not.toContain('Telegram 未连接');
  });

  it('falls back to local results when remote fetches fail with a connection error', async () => {
    callApi.mockRejectedValue(new Error('Not connected'));
    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'recent',
      limit: 10,
    }, 1);

    expect(result.messages).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.summary).toContain('Telegram 未连接');
    expect(callApi).toHaveBeenCalled();
  });

  it('does not fall back to local results for remoteOnly history queries when the client is unavailable', async () => {
    const selectChatMessages = jest.requireMock('../selectors/messages').selectChatMessages as jest.Mock;
    const selectThreadLocalState = jest.requireMock('../selectors/threads').selectThreadLocalState as jest.Mock;
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;

    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);
    selectThreadLocalState.mockReturnValue({
      listedIds: [12],
    });
    selectChatMessages.mockReturnValue({
      12: {
        id: 12,
        chatId: 'chat-1',
        date: 1770000012,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
    });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    callApi.mockRejectedValue(new Error('Not connected'));

    const result = await runMessageFetch(global, {
      mode: 'range',
      timeRange: {
        mode: 'preset',
        value: 'thisMonth',
      },
      limit: 10,
      remoteOnly: true,
    } as any, 1);

    expect(result.messages).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.summary).toContain('Telegram 未连接');
    expect(result.summary).toContain('远端历史不可用');
    expect(callApi).toHaveBeenCalled();
  });

  it('falls back to local results when the Telegram client disconnects during a request', async () => {
    const selectChat = jest.requireMock('../selectors').selectChat as jest.Mock;
    selectChat.mockReturnValue({
      id: 'chat-1',
      accessHash: 'hash-1',
    });
    callApi.mockImplementation(async () => {
      throw new Error('Not connected');
    });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'recent',
      limit: 10,
    }, 1);

    expect(result.messages).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(callApi).toHaveBeenCalledTimes(3);
  });

  it('retries a transient connection error before falling back to local results', async () => {
    callApi
      .mockRejectedValueOnce(new Error('Not connected'))
      .mockResolvedValueOnce({
        messages: [
          {
            id: 11,
            chatId: 'chat-1',
            date: 1770000001,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
      });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'recent',
      limit: 10,
    }, 1);

    expect(result.messages).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.summary).not.toContain('Telegram 未连接');
    expect(callApi.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('waits for Telegram flood wait errors before retrying the history request', async () => {
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;
    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);

    const floodWaitError = Object.assign(
      new Error('A wait of 2 seconds is required'),
      {
        seconds: 2,
        errorMessage: 'FLOOD_WAIT_2',
      },
    );

    callApi
      .mockRejectedValueOnce(floodWaitError)
      .mockResolvedValueOnce({
        messages: [
          {
            id: 21,
            chatId: 'chat-1',
            date: 1770000021,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'recent',
      limit: 10,
      remoteOnly: true,
    } as any, 1);

    expect(pause).toHaveBeenCalledWith(2000);
    expect(callApi.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.messages.map((item) => item.messageId)).toEqual([21]);
    expect(result.total).toBe(1);
  });

  it('reports flood wait progress while pausing before retrying', async () => {
    const floodWaitError = Object.assign(
      new Error('A wait of 3 seconds is required'),
      {
        seconds: 3,
        errorMessage: 'FLOOD_WAIT_3',
      },
    );

    callApi
      .mockRejectedValueOnce(floodWaitError)
      .mockResolvedValueOnce({
        messages: [],
        users: [],
        chats: [],
      });

    const onRemoteFloodWait = jest.fn();
    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    await runMessageFetch(global, {
      mode: 'recent',
      limit: 10,
      remoteOnly: true,
    } as any, 1, {
      onRemoteFloodWait,
    });

    expect(onRemoteFloodWait).toHaveBeenCalledWith(3);
    expect(pause).toHaveBeenCalledWith(3000);
  });

  it('skips local seed data when remoteOnly is requested so history fetch still calls GetHistory', async () => {
    const selectChatMessages = jest.requireMock('../selectors/messages').selectChatMessages as jest.Mock;
    const selectThreadLocalState = jest.requireMock('../selectors/threads').selectThreadLocalState as jest.Mock;
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;

    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);
    selectThreadLocalState.mockReturnValue({
      listedIds: Array.from({ length: 10 }, (_, index) => 100 - index),
    });
    selectChatMessages.mockReturnValue({
      ...Array.from({ length: 10 }, (_, index) => {
        const id = 100 - index;
        return [id, {
          id,
          chatId: 'chat-1',
          date: 1770000000 - id,
          isOutgoing: false,
          senderId: 'user-1',
          content: {},
        }];
      }).reduce<Record<number, any>>((acc, [id, message]) => {
        acc[id as number] = message;
        return acc;
      }, {}),
    });
    callApi.mockResolvedValueOnce({
      messages: [
        {
          id: 42,
          chatId: 'chat-1',
          date: 1769990000,
          isOutgoing: false,
          senderId: 'user-1',
          content: {},
        },
      ],
      users: [],
      chats: [],
    });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'recent',
      limit: 1,
      remoteOnly: true,
    } as any, 1);

    expect(callApi).toHaveBeenCalledTimes(1);
    expect(result.messages.map((item) => item.messageId)).toEqual([42]);
    expect(result.total).toBe(1);
    expect(result.summary).not.toContain('Telegram 未连接');
  });

  it('reports remote page progress for each GetHistory page during a range fetch', async () => {
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;
    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);

    callApi
      .mockResolvedValueOnce({
        messages: [
          {
            id: 30,
            chatId: 'chat-1',
            date: 1770000030,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
          {
            id: 29,
            chatId: 'chat-1',
            date: 1770000029,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 28,
            chatId: 'chat-1',
            date: 1770000028,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      })
      .mockResolvedValueOnce({
        messages: [],
        users: [],
        chats: [],
      });

    const onRemotePageFetched = jest.fn();
    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    await runMessageFetch(global, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1769990000000,
        endAt: 1770010000000,
      },
      remoteOnly: true,
    } as any, 1, {
      onRemotePageFetched,
    });

    expect(onRemotePageFetched).toHaveBeenCalledTimes(2);
    expect(onRemotePageFetched.mock.calls[0][0]).toEqual(expect.objectContaining({
      total: 2,
      evidenceIds: [29, 30],
    }));
    expect(onRemotePageFetched.mock.calls[1][0]).toEqual(expect.objectContaining({
      total: 1,
      evidenceIds: [28],
    }));
  });

  it('stops paginating a range query once pages are entirely older than the requested window', async () => {
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;
    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);

    callApi
      .mockResolvedValueOnce({
        messages: [
          {
            id: 30,
            chatId: 'chat-1',
            date: 1770000030,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
          {
            id: 29,
            chatId: 'chat-1',
            date: 1770000029,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 28,
            chatId: 'chat-1',
            date: 1769980000,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
          {
            id: 27,
            chatId: 'chat-1',
            date: 1769979000,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 26,
            chatId: 'chat-1',
            date: 1769970000,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1769990000000,
        endAt: 1770010000000,
      },
      remoteOnly: true,
    } as any, 1);

    expect(callApi).toHaveBeenCalledTimes(2);
    expect(result.messages.map((item) => item.messageId)).toEqual([29, 30]);
    expect(result.total).toBe(2);
  });

  it('uses persisted local range coverage metadata before attempting remote backfill', async () => {
    const selectChatMessages = jest.requireMock('../selectors/messages').selectChatMessages as jest.Mock;
    const selectThreadLocalState = jest.requireMock('../selectors/threads').selectThreadLocalState as jest.Mock;
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;

    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);
    selectThreadLocalState.mockReturnValue({
      listedIds: [30, 29, 28],
      fetchedMessageRangeCoverages: [
        {
          startAt: 1770000000000,
          endAt: 1770010000000,
          completedAt: 1770013600000,
        },
      ],
    });
    selectChatMessages.mockReturnValue({
      30: {
        id: 30,
        chatId: 'chat-1',
        date: 1770013600,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
      29: {
        id: 29,
        chatId: 'chat-1',
        date: 1770007200,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
      28: {
        id: 28,
        chatId: 'chat-1',
        date: 1769996400,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
    });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1770000000000,
        endAt: 1770010000000,
      },
    } as any, 1);

    expect(callApi).not.toHaveBeenCalled();
    expect(result.messages.map((item) => item.messageId)).toEqual([29]);
    expect(result.total).toBe(1);
  });

  it('still remote backfills a range query when local messages exist near the boundaries but no coverage metadata was recorded', async () => {
    const selectChatMessages = jest.requireMock('../selectors/messages').selectChatMessages as jest.Mock;
    const selectThreadLocalState = jest.requireMock('../selectors/threads').selectThreadLocalState as jest.Mock;
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;

    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);
    selectThreadLocalState.mockReturnValue({
      listedIds: [30, 29, 28],
    });
    selectChatMessages.mockReturnValue({
      30: {
        id: 30,
        chatId: 'chat-1',
        date: 1770013600,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
      29: {
        id: 29,
        chatId: 'chat-1',
        date: 1770007200,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
      28: {
        id: 28,
        chatId: 'chat-1',
        date: 1769996400,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
      27: {
        id: 27,
        chatId: 'chat-1',
        date: 1769992800,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
    });
    callApi
      .mockResolvedValueOnce({
        messages: [
          {
            id: 27,
            chatId: 'chat-1',
            date: 1770003600,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      })
      .mockResolvedValueOnce({
        messages: [],
        users: [],
        chats: [],
      });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1770000000000,
        endAt: 1770010000000,
      },
    } as any, 1);

    expect(callApi).toHaveBeenCalled();
    expect(result.messages.map((item) => item.messageId)).toEqual([27, 29]);
    expect(result.total).toBe(2);
  });

  it('starts range-query remote backfill from latest history instead of local minimum id anchors', async () => {
    const selectChatMessages = jest.requireMock('../selectors/messages').selectChatMessages as jest.Mock;
    const selectThreadLocalState = jest.requireMock('../selectors/threads').selectThreadLocalState as jest.Mock;
    const getMessageSummaryText = jest.requireMock('./messageSummary').getMessageSummaryText as jest.Mock;

    getMessageSummaryText.mockImplementation((_: any, message: { id: number }) => `message-${message.id}`);
    selectThreadLocalState.mockReturnValue({
      listedIds: [15422, 17000],
    });
    selectChatMessages.mockReturnValue({
      15422: {
        id: 15422,
        chatId: 'chat-1',
        date: 1770001000,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
      17000: {
        id: 17000,
        chatId: 'chat-1',
        date: 1770007200,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      },
    });

    callApi
      .mockResolvedValueOnce({
        messages: [
          {
            id: 17001,
            chatId: 'chat-1',
            date: 1770007300,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      })
      .mockResolvedValueOnce({
        messages: [],
        users: [],
        chats: [],
      });

    const global = {
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 40,
          },
        },
      },
    } as any;

    const result = await runMessageFetch(global, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1770000000000,
        endAt: 1770010000000,
      },
    } as any, 1);

    expect(callApi).toHaveBeenCalled();
    expect(callApi.mock.calls[0][1]).toEqual(expect.not.objectContaining({
      offsetId: 15422,
    }));
    expect(result.messages.map((item) => item.messageId)).toEqual([15422, 17000, 17001]);
  });
});
