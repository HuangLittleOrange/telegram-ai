import type {
  MessageFetchQuery,
  MessageFetchResult,
  ToolOutput,
} from '../types/tabState';
import type { AiChatMessage, AiToolCall } from './aiAgentRuntime';

import {
  applyRelativeTimeRangeOverrideFromPrompt,
  resolveHistoryFetchToolArgs,
} from './aiSkills';

const HISTORY_FETCH_MIN_LIMIT = 100;
const AUTO_HISTORY_FETCH_TOOL_CALL_ID_PREFIX = 'auto_history_context_stage_';
const AUTO_HISTORY_FETCH_DEFAULT_MAX_ROUNDS = 4;
const AUTO_HISTORY_FETCH_SPARSE_THRESHOLD = 1;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const AUTO_HISTORY_FETCH_RANGE_EXPANSION_DAYS = [0, 3, 14, 60];
const AUTO_HISTORY_FETCH_LIMIT_BY_STAGE = [120, 180, 260, 400, 500];

function formatToolTimestamp(value: number) {
  const normalized = value < 1e12 ? value * 1000 : value;
  const date = new Date(normalized);

  const pad = (input: number) => String(input).padStart(2, '0');

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ');
}

function describeHistoryFetchExportQuery(query: MessageFetchQuery) {
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

function parseToolCallArguments(argumentsText: string) {
  try {
    return JSON.parse(argumentsText);
  } catch {
    throw new Error('Invalid history-fetch tool arguments');
  }
}

function clampToolCallLimit(
  limit: unknown,
  fallback: number,
  minLimit = HISTORY_FETCH_MIN_LIMIT,
) {
  const normalizedFallback = Number.isFinite(fallback) && fallback > 0
    ? Math.min(500, Math.max(minLimit, Math.floor(fallback)))
    : minLimit;
  const numeric = Number(limit);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return normalizedFallback;
  }

  return Math.min(500, Math.max(minLimit, Math.floor(numeric)));
}

function buildFallbackRecentQueryFromToolArgs(
  parsedArgs: unknown,
  defaultLimit: number,
): MessageFetchQuery | undefined {
  if (!parsedArgs || typeof parsedArgs !== 'object') {
    return undefined;
  }

  const candidate = parsedArgs as Record<string, unknown>;

  return {
    mode: 'recent',
    limit: clampToolCallLimit(
      candidate.limit ?? candidate.count ?? candidate.maxResults,
      defaultLimit,
    ),
  };
}

function parseHistoryFetchToolResultPayload(content: string) {
  try {
    const parsed = JSON.parse(content) as {
      query?: unknown;
      total?: unknown;
      messageCount?: unknown;
      messages?: unknown;
    };
    return parsed;
  } catch {
    return undefined;
  }
}

function parseDateOnlyFromToolMessageLine(line: string | undefined) {
  if (!line) {
    return undefined;
  }

  const matched = line.match(/\|\s*(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\]/);
  return matched?.[1];
}

function parseDateOnlyToStartAt(dateOnly: string | undefined) {
  if (!dateOnly) {
    return undefined;
  }

  const matched = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) {
    return undefined;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }

  return new Date(year, month - 1, day).getTime();
}

function formatDateOnlyFromTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getAutoHistoryContextRoundCount(messages: AiChatMessage[]) {
  let maxRound = 0;

  messages.forEach((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      return;
    }

    message.tool_calls.forEach((toolCall) => {
      const matchedRound = toolCall.id.match(/^auto_history_context_stage_(\d+)_/);
      if (!matchedRound) {
        return;
      }

      const round = Number(matchedRound[1]);
      if (Number.isFinite(round) && round > maxRound) {
        maxRound = round;
      }
    });
  });

  return maxRound;
}

function findToolCallById(messages: AiChatMessage[], toolCallId: string) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      continue;
    }

    const toolCall = message.tool_calls.find((item) => item.id === toolCallId);
    if (toolCall) {
      return toolCall;
    }
  }

  return undefined;
}

