const mockMainThreadId = -1;

jest.mock('../cache', () => ({
  loadCachedGlobal: jest.fn(async () => undefined),
}));

jest.mock('../../api/gramjs', () => ({
  callApi: jest.fn(async () => {
    throw new Error('callApi should be mocked in pagination tests');
  }),
}));

jest.mock('../../util/establishMultitabRole', () => ({
  getCurrentTabId: jest.fn(() => 1),
}));

jest.mock('../../util/localization', () => ({
  getTranslationFn: jest.fn(() => ((value: string) => value)),
}));

jest.mock('../../util/schedulers', () => ({
  pause: jest.fn(async () => undefined),
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
      contextLimit: 550,
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
  getMessageSummaryText: jest.fn((_: any, message: { id: number }) => `message-${message.id}`),
}));

jest.mock('./peers', () => ({
  getPeerTitle: jest.fn(() => 'chat-1'),
}));

import { runMessageFetch } from './messageFetch';

const { callApi } = jest.requireMock('../../api/gramjs') as {
  callApi: jest.Mock;
};
const { selectChat } = jest.requireMock('../selectors') as {
  selectChat: jest.Mock;
};

function buildPage(startId: number, count: number) {
  return {
    messages: Array.from({ length: count }, (_, index) => {
      const id = startId - index;
      return {
        id,
        chatId: 'chat-1',
        date: 1770000000 - id,
        isOutgoing: false,
        senderId: 'user-1',
        content: {},
      };
    }),
    users: [],
    chats: [],
  };
}

describe('messageFetch pagination', () => {
  beforeEach(() => {
    callApi.mockReset();
    selectChat.mockReturnValue({
      id: 'chat-1',
      accessHash: 'hash-1',
    });
  });

  it('keeps fetching remote pages until the requested limit is reached', async () => {
    const pages = [
      buildPage(600, 100),
      buildPage(500, 100),
      buildPage(400, 100),
      buildPage(300, 100),
      buildPage(200, 100),
      buildPage(100, 100),
    ];
    let pageIndex = 0;

    callApi.mockImplementation(async (name: string) => {
      if (name !== 'fetchMessages') {
        throw new Error(`Unexpected method: ${name}`);
      }
      const page = pages[pageIndex];
      pageIndex += 1;
      return page;
    });

    const result = await runMessageFetch({
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 550,
          },
        },
      },
      currentUserId: 'user-0',
    } as any, {
      mode: 'recent',
      limit: 550,
    }, 1);

    expect(callApi).toHaveBeenCalledTimes(6);
    expect(result.total).toBe(550);
    expect(result.truncated).toBe(true);
    expect(result.messages[0]?.messageId).toBe(600);
    expect(result.messages.at(-1)?.messageId).toBe(1);
    expect(result.nextBeforeMessageId).toBe(600);
  });

  it('uses beforeMessageId as the offset cursor for range queries', async () => {
    callApi.mockImplementation(async (name: string) => {
      if (name !== 'fetchMessages') {
        throw new Error(`Unexpected method: ${name}`);
      }
      return buildPage(299, 3);
    });

    await runMessageFetch({
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 50,
          },
        },
      },
      currentUserId: 'user-0',
    } as any, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1770000000000,
        endAt: 1770100000000,
      },
      beforeMessageId: 300,
      limit: 50,
    }, 1);

    expect(callApi).toHaveBeenCalled();
    expect(callApi.mock.calls[0][1]).toEqual(expect.objectContaining({
      offsetId: 300,
      addOffset: 0,
    }));
  });

  it('keeps range queries inside the requested time window', async () => {
    callApi
      .mockImplementationOnce(async () => ({
        messages: [
          {
            id: 300,
            chatId: 'chat-1',
            date: 1770000100,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
          {
            id: 299,
            chatId: 'chat-1',
            date: 1770000050,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
          {
            id: 298,
            chatId: 'chat-1',
            date: 1769999899,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      }))
      .mockImplementationOnce(async () => ({
        messages: [
          {
            id: 297,
            chatId: 'chat-1',
            date: 1769999950,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
          {
            id: 296,
            chatId: 'chat-1',
            date: 1769999900,
            isOutgoing: false,
            senderId: 'user-1',
            content: {},
          },
        ],
        users: [],
        chats: [],
      }));

    const result = await runMessageFetch({
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 50,
          },
        },
      },
      currentUserId: 'user-0',
    } as any, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1769999900000,
        endAt: 1770000200000,
      },
      limit: 50,
    }, 1);

    expect(result.messages.map((item) => item.messageId)).toEqual([296, 297, 299, 300]);
    expect(result.messages.map((item) => item.date)).toEqual([1769999900, 1769999950, 1770000050, 1770000100]);
    expect(callApi).toHaveBeenCalledTimes(3);
  });

  it('starts remoteOnly range queries without relying on local seed cursors', async () => {
    const page = buildPage(420, 3);
    callApi.mockResolvedValue(page);

    selectChat.mockReturnValue({
      id: 'chat-1',
      accessHash: 'hash-1',
    });

    const result = await runMessageFetch({
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 50,
          },
        },
      },
      currentUserId: 'user-0',
    } as any, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1760000000000,
        endAt: 1780000000000,
      },
      remoteOnly: true,
      limit: 100,
    } as any, 1);

    expect('offsetId' in callApi.mock.calls[0][1]).toBe(false);
    expect(result.messages.map((item) => item.messageId)).toEqual([420, 419, 418]);
  });

  it('continues range pagination past five pages when the window still has more messages', async () => {
    const pages = Array.from({ length: 6 }, (_, page) => buildPage(600 - (page * 20), 20));
    let pageIndex = 0;

    callApi.mockImplementation(async () => {
      const page = pages[pageIndex];
      pageIndex += 1;
      return page;
    });

    const result = await runMessageFetch({
      connectionState: 'connectionStateReady',
      byTabId: {
        1: {
          aiAssistant: {
            contextLimit: 550,
          },
        },
      },
      currentUserId: 'user-0',
    } as any, {
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: 1760000000000,
        endAt: 1780000000000,
      },
      limit: 50,
    }, 1);

    expect(callApi).toHaveBeenCalledTimes(7);
    expect(result.messages).toHaveLength(120);
    expect(result.truncated).toBe(false);
    expect(result.messages[0]?.messageId).toBe(600);
    expect(result.messages.at(-1)?.messageId).toBe(481);
  });
});
