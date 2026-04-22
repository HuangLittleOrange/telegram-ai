import {
  resolveAiAgentConversation,
  runAiAgentLoop,
} from './aiAgentRuntime';

describe('aiAgentRuntime', () => {
  it('returns the conversation unchanged when the assistant answers directly', async () => {
    const conversation = await resolveAiAgentConversation({
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'BitTensor 是什么？' },
      ],
      complete: () => Promise.resolve({
        content: 'BitTensor 是一个去中心化的机器学习网络。',
      }),
      executeTool: jest.fn(),
    });

    expect(conversation).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'BitTensor 是什么？' },
    ]);
  });

  it(
    'returns the transcript with assistant tool calls and tool messages when a tool is used before the final answer',
    async () => {
      const result = await runAiAgentLoop({
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: '最近一周聊了什么' },
        ],
        complete: (messages) => {
          if (messages.length === 2) {
            return Promise.resolve({
              content: '我先查一下',
              toolCalls: [{
                id: 'call-1',
                type: 'function' as const,
                function: {
                  name: 'history-fetch',
                  arguments: '{"mode":"recent","limit":5}',
                },
              }],
            });
          }

          return Promise.resolve({
            content: '最终答案',
          });
        },
        executeTool: (toolCall) => Promise.resolve({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: '{"messages":[{"messageId":1}],"total":1}',
        }),
      });

      expect(result.content).toBe('最终答案');
      expect(result.messages).toEqual([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '最近一周聊了什么' },
        {
          role: 'assistant',
          content: '我先查一下',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'history-fetch',
              arguments: '{"mode":"recent","limit":5}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          name: 'history-fetch',
          content: '{"messages":[{"messageId":1}],"total":1}',
        },
      ]);
    },
  );

  it('replays assistant history and tool results through the loop', async () => {
    const seenMessages: Array<Array<{ role: string; content: string }>> = [];

    const result = await runAiAgentLoop({
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'assistant', content: '上一轮 AI 回复' },
        { role: 'user', content: '最近一周聊了什么' },
      ],
      complete: (messages) => {
        seenMessages.push(messages.map((message) => ({
          role: message.role,
          content: message.content,
        })));

        if (seenMessages.length === 1) {
          return Promise.resolve({
            content: '我先查一下',
            toolCalls: [{
              id: 'call-1',
              type: 'function' as const,
              function: {
                name: 'history-fetch',
                arguments: '{"mode":"recent","limit":5}',
              },
            }],
          });
        }

        return Promise.resolve({
          content: '最终答案',
        });
      },
      executeTool: (toolCall) => {
        expect(toolCall.function.name).toBe('history-fetch');
        return Promise.resolve({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: '{"messages":[{"messageId":1}],"total":1}',
        });
      },
    });

    expect(result.content).toBe('最终答案');
    expect(seenMessages).toHaveLength(2);
    expect(seenMessages[0]).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: '上一轮 AI 回复' },
      { role: 'user', content: '最近一周聊了什么' },
    ]);
    expect(seenMessages[1]).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: '上一轮 AI 回复' },
      { role: 'user', content: '最近一周聊了什么' },
      { role: 'assistant', content: '我先查一下' },
      { role: 'tool', content: '{"messages":[{"messageId":1}],"total":1}' },
    ]);
  });
});
