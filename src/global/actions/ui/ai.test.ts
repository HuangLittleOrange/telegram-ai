import { createEmptyAiAssistantState } from '../../helpers/aiRunState';

describe('ui ai action', () => {
  it('appends the user turn, emits retriever and answer progress, and commits the final assistant text', async () => {
    const actionHandlers = new Map<string, Function>();
    const progressSnapshots: Array<ReturnType<typeof createEmptyAiAssistantState>> = [];

    let currentGlobal: any = {
      settings: {
        byKey: {
          aiSettings: {
            provider: 'openai',
            model: 'gpt-4.1-mini',
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
      appendAiTurn: jest.fn((payload: { tabId: number; role: 'user' | 'assistant'; text: string; thinkingLog?: unknown }) => {
        const tabState = currentGlobal.byTabId[payload.tabId];
        tabState.aiAssistant.turns = [
          ...tabState.aiAssistant.turns,
          {
            role: payload.role,
            text: payload.text,
            thinkingLog: payload.thinkingLog,
          },
        ];
      }),
      setAiThinkingEndedAt: jest.fn((payload: { tabId: number; thinkingEndedAt?: number }) => {
        currentGlobal.byTabId[payload.tabId].aiAssistant.thinkingEndedAt = payload.thinkingEndedAt;
      }),
      setAiActualUsedCount: jest.fn((payload: { tabId: number; actualUsedCount: number }) => {
        currentGlobal.byTabId[payload.tabId].aiAssistant.actualUsedCount = payload.actualUsedCount;
      }),
    };

    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const content = body.tools?.length
        ? '我先直接回答。'
        : '最终答案：BitTensor 是一个去中心化的机器学习网络。';

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content,
            },
          }],
        }),
        text: async () => JSON.stringify({
          choices: [{
            message: {
              content,
            },
          }],
        }),
      } as never;
    });

    try {
      globalThis.fetch = fetchMock as never;

      await jest.isolateModulesAsync(async () => {
        jest.doMock('../../index', () => ({
          addActionHandler: jest.fn((name: string, handler: Function) => {
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
          selectTabState: jest.fn((global: any, tabId: number) => global.byTabId[tabId]),
          selectViewportIds: jest.fn(() => undefined),
          selectChatMessages: jest.fn(() => ({})),
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

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstRequest = JSON.parse(String(fetchMock.mock.calls[0][1]?.body || '{}'));
      const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body || '{}'));
      expect(firstRequest.tools).toBeDefined();
      expect(secondRequest.tools).toBeUndefined();

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

      expect(progressSnapshots.some((snapshot) => snapshot.streamStatus === 'streaming' && snapshot.activeStage === 'retriever')).toBe(true);
      expect(progressSnapshots.some((snapshot) => snapshot.streamStatus === 'streaming' && snapshot.activeStage === 'answer' && snapshot.finalText === '最终答案：BitTensor 是一个去中心化的机器学习网络。')).toBe(true);
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
        { role: 'assistant', content: '最终答案：BitTensor 是一个去中心化的机器学习网络。' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
