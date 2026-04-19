describe('ui chats actions', () => {
  it('closes AI assistant when opening thread info', async () => {
    const actionHandlers = new Map<string, (...args: any[]) => any>();

    let currentGlobal: any = {
      byTabId: {
        1: {
          chatInfo: {
            isOpen: false,
          },
          aiAssistant: {
            isOpen: true,
            turns: [],
          },
        },
      },
    };

    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../index', () => ({
        addActionHandler: jest.fn((name: string, handler: (...args: any[]) => any) => {
          actionHandlers.set(name, handler);
        }),
        execAfterActions: jest.fn((callback: () => void) => {
          callback();
        }),
        getGlobal: jest.fn(() => currentGlobal),
        setGlobal: jest.fn((next: any) => {
          currentGlobal = next;
        }),
      }));

      jest.doMock('../../../util/establishMultitabRole', () => ({
        getCurrentTabId: jest.fn(() => 1),
      }));

      jest.doMock('../../reducers', () => ({
        closeMiddleSearch: jest.fn((global: any) => global),
        exitMessageSelectMode: jest.fn((global: any) => global),
        updateCurrentMessageList: jest.fn((global: any) => global),
        updateRequestedChatTranslation: jest.fn((global: any) => global),
      }));

      jest.doMock('../../reducers/tabs', () => ({
        updateTabState: jest.fn((global: any, patch: any, tabId: number) => ({
          ...global,
          byTabId: {
            ...global.byTabId,
            [tabId]: {
              ...global.byTabId[tabId],
              ...patch,
            },
          },
        })),
      }));

      jest.doMock('../../reducers/threads', () => ({
        replaceTabThreadParam: jest.fn((global: any) => global),
      }));

      jest.doMock('../../selectors', () => ({
        selectChat: jest.fn(() => undefined),
        selectCurrentMessageList: jest.fn(() => ({
          chatId: 'chat-1',
          threadId: 1,
          type: 'thread',
        })),
        selectTabState: jest.fn((global: any, tabId: number) => global.byTabId[tabId]),
      }));

      await import('./chats');
    });

    const openThreadWithInfo = actionHandlers.get('openThreadWithInfo');
    expect(openThreadWithInfo).toBeDefined();

    openThreadWithInfo!(
      currentGlobal,
      {
        openThread: jest.fn(),
      },
      {
        chatId: 'chat-1',
        threadId: 1,
        tabId: 1,
      },
    );

    expect(currentGlobal.byTabId[1].chatInfo.isOpen).toBe(true);
    expect(currentGlobal.byTabId[1].aiAssistant.isOpen).toBe(false);
  });
});
