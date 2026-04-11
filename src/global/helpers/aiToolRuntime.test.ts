import {
  executeHistoryFetchToolCall,
  formatHistoryFetchToolResultForModel,
  resolveHistoryFetchToolCallQuery,
  shouldOfferHistoryFetchTool,
} from './aiToolRuntime';

describe('aiToolRuntime', () => {
  it('executes a valid history-fetch tool call and returns a tool message', async () => {
    const executeQuery = jest.fn(({ query }) => Promise.resolve({
      messages: [{
        chatId: 'chat-1',
        threadId: -1,
        messageId: 101,
        sender: 'look',
        date: new Date(2026, 3, 8, 13, 7).getTime() / 1000,
        text: 'VST 相关讨论',
      }],
      total: 1,
      truncated: false,
      evidenceIds: [101],
      summary: '按时间获取到 1 条消息',
    }));

    const result = await executeHistoryFetchToolCall({
      toolCall: {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'history-fetch',
          arguments: JSON.stringify({
            mode: 'range',
            timeRange: {
              fromDate: '2026-04-08',
              toDate: '2026-04-10',
              preset: 'lastWeek',
            },
            limit: 20,
            unexpected: 'ignored',
          }),
        },
      },
      userPrompt: '上周聊了什么话题',
      now: new Date(2026, 3, 10, 22, 32).getTime(),
      createdAt: new Date(2026, 3, 10, 22, 32).getTime(),
      executeQuery,
    });

    expect(executeQuery).toHaveBeenCalledTimes(1);
    expect(executeQuery).toHaveBeenCalledWith(expect.objectContaining({
      query: {
        mode: 'range',
        timeRange: {
          mode: 'custom',
          startAt: new Date(2026, 2, 30).getTime(),
          endAt: new Date(2026, 3, 6).getTime(),
        },
        limit: 20,
      },
    }));
    expect(result.toolOutput).toEqual({
      type: 'message.fetch',
      query: {
        mode: 'range',
        timeRange: {
          mode: 'custom',
          startAt: new Date(2026, 2, 30).getTime(),
          endAt: new Date(2026, 3, 6).getTime(),
        },
        limit: 20,
      },
      result: expect.objectContaining({ total: 1 }),
      createdAt: new Date(2026, 3, 10, 22, 32).getTime(),
    });
    expect(result.message).toEqual(expect.objectContaining({
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'history-fetch',
    }));
    expect(result.message.content).toContain('"total": 1');
    expect(result.message.content).toContain('look: VST 相关讨论');
  });

  it('throws a controlled error for invalid json tool arguments', () => {
    expect(() => resolveHistoryFetchToolCallQuery({
      toolCall: {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'history-fetch',
          arguments: '{bad json',
        },
      },
      userPrompt: '上周聊了什么话题',
    })).toThrow('Invalid history-fetch tool arguments');
  });

  it('rejects unsupported tools before execution', () => {
    expect(() => resolveHistoryFetchToolCallQuery({
      toolCall: {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'search-web',
          arguments: '{}',
        },
      },
      userPrompt: '帮我查一下',
    })).toThrow('Unsupported AI tool: search-web');
  });

  it('formats tool results with query metadata and fetched messages', () => {
    const content = formatHistoryFetchToolResultForModel({
      mode: 'keyword',
      keyword: 'VST',
      limit: 5,
    }, {
      messages: [{
        chatId: 'chat-1',
        threadId: -1,
        messageId: 101,
        sender: 'look',
        date: new Date(2026, 3, 8, 13, 7).getTime() / 1000,
        text: 'VST 相关讨论',
      }],
      total: 1,
      truncated: false,
      evidenceIds: [101],
      summary: '按关键词获取到 1 条消息',
    });

    expect(content).toContain('"query": "关键词：VST"');
    expect(content).toContain('"summary": "按关键词获取到 1 条消息"');
    expect(content).toContain('"messageCount": 1');
    expect(content).toContain('look: VST 相关讨论');
  });

  it('offers history-fetch only before a tool message exists', () => {
    expect(shouldOfferHistoryFetchTool([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '上周聊了什么' },
    ])).toBe(true);

    expect(shouldOfferHistoryFetchTool([
      { role: 'system', content: 'system prompt' },
      {
        role: 'assistant',
        content: '我先查一下',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'history-fetch',
            arguments: '{"mode":"range"}',
          },
        }],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
    ])).toBe(false);
  });
});