function resolveRangeBoundsFromToolCall(
  toolCall: AiToolCall | undefined,
  payload: ReturnType<typeof parseHistoryFetchToolResultPayload>,
) {
  const parsedArgs = toolCall?.function?.arguments
    ? parseToolCallArguments(toolCall.function.arguments)
    : undefined;
  const candidate = parsedArgs && typeof parsedArgs === 'object'
    ? parsedArgs as Record<string, unknown>
    : undefined;

  const candidateRange = candidate?.timeRange && typeof candidate.timeRange === 'object'
    ? candidate.timeRange as Record<string, unknown>
    : undefined;
  const fromDateFromArgs = typeof candidateRange?.fromDate === 'string'
    ? candidateRange.fromDate
    : undefined;
  const toDateFromArgs = typeof candidateRange?.toDate === 'string'
    ? candidateRange.toDate
    : undefined;

  if (fromDateFromArgs && toDateFromArgs) {
    return {
      fromDate: fromDateFromArgs,
      toDate: toDateFromArgs,
      sourceMode: candidate?.mode,
    };
  }

  const toolMessages = Array.isArray(payload?.messages)
    ? payload.messages.filter((item): item is string => typeof item === 'string')
    : [];
  const firstDateOnly = parseDateOnlyFromToolMessageLine(toolMessages[0]);
  if (!firstDateOnly) {
    return undefined;
  }

  return {
    fromDate: firstDateOnly,
    toDate: firstDateOnly,
    sourceMode: candidate?.mode,
  };
}

function normalizeHistoryFetchQueryWithMinLimit(
  query: MessageFetchQuery,
  defaultLimit: number,
): MessageFetchQuery {
  return {
    ...query,
    limit: clampToolCallLimit(query.limit, defaultLimit),
  };
}

function buildExpandedDateRangeQuery(args: {
  fromDate: string;
  toDate: string;
  stageIndex: number;
}) {
  const { fromDate, toDate, stageIndex } = args;
  const fromStartAt = parseDateOnlyToStartAt(fromDate);
  const toStartAt = parseDateOnlyToStartAt(toDate);
  if (!fromStartAt || !toStartAt) {
    return undefined;
  }

  const expansionDays = AUTO_HISTORY_FETCH_RANGE_EXPANSION_DAYS[
    Math.min(stageIndex, AUTO_HISTORY_FETCH_RANGE_EXPANSION_DAYS.length - 1)
  ];
  const expandedStart = fromStartAt - expansionDays * DAY_IN_MS;
  const expandedEnd = toStartAt + expansionDays * DAY_IN_MS;

  return {
    mode: 'range' as const,
    timeRange: {
      fromDate: formatDateOnlyFromTimestamp(expandedStart),
      toDate: formatDateOnlyFromTimestamp(expandedEnd),
    },
  };
}

function buildAutoHistoryExpansionQuery(args: {
  messages: AiChatMessage[];
  stageIndex: number;
  defaultLimit: number;
}) {
  const { messages, stageIndex, defaultLimit } = args;

  const latestToolMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'tool' && (!message.name || message.name === 'history-fetch'));
  if (!latestToolMessage?.content || !latestToolMessage.tool_call_id) {
    return undefined;
  }

  const payload = parseHistoryFetchToolResultPayload(latestToolMessage.content);
  if (!payload) {
    return undefined;
  }

  const total = Number(payload.total ?? payload.messageCount);
  if (!Number.isFinite(total) || total > AUTO_HISTORY_FETCH_SPARSE_THRESHOLD) {
    return undefined;
  }

  const latestToolCall = findToolCallById(messages, latestToolMessage.tool_call_id);
  const rangeBounds = resolveRangeBoundsFromToolCall(latestToolCall, payload);
  const stageLimit = AUTO_HISTORY_FETCH_LIMIT_BY_STAGE[
    Math.min(stageIndex, AUTO_HISTORY_FETCH_LIMIT_BY_STAGE.length - 1)
  ];

  if (rangeBounds) {
    const expandedRangeQuery = buildExpandedDateRangeQuery({
      fromDate: rangeBounds.fromDate,
      toDate: rangeBounds.toDate,
      stageIndex,
    });

    if (expandedRangeQuery) {
      return {
        ...expandedRangeQuery,
        limit: clampToolCallLimit(stageLimit, defaultLimit),
      };
    }
  }

  return {
    mode: 'recent',
    limit: clampToolCallLimit(stageLimit, defaultLimit),
  };
}

export function buildAutoHistoryContextToolCall(args: {
  messages: AiChatMessage[];
  defaultLimit?: number;
  maxAutoRounds?: number;
}): AiToolCall | undefined {
  const {
    messages,
    defaultLimit = HISTORY_FETCH_MIN_LIMIT,
    maxAutoRounds = AUTO_HISTORY_FETCH_DEFAULT_MAX_ROUNDS,
  } = args;
  const autoRoundCount = getAutoHistoryContextRoundCount(messages);
  if (autoRoundCount >= maxAutoRounds) {
    return undefined;
  }

  const latestToolMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'tool' && (!message.name || message.name === 'history-fetch'));
  if (!latestToolMessage?.tool_call_id) {
    return undefined;
  }

  const latestToolCall = findToolCallById(messages, latestToolMessage.tool_call_id);
  const latestToolCallArgs = latestToolCall?.function?.arguments
    ? parseToolCallArguments(latestToolCall.function.arguments)
    : undefined;
  const latestArgsObject = latestToolCallArgs && typeof latestToolCallArgs === 'object'
    ? latestToolCallArgs as Record<string, unknown>
    : undefined;
  const hasExplicitRangeQuery = latestArgsObject?.mode === 'range';
  const stageIndex = autoRoundCount === 0 && hasExplicitRangeQuery
    ? 1
    : autoRoundCount;

  const nextQuery = buildAutoHistoryExpansionQuery({
    messages,
    stageIndex,
    defaultLimit,
  });
  if (!nextQuery) {
    return undefined;
  }

  return {
    id: `${AUTO_HISTORY_FETCH_TOOL_CALL_ID_PREFIX}${autoRoundCount + 1}_${Date.now()}`,
    type: 'function',
    function: {
      name: 'history-fetch',
      arguments: JSON.stringify(nextQuery),
    },
  };
}

