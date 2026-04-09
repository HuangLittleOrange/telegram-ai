import { persistFetchedMessages, persistFetchedRangeCoverage } from './aiMessagePersistence';

describe('aiMessagePersistence', () => {
  it('reads the latest global state before persisting fetched messages', () => {
    const latestGlobal = {
      messages: {
        byChatId: {
          chat1: {
            byId: {
              1: { id: 1, chatId: 'chat1', date: 1 },
              2: { id: 2, chatId: 'chat1', date: 2 },
            },
            threadsById: {},
            summaryById: {},
          },
        },
      },
    } as any;

    const getGlobal = jest.fn(() => latestGlobal);
    const setGlobal = jest.fn();
    const forceUpdateCache = jest.fn();
    const addMessages = jest.fn((global: any, messages: any[]) => ({
      ...global,
      messages: {
        ...global.messages,
        byChatId: {
          ...global.messages.byChatId,
          chat1: {
            ...global.messages.byChatId.chat1,
            byId: {
              ...global.messages.byChatId.chat1.byId,
              [messages[0].id]: messages[0],
            },
          },
        },
      },
    }));

    const nextGlobal = persistFetchedMessages({
      messages: [
        { id: 3, chatId: 'chat1', date: 3 },
      ] as any,
      getGlobal,
      setGlobal,
      forceUpdateCache,
      addMessages,
    });

    expect(getGlobal).toHaveBeenCalledTimes(1);
    expect(setGlobal).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.objectContaining({
        byChatId: expect.objectContaining({
          chat1: expect.objectContaining({
            byId: expect.objectContaining({
              1: expect.anything(),
              2: expect.anything(),
              3: expect.anything(),
            }),
          }),
        }),
      }),
    }));
    expect(forceUpdateCache).toHaveBeenCalledTimes(1);
    expect(nextGlobal.messages.byChatId.chat1.byId[3]).toEqual(expect.objectContaining({ id: 3 }));
    expect(nextGlobal.messages.byChatId.chat1.byId[2]).toEqual(expect.objectContaining({ id: 2 }));
    expect(nextGlobal.messages.byChatId.chat1.byId[1]).toEqual(expect.objectContaining({ id: 1 }));
    expect(addMessages).toHaveBeenCalledWith(latestGlobal, [
      expect.objectContaining({ id: 3 }),
    ]);
  });

  it('merges fetched message ids into the current thread cache lists', () => {
    const latestGlobal = {
      messages: {
        byChatId: {
          chat1: {
            byId: {
              1: { id: 1, chatId: 'chat1', date: 1 },
              2: { id: 2, chatId: 'chat1', date: 2 },
              3: { id: 3, chatId: 'chat1', date: 3 },
            },
            threadsById: {
              '-1': {
                localState: {
                  listedIds: [2, 3],
                  lastViewportIds: [2, 3],
                },
              },
            },
            summaryById: {},
          },
        },
      },
    } as any;

    const nextGlobal = persistFetchedMessages({
      messages: [
        { id: 1, chatId: 'chat1', date: 1 },
      ] as any,
      chatId: 'chat1',
      threadId: -1,
      getGlobal: () => latestGlobal,
      setGlobal: jest.fn(),
      forceUpdateCache: jest.fn(),
      addMessages: (global: any) => global,
    });

    expect(nextGlobal.messages.byChatId.chat1.threadsById['-1'].localState.listedIds).toEqual([1, 2, 3]);
    expect(nextGlobal.messages.byChatId.chat1.threadsById['-1'].localState.lastViewportIds).toEqual([1, 2, 3]);
  });

  it('persists completed range coverage metadata into the thread local cache state', () => {
    const latestGlobal = {
      messages: {
        byChatId: {
          chat1: {
            byId: {},
            threadsById: {
              '-1': {
                localState: {},
              },
            },
            summaryById: {},
          },
        },
      },
    } as any;

    const setGlobal = jest.fn();
    const forceUpdateCache = jest.fn();

    const nextGlobal = persistFetchedRangeCoverage({
      query: {
        mode: 'range',
        timeRange: {
          mode: 'custom',
          startAt: 1770000000000,
          endAt: 1770010000000,
        },
      } as any,
      result: {
        messages: [],
        total: 10,
        truncated: false,
        evidenceIds: [],
      },
      chatId: 'chat1',
      threadId: -1,
      getGlobal: () => latestGlobal,
      setGlobal,
      forceUpdateCache,
    });

    expect(nextGlobal.messages.byChatId.chat1.threadsById['-1'].localState.fetchedMessageRangeCoverages).toEqual([
      expect.objectContaining({
        startAt: 1770000000000,
        endAt: 1770010000000,
      }),
    ]);
    expect(setGlobal).toHaveBeenCalled();
    expect(forceUpdateCache).toHaveBeenCalled();
  });
});
