import type {
  MessageFetchQuery,
  PersonRef,
  TimeRange,
} from '../types/tabState';
import type { AiJudgeDecision, AiQueryPlan } from './aiOrchestrator';

export type AiSkillInvocation =
  | {
    skillName: 'history.fetch';
    mode: 'query';
    query: MessageFetchQuery;
    description: string;
  }
  | {
    skillName: 'history.fetch';
    mode: 'backfill';
    beforeMessageId?: number;
    limit: number;
    description: string;
  };

export const AI_SKILL_GUIDANCE = [
  '可用技能/工具：`history-fetch`。',
  '用途：从当前聊天的本地已同步消息中按人、按关键词、按时间范围获取消息，用来补充上下文。',
  '筛选可组合：`keyword`、`person`、`timeRange` 可以叠加，不是互斥关系。',
  '关键词规则：`keyword` 采用模糊匹配，既会匹配消息内容，也会匹配发言人名称。',
  '限制：不会触发远程拉取，只读取本地已同步数据。',
  '未显式指定对象时，默认读取当前聊天，不是全局所有对话。',
  '时间范围优先使用结构化的 `timeRange` 对象。',
  '当用户使用 `上周`、`本周`、`本月`、`昨天`、`今天` 这类模糊时间时，先基于当前时间准确换算，再传'
  + ' `timeRange: { "fromDate": "YYYY-MM-DD", "toDate": "YYYY-MM-DD" }`。',
  '其中 `上周`、`本周` 按自然周（周一到周日）理解。',
  '不要传 `preset`；统一使用 `fromDate` 和 `toDate`。',
  '调用前先明确你缺什么信息，再为工具准备结构化查询参数。',
  '不要根据用户问题里的字面词做路由判断；历史查询只通过 `toolArgs` 和结构化的 `toolQueryHints` 传递。',
  '尽量把参数写进 `toolArgs`，并保留 `toolQueryHints` 作为补充线索。',
  '如果任务是在找某个名字、称呼、术语或提法，优先在 `toolQueryHints` 里提供 `keyword`。',
  '如果用户要的是一整段时间的话题概览，而范围检索只拿到很少几条消息，要先说明当前聊天本地同步不足，不要把零散消息概括成整段时间的话题。',
  '如果结果不足，优先提示用户先补齐同步范围，而不是假设远程历史可用。',
].join(' ');

export function buildAiSkillGuidance() {
  return AI_SKILL_GUIDANCE;
}

export function buildHistoryFetchToolDefinition() {
  return {
    type: 'function' as const,
    function: {
      name: 'history-fetch',
      description: 'Fetch local synced Telegram chat history with combinable filters (keyword/person/timeRange).',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['person', 'keyword', 'range'],
            description: 'Primary retrieval intent. Filters can still be combined with keyword/person/timeRange.',
          },
          person: {
            type: 'object',
            description: 'Optional sender filter. Can be combined with keyword or timeRange.',
            properties: {
              peerId: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['peerId'],
            additionalProperties: true,
          },
          keyword: {
            type: 'string',
            description: 'Fuzzy keyword that matches both message text and sender display name.',
          },
          timeRange: {
            type: 'object',
            description: 'Optional time filter. Can be combined with keyword/person.',
            properties: {
              fromDate: {
                type: 'string',
                description: 'ISO date string in YYYY-MM-DD format.',
              },
              toDate: {
                type: 'string',
                description: 'ISO date string in YYYY-MM-DD format.',
              },
            },
            additionalProperties: false,
          },
          beforeMessageId: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
    },
  };
}

function describeMessageFetchQuery(query: MessageFetchQuery) {
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

function isHistoryFetchToolName(value: unknown) {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'history.fetch' || normalized === 'history-fetch';
}

function clampMessageFetchLimit(limit: number | undefined, fallback: number) {
  const normalizedFallback = Number.isFinite(fallback) && fallback > 0
    ? Math.min(500, Math.max(1, Math.floor(fallback)))
    : 100;

  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return normalizedFallback;
  }

  return Math.min(500, Math.max(1, Math.floor(limit)));
}

