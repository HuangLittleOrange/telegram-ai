import type { AiProvider } from '../../types';
import type {
  MessageFetchQuery,
  MessageFetchResult,
  PersonRef,
  TimeRange,
  ToolOutput,
} from '../types/tabState';
import type { AiChatMessage, AiToolCall } from './aiAgentRuntime';
import type {
  AiJudgeDecision,
  AiQueryPlan,
} from './aiOrchestrator';
export {
  buildAiFinalAnswerSystemPrompt,
  buildAiRequestSystemPrompt,
  buildAiSystemPrompt,
  getAiPromptTimeContext,
} from './aiContext';

export const AI_CONTEXT_LIMIT_MIN = 20;
export const AI_CONTEXT_LIMIT_MAX = 500;
export const AI_CONTEXT_LIMIT_DEFAULT = 100;

function joinPromptBlocks(...blocks: Array<string | Array<string | undefined> | undefined>) {
  return blocks
    .flatMap((block) => {
      if (!block) {
        return [];
      }

      if (Array.isArray(block)) {
        return [block.filter((line): line is string => Boolean(line && line.trim())).join('\n')];
      }

      const trimmed = block.trim();
      return trimmed ? [trimmed] : [];
    })
    .join('\n\n');
}

export function clampAiContextLimit(limit: number | undefined, fallback = AI_CONTEXT_LIMIT_DEFAULT) {
  const normalizedFallback = Number.isFinite(fallback) && fallback > 0 ? fallback : AI_CONTEXT_LIMIT_DEFAULT;
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return normalizedFallback;
  }

  return Math.min(AI_CONTEXT_LIMIT_MAX, Math.max(AI_CONTEXT_LIMIT_MIN, Math.floor(limit)));
}

export function pickRecentMessageIds(ids: number[] | undefined, limit: number) {
  if (!ids?.length) {
    return [];
  }

  const normalizedLimit = clampAiContextLimit(limit, AI_CONTEXT_LIMIT_DEFAULT);
  if (ids.length <= normalizedLimit) {
    return ids;
  }

  return ids.slice(ids.length - normalizedLimit);
}

export function formatAiPromptTimestamp(value: number) {
  const normalized = value < 1e12 ? value * 1000 : value;
  const date = new Date(normalized);

  const pad = (input: number) => String(input).padStart(2, '0');

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ');
}

export type AiPromptTurn = {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
};

export function formatAiPromptEvidenceLines(items: Array<{
  messageId: number;
  sender: string;
  text: string;
  date?: number;
}>) {
  return items.map(({ messageId, sender, text, date }) => (
    date
      ? `[${messageId} | ${formatAiPromptTimestamp(date)}] ${sender}: ${text}`
      : `[${messageId}] ${sender}: ${text}`
  ));
}

export function formatAiPromptConversationContextLines(
  turns: AiPromptTurn[],
  limit = 6,
) {
  return turns
    .slice(-limit)
    .map((turn) => {
      const normalizedText = sanitizeAssistantText(turn.text) || turn.text;
      if (!normalizedText?.trim()) {
        return undefined;
      }

      const speaker = turn.role === 'assistant' ? 'AI' : '用户';
      return `[${formatAiPromptTimestamp(turn.createdAt)}] ${speaker}：${normalizedText.trim()}`;
    })
    .filter((line): line is string => Boolean(line));
}

function describeToolOutputQuery(query: MessageFetchQuery) {
  if (query.mode === 'person') {
    return `按人读取：${query.person.title || query.person.peerId}`;
  }

  if (query.mode === 'keyword') {
    return `按关键词读取：${query.keyword.trim()}`;
  }

  if (query.mode === 'range') {
    if (query.timeRange.mode === 'preset') {
      const presetLabels: Record<'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth', string> = {
        today: '今天',
        yesterday: '昨天',
        thisWeek: '本周',
        lastWeek: '上周',
        thisMonth: '本月',
      };

      return `按时间读取：${presetLabels[query.timeRange.value]}`;
    }

    return '按时间读取：自定义范围';
  }

  return `读取最近 ${query.limit} 条消息`;
}

