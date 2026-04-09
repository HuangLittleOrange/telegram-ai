import {
  buildAiThinkingSummary,
  createAiThinkingTraceStep,
  formatAiThinkingDuration,
  summarizeAiJudgeDecision,
  summarizeAiRetrievalPlan,
} from './aiThinking';

describe('ai thinking helper', () => {
  it('formats elapsed time as minutes and seconds', () => {
    expect(formatAiThinkingDuration(2000)).toBe('2s');
    expect(formatAiThinkingDuration(3 * 60 * 1000 + 20 * 1000)).toBe('3m 20s');
  });

  it('builds a collapsed summary for a finished reasoning log', () => {
    const summary = buildAiThinkingSummary({
      startedAt: 1000,
      endedAt: 201000,
      steps: [
        { stage: 'retriever', title: '正在理解你的问题', createdAt: 1000 },
        { stage: 'retriever', title: '正在规划信息收集路径', createdAt: 2000 },
      ],
    });

    expect(summary.label).toContain('已处理');
    expect(summary.label).toContain('3m 20s');
    expect(summary.stepCount).toBe(2);
  });

  it('normalizes explicit trace steps for display', () => {
    expect(createAiThinkingTraceStep({
      stage: 'retriever',
      title: '正在规划信息收集路径',
      detail: '基于当前聊天记录决定是否继续向前收集',
      createdAt: 1234,
    })).toEqual({
      stage: 'retriever',
      title: '正在规划信息收集路径',
      detail: '基于当前聊天记录决定是否继续向前收集',
      createdAt: 1234,
    });
  });

  it('summarizes a retrieval plan for visible trace', () => {
    const summary = summarizeAiRetrievalPlan({
      goal: '帮助用户反驳 EOSUSA',
      retrievalGoals: ['找到 EOSUSA 的原话', '找到群里反驳他的证据'],
      targetEvidenceTypes: ['original_quote', 'counter_argument'],
      speakerHints: ['EOSUSA'],
      timeHints: ['today'],
    });

    expect(summary.title).toContain('信息收集目标');
    expect(summary.title).toContain('EOSUSA');
    expect(summary.detail).toContain('原话');
    expect(summary.detail).toContain('反驳点');
    expect(summary.detail).toContain('EOSUSA');
    expect(summary.detail).toContain('信息类型');
  });

  it('summarizes a judge decision for visible trace', () => {
    const summary = summarizeAiJudgeDecision({
      enough: false,
      reason: '还缺少起因消息',
      missing: ['起因消息', '反驳证据'],
      nextQueries: ['起因', '反驳'],
      historyInstruction: '继续向前补历史上下文',
    });

    expect(summary.title).toContain('任务判断');
    expect(summary.title).toContain('继续收集');
    expect(summary.detail).toContain('起因消息');
    expect(summary.detail).toContain('反驳证据');
    expect(summary.detail).toContain('下一轮');
    expect(summary.detail).toContain('动作');
    expect(summary.detail).toContain('继续向前补历史上下文');
  });
});
