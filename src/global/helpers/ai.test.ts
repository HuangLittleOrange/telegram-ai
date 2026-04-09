import {
  buildAiConversationMessages,
  buildAiFinalAnswerSystemPrompt,
  buildAiFinalAnswerTaskPrompt,
  buildAiSystemPrompt,
  buildAiTaskPrompt,
  buildHistoryFetchFallbackAnswer,
  buildHistoryFetchQueryFromToolHints,
  buildPersistentAiHistoryMessages,
  clampAiContextLimit,
  formatAiPromptConversationContextLines,
  formatAiPromptEvidenceLines,
  formatAiPromptToolOutputLines,
  formatHistoryFetchFloodWaitProgress,
  formatHistoryFetchPageProgress,
  formatHistoryFetchToolResultForModel,
  formatRawMessageExport,
  getAiApiUrl,
  parseGeminiAssistantText,
  parseOpenAiAssistantText,
  pickRecentMessageIds,
  sanitizeAssistantText,
  serializeOpenAiCompatibleMessages,
  shouldOfferHistoryFetchTool,
} from './ai';

describe('ai helper', () => {
  describe('clampAiContextLimit', () => {
    it('returns default when value is invalid', () => {
      expect(clampAiContextLimit(Number.NaN, 100)).toBe(100);
      expect(clampAiContextLimit(0, 100)).toBe(100);
      expect(clampAiContextLimit(-5, 100)).toBe(100);
    });

    it('clamps to allowed bounds', () => {
      expect(clampAiContextLimit(10, 100)).toBe(20);
      expect(clampAiContextLimit(9999, 100)).toBe(500);
      expect(clampAiContextLimit(120, 100)).toBe(120);
    });
  });

  describe('pickRecentMessageIds', () => {
    it('returns most recent N ids preserving chronological order', () => {
      const ids = Array.from({ length: 25 }).map((_, i) => i + 1);
      expect(pickRecentMessageIds(ids, 20)).toEqual([
        6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
      ]);
    });

    it('returns empty list for missing ids', () => {
      expect(pickRecentMessageIds(undefined, 100)).toEqual([]);
    });

    it('uses clamped limit', () => {
      expect(pickRecentMessageIds([1, 2, 3, 4, 5], 1)).toEqual([1, 2, 3, 4, 5]);
      expect(pickRecentMessageIds([1, 2, 3, 4, 5], 2)).toEqual([1, 2, 3, 4, 5]);
      expect(pickRecentMessageIds([1, 2, 3, 4, 5], 20)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('getAiApiUrl', () => {
    it('keeps full OpenAI-compatible completions endpoints unchanged', () => {
      expect(getAiApiUrl('openai', 'https://api.minimaxi.com/v1/chat/completions'))
        .toBe('https://api.minimaxi.com/v1/chat/completions');
    });

    it('appends chat completions for v1-compatible base urls', () => {
      expect(getAiApiUrl('openai', 'https://api.minimaxi.com/v1'))
        .toBe('https://api.minimaxi.com/v1/chat/completions');
      expect(getAiApiUrl('openai', 'https://api.minimaxi.com/v1/'))
        .toBe('https://api.minimaxi.com/v1/chat/completions');
    });

    it('appends v1 chat completions for host-only compatible urls', () => {
      expect(getAiApiUrl('openai', 'https://api.minimaxi.com'))
        .toBe('https://api.minimaxi.com/v1/chat/completions');
    });
  });

  describe('parseOpenAiAssistantText', () => {
    it('strips think blocks from assistant output', () => {
      expect(parseOpenAiAssistantText({
        choices: [{
          message: {
            content: '<think>internal reasoning</think>\n最终答案',
          },
        }],
      })).toBe('最终答案');
    });

    it('strips think tags with attributes and mixed case', () => {
      expect(parseOpenAiAssistantText({
        choices: [{
          message: {
            content: '<THINK class="reasoning">hidden</THINK>\n最终答案',
          },
        }],
      })).toBe('最终答案');
    });
  });

  describe('parseGeminiAssistantText', () => {
    it('strips escaped think blocks from assistant output', () => {
      expect(parseGeminiAssistantText({
        candidates: [{
          content: {
            parts: [{
              text: '&lt;think&gt;hidden&lt;/think&gt;\n最终答案',
            }],
          },
        }],
      })).toBe('最终答案');
    });
  });

  describe('sanitizeAssistantText', () => {
    it('removes trailing unclosed think content', () => {
      expect(sanitizeAssistantText('最终答案\n<think>hidden chain')).toBe('最终答案');
    });
  });

  describe('prompt architecture', () => {
    it('builds a single shared system prompt with identity, tools, behavior sections, and current time context', () => {
      const prompt = buildAiSystemPrompt({
        now: new Date('2026-04-09T11:38:00+08:00').getTime(),
        timeZone: 'Asia/Shanghai',
      });

      expect(prompt).toContain('## Identity');
      expect(prompt).toContain('## Time Context');
      expect(prompt).toContain('## Tool Contract');
      expect(prompt).toContain('## Protocol');
      expect(prompt).toContain('history-fetch');
      expect(prompt).toContain('fromDate');
      expect(prompt).toContain('toDate');
      expect(prompt).toContain('"mode": "preset"');
      expect(prompt).toContain('lastWeek');
      expect(prompt).toContain('只使用结构化参数');
      expect(prompt).toContain('toolQueryHints');
      expect(prompt).toContain('Telegram 群聊风格');
      expect(prompt).toContain('通用事实或背景知识');
      expect(prompt).toContain('先直接给结论');
      expect(prompt).toContain('当前时间：2026-04-09 11:38');
      expect(prompt).toContain('当前时区：Asia/Shanghai');
      expect(prompt).not.toContain('planner');
      expect(prompt).not.toContain('judge');
    });

    it('includes timestamps in formatted evidence and conversation context lines', () => {
      const evidenceLines = formatAiPromptEvidenceLines([
        {
          chatId: 'chat-1',
          threadId: 0,
          messageId: 101,
          sender: 'Huaqiang',
          text: '这次我来做“大恶人”',
          source: 'history',
          date: 1712457240,
        } as never,
      ]);

      const contextLines = formatAiPromptConversationContextLines([
        {
          role: 'user',
          text: '最近一周在聊什么',
          createdAt: 1712457240000,
        } as never,
      ]);

      expect(evidenceLines[0]).toContain('[101 | ');
      expect(evidenceLines[0]).toContain('Huaqiang: 这次我来做“大恶人”');
      expect(contextLines[0]).toContain('[2024-04-07 10:34]');
      expect(contextLines[0]).toContain('用户：最近一周在聊什么');
    });

    it('builds a compact task prompt with title, objective, requirements, and inputs', () => {
      const prompt = buildAiTaskPrompt(
        '回答当前问题',
        '根据聊天记录直接回答用户问题。',
        '如果信息足够就直接给结果；如果信息不足就明确说明还缺什么。',
        '为什么大家不理他',
        ['[101] wangjh: 发了抹黑别人的截图'],
      );

      expect(prompt).toContain('## Task Prompt');
      expect(prompt).toContain('当前任务：回答当前问题');
      expect(prompt).toContain('任务目标：根据聊天记录直接回答用户问题。');
      expect(prompt).toContain('输出要求：如果信息足够就直接给结果；如果信息不足就明确说明还缺什么。');
      expect(prompt).toContain('需要检索时，只发结构化工具参数');
      expect(prompt).toContain('如果用户问的是通用事实或背景知识');
      expect(prompt).toContain('优先使用短模板：先一句结论');
      expect(prompt).toContain('用户问题：为什么大家不理他');
      expect(prompt).toContain('聊天记录');
      expect(prompt).toContain('为什么大家不理他');
    });

    it('includes recent conversation context and tool output in the unified task prompt', () => {
      const prompt = buildAiTaskPrompt(
        '回答当前问题',
        '根据聊天记录直接回答用户问题。',
        '如果信息足够就直接给结果；如果信息不足就明确说明还缺什么。',
        '我想反驳他，该说些什么',
        ['[101] EOSUSA: 反对 treasury 直接操控投票'],
        [
          '用户：EOSUSA说了什么？怎样反对',
          'AI：EOSUSA 的立场是反对 treasury 直接影响治理。',
          '用户：我想反驳他，该说些什么',
        ],
        formatAiPromptToolOutputLines([
          {
            type: 'message.fetch',
            query: {
              mode: 'keyword',
              keyword: '官老师',
              limit: 12,
            },
            result: {
              messages: [],
              total: 3,
              truncated: false,
              evidenceIds: [],
              summary: '按关键词获取到 3 条消息',
            },
            createdAt: 1712457240000,
          } as never,
        ]),
      );

      expect(prompt).toContain('对话上下文');
      expect(prompt).toContain('EOSUSA说了什么？怎样反对');
      expect(prompt).toContain('我想反驳他，该说些什么');
      expect(prompt).toContain('工具结果');
      expect(prompt).toContain('按关键词读取：官老师');
      expect(prompt).toContain('按关键词获取到 3 条消息');
    });

    it('builds a compact quick-style task prompt with the same unified task shell', () => {
      const prompt = buildAiTaskPrompt(
        '整理今天聊天记录',
        '先读取今天相关的聊天记录，提炼关键结论和未完成事项。',
        '用简体中文输出，短句优先。',
      );

      expect(prompt).toContain('## Task Prompt');
      expect(prompt).toContain('当前任务：整理今天聊天记录');
      expect(prompt).toContain('任务目标：先读取今天相关的聊天记录，提炼关键结论和未完成事项。');
      expect(prompt).toContain('输出要求：用简体中文输出，短句优先。');
      expect(prompt).toContain('如果信息不足，就先检索；信息足够，就直接产出结果。');
    });

    it('builds a tool-free final-answer system prompt', () => {
      const prompt = buildAiFinalAnswerSystemPrompt({
        now: new Date('2026-04-09T11:38:00+08:00').getTime(),
        timeZone: 'Asia/Shanghai',
      });

      expect(prompt).toContain('当前阶段不能调用任何工具');
      expect(prompt).toContain('当前时间：2026-04-09 11:38');
      expect(prompt).toContain('当前时区：Asia/Shanghai');
      expect(prompt).toContain('不要输出 tool call');
      expect(prompt).not.toContain('## Tool Contract');
      expect(prompt).not.toContain('history-fetch');
    });

    it('builds a final-answer task prompt that forbids more retrieval', () => {
      const prompt = buildAiFinalAnswerTaskPrompt(
        'BitTensor是什么？',
        ['[16697] Sea: bittrentao 就是这样的'],
        ['用户：BitTensor是什么？'],
        ['[工具 | 2026-04-09 10:00] 按时间读取：本月'],
      );

      expect(prompt).toContain('当前阶段不能继续检索');
      expect(prompt).toContain('不要再请求调用工具');
      expect(prompt).toContain('先一句结论');
    });

    it('formats raw history exports with ids timestamps and original text', () => {
      const exportText = formatRawMessageExport(
        {
          mode: 'range',
          timeRange: {
            mode: 'preset',
            value: 'thisMonth',
          },
          limit: 100,
        },
        {
          messages: [
            {
              chatId: 'chat-1',
              threadId: -1,
              messageId: 363267,
              sender: 'Executor',
              date: 1775308667,
              text: '都会被清算的',
            },
            {
              chatId: 'chat-1',
              threadId: -1,
              messageId: 363269,
              sender: '今日与明日',
              date: 1775311314,
              text: '过不了吧',
            },
          ],
          total: 2,
          truncated: false,
          evidenceIds: [363267, 363269],
          sourceMessages: [],
          nextBeforeMessageId: 363267,
          summary: '按时间获取到 2 条消息',
        } as never,
      );

      expect(exportText).toContain('本月原始消息导出（2 条）');
      expect(exportText).toContain('[363267 | ');
      expect(exportText).toContain('Executor: 都会被清算的');
      expect(exportText).toContain('[363269 | ');
      expect(exportText).toContain('今日与明日: 过不了吧');
    });
  });

  describe('formatAiPromptToolOutputLines', () => {
    it('summarizes message fetch tool output for prompt context', () => {
      const lines = formatAiPromptToolOutputLines([
        {
          type: 'message.fetch',
          query: {
            mode: 'keyword',
            keyword: '官老师',
            limit: 12,
          },
          result: {
            messages: [],
            total: 3,
            truncated: false,
            evidenceIds: [],
            summary: '按关键词获取到 3 条消息',
          },
          createdAt: 1712457240000,
        } as never,
      ]);

      expect(lines.join('\n')).toContain('按关键词读取：官老师');
      expect(lines.join('\n')).toContain('按关键词获取到 3 条消息');
    });

    it('includes fetched message lines so follow-up turns can reuse prior history evidence', () => {
      const lines = formatAiPromptToolOutputLines([
        {
          type: 'message.fetch',
          query: {
            mode: 'range',
            timeRange: {
              mode: 'preset',
              value: 'lastWeek',
            },
          },
          result: {
            messages: [
              {
                chatId: 'chat-1',
                threadId: -1,
                messageId: 362190,
                sender: '斥候',
                date: 1775200000,
                text: '复星也启动了一个 BP',
              },
            ],
            total: 1,
            truncated: false,
            evidenceIds: [362190],
            summary: '按时间获取到 1 条消息',
          },
          createdAt: 1712457240000,
        } as never,
      ]);

      expect(lines.join('\n')).toContain('按时间读取：上周');
      expect(lines.join('\n')).toContain('[362190 |');
      expect(lines.join('\n')).toContain('斥候: 复星也启动了一个 BP');
    });

    it('includes history-fetch tool payload lines emitted by the main agent loop', () => {
      const lines = formatAiPromptToolOutputLines([
        {
          type: 'history-fetch',
          description: '按时间读取：上周',
          payload: {
            query: {
              mode: 'range',
              timeRange: {
                mode: 'preset',
                value: 'lastWeek',
              },
            },
            result: {
              messages: [
                {
                  chatId: 'chat-1',
                  threadId: -1,
                  messageId: 362190,
                  sender: 'iAmRobot',
                  date: 1775200000,
                  text: 'Fosun Finchain 也启动了一个 BP',
                },
              ],
              total: 1,
              truncated: false,
              evidenceIds: [362190],
              summary: '按时间获取到 1 条消息',
            },
          },
          createdAt: 1712457240000,
        } as never,
      ]);

      expect(lines.join('\n')).toContain('按时间读取：上周');
      expect(lines.join('\n')).toContain('[362190 |');
      expect(lines.join('\n')).toContain('iAmRobot: Fosun Finchain 也启动了一个 BP');
    });
  });

  describe('buildHistoryFetchQueryFromToolHints', () => {
    it('converts structured tool hints into a message fetch query', () => {
      expect(buildHistoryFetchQueryFromToolHints({
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
            { person: { peerId: '456', title: '备用名字' } },
            { timeRange: { mode: 'preset', value: 'today' } },
            { limit: 99 },
          ],
        },
        judge: {
          nextAction: 'history.fetch',
          toolName: 'history.fetch',
          toolQueryHints: [],
        },
      })).toEqual({
        mode: 'person',
        person: { peerId: '123', title: '官老师' },
        limit: 12,
      });
    });
  });

  describe('buildAiConversationMessages', () => {
    it('always includes the current prompt as the last user message', () => {
      expect(buildAiConversationMessages({
        systemPrompt: 'system',
        evidenceLines: ['[1] a: hi'],
        toolOutputLines: [],
        turns: [],
        currentPrompt: '最近一周聊了什么',
      })).toEqual([
        { role: 'system', content: 'system\n\n当前聊天记录：\n[1] a: hi' },
        { role: 'user', content: '最近一周聊了什么' },
      ]);
    });

    it('does not duplicate the current prompt when it is already the last turn', () => {
      expect(buildAiConversationMessages({
        systemPrompt: 'system',
        evidenceLines: [],
        toolOutputLines: [],
        turns: [
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: '最近一周聊了什么' },
        ],
        currentPrompt: '最近一周聊了什么',
      })).toEqual([
        { role: 'system', content: 'system' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: '最近一周聊了什么' },
      ]);
    });

    it('keeps all prior turns in chronological order', () => {
      const turns = Array.from({ length: 14 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `turn-${index + 1}`,
      }));

      const result = buildAiConversationMessages({
        systemPrompt: 'system',
        evidenceLines: [],
        toolOutputLines: [],
        turns,
        currentPrompt: '现在呢',
      });

      expect(result.slice(1, -1)).toEqual(turns);
      expect(result.at(-1)).toEqual({ role: 'user', content: '现在呢' });
    });

    it('preserves assistant tool calls and tool call ids when replaying prior history messages', () => {
      const result = buildAiConversationMessages({
        systemPrompt: 'system',
        evidenceLines: [],
        toolOutputLines: [],
        turns: [
          {
            role: 'assistant',
            content: '',
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
            content: '{"total":10}',
            tool_call_id: 'call-1',
          },
        ],
        currentPrompt: 'BitTensor 是什么？',
      });

      expect(result[1]).toEqual({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'history-fetch',
            arguments: '{"mode":"range"}',
          },
        }],
      });
      expect(result[2]).toEqual({
        role: 'tool',
        content: '{"total":10}',
        tool_call_id: 'call-1',
      });
    });
  });

  describe('buildPersistentAiHistoryMessages', () => {
    it('keeps assistant tool calls and tool payloads in the persisted message history', () => {
      const result = buildPersistentAiHistoryMessages([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '上周聊了什么' },
        {
          role: 'assistant',
          content: '',
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
          content: '{"total":894}',
          tool_call_id: 'call-1',
        },
      ], '上周主要在讨论治理和投票');

      expect(result).toEqual([
        { role: 'user', content: '上周聊了什么' },
        {
          role: 'assistant',
          content: '',
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
          content: '{"total":894}',
          tool_call_id: 'call-1',
        },
        {
          role: 'assistant',
          content: '上周主要在讨论治理和投票',
        },
      ]);
    });
  });

  describe('serializeOpenAiCompatibleMessages', () => {
    it('omits empty assistant content when tool calls are present', () => {
      expect(serializeOpenAiCompatibleMessages([
        { role: 'system', content: 'system prompt' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'history-fetch',
              arguments: '{"mode":"recent","limit":5}',
            },
          }],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
      ])).toEqual([
        { role: 'system', content: 'system prompt' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'history-fetch',
              arguments: '{"mode":"recent","limit":5}',
            },
          }],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
      ]);
    });
  });

  describe('shouldOfferHistoryFetchTool', () => {
    it('offers the tool before any tool result is present and disables it afterwards', () => {
      expect(shouldOfferHistoryFetchTool([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '上周聊了什么' },
      ])).toBe(true);

      expect(shouldOfferHistoryFetchTool([
        { role: 'system', content: 'system prompt' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'history-fetch',
              arguments: '{"mode":"range"}',
            },
          }],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
      ])).toBe(false);
    });
  });

  describe('formatHistoryFetchToolResultForModel', () => {
    it('includes all fetched messages for the model', () => {
      const content = formatHistoryFetchToolResultForModel({
        mode: 'range',
        timeRange: {
          mode: 'preset',
          value: 'lastWeek',
        },
      }, {
        messages: Array.from({ length: 150 }, (_, index) => ({
          chatId: 'chat-1',
          threadId: -1,
          messageId: 1000 + index,
          sender: `user-${index}`,
          date: 1770000000 + index,
          text: `message-${index}`,
        })),
        total: 150,
        truncated: false,
        evidenceIds: [],
        summary: '按时间获取到 150 条消息',
      });

      expect(content).toContain('"total": 150');
      expect(content).toContain('"messageCount": 150');
      expect(content).toContain('[1000 |');
      expect(content).toContain('[1149 |');
    });
  });

  describe('formatHistoryFetchPageProgress', () => {
    it('includes local hits, remote additions, total count, and fetch status', () => {
      const progress = formatHistoryFetchPageProgress(2, 536, {
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 10,
            sender: 'Alice',
            date: 1774972800,
            text: 'a',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 11,
            sender: 'Bob',
            date: 1775232000,
            text: 'b',
          },
        ],
        total: 2,
        truncated: false,
        nextBeforeMessageId: 9,
      }, {
        localCount: 58,
      });

      expect(progress.title).toBe('第 2 页');
      expect(progress.detail).toContain('本地 58 条');
      expect(progress.detail).toContain('远程新增 536 条');
      expect(progress.detail).toContain('累计可用 594 条');
      expect(progress.detail).toContain('本页 2 条');
      expect(progress.detail).toContain('2026-04-01');
      expect(progress.detail).toContain('2026-04-04');
      expect(progress.detail).toContain('继续抓取中');
    });
  });

  describe('formatHistoryFetchFloodWaitProgress', () => {
    it('formats a user-facing wait message for Telegram flood limits', () => {
      const progress = formatHistoryFetchFloodWaitProgress(2);

      expect(progress.title).toBe('Telegram 限流');
      expect(progress.detail).toBe('等待 2 秒后继续抓取');
    });
  });

  describe('buildHistoryFetchFallbackAnswer', () => {
    it('builds a readable fallback when the model does not return final text', () => {
      const answer = buildHistoryFetchFallbackAnswer({
        mode: 'range',
        timeRange: {
          mode: 'preset',
          value: 'lastWeek',
        },
      }, {
        messages: [
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 1,
            sender: 'Alice',
            date: 1774972800,
            text: '先看律师那边怎么说',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 2,
            sender: 'Bob',
            date: 1774976400,
            text: '价格还是没动静',
          },
          {
            chatId: 'chat-1',
            threadId: -1,
            messageId: 3,
            sender: 'Alice',
            date: 1775059200,
            text: '会议记录先发一下',
          },
        ],
        total: 3,
        truncated: false,
        evidenceIds: [1, 2, 3],
        summary: '按时间获取到 3 条消息',
      });

      expect(answer).toContain('已读取上周的聊天记录，共 3 条。');
      expect(answer).toContain('较活跃的发言人有 Alice（2 条）');
      expect(answer).toContain('先摘几条原话：');
    });
  });
});