function formatToolOutputSummaryLine(toolOutput: ToolOutput) {
  const historyFetchPayload = getHistoryFetchToolPayload(toolOutput);

  if (historyFetchPayload) {
    const querySummary = describeToolOutputQuery(historyFetchPayload.query);
    const resultSummary = [
      `命中 ${historyFetchPayload.result.total} 条`,
      historyFetchPayload.result.truncated ? '结果已截断' : '结果完整',
    ].join(' · ');

    return {
      title: querySummary,
      detail: historyFetchPayload.result.summary || resultSummary,
    };
  }

  if ('description' in toolOutput && toolOutput.description?.trim()) {
    return {
      title: toolOutput.description.trim(),
      detail: '工具已完成',
    };
  }

  return {
    title: toolOutput.type,
    detail: '工具已完成',
  };
}

function getHistoryFetchToolPayload(toolOutput: ToolOutput) {
  if (
    toolOutput.type === 'message.fetch'
    && 'query' in toolOutput
    && 'result' in toolOutput
  ) {
    return {
      query: toolOutput.query,
      result: toolOutput.result,
    };
  }

  if (
    toolOutput.type === 'history-fetch'
    && 'payload' in toolOutput
    && toolOutput.payload
    && typeof toolOutput.payload === 'object'
    && 'query' in toolOutput.payload
    && 'result' in toolOutput.payload
  ) {
    return toolOutput.payload as {
      query: MessageFetchQuery;
      result: MessageFetchResult;
    };
  }

  return undefined;
}

export function formatAiPromptToolOutputLines(
  toolOutputs: ToolOutput[],
  limit = 4,
) {
  return toolOutputs
    .slice(-limit)
    .flatMap((toolOutput) => {
      const summary = formatToolOutputSummaryLine(toolOutput);
      const createdAt = formatAiPromptTimestamp(toolOutput.createdAt);
      const lines = [`[工具 | ${createdAt}] ${summary.title}`];

      if (summary.detail) {
        lines.push(`- ${summary.detail}`);
      }

      const historyFetchPayload = getHistoryFetchToolPayload(toolOutput);
      if (historyFetchPayload) {
        const payload = formatHistoryFetchToolResultForModel(
          historyFetchPayload.query,
          historyFetchPayload.result,
        )
          .split('\n')
          .slice(1, -1)
          .map((line) => `  ${line}`);
        lines.push(...payload);
      }

      return lines;
    });
}

const HISTORY_FETCH_LIMIT_MAX = 500;

function clampMessageFetchLimit(limit: number | undefined, fallback: number) {
  const normalizedFallback = Number.isFinite(fallback) && fallback > 0
    ? Math.min(HISTORY_FETCH_LIMIT_MAX, Math.max(1, Math.floor(fallback)))
    : 100;

  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return normalizedFallback;
  }

  return Math.min(HISTORY_FETCH_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

function normalizeHistoryFetchKeywordHint(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  for (const key of ['keyword', 'query', 'text', 'value']) {
    const candidateValue = candidate[key];
    if (typeof candidateValue === 'string' && candidateValue.trim()) {
      return candidateValue.trim();
    }
  }

  return undefined;
}

function normalizeHistoryFetchPersonHint(value: unknown): PersonRef | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const pickString = (values: unknown[]) => {
    for (const item of values) {
      if (typeof item === 'string' && item.trim()) {
        return item.trim();
      }
    }

    return undefined;
  };
  const candidate = value as Record<string, unknown>;
  const peerId = pickString([
    candidate.peerId,
    candidate.userId,
    candidate.id,
    candidate.value,
  ]);
  const title = pickString([
    candidate.title,
    candidate.name,
    candidate.username,
    candidate.handle,
  ]);

  if (!peerId && !title) {
    return undefined;
  }

  return {
    peerId: peerId || title || '',
    title: title || undefined,
  };
}

export function buildPersistentAiHistoryMessages(
  messages: AiChatMessage[],
  finalAssistantText?: string,
) {
  const persistedMessages = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      ...message,
      content: message.content || '',
    }));

  const normalizedFinalText = sanitizeAssistantText(finalAssistantText) || finalAssistantText || '';
  if (!normalizedFinalText.trim()) {
    return persistedMessages;
  }

  return [
    ...persistedMessages,
    {
      role: 'assistant' as const,
      content: normalizedFinalText.trim(),
    },
  ];
}

