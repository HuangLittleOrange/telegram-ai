import {
  consumeAssistantThinkDelta,
  createAssistantThinkStreamState,
  flushAssistantThinkState,
  sanitizeAssistantText,
} from './aiText';

describe('aiText think stream parser', () => {
  it('moves think block out of visible text', () => {
    const state = createAssistantThinkStreamState();
    const result = consumeAssistantThinkDelta(state, '<think>内部推理</think>这是答案');

    expect(result.visibleText).toBe('这是答案');
    expect(result.thinkBlocks).toEqual(['内部推理']);
  });

  it('handles split think tags across stream chunks', () => {
    const state = createAssistantThinkStreamState();
    const visibleParts: string[] = [];
    const thinkParts: string[] = [];

    ['前缀<th', 'ink>推理片段', '</th', 'ink>后缀'].forEach((chunk) => {
      const parsed = consumeAssistantThinkDelta(state, chunk);
      if (parsed.visibleText) {
        visibleParts.push(parsed.visibleText);
      }
      thinkParts.push(...parsed.thinkBlocks);
    });

    const flushed = flushAssistantThinkState(state);
    if (flushed.visibleText) {
      visibleParts.push(flushed.visibleText);
    }
    thinkParts.push(...flushed.thinkBlocks);

    expect(visibleParts.join('')).toBe('前缀后缀');
    expect(thinkParts).toEqual(['推理片段']);
  });

  it('flushes unclosed think content to thinking panel', () => {
    const state = createAssistantThinkStreamState();
    consumeAssistantThinkDelta(state, '<think>还在思考');

    const flushed = flushAssistantThinkState(state);
    expect(flushed.visibleText).toBe('');
    expect(flushed.thinkBlocks).toEqual(['还在思考']);
  });

  it('sanitizes think block from final assistant text', () => {
    expect(sanitizeAssistantText('<think>hidden</think>\n最终答案')).toBe('最终答案');
  });

  it('moves escaped think block out of visible text', () => {
    const state = createAssistantThinkStreamState();
    const result = consumeAssistantThinkDelta(state, '&lt;think&gt;内部推理&lt;/think&gt;这是答案');

    expect(result.visibleText).toBe('这是答案');
    expect(result.thinkBlocks).toEqual(['内部推理']);
  });

  it('handles split escaped think tags across stream chunks', () => {
    const state = createAssistantThinkStreamState();
    const visibleParts: string[] = [];
    const thinkParts: string[] = [];

    ['前缀&lt;th', 'ink&gt;推理片段', '&lt;/th', 'ink&gt;后缀'].forEach((chunk) => {
      const parsed = consumeAssistantThinkDelta(state, chunk);
      if (parsed.visibleText) {
        visibleParts.push(parsed.visibleText);
      }
      thinkParts.push(...parsed.thinkBlocks);
    });

    const flushed = flushAssistantThinkState(state);
    if (flushed.visibleText) {
      visibleParts.push(flushed.visibleText);
    }
    thinkParts.push(...flushed.thinkBlocks);

    expect(visibleParts.join('')).toBe('前缀后缀');
    expect(thinkParts).toEqual(['推理片段']);
  });
});
