import { formatAiToolOutputSummary } from './aiToolOutput';

describe('formatAiToolOutputSummary', () => {
  it('does not expose payload parameters in the summary', () => {
    const summary = formatAiToolOutputSummary({
      type: 'history.backfill',
      description: '继续向前补回历史聊天记录',
      payload: {
        fetchedCount: 100,
        beforeMessageId: 46420,
      },
      createdAt: 1712451200000,
    });

    expect(summary.title).toBe('继续向前补回历史聊天记录');
    expect(summary.detail).toBe('工具已完成');
  });

  it('summarizes keyword fetches as keyword mode', () => {
    const summary = formatAiToolOutputSummary({
      type: 'message.fetch',
      query: {
        mode: 'keyword',
        keyword: '官老师',
      },
      result: {
        messages: [],
        total: 2,
        truncated: false,
        evidenceIds: [],
      },
      createdAt: 1712451200000,
    });

    expect(summary.title).toBe('按关键词查看');
    expect(summary.detail).toBe('命中 2 条 · 结果完整');
  });
});