function normalizeHistoryFetchTimeRangeHint(value: unknown): TimeRange | undefined {
  type PresetTimeRangeValue = Extract<TimeRange, { mode: 'preset' }>['value'];

  const normalizeTimeValue = (input: unknown, boundary: 'start' | 'end' = 'start') => {
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) {
        return undefined;
      }

      const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateOnlyMatch) {
        const year = Number(dateOnlyMatch[1]);
        const month = Number(dateOnlyMatch[2]);
        const day = Number(dateOnlyMatch[3]);
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
          return undefined;
        }

        const date = new Date(year, month - 1, day);
        if (boundary === 'end') {
          date.setDate(date.getDate() + 1);
        }
        return date.getTime();
      }

      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed;
      }

      return undefined;
    }

    const numeric = Number(input);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return undefined;
    }

    return numeric < 1e12 ? numeric * 1000 : numeric;
  };

  const normalizePreset = (
    preset: unknown,
  ): { mode: 'preset'; value: PresetTimeRangeValue } | undefined => {
    if (
      preset === 'today'
      || preset === 'yesterday'
      || preset === 'thisWeek'
      || preset === 'lastWeek'
      || preset === 'thisMonth'
    ) {
      return {
        mode: 'preset' as const,
        value: preset,
      };
    }
    return undefined;
  };

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const preset = normalizePreset(trimmed);
    if (preset) {
      return preset;
    }

    const relativeMatch = trimmed.match(/^(\d+)\s*(d|day|days|h|hour|hours)$/i);
    if (relativeMatch) {
      const amount = Number(relativeMatch[1]);
      const unit = relativeMatch[2].toLowerCase();
      const now = Date.now();
      const durationMs = unit.startsWith('h')
        ? amount * 60 * 60 * 1000
        : amount * 24 * 60 * 60 * 1000;
      return {
        mode: 'custom',
        startAt: Math.max(0, now - durationMs),
        endAt: now,
      };
    }

    return undefined;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const startAt = normalizeTimeValue(
    candidate.startAt ?? candidate.start ?? candidate.from ?? candidate.startTime ?? candidate.fromDate,
  );
  const endAt = normalizeTimeValue(
    candidate.endAt ?? candidate.end ?? candidate.to ?? candidate.endTime ?? candidate.toDate,
    'end',
  );
  if (startAt && endAt && endAt > startAt) {
    return {
      mode: 'custom',
      startAt,
      endAt,
    };
  }

  const preset = normalizePreset(candidate.value ?? candidate.preset ?? candidate.range);
  if (candidate.mode === 'preset' && preset) {
    return preset;
  }

  const days = Number(candidate.days ?? candidate.dayCount);
  if (Number.isFinite(days) && days > 0) {
    const now = Date.now();
    const durationMs = Math.floor(days) * 24 * 60 * 60 * 1000;
    return {
      mode: 'custom',
      startAt: Math.max(0, now - durationMs),
      endAt: now,
    };
  }

  return undefined;
}

function normalizeHistoryFetchQueryHint(
  hint: unknown,
  fallbackLimit: number,
): NormalizedHistoryFetchQueryHint | undefined {
  if (typeof hint === 'string') {
    const trimmed = hint.trim();
    if (!trimmed) {
      return undefined;
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const normalized = normalizeHistoryFetchQueryHint(parsed, fallbackLimit);
        if (normalized) {
          return normalized;
        }
      } catch {
        // structured hints only
      }
    }

    return undefined;
  }

  if (!hint || typeof hint !== 'object') {
    return undefined;
  }

  const candidate = hint as Record<string, unknown>;
  const keyword = normalizeHistoryFetchKeywordHint(
    candidate.keyword ?? candidate.query ?? candidate.text ?? candidate.value,
  );
  const person = normalizeHistoryFetchPersonHint(
    candidate.person
    ?? candidate.personRef
    ?? candidate.persona
    ?? candidate.user
    ?? candidate.sender
    ?? candidate.author,
  );
  const timeRange = normalizeHistoryFetchTimeRangeHint(
    candidate.timeRange ?? candidate.range ?? candidate.dateRange ?? candidate.time,
  );
  const limit = clampMessageFetchLimit(
    Number(candidate.limit ?? candidate.count ?? candidate.maxResults),
    fallbackLimit,
  );

  if (keyword || person || timeRange) {
    return {
      keyword,
      person,
      timeRange,
      limit,
    };
  }

  return undefined;
}

