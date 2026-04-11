import { runAiQueryLoop } from './aiQueryLoop';

describe('aiQueryLoop', () => {
  it('returns a direct answer from the same loop without a follow-up completion', async () => {
    const complete = jest.fn(() => Promise.resolve({
      content: '直接答案',
    }));

    const result = await runAiQueryLoop({
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'BitTensor 是什么？' },
      ],
      complete,
      executeTool: jest.fn(),
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: '直接答案',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'BitTensor 是什么？' },
      ],
    });
  });

  it('runs tool calls and returns the final answer from the same loop', async () => {
    const complete = jest.fn((messages) => {
      if (messages.length === 2) {
        return Promise.resolve({
          content: '我先查一下',
          toolCalls: [{
            id: 'call-1',
            type: 'function' as const,
            function: {
              name: 'history-fetch',
              arguments: '{"mode":"range"}',
            },
          }],
        });
      }

      return Promise.resolve({
        content: '最终答案',
      });
    });

    const result = await runAiQueryLoop({
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '上周聊了什么？' },
      ],
      complete,
      executeTool: () => Promise.resolve({
        role: 'tool',
        tool_call_id: 'call-1',
        name: 'history-fetch',
        content: '{"total":1}',
      }),
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('最终答案');
    expect(result.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '上周聊了什么？' },
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
      {
        role: 'tool',
        tool_call_id: 'call-1',
        name: 'history-fetch',
        content: '{"total":1}',
      },
    ]);
  });

  it('stops after maxSteps to avoid infinite tool loops', async () => {
    await expect(runAiQueryLoop({
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '继续查' },
      ],
      complete: () => Promise.resolve({
        content: '继续调用',
        toolCalls: [{
          id: 'call-1',
          type: 'function' as const,
          function: {
            name: 'history-fetch',
            arguments: '{"mode":"range"}',
          },
        }],
      }),
      executeTool: () => Promise.resolve({
        role: 'tool',
        tool_call_id: 'call-1',
        name: 'history-fetch',
        content: '{"total":1}',
      }),
      maxSteps: 2,
    })).rejects.toThrow('AI agent loop exceeded 2 steps');
  });
});