function normalizeHistoryFetchKeywordHint(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized: string | undefined = normalizeHistoryFetchKeywordHint(item);
      if (normalized) {
        return normalized;
      }
    }

    return undefined;
  }

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

function hasExplicitDateExpression(prompt: string) {
  return /(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?|\d{1,2}[-/.]\d{1,2}(?:[-/.]\d{2,4})?|\d{1,2}月\d{1,2}日)/.test(prompt);
}

function startOfDay(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfWeekMonday(timestamp: number) {
  const date = new Date(timestamp);
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday).getTime();
}

function startOfMonth(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function resolveRelativeTimeRangeFromPrompt(
  userPrompt: string,
  now = Date.now(),
): TimeRange | undefined {
  const normalizedPrompt = userPrompt.trim();
  if (!normalizedPrompt || hasExplicitDateExpression(normalizedPrompt)) {
    return undefined;
  }

  const todayStart = startOfDay(now);
  const currentWeekStart = startOfWeekMonday(now);

  if (normalizedPrompt.includes('上周')) {
    const previousWeekStart = currentWeekStart - (7 * 24 * 60 * 60 * 1000);
    return {
      mode: 'custom',
      startAt: previousWeekStart,
      endAt: currentWeekStart,
    };
  }

  if (normalizedPrompt.includes('本周')) {
    return {
      mode: 'custom',
      startAt: currentWeekStart,
      endAt: now,
    };
  }

  if (normalizedPrompt.includes('本月')) {
    return {
      mode: 'custom',
      startAt: startOfMonth(now),
      endAt: now,
    };
  }

  if (normalizedPrompt.includes('昨天')) {
    return {
      mode: 'custom',
      startAt: todayStart - (24 * 60 * 60 * 1000),
      endAt: todayStart,
    };
  }

  if (normalizedPrompt.includes('今天')) {
    return {
      mode: 'custom',
      startAt: todayStart,
      endAt: now,
    };
  }

  return undefined;
}

export function applyRelativeTimeRangeOverrideFromPrompt(args: {
  query: MessageFetchQuery;
  userPrompt: string;
  now?: number;
}): MessageFetchQuery {
  const { query, userPrompt, now } = args;
  const timeRange = resolveRelativeTimeRangeFromPrompt(userPrompt, now);
  if (!timeRange) {
    return query;
  }

  if (query.mode === 'range') {
    return {
      ...query,
      timeRange,
    };
  }

  if (query.mode === 'keyword' || query.mode === 'person') {
    return {
      ...query,
      timeRange,
    };
  }

  return query;
}

function normalizeHistoryFetchPersonHint(value: unknown): PersonRef | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeHistoryFetchPersonHint(item);
      if (normalized) {
        return normalized;
      }
    }

    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    return {
      peerId: trimmed,
      title: trimmed,
    };
  }

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

    // Accept both seconds and milliseconds.
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

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const normalized = normalizeHistoryFetchTimeRangeHint(parsed);
        if (normalized) {
          return normalized;
        }
      } catch {
        // fall through to non-JSON string parsing
      }
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

  if (endAt && !startAt) {
    const durationMs = 7 * 24 * 60 * 60 * 1000;
    return {
      mode: 'custom',
      startAt: Math.max(0, endAt - durationMs),
      endAt,
    };
  }

  if (startAt && !endAt) {
    const durationMs = 7 * 24 * 60 * 60 * 1000;
    return {
      mode: 'custom',
      startAt,
      endAt: startAt + durationMs,
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
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const normalized = normalizeHistoryFetchQueryHint(parsed, fallbackLimit);
        if (normalized) {
          return normalized;
        }
      } catch {
        // fall through to structured parsing only
      }
    }

    return undefined;
  }

  if (!hint || typeof hint !== 'object') {
    return undefined;
  }

  const candidate = hint as Record<string, unknown>;
  const wrappedHint: NormalizedHistoryFetchQueryHint | undefined = normalizeHistoryFetchQueryHint(
    candidate.toolArgs
    ?? candidate.query
    ?? candidate.arguments
    ?? candidate.params
    ?? candidate.input,
    fallbackLimit,
  );
  if (wrappedHint) {
    return wrappedHint;
  }

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