type NormalizedHistoryFetchQueryHint = {
  keyword?: string;
  person?: PersonRef;
  timeRange?: TimeRange;
  limit?: number;
};

export function buildHistoryFetchQueryFromToolHints(args: {
  userPrompt: string;
  plan: Pick<AiQueryPlan, 'nextAction' | 'toolName' | 'toolArgs' | 'toolQueryHints'>;
  judge: Pick<AiJudgeDecision, 'nextAction' | 'toolName' | 'toolArgs' | 'toolQueryHints'>;
  defaultLimit?: number;
}): MessageFetchQuery | undefined {
  const {
    plan,
    judge,
    defaultLimit = 100,
  } = args;

  const explicitArgs = [
    plan.toolArgs,
    judge.toolArgs,
  ];

  for (const hint of explicitArgs) {
    const normalized = normalizeHistoryFetchQueryHint(hint, defaultLimit);
    if (!normalized) {
      continue;
    }

    if ('keyword' in normalized && typeof normalized.keyword === 'string' && normalized.keyword.trim()) {
      return {
        mode: 'keyword',
        keyword: normalized.keyword,
        ...(normalized.person ? { person: normalized.person } : {}),
        ...(normalized.timeRange ? { timeRange: normalized.timeRange } : {}),
        limit: normalized.limit || clampMessageFetchLimit(undefined, defaultLimit),
      };
    }

    if ('person' in normalized && normalized.person) {
      return {
        mode: 'person',
        person: normalized.person,
        ...(normalized.timeRange ? { timeRange: normalized.timeRange } : {}),
        ...(normalized.limit
          ? { limit: normalized.limit }
          : { limit: clampMessageFetchLimit(undefined, defaultLimit) }),
      };
    }

    if ('timeRange' in normalized && normalized.timeRange) {
      return {
        mode: 'range',
        timeRange: normalized.timeRange,
        ...(normalized.limit
          ? { limit: normalized.limit }
          : { limit: clampMessageFetchLimit(undefined, defaultLimit) }),
      };
    }

  }

  const hints = [
    ...(Array.isArray(plan.toolQueryHints) ? plan.toolQueryHints : []),
    ...(Array.isArray(judge.toolQueryHints) ? judge.toolQueryHints : []),
  ];

  let keywordQuery: NormalizedHistoryFetchQueryHint | undefined;
  let personQuery: PersonRef | undefined;
  let timeRangeQuery: TimeRange | undefined;
  let queryLimit: number | undefined;

  for (const hint of hints) {
    const normalized = normalizeHistoryFetchQueryHint(hint, defaultLimit);
    if (!normalized) {
      continue;
    }

    if ('keyword' in normalized && typeof normalized.keyword === 'string' && normalized.keyword.trim()) {
      keywordQuery = {
        keyword: normalized.keyword,
        person: normalized.person,
        timeRange: normalized.timeRange,
        limit: normalized.limit,
      };
      continue;
    }

    if ('person' in normalized && normalized.person) {
      personQuery = normalized.person;
    }

    if ('timeRange' in normalized && normalized.timeRange) {
      timeRangeQuery = normalized.timeRange;
    }

    if ('limit' in normalized && normalized.limit) {
      queryLimit = normalized.limit;
    }
  }

  if (keywordQuery?.keyword) {
    return {
      mode: 'keyword',
      keyword: keywordQuery.keyword,
      ...(keywordQuery.person ? { person: keywordQuery.person } : {}),
      ...(keywordQuery.timeRange ? { timeRange: keywordQuery.timeRange } : {}),
      limit: keywordQuery.limit || clampMessageFetchLimit(undefined, defaultLimit),
    };
  }

  if (personQuery) {
    return {
      mode: 'person',
      person: personQuery,
      ...(timeRangeQuery ? { timeRange: timeRangeQuery } : {}),
      ...(queryLimit ? { limit: queryLimit } : { limit: clampMessageFetchLimit(undefined, defaultLimit) }),
    };
  }

  if (timeRangeQuery) {
    return {
      mode: 'range',
      timeRange: timeRangeQuery,
      ...(queryLimit ? { limit: queryLimit } : { limit: clampMessageFetchLimit(undefined, defaultLimit) }),
    };
  }

  return undefined;
}

