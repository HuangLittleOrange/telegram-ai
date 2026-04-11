import * as aiContext from './aiContext';

describe('ai context helper', () => {
  it('builds a shared system prompt with time context', () => {
    const prompt = aiContext.buildAiSystemPrompt({
      now: new Date('2026-04-09T11:38:00+08:00').getTime(),
      timeZone: 'Asia/Shanghai',
    });

    expect(prompt).toContain('## Identity');
    expect(prompt).toContain('## Time Context');
    expect(prompt).toContain('当前时间：2026-04-09 11:38');
    expect(prompt).toContain('当前时区：Asia/Shanghai');
    expect(prompt).toContain('## Tool Contract');
    expect(prompt).toContain('history-fetch');
    expect(prompt).toContain('## Protocol');
  });

  it('appends Telegram-specific request context after the shared system prompt', () => {
    const prompt = aiContext.buildAiRequestSystemPrompt({
      now: new Date('2026-04-09T11:38:00+08:00').getTime(),
      timeZone: 'Asia/Shanghai',
    });

    const sharedPrompt = aiContext.buildAiSystemPrompt({
      now: new Date('2026-04-09T11:38:00+08:00').getTime(),
      timeZone: 'Asia/Shanghai',
    });

    expect(prompt).toContain(sharedPrompt);
    expect(prompt).toContain('## Telegram Context');
    expect(prompt).toContain('当前任务是围绕 Telegram 聊天记录完成总结、回复、待办或检索');
    expect(prompt.indexOf('## Telegram Context')).toBeGreaterThan(prompt.indexOf('## Time Context'));
  });

  it('builds the final-answer system prompt with time context and no execution helpers', () => {
    const prompt = aiContext.buildAiFinalAnswerSystemPrompt({
      now: new Date('2026-04-09T11:38:00+08:00').getTime(),
      timeZone: 'Asia/Shanghai',
    });

    expect(prompt).toContain('## Final Answer Mode');
    expect(prompt).toContain('当前阶段不能调用任何工具');
    expect(prompt).toContain('当前时间：2026-04-09 11:38');
    expect(prompt).toContain('当前时区：Asia/Shanghai');
  });

  it('only exposes context assembly helpers', () => {
    expect(Object.keys(aiContext)).toEqual(expect.arrayContaining([
      'buildAiFinalAnswerSystemPrompt',
      'buildAiRequestSystemPrompt',
      'buildAiSystemPrompt',
      'getAiPromptTimeContext',
    ]));
  });
});
