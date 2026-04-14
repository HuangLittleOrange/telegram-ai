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
    defaultLimit = 100,
    userPrompt,
    now,
  } = args;

  if (toolCall.function.name !== 'history-fetch') {
    throw new Error(`Unsupported AI tool: ${toolCall.function.name}`);
  }

  const parsedArgs = parseToolCallArguments(toolCall.function.arguments);
  const resolvedQuery = resolveHistoryFetchToolArgs(parsedArgs, defaultLimit);

  if (!resolvedQuery) {
    throw new Error('Invalid history-fetch tool arguments');
  }

  return applyRelativeTimeRangeOverrideFromPrompt({
    query: resolvedQuery,
    userPrompt,
    now,
  });
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