export function buildAiPrompt(
  basePrompt: string,
  contextLines: string[],
  conversationContextLines?: string[],
  toolOutputLines: string[] = [],
) {
  return buildAiTaskPrompt(
    '回答用户问题',
    '根据聊天记录直接回答用户问题。',
    '如果信息足够就直接给结果；如果信息不足就明确说明还缺什么。',
    basePrompt,
    contextLines,
    conversationContextLines || [],
    toolOutputLines,
  );
}

export function buildAiTaskPrompt(
  taskTitle: string,
  taskObjective: string,
  outputRequirements: string,
  userPrompt?: string,
  contextLines: string[] = [],
  conversationContextLines: string[] = [],
  toolOutputLines: string[] = [],
) {
  const contextText = contextLines.join('\n');
  const conversationText = conversationContextLines.join('\n');
  return joinPromptBlocks(
    [
      '## Task Prompt',
      `当前任务：${taskTitle}`,
      `任务目标：${taskObjective}`,
      `输出要求：${outputRequirements}`,
      '如果信息不足，就先检索；信息足够，就直接产出结果。',
      '如果用户问的是通用事实或背景知识，而当前聊天记录没有直接答案，可以直接基于常识回答，并明确标注不是来自当前聊天记录。',
      '当你已经处于最终回答阶段时，不要停在“需要继续检索”这句话上；要么直接给答案，要么明确说明仅凭聊天记录无法判断，并在适用时补充常识答案。',
      '优先使用短模板：先一句结论，再一句说明聊天记录里有没有直接依据；如果用了常识或模型知识，再补一句“这部分不是来自当前聊天记录”。',
      '需要检索时，只发结构化工具参数，不要用自然语言描述要查什么。',
    ],
    [
      '## Inputs',
      userPrompt ? `用户问题：${userPrompt}` : undefined,
      contextText ? `聊天记录：\n${contextText}` : undefined,
      conversationText ? `对话上下文：\n${conversationText}` : undefined,
      toolOutputLines.length ? `工具结果：\n${toolOutputLines.join('\n')}` : undefined,
    ],
  );
}

export function buildAiFinalAnswerTaskPrompt(
  userPrompt: string,
  contextLines: string[] = [],
  conversationContextLines: string[] = [],
  toolOutputLines: string[] = [],
) {
  const contextText = contextLines.join('\n');
  const conversationText = conversationContextLines.join('\n');

  return joinPromptBlocks(
    [
      '## Final Answer Task',
      `用户问题：${userPrompt}`,
      '当前阶段不能继续检索，不要再请求调用工具。',
      '先一句结论，再一句说明聊天记录里有没有直接依据；如果用了常识或模型知识，再补一句“这部分不是来自当前聊天记录”。',
    ],
    [
      '## Inputs',
      contextText ? `聊天记录：\n${contextText}` : undefined,
      conversationText ? `对话上下文：\n${conversationText}` : undefined,
      toolOutputLines.length ? `已有工具结果：\n${toolOutputLines.join('\n')}` : undefined,
    ],
  );
}

function describeRawExportQuery(query: MessageFetchQuery) {
  if (query.mode === 'person') {
    return `发言人：${query.person.title || query.person.peerId}`;
  }

  if (query.mode === 'keyword') {
    return `关键词：${query.keyword.trim()}`;
  }

  if (query.mode === 'range') {
    if (query.timeRange.mode === 'preset') {
      const presetLabels: Record<'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth', string> = {
        today: '今天',
        yesterday: '昨天',
        thisWeek: '本周',
        lastWeek: '上周',
        thisMonth: '本月',
      };

      return presetLabels[query.timeRange.value];
    }

    return '自定义范围';
  }

  return `最近 ${query.limit} 条消息`;
}

export function formatRawMessageExport(
  query: MessageFetchQuery,
  result: MessageFetchResult,
) {
  const header = `${describeRawExportQuery(query)}原始消息导出（${result.total} 条）`;
  const lines = result.messages.map((message) => {
    const timestamp = formatAiPromptTimestamp(message.date);
    const text = message.text?.trim() || '（无文本）';
    return `[${message.messageId} | ${timestamp}] ${message.sender}: ${text}`;
  });

  return [header, ...lines].join('\n');
}

