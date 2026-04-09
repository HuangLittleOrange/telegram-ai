import {
  normalizeOpenAiStreamChunks,
  readAiProviderStream,
} from './aiProviderStream';

describe('aiProviderStream', () => {
  it('normalizes OpenAI-style streaming chunks into answer and termination events', () => {
    const events = normalizeOpenAiStreamChunks({
      runId: 'run-1',
      chunks: [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: [DONE]',
      ],
    });

    expect(events).toEqual([
      {
        type: 'answer.delta',
        runId: 'run-1',
        createdAt: expect.any(Number),
        textDelta: 'Hello',
      },
      {
        type: 'run.done',
        runId: 'run-1',
        createdAt: expect.any(Number),
      },
    ]);
  });

  it('normalizes Gemini-style streaming chunks into answer and termination events', () => {
    const events = normalizeOpenAiStreamChunks({
      runId: 'run-2',
      chunks: [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}',
        'data: [DONE]',
      ],
    });

    expect(events).toEqual([
      {
        type: 'answer.delta',
        runId: 'run-2',
        createdAt: expect.any(Number),
        textDelta: 'Hi',
      },
      {
        type: 'run.done',
        runId: 'run-2',
        createdAt: expect.any(Number),
      },
    ]);
  });

  it('stops consuming chunks when the abort signal is triggered', async () => {
    const controller = new AbortController();
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: Buffer.from('data: {"choices":[{"delta":{"content":"Hel"}}]}\n'),
        })
        .mockImplementationOnce(async () => {
          controller.abort();
          throw new DOMException('The operation was aborted.', 'AbortError');
        }),
      cancel: jest.fn(),
    };

    const events: unknown[] = [];
    await expect(readAiProviderStream({
      runId: 'run-1',
      signal: controller.signal,
      reader: reader as any,
      onEvent: (event) => events.push(event),
    })).resolves.toBeUndefined();

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'answer.delta',
      runId: 'run-1',
      textDelta: 'Hel',
    }));
    expect(events[1]).toEqual(expect.objectContaining({
      type: 'run.cancelled',
      runId: 'run-1',
    }));
  });

  it('hides think content from visible deltas and splits large answer chunks into smaller updates', async () => {
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: Buffer.from(
            'data: {"choices":[{"delta":{"content":"<think>hidden reasoning</think>第一句。第二句。第三句。第四句。第五句。第六句。"}}]}\n',
          ),
        })
        .mockResolvedValueOnce({
          done: true,
          value: undefined,
        }),
      cancel: jest.fn(),
    };

    const events: any[] = [];
    await expect(readAiProviderStream({
      runId: 'run-2',
      reader: reader as any,
      onEvent: (event) => events.push(event),
    })).resolves.toBeUndefined();

    const deltaEvents = events.filter((event) => event.type === 'answer.delta');
    expect(deltaEvents.length).toBeGreaterThan(1);
    expect(deltaEvents.map((event) => event.textDelta).join(''))
      .toBe('第一句。第二句。第三句。第四句。第五句。第六句。');
    expect(deltaEvents.some((event) => String(event.textDelta).includes('<think>'))).toBe(false);
  });
});