export function shouldOfferHistoryFetchTool(
  messages: AiChatMessage[],
  maxToolRounds = 3,
) {
  const normalizedMaxToolRounds = Number.isFinite(maxToolRounds) && maxToolRounds > 0
    ? Math.floor(maxToolRounds)
    : 1;
  const usedToolRounds = messages.filter((message) => (
    message.role === 'tool'
    && (!message.name || message.name === 'history-fetch')
  )).length;

  return usedToolRounds < normalizedMaxToolRounds;
}

export function formatHistoryFetchToolResultForModel(
  query: MessageFetchQuery,
  result: MessageFetchResult,
) {
  const messageLines = result.messages.map((message) => {
    const timestamp = formatToolTimestamp(message.date);
    const text = message.text?.trim() || '（无文本）';
    return `[${message.messageId} | ${timestamp}] ${message.sender}: ${text}`;
  });

  return [
    '{',
    `  "query": ${JSON.stringify(describeHistoryFetchExportQuery(query))},`,
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

export function resolveHistoryFetchToolCallQuery(args: {
  toolCall: AiToolCall;
  defaultLimit?: number;
  userPrompt: string;
  now?: number;
}): MessageFetchQuery {
  const {
    toolCall,
    defaultLimit = HISTORY_FETCH_MIN_LIMIT,
    userPrompt,
    now,
  } = args;

  if (toolCall.function.name !== 'history-fetch') {
    throw new Error(`Unsupported AI tool: ${toolCall.function.name}`);
  }

  const parsedArgs = parseToolCallArguments(toolCall.function.arguments);
  const resolvedQuery = resolveHistoryFetchToolArgs(parsedArgs, defaultLimit);

  if (resolvedQuery) {
    return normalizeHistoryFetchQueryWithMinLimit(applyRelativeTimeRangeOverrideFromPrompt({
      query: resolvedQuery,
      userPrompt,
      now,
    }), defaultLimit);
  }

  const fallbackQuery = buildFallbackRecentQueryFromToolArgs(parsedArgs, defaultLimit);
  if (!fallbackQuery) {
    throw new Error('Invalid history-fetch tool arguments');
  }

  return normalizeHistoryFetchQueryWithMinLimit(applyRelativeTimeRangeOverrideFromPrompt({
    query: fallbackQuery,
    userPrompt,
    now,
  }), defaultLimit);
}

export type ExecuteHistoryFetchToolCallArgs = {
  toolCall: AiToolCall;
  defaultLimit?: number;
  userPrompt: string;
  now?: number;
  executeQuery: (args: {
    query: MessageFetchQuery;
  }) => Promise<MessageFetchResult>;
  onQueryStart?: (query: MessageFetchQuery) => void;
  onQueryResult?: (query: MessageFetchQuery, result: MessageFetchResult) => void;
  createdAt?: number;
};

export type ExecuteHistoryFetchToolCallResult = {
  query: MessageFetchQuery;
  result: MessageFetchResult;
  toolOutput: ToolOutput;
  message: AiChatMessage;
};

export async function executeHistoryFetchToolCall(
  args: ExecuteHistoryFetchToolCallArgs,
): Promise<ExecuteHistoryFetchToolCallResult> {
  const {
    toolCall,
    defaultLimit,
    userPrompt,
    now,
    executeQuery,
    onQueryStart,
    onQueryResult,
    createdAt = Date.now(),
  } = args;

  const query = resolveHistoryFetchToolCallQuery({
    toolCall,
    defaultLimit,
    userPrompt,
    now,
  });

  onQueryStart?.(query);

  const result = await executeQuery({
    query,
  });

  onQueryResult?.(query, result);

  return {
    query,
    result,
    toolOutput: {
      type: 'message.fetch',
      query,
      result,
      createdAt,
    },
    message: {
      role: 'tool',
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content: formatHistoryFetchToolResultForModel(query, result),
    },
  };
}