export function formatHistoryFetchToolResultForModel(
  query: MessageFetchQuery,
  result: MessageFetchResult,
) {
  const messageLines = result.messages.map((message) => {
    const timestamp = formatAiPromptTimestamp(message.date);
    const text = message.text?.trim() || '（无文本）';
    return `[${message.messageId} | ${timestamp}] ${message.sender}: ${text}`;
  });

  return [
    '{',
    `  "query": ${JSON.stringify(describeRawExportQuery(query))},`,
    `  "summary": ${JSON.stringify(result.summary || '')},`,
    `  "total": ${result.total},`,
    `  "truncated": ${result.truncated ? 'true' : 'false'},`,
    `  "messageCount": ${result.messages.length},`,
    '  "messages": [',
    ...messageLines.map((line, index) => `    ${JSON.stringify(line)}${index < messageLines.length - 1 ? ',' : ''}`),
    '  ]',
    '}',
  ].join('\n');
}

export function shouldOfferHistoryFetchTool(messages: AiChatMessage[]) {
  return !messages.some((message) => message.role === 'tool');
}

export function formatHistoryFetchPageProgress(
  pageIndex: number,
  accumulatedCount: number,
  result: Pick<MessageFetchResult, 'messages' | 'total' | 'truncated' | 'nextBeforeMessageId'>,
  options?: {
    localCount?: number;
  },
) {
  const dates = result.messages.map((message) => message.date).filter(Boolean);
  const minDate = dates.length ? Math.min(...dates) : undefined;
  const maxDate = dates.length ? Math.max(...dates) : undefined;
  const dateRange = minDate && maxDate
    ? `${formatAiPromptTimestamp(minDate).slice(0, 10)} ~ ${formatAiPromptTimestamp(maxDate).slice(0, 10)}`
    : undefined;
  const localCount = Math.max(0, options?.localCount || 0);
  const totalAvailable = localCount + accumulatedCount;

  return {
    title: `第 ${pageIndex} 页`,
    detail: [
      localCount ? `本地 ${localCount} 条` : undefined,
      `新增 ${accumulatedCount} 条`,
      `累计可用 ${totalAvailable} 条`,
      `本页 ${result.total} 条`,
      dateRange,
      result.nextBeforeMessageId ? `游标 ${result.nextBeforeMessageId}` : '无游标',
      result.nextBeforeMessageId ? '继续抓取中' : '本轮完成',
      result.truncated ? '已截断' : '未截断',
    ].filter(Boolean).join(' · '),
  };
}

export function formatHistoryFetchFloodWaitProgress(seconds: number) {
  return {
    title: '检索限流',
    detail: `等待 ${seconds} 秒后继续抓取`,
  };
}

export function buildHistoryFetchFallbackAnswer(
  query: MessageFetchQuery,
  result: MessageFetchResult,
) {
  const scopeLabel = describeRawExportQuery(query);
  const messages = result.messages.filter((message) => message.text?.trim());
  const isSparseRangeSummary = query.mode === 'range' && result.total > 0 && result.total <= 2;
  const senderCounts = new Map<string, number>();
  const dayCounts = new Map<string, number>();

  messages.forEach((message) => {
    senderCounts.set(message.sender, (senderCounts.get(message.sender) || 0) + 1);
    const day = formatAiPromptTimestamp(message.date).slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  });

  const topSenders = Array.from(senderCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([sender, count]) => `${sender}（${count} 条）`)
    .join('、');

  const topDays = Array.from(dayCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([day, count]) => `${day}（${count} 条）`)
    .join('、');

  const exampleLines = messages.slice(0, 5)
    .map((message) => `- [${formatAiPromptTimestamp(message.date)}] ${message.sender}: ${message.text.trim()}`);

  if (isSparseRangeSummary) {
    return [
      `已读取${scopeLabel}的聊天记录，但当前聊天在这段时间里本地只找到 ${result.total} 条消息。`,
      '这不能代表这段时间的完整话题。',
      '如果你是想看整周都聊了什么，建议先同步更多历史再继续分析。',
      exampleLines.length ? ['目前能看到的原话：', ...exampleLines].join('\n') : undefined,
    ].filter(Boolean).join('\n');
  }

  return [
    `已读取${scopeLabel}的聊天记录，共 ${result.total} 条。`,
    topDays ? `聊天量主要集中在 ${topDays}。` : undefined,
    topSenders ? `较活跃的发言人有 ${topSenders}（按当前抓到的消息计）。` : undefined,
    exampleLines.length ? ['先摘几条原话：', ...exampleLines].join('\n') : undefined,
  ].filter(Boolean).join('\n');
}