function buildHistoryFetchQueryFromNormalizedHint(
  normalized: NormalizedHistoryFetchQueryHint,
  defaultLimit: number,
) {
  if ('keyword' in normalized && typeof normalized.keyword === 'string' && normalized.keyword.trim()) {
    return {
      mode: 'keyword' as const,
      keyword: normalized.keyword,
      ...(normalized.person ? { person: normalized.person } : {}),
      ...(normalized.timeRange ? { timeRange: normalized.timeRange } : {}),
      limit: normalized.limit || clampMessageFetchLimit(undefined, defaultLimit),
    };
  }

  if ('person' in normalized && normalized.person) {
    return {
      mode: 'person' as const,
      person: normalized.person,
      ...(normalized.timeRange ? { timeRange: normalized.timeRange } : {}),
      ...(normalized.limit ? { limit: normalized.limit } : { limit: clampMessageFetchLimit(undefined, defaultLimit) }),
    };
  }

  if ('timeRange' in normalized && normalized.timeRange) {
    return {
      mode: 'range' as const,
      timeRange: normalized.timeRange,
      ...(normalized.limit ? { limit: normalized.limit } : { limit: clampMessageFetchLimit(undefined, defaultLimit) }),
    };
  }

  return undefined;
}

export function resolveHistoryFetchToolArgs(
  toolArgs: unknown,
  defaultLimit = 100,
): MessageFetchQuery | undefined {
  const normalized = normalizeHistoryFetchQueryHint(toolArgs, defaultLimit);
  if (!normalized) {
    return undefined;
  }

  return buildHistoryFetchQueryFromNormalizedHint(normalized, defaultLimit);
}

export function buildHistoryFetchQueryFromToolHints(args: {
  userPrompt: string;
  plan: Pick<AiQueryPlan, 'nextAction' | 'nextActionReason' | 'toolName' | 'toolArgs' | 'toolQueryHints'>;
  judge: Pick<AiJudgeDecision, 'nextAction' | 'reasoningSummary' | 'toolName' | 'toolArgs' | 'toolQueryHints'>;
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
    const query = buildHistoryFetchQueryFromNormalizedHint(normalized, defaultLimit);
    if (query) {
      return query;
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

export function resolveAiSkillInvocation(args: {
  userPrompt: string;
  plan: Pick<AiQueryPlan, 'nextAction' | 'toolName' | 'toolArgs' | 'toolQueryHints'>;
  judge: Pick<AiJudgeDecision, 'nextAction' | 'toolName' | 'toolArgs' | 'toolQueryHints' | 'beforeMessageId'>;
  defaultLimit?: number;
}): AiSkillInvocation | undefined {
  const query = buildHistoryFetchQueryFromToolHints(args);
  if (query) {
    return {
      skillName: 'history.fetch',
      mode: 'query',
      query,
      description: describeMessageFetchQuery(query),
    };
  }

  const shouldFetch = [
    args.plan.nextAction,
    args.plan.toolName,
    args.judge.nextAction,
    args.judge.toolName,
  ].some((value) => isHistoryFetchToolName(value));

  if (!shouldFetch) {
    return undefined;
  }

  const limit = clampMessageFetchLimit(undefined, args.defaultLimit ?? 100);
  return {
    skillName: 'history.fetch',
    mode: 'backfill',
    beforeMessageId: args.judge.beforeMessageId,
    limit,
    description: '继续向前补回历史聊天记录',
  };
}
