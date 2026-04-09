jest.mock('../../util/establishMultitabRole', () => ({
  getCurrentTabId: jest.fn(() => 1),
}));

jest.mock('../helpers', () => ({
  isChatBasicGroup: jest.fn(() => false),
  isChatSuperGroup: jest.fn(() => false),
}));

jest.mock('../helpers/replies', () => ({
  getMessageReplyInfo: jest.fn(() => undefined),
}));

jest.mock('./chats', () => ({
  selectChat: jest.fn(() => undefined),
}));

jest.mock('./tabs', () => ({
  selectTabState: jest.fn(() => ({})),
}));

import { MAIN_THREAD_ID } from '../../api/types';

import { selectThread, selectThreadInfo, selectThreadLocalState, selectThreadReadState } from './threads';

describe('selectThread', () => {
  it('returns undefined when a chat exists without threadsById', () => {
    const global = {
      messages: {
        byChatId: {
          chat1: {
            byId: {},
            summaryById: {},
          },
        },
      },
    } as any;

    expect(selectThread(global, 'chat1', MAIN_THREAD_ID)).toBeUndefined();
    expect(selectThreadReadState(global, 'chat1', MAIN_THREAD_ID)).toBeUndefined();
    expect(selectThreadLocalState(global, 'chat1', MAIN_THREAD_ID)).toBeUndefined();
    expect(selectThreadInfo(global, 'chat1', MAIN_THREAD_ID)).toBeUndefined();
  });

  it('returns the thread when threadsById exists', () => {
    const thread = {
      localState: { draft: 'hello' },
      readState: { unreadCount: 3 },
      threadInfo: { threadId: MAIN_THREAD_ID, chatId: 'chat1' },
    };
    const global = {
      messages: {
        byChatId: {
          chat1: {
            byId: {},
            threadsById: {
              [MAIN_THREAD_ID]: thread,
            },
            summaryById: {},
          },
        },
      },
    } as any;

    expect(selectThread(global, 'chat1', MAIN_THREAD_ID)).toEqual(thread);
    expect(selectThreadReadState(global, 'chat1', MAIN_THREAD_ID)).toEqual(thread.readState);
    expect(selectThreadLocalState(global, 'chat1', MAIN_THREAD_ID)).toEqual(thread.localState);
    expect(selectThreadInfo(global, 'chat1', MAIN_THREAD_ID)).toEqual(thread.threadInfo);
  });
});