function normalizeOpenAiCompatibleUrl(baseUrl: string) {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');

  if (!trimmedBaseUrl) {
    return 'https://api.openai.com/v1/chat/completions';
  }

  if (trimmedBaseUrl.endsWith('/chat/completions')) {
    return trimmedBaseUrl;
  }

  if (trimmedBaseUrl.endsWith('/v1')) {
    return `${trimmedBaseUrl}/chat/completions`;
  }

  return `${trimmedBaseUrl}/v1/chat/completions`;
}

export function getAiApiUrl(provider: AiProvider, baseUrl?: string) {
  const normalizedBaseUrl = baseUrl?.trim();

  if (provider === 'gemini') {
    return normalizedBaseUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  return normalizedBaseUrl
    ? normalizeOpenAiCompatibleUrl(normalizedBaseUrl)
    : 'https://api.openai.com/v1/chat/completions';
}

export function sanitizeAssistantText(text: string | undefined) {
  if (!text) return undefined;

  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/&lt;think\b[^&]*&gt;[\s\S]*?&lt;\/think&gt;/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/&lt;think\b[^&]*&gt;[\s\S]*$/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseOpenAiAssistantText(responseJson: any) {
  const content = responseJson?.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content
    : content?.map?.((part: { text?: string; type?: string }) => part.text || '').join('');

  return sanitizeAssistantText(text);
}

export function parseOpenAiAssistantRawText(responseJson: any) {
  const content = responseJson?.choices?.[0]?.message?.content;

  return typeof content === 'string'
    ? content
    : content?.map?.((part: { text?: string; type?: string }) => part.text || '').join('');
}

export function buildAiConversationMessages(args: {
  systemPrompt: string;
  evidenceLines: string[];
  toolOutputLines: string[];
  turns: AiChatMessage[];
  currentPrompt: string;
}) {
  const {
    systemPrompt,
    evidenceLines,
    toolOutputLines,
    turns,
    currentPrompt,
  } = args;

  const lastTurn = turns[turns.length - 1];
  const shouldAppendCurrentPrompt = !(
    lastTurn?.role === 'user'
    && lastTurn.content.trim() === currentPrompt.trim()
  );

  const systemContent = [
    systemPrompt,
    ...(evidenceLines.length ? [
      '',
      '当前聊天记录：',
      ...evidenceLines,
    ] : []),
    ...(toolOutputLines.length ? [
      '',
      '工具结果：',
      ...toolOutputLines,
    ] : []),
  ].join('\n');

  return [
    { role: 'system' as const, content: systemContent },
    ...turns.map((turn) => ({
      role: turn.role,
      content: turn.content,
      ...(turn.name ? { name: turn.name } : {}),
      ...(turn.tool_call_id ? { tool_call_id: turn.tool_call_id } : {}),
      ...(turn.tool_calls?.length ? { tool_calls: turn.tool_calls } : {}),
    })),
    ...(shouldAppendCurrentPrompt ? [{
      role: 'user' as const,
      content: currentPrompt,
    }] : []),
  ] as AiChatMessage[];
}

export function resolveAiConversationTurnsForRequest(args: {
  isFirstConversationTurn: boolean;
  historyMessages?: AiChatMessage[];
  turns: AiChatMessage[];
}) {
  const {
    isFirstConversationTurn,
    historyMessages,
    turns,
  } = args;

  if (isFirstConversationTurn) {
    return [] as AiChatMessage[];
  }

  return historyMessages?.length ? historyMessages : turns;
}

export type OpenAiCompatibleMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AiToolCall[];
};

export function serializeOpenAiCompatibleMessages(
  messages: Array<{
    role: OpenAiCompatibleMessage['role'];
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: AiToolCall[];
  }>,
): OpenAiCompatibleMessage[] {
  return messages.map((message) => {
    const normalizedContent = message.content.trim();
    if (!normalizedContent) {
      return {
        role: message.role,
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      };
    }

    return {
      role: message.role,
      content: normalizedContent,
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    };
  });
}

export function parseGeminiAssistantText(responseJson: any) {
  const text = responseJson?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || '')
    .join('') as string | undefined;

  return sanitizeAssistantText(text);
}
