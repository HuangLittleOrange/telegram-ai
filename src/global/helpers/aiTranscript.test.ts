import {
  buildAiConversationMessages,
  buildPersistentAiHistoryMessages,
  resolveAiConversationTurnsForRequest,
  serializeOpenAiCompatibleMessages,
} from './aiTranscript';

describe('ai transcript helper', () => {
  it('ignores stale persisted history on the first conversation turn', () => {
    const staleHistory = [
      { role: 'user' as const, content: 'old question' },
      { role: 'assistant' as const, content: 'old answer' },
    ];

    expect(resolveAiConversationTurnsForRequest({
      isFirstConversationTurn: true,
      historyMessages: staleHistory,
      turns: [{ role: 'user', content: 'fresh question' }],
    })).toEqual([]);

    expect(resolveAiConversationTurnsForRequest({
      isFirstConversationTurn: false,
      historyMessages: staleHistory,
      turns: [{ role: 'user', content: 'fresh question' }],
    })).toEqual(staleHistory);

    expect(resolveAiConversationTurnsForRequest({
      isFirstConversationTurn: false,
      turns: staleHistory,
    })).toEqual(staleHistory);
  });

  it('appends the current prompt when it is missing from the turn history', () => {
    const result = buildAiConversationMessages({
      systemPrompt: 'system',
      evidenceLines: [],
      toolOutputLines: [],
      turns: [{ role: 'assistant', content: 'hello' }],
      currentPrompt: '最近一周聊了什么',
    });

    expect(result).toEqual([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: '最近一周聊了什么' },
    ]);
  });

  it('does not duplicate the trailing current prompt', () => {
    const result = buildAiConversationMessages({
      systemPrompt: 'system',
      evidenceLines: [],
      toolOutputLines: [],
      turns: [
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: '最近一周聊了什么' },
      ],
      currentPrompt: '最近一周聊了什么',
    });

    expect(result).toEqual([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: '最近一周聊了什么' },
    ]);
  });

  it('preserves chronological replay of prior turns', () => {
    const turns = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn-${index + 1}`,
    }));

    const result = buildAiConversationMessages({
      systemPrompt: 'system',
      evidenceLines: [],
      toolOutputLines: [],
      turns,
      currentPrompt: 'BitTensor 是什么？',
    });

    expect(result.slice(1, -1)).toEqual(turns);
    expect(result.at(-1)).toEqual({ role: 'user', content: 'BitTensor 是什么？' });
  });

  it('preserves assistant tool call messages when rebuilding the conversation payload', () => {
    const result = buildAiConversationMessages({
      systemPrompt: 'system',
      evidenceLines: [],
      toolOutputLines: [],
      turns: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'history-fetch',
              arguments: '{"mode":"range"}',
            },
          }],
        },
        {
          role: 'tool',
          content: '{"total":10}',
          tool_call_id: 'call-1',
        },
      ],
      currentPrompt: 'BitTensor 是什么？',
    });

    expect(result[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: {
          name: 'history-fetch',
          arguments: '{"mode":"range"}',
        },
      }],
    });
    expect(result[2]).toEqual({
      role: 'tool',
      content: '{"total":10}',
      tool_call_id: 'call-1',
    });
  });

  it('keeps tool messages in persisted history and appends the final assistant answer', () => {
    const result = buildPersistentAiHistoryMessages([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '上周聊了什么' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'history-fetch',
            arguments: '{"mode":"range"}',
          },
        }],
      },
      {
        role: 'tool',
        content: '{"total":894}',
        tool_call_id: 'call-1',
      },
    ], '上周主要在讨论治理和投票');

    expect(result).toEqual([
      { role: 'user', content: '上周聊了什么' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'history-fetch',
            arguments: '{"mode":"range"}',
          },
        }],
      },
      {
        role: 'tool',
        content: '{"total":894}',
        tool_call_id: 'call-1',
      },
      {
        role: 'assistant',
        content: '上周主要在讨论治理和投票',
      },
    ]);
  });

  it('serializes OpenAI-compatible messages without dropping tool metadata', () => {
    expect(serializeOpenAiCompatibleMessages([
      { role: 'system', content: 'system prompt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'history-fetch',
            arguments: '{"mode":"recent","limit":5}',
          },
        }],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
    ])).toEqual([
      { role: 'system', content: 'system prompt' },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'history-fetch',
            arguments: '{"mode":"recent","limit":5}',
          },
        }],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
    ]);
  });
});
