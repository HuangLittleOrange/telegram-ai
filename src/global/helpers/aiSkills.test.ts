import {
  buildAiSkillGuidance,
  buildHistoryFetchToolDefinition,
  resolveAiSkillInvocation,
  resolveHistoryFetchToolArgs,
} from './aiSkills';

describe('ai skill registry', () => {
  it('describes history.fetch and its toolArgs guidance', () => {
    const guidance = buildAiSkillGuidance();

    expect(guidance).toContain('history-fetch');
    expect(guidance).toContain('toolArgs');
    expect(guidance).toContain('toolQueryHints');
    expect(guidance).toContain('"mode": "preset"');
    expect(guidance).toContain('lastWeek');
    expect(guidance).toContain('fromDate');
  });

  it('describes history.fetch as a callable tool', () => {
    const tool = buildHistoryFetchToolDefinition();

    expect(tool.function.name).toBe('history-fetch');
    expect(tool.function.parameters).toEqual(expect.objectContaining({
      type: 'object',
      properties: expect.any(Object),
    }));
  });

  it('supports preset and custom range tool schema', () => {
    const tool = buildHistoryFetchToolDefinition();
    const timeRange = (tool.function.parameters as any).properties.timeRange;

    expect(timeRange).toEqual(expect.objectContaining({
      type: 'object',
      properties: expect.objectContaining({
        mode: expect.objectContaining({ type: 'string' }),
        value: expect.objectContaining({ type: 'string' }),
        fromDate: expect.objectContaining({ type: 'string' }),
        toDate: expect.objectContaining({ type: 'string' }),
      }),
      additionalProperties: false,
    }));
  });

  it('keeps the top-level tool schema compatible with OpenAI function parameters', () => {
    const tool = buildHistoryFetchToolDefinition();
    const parameters = tool.function.parameters as Record<string, unknown>;

    expect(parameters).toEqual(expect.objectContaining({
      type: 'object',
      properties: expect.any(Object),
      required: ['mode'],
      additionalProperties: false,
    }));
    expect(parameters).not.toHaveProperty('allOf');
    expect(parameters).not.toHaveProperty('anyOf');
    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters).not.toHaveProperty('not');
    expect(parameters).not.toHaveProperty('enum');
  });

  it('resolves explicit toolArgs into a history.fetch query invocation', () => {
    expect(resolveAiSkillInvocation({
      userPrompt: '帮我找官老师最近说了什么',
      defaultLimit: 40,
      plan: {
        nextAction: 'history.fetch',
        toolName: 'history.fetch',
        toolArgs: {
          mode: 'person',
          person: { peerId: '123', title: '官老师' },
          limit: 12,
        },
        toolQueryHints: [
          { keyword: '备用词' },
        ],
      },
      judge: {
        nextAction: 'history.fetch',
        toolName: 'history.fetch',
        toolQueryHints: [],
      },
    })).toEqual({
      skillName: 'history.fetch',
      mode: 'query',
      description: '按人读取：官老师',
      query: {
        mode: 'person',
        person: { peerId: '123', title: '官老师' },
        limit: 12,
      },
    });
  });

  it('falls back to backfill when only the user prompt is available', () => {
    expect(resolveAiSkillInvocation({
      userPrompt: '帮我找官老师最近说了什么',
      defaultLimit: 40,
      plan: {
        nextAction: 'history.fetch',
        toolName: 'history.fetch',
        toolQueryHints: [],
      },
      judge: {
        nextAction: 'history.fetch',
        toolName: 'history.fetch',
        toolQueryHints: [],
      },
    })).toEqual({
      skillName: 'history.fetch',
      mode: 'backfill',
      description: '继续向前补回历史聊天记录',
      beforeMessageId: undefined,
      limit: 40,
    });
  });

  it('falls back to backfill when history.fetch is requested without structured params', () => {
    expect(resolveAiSkillInvocation({
      userPrompt: '继续往前找',
      defaultLimit: 40,
      plan: {
        nextAction: 'history.fetch',
        toolName: 'history.fetch',
        toolQueryHints: [],
      },
      judge: {
        nextAction: 'history.fetch',
        toolName: 'history.fetch',
        beforeMessageId: 88,
        toolQueryHints: [],
      },
    })).toEqual({
      skillName: 'history.fetch',
      mode: 'backfill',
      description: '继续向前补回历史聊天记录',
      beforeMessageId: 88,
      limit: 40,
    });
  });

  it('resolves direct tool args into a history.fetch query', () => {
    expect(resolveHistoryFetchToolArgs({
      mode: 'keyword',
      keyword: '官老师',
      limit: 20,
    }, 100)).toEqual({
      mode: 'keyword',
      keyword: '官老师',
      limit: 20,
    });

    expect(resolveHistoryFetchToolArgs({
      person: {
        peerId: '123',
        title: 'AAA建材老王',
      },
      timeRange: {
        mode: 'preset',
        value: 'today',
      },
    }, 100)).toEqual({
      mode: 'person',
      person: {
        peerId: '123',
        title: 'AAA建材老王',
      },
      timeRange: {
        mode: 'preset',
        value: 'today',
      },
      limit: 100,
    });
  });

  it('unwraps nested toolArgs into a history.fetch query', () => {
    expect(resolveHistoryFetchToolArgs({
      toolArgs: {
        mode: 'recent',
        limit: 18,
      },
      toolQueryHints: [
        {
          keyword: '官老师',
        },
      ],
    }, 100)).toEqual({
      mode: 'recent',
      limit: 18,
    });
  });

  it('parses stringified toolArgs into a history.fetch query', () => {
    expect(resolveHistoryFetchToolArgs({
      toolArgs: JSON.stringify({
        mode: 'recent',
        limit: 18,
      }),
    }, 100)).toEqual({
      mode: 'recent',
      limit: 18,
    });
  });

  it('parses stringified range timeRange payloads returned by model tool calls', () => {
    const startAt = new Date(2026, 3, 1).getTime();
    const endAt = new Date(2026, 3, 4).getTime();

    expect(resolveHistoryFetchToolArgs({
      mode: 'range',
      timeRange: JSON.stringify({
        fromDate: '2026-04-01',
        toDate: '2026-04-03',
        mode: 'preset',
      }),
      toolQueryHints: JSON.stringify({
        keyword: ['BitTensor', 'TAO'],
      }),
    }, 100)).toEqual({
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt,
        endAt,
      },
      limit: 100,
    });
  });

  it('parses range toolArgs with endTime into a custom history.fetch query', () => {
    const endAt = 1743984000 * 1000;
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    expect(resolveHistoryFetchToolArgs({
      mode: 'range',
      timeRange: {
        endTime: 1743984000,
      },
      limit: 100,
    }, 100)).toEqual({
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt: endAt - oneWeekMs,
        endAt,
      },
      limit: 100,
    });
  });

  it('parses range toolArgs with fromDate and toDate into a custom history.fetch query', () => {
    const startAt = new Date(2026, 2, 31).getTime();
    const endAt = new Date(2026, 3, 7).getTime();

    expect(resolveHistoryFetchToolArgs({
      mode: 'range',
      timeRange: {
        fromDate: '2026-03-31',
        toDate: '2026-04-06',
      },
      limit: 100,
    }, 100)).toEqual({
      mode: 'range',
      timeRange: {
        mode: 'custom',
        startAt,
        endAt,
      },
      limit: 100,
    });
  });

  it('parses lastWeek preset toolArgs into a history.fetch query', () => {
    expect(resolveHistoryFetchToolArgs({
      mode: 'range',
      timeRange: {
        mode: 'preset',
        value: 'lastWeek',
      },
      limit: 100,
    }, 100)).toEqual({
      mode: 'range',
      timeRange: {
        mode: 'preset',
        value: 'lastWeek',
      },
      limit: 100,
    });
  });

  it('does not infer a history.fetch query from prompt text or plain string hints', () => {
    expect(resolveAiSkillInvocation({
      userPrompt: '上周在聊什么',
      defaultLimit: 40,
      plan: {
        nextAction: 'history.fetch',
        toolName: 'history.fetch',
        toolQueryHints: ['官老师'],
      },
      judge: {
        nextAction: 'history.fetch',
        toolName: 'history.fetch',
        toolQueryHints: [],
      },
    })).toEqual({
      skillName: 'history.fetch',
      mode: 'backfill',
      beforeMessageId: undefined,
      limit: 40,
      description: '继续向前补回历史聊天记录',
    });
  });
});
