import { createEmptyAiAssistantState } from '../../helpers/aiRunState';

type ActionHandler = (...args: any[]) => any;

describe('ui ai action', () => {
  it('opens the assistant from selected messages with chronological selection context', async () => {
    const actionHandlers = new Map<string, ActionHandler>();

    let currentGlobal: any = {
      settings: {
        byKey: {
          aiSettings: {
            defaultContextLimit: 100,
          },
        },
      },
      byTabId: {
        1: {
          aiAssistant: createEmptyAiAssistantState(),
          selectedMessages: {
            chatId: 'chat-1',
            messageIds: [30, 10, 20],
          },
          messageLists: [{
            chatId: 'chat-1',
            threadId: 7,
            type: 'thread',
          }],
        },
      },
    };

    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../index', () => ({
        addActionHandler: jest.fn((name: string, handler: (...args: any[]) => any) => {
          actionHandlers.set(name, handler);
        }),
        getGlobal: jest.fn(() => currentGlobal),
        setGlobal: jest.fn((next: any) => {
          currentGlobal = next;
        }),
        forceUpdateCache: jest.fn(),
        loadCachedGlobal: jest.fn(),
      }));
      jest.doMock('../../../util/establishMultitabRole', () => ({
        getCurrentTabId: jest.fn(() => 1),
      }));
      jest.doMock('../../../util/localization', () => ({
        getTranslationFn: jest.fn(() => (value: string) => value),
      }));
      jest.doMock('../../cache', () => ({
        forceUpdateCache: jest.fn(),
        loadCachedGlobal: jest.fn(() => undefined),
      }));
      jest.doMock('../../reducers/messages', () => ({
        addMessages: jest.fn(),
      }));
      jest.doMock('../../helpers/messageFetch', () => ({
        describeMessageFetchQuery: jest.fn(() => '按时间读取：上周'),
        runMessageFetch: jest.fn(),
        runMessageFetchWithContinuation: jest.fn(),
      }));
      jest.doMock('../../helpers/messageSummary', () => ({
        getMessageSummaryText: jest.fn((_: unknown, message: { text?: string }) => message.text || ''),
      }));
      jest.doMock('../../helpers/peers', () => ({
        getPeerTitle: jest.fn(() => 'peer-title'),
      }));
      jest.doMock('../../helpers/aiProviderStream', () => ({
        readAiProviderStream: jest.fn(),
      }));
      jest.doMock('../../selectors', () => ({
        selectCurrentMessageList: jest.fn(() => ({
          chatId: 'chat-1',
          threadId: 7,
          type: 'thread',
        })),
        selectLanguageCode: jest.fn(() => 'zh-hans'),
        selectTabState: jest.fn((global: any, tabId: number) => global.byTabId[tabId]),
        selectViewportIds: jest.fn(() => undefined),
        selectChatMessages: jest.fn(() => ({
          10: { id: 10, date: 300, chatId: 'chat-1' },
          20: { id: 20, date: 100, chatId: 'chat-1' },
          30: { id: 30, date: 200, chatId: 'chat-1' },
        })),
        selectChatMessage: jest.fn((global: any, chatId: string, messageId: number) => (
          global.byTabId[1].selectedMessages.chatId === chatId
            ? {
              10: { id: 10, date: 300, chatId: 'chat-1' },
              20: { id: 20, date: 100, chatId: 'chat-1' },
              30: { id: 30, date: 200, chatId: 'chat-1' },
            }[messageId]
            : undefined
        )),
        selectSender: jest.fn(() => undefined),
      }));

      await import('./ai');
    });

    const openAiAssistantWithSelectedMessages = actionHandlers.get('openAiAssistantWithSelectedMessages');
    expect(openAiAssistantWithSelectedMessages).toBeDefined();

    const nextGlobal = openAiAssistantWithSelectedMessages!(currentGlobal, {}, { tabId: 1 });

    expect(nextGlobal.byTabId[1].aiAssistant.isOpen).toBe(true);
    expect(nextGlobal.byTabId[1].aiAssistant.selectionContext).toEqual(expect.objectContaining({
      source: 'message-selection',
      chatId: 'chat-1',
      threadId: 7,
      messageIds: [20, 30, 10],
    }));
    expect(nextGlobal.byTabId[1].selectedMessages).toBeUndefined();
  });

  it(
    'appends the user turn, emits retriever and answer progress, and commits the final assistant text',
    async () => {
      const actionHandlers = new Map<string, ActionHandler>();
      const progressSnapshots: Array<ReturnType<typeof createEmptyAiAssistantState>> = [];

      let currentGlobal: any = {
        settings: {
          byKey: {
            aiSettings: {
              provider: 'anthropic',
              model: 'claude-3-5-sonnet-latest',
              apiKey: 'test-key',
              baseUrl: undefined,
            },
          },
        },
        byTabId: {
          1: {
            aiAssistant: createEmptyAiAssistantState(),
            messageLists: [],
          },
        },
      };

      const actions = {
        appendAiTurn: jest.fn(
          (payload: {
            tabId: number;
            role: 'user' | 'assistant';
            text: string;
            attachedMessageCount?: number;
            thinkingLog?: unknown;
          }) => {
            const tabState = currentGlobal.byTabId[payload.tabId];
            tabState.aiAssistant.turns = [
              ...tabState.aiAssistant.turns,
              {
                role: payload.role,
                text: payload.text,
                attachedMessageCount: payload.attachedMessageCount,
                thinkingLog: payload.thinkingLog,
              },
            ];
          },
        ),
        setAiThinkingEndedAt: jest.fn((payload: { tabId: number; thinkingEndedAt?: number }) => {
          currentGlobal.byTabId[payload.tabId].aiAssistant.thinkingEndedAt = payload.thinkingEndedAt;
        }),
        setAiActualUsedCount: jest.fn((payload: { tabId: number; actualUsedCount: number }) => {
          currentGlobal.byTabId[payload.tabId].aiAssistant.actualUsedCount = payload.actualUsedCount;
        }),
      };

      const originalFetch = globalThis.fetch;
      const fetchMock = jest.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
        const content = '最终答案：BitTensor 是一个去中心化的机器学习网络。';

        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            content: [{
              type: 'text',
              text: content,
            }],
          }),
          text: () => Promise.resolve(JSON.stringify({
            content: [{
              type: 'text',
              text: content,
            }],
          })),
        } as never);
      });

      try {
        globalThis.fetch = fetchMock as never;

        await jest.isolateModulesAsync(async () => {
          jest.doMock('../../index', () => ({
            addActionHandler: jest.fn((name: string, handler: ActionHandler) => {
              actionHandlers.set(name, handler);
            }),
            getGlobal: jest.fn(() => currentGlobal),
            setGlobal: jest.fn((next: any) => {
              currentGlobal = next;
              progressSnapshots.push(structuredClone(next.byTabId[1].aiAssistant));
            }),
            forceUpdateCache: jest.fn(),
            loadCachedGlobal: jest.fn(),
          }));
          jest.doMock('../../../util/establishMultitabRole', () => ({
            getCurrentTabId: jest.fn(() => 1),
          }));
          jest.doMock('../../../util/localization', () => ({
            getTranslationFn: jest.fn(() => (value: string) => value),
          }));
          jest.doMock('../../cache', () => ({
            forceUpdateCache: jest.fn(),
            loadCachedGlobal: jest.fn(() => undefined),
          }));
          jest.doMock('../../reducers/messages', () => ({
            addMessages: jest.fn(),
          }));
          jest.doMock('../../helpers/messageFetch', () => ({
            describeMessageFetchQuery: jest.fn(() => '按时间读取：上周'),
            runMessageFetch: jest.fn(),
            runMessageFetchWithContinuation: jest.fn(),
          }));
          jest.doMock('../../helpers/messageSummary', () => ({
            getMessageSummaryText: jest.fn((_: unknown, message: { text?: string }) => message.text || ''),
          }));
          jest.doMock('../../helpers/peers', () => ({
            getPeerTitle: jest.fn(() => 'peer-title'),
          }));
          jest.doMock('../../selectors', () => ({
            selectCurrentMessageList: jest.fn(() => undefined),
            selectLanguageCode: jest.fn(() => 'zh-hans'),
            selectTabState: jest.fn((global: any, tabId: number) => global.byTabId[tabId]),
            selectViewportIds: jest.fn(() => undefined),
            selectChatMessages: jest.fn(() => ({})),
            selectChatMessage: jest.fn(() => undefined),
            selectSender: jest.fn(() => undefined),
          }));

          await import('./ai');
        });

        const requestAiPrompt = actionHandlers.get('requestAiPrompt');
        expect(requestAiPrompt).toBeDefined();

        await requestAiPrompt!(currentGlobal, actions as never, {
          prompt: 'BitTensor 是什么？',
          tabId: 1,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, firstInit] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
        const firstRequest = JSON.parse(firstInit.body as string);
        expect(firstRequest.system).toContain('## Telegram Context');
        expect(firstRequest.messages[0].content).toContain('BitTensor 是什么？');

        expect(actions.appendAiTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
          role: 'user',
          text: 'BitTensor 是什么？',
          tabId: 1,
        }));
        expect(actions.appendAiTurn).toHaveBeenLastCalledWith(expect.objectContaining({
          role: 'assistant',
          text: '最终答案：BitTensor 是一个去中心化的机器学习网络。',
          tabId: 1,
        }));

        expect(progressSnapshots.at(-1)).toMatchObject({
          streamStatus: 'done',
          isLoading: false,
        });
        expect(progressSnapshots.at(-1)?.activeStage).toBeUndefined();
        expect(progressSnapshots.at(-1)?.draftText).toBeUndefined();
        expect(progressSnapshots.at(-1)?.finalText).toBeUndefined();

        expect(currentGlobal.byTabId[1].aiAssistant.turns).toEqual([
          expect.objectContaining({
            role: 'user',
            text: 'BitTensor 是什么？',
          }),
          expect.objectContaining({
            role: 'assistant',
            text: '最终答案：BitTensor 是一个去中心化的机器学习网络。',
          }),
        ]);
        expect(currentGlobal.byTabId[1].aiAssistant.historyMessages).toEqual([
          { role: 'user', content: 'BitTensor 是什么？' },
          {
            role: 'assistant',
            content: '最终答案：BitTensor 是一个去中心化的机器学习网络。',
          },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  it('injects selected message context into the AI prompt when selection context exists', async () => {
    const actionHandlers = new Map<string, ActionHandler>();

    let currentGlobal: any = {
      settings: {
        byKey: {
          aiSettings: {
            provider: 'anthropic',
            model: 'claude-3-5-sonnet-latest',
            apiKey: 'test-key',
            baseUrl: undefined,
          },
        },
      },
      byTabId: {
        1: {
          aiAssistant: {
            ...createEmptyAiAssistantState(),
            selectionContext: {
              source: 'message-selection',
              chatId: 'chat-1',
              threadId: 1,
              messageIds: [10, 20],
              createdAt: 123,
            },
          },
          messageLists: [],
        },
      },
    };

    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        content: [{
          type: 'text',
          text: '已整理完成',
        }],
      }),
      text: () => Promise.resolve(JSON.stringify({
        content: [{
          type: 'text',
          text: '已整理完成',
        }],
      })),
    }) as never);

    try {
      globalThis.fetch = fetchMock as never;

      await jest.isolateModulesAsync(async () => {
        jest.doMock('../../index', () => ({
          addActionHandler: jest.fn((name: string, handler: ActionHandler) => {
            actionHandlers.set(name, handler);
          }),
          getGlobal: jest.fn(() => currentGlobal),
          setGlobal: jest.fn((next: any) => {
            currentGlobal = next;
          }),
          forceUpdateCache: jest.fn(),
          loadCachedGlobal: jest.fn(),
        }));
        jest.doMock('../../../util/establishMultitabRole', () => ({
          getCurrentTabId: jest.fn(() => 1),
        }));
        jest.doMock('../../../util/localization', () => ({
          getTranslationFn: jest.fn(() => (value: string) => value),
        }));
        jest.doMock('../../cache', () => ({
          forceUpdateCache: jest.fn(),
          loadCachedGlobal: jest.fn(() => undefined),
        }));
        jest.doMock('../../reducers/messages', () => ({
          addMessages: jest.fn(),
        }));
        jest.doMock('../../helpers/messageFetch', () => ({
          describeMessageFetchQuery: jest.fn(() => '按时间读取：上周'),
          runMessageFetch: jest.fn(),
          runMessageFetchWithContinuation: jest.fn(),
        }));
        jest.doMock('../../helpers/messageSummary', () => ({
          getMessageSummaryText: jest.fn((_: unknown, message: { text?: string; id?: number }) => (
            message.text || (message.id ? `message-${message.id}` : '')
          )),
        }));
        jest.doMock('../../helpers/peers', () => ({
          getPeerTitle: jest.fn((_lang: unknown, peer: { id?: string }) => `peer-${peer.id}`),
        }));
        jest.doMock('../../selectors', () => ({
          selectCurrentMessageList: jest.fn(() => undefined),
          selectLanguageCode: jest.fn(() => 'zh-hans'),
          selectTabState: jest.fn((global: any, tabId: number) => global.byTabId[tabId]),
          selectViewportIds: jest.fn(() => undefined),
          selectChatMessages: jest.fn(() => ({})),
          selectChatMessage: jest.fn((_global: any, _chatId: string, messageId: number) => ({
            10: {
              id: 10,
              date: 1000,
              chatId: 'chat-1',
              text: '先确认一下目标',
              content: { text: { text: '先确认一下目标' } },
            },
            20: {
              id: 20,
              date: 2000,
              chatId: 'chat-1',
              text: '我建议今天发公告',
              content: { text: { text: '我建议今天发公告' } },
            },
          }[messageId])),
          selectSender: jest.fn((_global: any, message: { id: number }) => ({ id: `sender-${message.id}` })),
        }));

        await import('./ai');
      });

      const requestAiPrompt = actionHandlers.get('requestAiPrompt');
      expect(requestAiPrompt).toBeDefined();

      const actions = {
        appendAiTurn: jest.fn((payload: {
          tabId: number;
          role: 'user' | 'assistant';
          text: string;
          attachedMessageCount?: number;
        }) => {
          const tabState = currentGlobal.byTabId[payload.tabId];
          tabState.aiAssistant.turns = [
            ...tabState.aiAssistant.turns,
            {
              role: payload.role,
              text: payload.text,
              attachedMessageCount: payload.attachedMessageCount,
              createdAt: Date.now(),
            },
          ];
        }),
        setAiThinkingEndedAt: jest.fn(),
        setAiActualUsedCount: jest.fn(),
      };

      await requestAiPrompt!(currentGlobal, {
        ...actions,
      } as never, {
        prompt: '帮我写个回复',
        tabId: 1,
      });

      const [, firstInit] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
      const firstRequest = JSON.parse(firstInit.body as string);
      expect(firstRequest.system).toContain('## Selected Message Context');
      expect(firstRequest.messages[0].content).toContain('用户显式选中了以下消息');
      expect(firstRequest.messages[0].content).toContain('peer-sender-10');
      expect(firstRequest.messages[0].content).toContain('先确认一下目标');
      expect(firstRequest.messages[0].content).toContain('我建议今天发公告');
      expect(currentGlobal.byTabId[1].aiAssistant.turns[0]).toEqual(expect.objectContaining({
        role: 'user',
        text: '帮我写个回复',
        attachedMessageCount: 2,
      }));
      expect(currentGlobal.byTabId[1].aiAssistant.selectionContext).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
