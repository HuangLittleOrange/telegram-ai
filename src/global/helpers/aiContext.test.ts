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

  it('includes local sync coverage in request prompt when chat sync state is available', () => {
    const prompt = aiContext.buildAiRequestSystemPrompt({
      now: new Date('2026-04-16T15:41:00+08:00').getTime(),
      timeZone: 'Asia/Shanghai',
      syncCoverage: {
        chatId: '-1001234567890',
        oldestSyncedDate: new Date('2025-08-05T00:00:00+08:00').getTime(),
        newestSyncedDate: new Date('2026-04-16T00:00:00+08:00').getTime(),
        syncedMessages: 65015,
        totalMessages: 332121,
      },
    });

    expect(prompt).toContain('## Local Sync Coverage');
    expect(prompt).toContain('当前聊天：-1001234567890');
    expect(prompt).toContain('本地已同步时间范围：2025-08-05 至 2026-04-16');
    expect(prompt).toContain('本地已同步消息数：65015 / 332121');
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

  it('builds English system prompts when languageCode is English', () => {
    const prompt = aiContext.buildAiRequestSystemPrompt({
      now: new Date('2026-04-09T11:38:00+08:00').getTime(),
      timeZone: 'Asia/Shanghai',
      languageCode: 'en',
      syncCoverage: {
        chatId: '-1001234567890',
        oldestSyncedDate: new Date('2025-08-05T00:00:00+08:00').getTime(),
        newestSyncedDate: new Date('2026-04-16T00:00:00+08:00').getTime(),
        syncedMessages: 65015,
        totalMessages: 332121,
      },
    });

    expect(prompt).toContain('## Identity');
    expect(prompt).toContain('Current time: 2026-04-09 11:38');
    expect(prompt).toContain('Current time zone: Asia/Shanghai');
    expect(prompt).toContain('Current chat: -1001234567890');
    expect(prompt).toContain('Locally synced date range: 2025-08-05 to 2026-04-16');
    expect(prompt).toContain('Locally synced messages: 65015 / 332121');
    expect(prompt).toContain('## Telegram Context');
    expect(prompt).toContain('focused on Telegram chat history');
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
