import {
  type AiEvidenceItem,
  parseAiJudgeDecision,
  parseAiQueryPlan,
  rankAiEvidenceByPlan,
  runAiPlannerRetrieverJudge,
} from './aiOrchestrator';

describe('ai orchestrator', () => {
  const evidence = (messageId: number, text: string, source: AiEvidenceItem['source'] = 'recent'): AiEvidenceItem => ({
    chatId: 'chat-1',
    threadId: 1,
    messageId,
    sender: 'Alice',
    text,
    source,
  });

  describe('parseAiQueryPlan', () => {
    it('parses JSON wrapped in markdown fences', () => {
      expect(parseAiQueryPlan([
        '```json',
        JSON.stringify({
          goal: '解释社区为什么选择无视',
          nextAction: 'history.fetch',
          nextActionReason: '需要查找官老师',
          toolName: 'history.fetch',
          toolArgs: {
            mode: 'keyword',
            keyword: '官老师',
            limit: 20,
          },
          toolQueryHints: [{ keyword: '官老师' }],
          needRecentContext: true,
          needHistory: true,
          retrievalGoals: ['找到 EOSUSA 的原话', '找到群里反驳他的证据'],
          retrievalQueries: ['抹黑 截图', '社区 无视'],
          speakerHints: ['wangjh'],
          timeHints: ['today', '7d'],
          targetEvidenceTypes: ['original_quote', 'counter_argument'],
          targetEvidenceCount: 8,
          maxRounds: 4,
          stopWhen: '找到起因和社区结论',
          reasoningSummary: '先查近期讨论，再回溯起因。',
        }),
        '```',
      ].join('\n'), '为什么大家不理他')).toEqual(expect.objectContaining({
        goal: '解释社区为什么选择无视',
        nextAction: 'history.fetch',
        nextActionReason: '需要查找官老师',
        toolName: 'history.fetch',
        toolArgs: {
          mode: 'keyword',
          keyword: '官老师',
          limit: 20,
        },
        toolQueryHints: [{ keyword: '官老师' }],
        needHistory: true,
        retrievalGoals: ['找到 EOSUSA 的原话', '找到群里反驳他的证据'],
        retrievalQueries: ['抹黑 截图', '社区 无视'],
        speakerHints: ['wangjh'],
        timeHints: ['today', '7d'],
        targetEvidenceTypes: ['original_quote', 'counter_argument'],
        targetEvidenceCount: 8,
        maxRounds: 4,
        reasoningSummary: '先查近期讨论，再回溯起因。',
      }));
    });

    it('falls back to a safe retrieval plan when JSON is invalid', () => {
      expect(parseAiQueryPlan('not json', '为什么大家不理他')).toEqual(expect.objectContaining({
        goal: '为什么大家不理他',
        needRecentContext: true,
        needHistory: true,
        retrievalGoals: ['为什么大家不理他'],
        retrievalQueries: ['为什么大家不理他'],
        timeHints: [],
        targetEvidenceTypes: [],
      }));
    });
  });

  describe('parseAiJudgeDecision', () => {
    it('falls back to requesting more evidence when the model output is invalid', () => {
      expect(parseAiJudgeDecision('nope')).toEqual(expect.objectContaining({
        enough: false,
        needMoreHistory: true,
      }));
    });

    it('parses tool hints and next action fields', () => {
      expect(parseAiJudgeDecision(JSON.stringify({
        enough: false,
        needMoreHistory: true,
        reason: '需要关键词搜索',
        nextAction: 'history.fetch',
        nextActionReason: '先搜官老师',
        toolName: 'history.fetch',
        toolArgs: {
          mode: 'keyword',
          keyword: '官老师',
          limit: 12,
        },
        toolQueryHints: [{ keyword: '官老师' }],
      }))).toEqual(expect.objectContaining({
        nextAction: 'history.fetch',
        nextActionReason: '先搜官老师',
        toolName: 'history.fetch',
        toolArgs: {
          mode: 'keyword',
          keyword: '官老师',
          limit: 12,
        },
        toolQueryHints: [{ keyword: '官老师' }],
      }));
    });
  });

  describe('rankAiEvidenceByPlan', () => {
    it('moves more relevant evidence to the front', () => {
      const plan = parseAiQueryPlan(JSON.stringify({
        goal: '解释争议',
        needRecentContext: true,
        needHistory: true,
        retrievalGoals: ['找到反驳证据'],
        retrievalQueries: ['抹黑 截图', '社区 无视'],
        speakerHints: ['wangjh'],
        targetEvidenceTypes: ['counter_argument'],
        targetEvidenceCount: 5,
        maxRounds: 3,
        stopWhen: '找到答案',
      }), '解释争议');

      expect(rankAiEvidenceByPlan([
        evidence(1, '今天开会了'),
        evidence(2, 'wangjh 发了抹黑别人的截图'),
        evidence(3, '社区成员建议直接无视，不要浪费时间'),
      ], plan).map(({ messageId }) => messageId)).toEqual([2, 3, 1]);
    });
  });

  describe('runAiPlannerRetrieverJudge', () => {
    it('keeps fetching older evidence until judge says enough', async () => {
      const requestPlan = jest.fn().mockResolvedValue(JSON.stringify({
        goal: '解释争议原因',
        needRecentContext: true,
        needHistory: true,
        retrievalGoals: ['找到反驳证据'],
        retrievalQueries: ['抹黑 截图', '社区 无视'],
        speakerHints: ['wangjh'],
        targetEvidenceTypes: ['counter_argument'],
        targetEvidenceCount: 3,
        maxRounds: 3,
        stopWhen: '找到起因和结论',
      }));

      const requestJudge = jest.fn()
        .mockResolvedValueOnce(JSON.stringify({
          enough: false,
          needMoreHistory: true,
          reason: '还缺少起因消息',
          nextQueries: ['抹黑 截图'],
          beforeMessageId: 100,
          historyInstruction: '继续向前补 100 条历史消息',
        }))
        .mockResolvedValueOnce(JSON.stringify({
          enough: true,
          needMoreHistory: false,
          reason: '证据已经足够',
        }));

      const fetchOlderEvidence = jest.fn().mockResolvedValue([
        evidence(99, 'wangjh 发了抹黑别人的截图', 'history'),
        evidence(98, '社区建议不要理会，直接无视', 'history'),
      ]);

      const result = await runAiPlannerRetrieverJudge({
        userPrompt: '为什么大家不理他',
        initialEvidence: [evidence(101, '今天有人问为什么大家不理他')],
        requestPlan,
        requestJudge,
        fetchOlderEvidence,
      });

      expect(fetchOlderEvidence).toHaveBeenCalledTimes(1);
      expect(result.judge.enough).toBe(true);
      expect(result.evidence.map(({ messageId }) => messageId)).toEqual([98, 99, 101]);
    });

    it('continues beyond the old maxRounds-style limit while new evidence keeps appearing', async () => {
      const requestPlan = jest.fn().mockResolvedValue(JSON.stringify({
        goal: '解释争议原因',
        needRecentContext: true,
        needHistory: true,
        retrievalGoals: ['找到反驳证据'],
        retrievalQueries: ['抹黑 截图', '社区 无视'],
        speakerHints: ['wangjh'],
        targetEvidenceTypes: ['counter_argument'],
        targetEvidenceCount: 3,
        maxRounds: 3,
        stopWhen: '找到起因和结论',
      }));

      const requestJudge = jest.fn()
        .mockResolvedValueOnce(JSON.stringify({
          enough: false,
          needMoreHistory: true,
          reason: '还缺少起因消息',
          beforeMessageId: 100,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          enough: false,
          needMoreHistory: true,
          reason: '继续向前找',
          beforeMessageId: 99,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          enough: false,
          needMoreHistory: true,
          reason: '还差一层上下文',
          beforeMessageId: 98,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          enough: false,
          needMoreHistory: true,
          reason: '再往前一点',
          beforeMessageId: 97,
        }))
        .mockResolvedValueOnce(JSON.stringify({
          enough: true,
          needMoreHistory: false,
          reason: '证据已经足够',
        }));

      const fetchOlderEvidence = jest.fn()
        .mockResolvedValueOnce([evidence(100, '第一轮补回的消息', 'history')])
        .mockResolvedValueOnce([evidence(99, '第二轮补回的消息', 'history')])
        .mockResolvedValueOnce([evidence(98, '第三轮补回的消息', 'history')])
        .mockResolvedValueOnce([evidence(97, '第四轮补回的消息', 'history')]);

      const result = await runAiPlannerRetrieverJudge({
        userPrompt: '为什么大家不理他',
        initialEvidence: [evidence(101, '今天有人问为什么大家不理他')],
        requestPlan,
        requestJudge,
        fetchOlderEvidence,
      });

      expect(fetchOlderEvidence).toHaveBeenCalledTimes(4);
      expect(result.rounds).toHaveLength(5);
      expect(result.judge.enough).toBe(true);
      expect(result.evidence.map(({ messageId }) => messageId)).toEqual([97, 98, 99, 100, 101]);
    });

    it('stops when fetch returns no new evidence', async () => {
      const result = await runAiPlannerRetrieverJudge({
        userPrompt: '发生了什么',
        initialEvidence: [evidence(10, '最近大家在讨论')],
        requestPlan: () => Promise.resolve(JSON.stringify({
          goal: '解释发生了什么',
          needRecentContext: true,
          needHistory: true,
          retrievalGoals: ['找到背景'],
          retrievalQueries: ['讨论'],
          speakerHints: [],
          targetEvidenceTypes: ['context'],
          targetEvidenceCount: 5,
          maxRounds: 2,
          stopWhen: '找到事件脉络',
        })),
        requestJudge: () => Promise.resolve(JSON.stringify({
          enough: false,
          needMoreHistory: true,
          reason: '需要更多证据',
        })),
        fetchOlderEvidence: () => Promise.resolve([]),
      });

      expect(result.judge.enough).toBe(false);
      expect(result.evidence).toHaveLength(1);
      expect(result.rounds).toHaveLength(1);
    });
  });
});
