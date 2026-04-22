/* eslint-disable @stylistic/max-len */

import type {
  MessageFetchQuery,
  MessageFetchResult,
  ToolOutput,
} from '../types/tabState';

import { resolveAiPromptLocale } from './aiLanguage';
import { sanitizeAssistantText } from './aiText';
import {
  formatHistoryFetchToolResultForModel,
} from './aiToolRuntime';
export {
  buildAiFinalAnswerSystemPrompt,
  buildAiRequestSystemPrompt,
  buildAiSystemPrompt,
  getAiPromptTimeContext,
} from './aiContext';
export {
  sanitizeAssistantText,
} from './aiText';
export {
  buildHistoryFetchQueryFromToolHints,
} from './aiSkills';
export {
  buildAiConversationMessages,
  buildPersistentAiHistoryMessages,
  resolveAiConversationTurnsForRequest,
  serializeOpenAiCompatibleMessages,
  type OpenAiCompatibleMessage,
} from './aiTranscript';
export {
  formatHistoryFetchToolResultForModel,
  shouldOfferHistoryFetchTool,
} from './aiToolRuntime';

export const AI_CONTEXT_LIMIT_MIN = 20;
export const AI_CONTEXT_LIMIT_MAX = 500;
export const AI_CONTEXT_LIMIT_DEFAULT = 100;

type SupportedAiProvider = 'openai' | 'anthropic' | 'gemini';
type PresetRangeValue = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth';

function isEnglishPrompt(languageCode?: string) {
  return resolveAiPromptLocale(languageCode) === 'en';
}

function getPresetRangeLabel(value: PresetRangeValue, languageCode?: string) {
  if (isEnglishPrompt(languageCode)) {
    const englishLabels: Record<PresetRangeValue, string> = {
      today: 'Today',
      yesterday: 'Yesterday',
      thisWeek: 'This week',
      lastWeek: 'Last week',
      thisMonth: 'This month',
    };

    return englishLabels[value];
  }

  const chineseLabels: Record<PresetRangeValue, string> = {
    today: '今天',
    yesterday: '昨天',
    thisWeek: '本周',
    lastWeek: '上周',
    thisMonth: '本月',
  };

  return chineseLabels[value];
}

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
  languageCode?: string,
) {
  const englishPrompt = isEnglishPrompt(languageCode);

  return turns
    .slice(-limit)
    .map((turn) => {
      const normalizedText = sanitizeAssistantText(turn.text) || turn.text;
      if (!normalizedText?.trim()) {
        return undefined;
      }

      const speaker = turn.role === 'assistant' ? 'AI' : (englishPrompt ? 'User' : '用户');
      return `[${formatAiPromptTimestamp(turn.createdAt)}] ${speaker}${englishPrompt ? ': ' : '：'}${normalizedText.trim()}`;
    })
    .filter((line): line is string => Boolean(line));
}

function describeToolOutputQuery(query: MessageFetchQuery, languageCode?: string) {
  const englishPrompt = isEnglishPrompt(languageCode);

  if (query.mode === 'person') {
    return englishPrompt
      ? `Search by person: ${query.person.title || query.person.peerId}`
      : `按人读取：${query.person.title || query.person.peerId}`;
  }

  if (query.mode === 'keyword') {
    return englishPrompt
      ? `Search by keyword: ${query.keyword.trim()}`
      : `按关键词读取：${query.keyword.trim()}`;
  }

  if (query.mode === 'range') {
    if (query.timeRange.mode === 'preset') {
      return englishPrompt
        ? `Search by time: ${getPresetRangeLabel(query.timeRange.value, languageCode)}`
        : `按时间读取：${getPresetRangeLabel(query.timeRange.value, languageCode)}`;
    }

    return englishPrompt ? 'Search by time: Custom range' : '按时间读取：自定义范围';
  }

  return englishPrompt
    ? `Read latest ${query.limit} messages`
    : `读取最近 ${query.limit} 条消息`;
}

function formatToolOutputSummaryLine(toolOutput: ToolOutput, languageCode?: string) {
  const englishPrompt = isEnglishPrompt(languageCode);
  const historyFetchPayload = getHistoryFetchToolPayload(toolOutput);

  if (historyFetchPayload) {
    const querySummary = describeToolOutputQuery(historyFetchPayload.query, languageCode);
    const resultSummary = [
      englishPrompt ? `Matched ${historyFetchPayload.result.total}` : `命中 ${historyFetchPayload.result.total} 条`,
      historyFetchPayload.result.truncated
        ? (englishPrompt ? 'Truncated' : '结果已截断')
        : (englishPrompt ? 'Complete' : '结果完整'),
    ].join(' · ');

    return {
      title: querySummary,
      detail: historyFetchPayload.result.summary || resultSummary,
    };
  }

  if ('description' in toolOutput && toolOutput.description?.trim()) {
    return {
      title: toolOutput.description.trim(),
      detail: englishPrompt ? 'Tool completed' : '工具已完成',
    };
  }

  return {
    title: toolOutput.type,
    detail: englishPrompt ? 'Tool completed' : '工具已完成',
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
  languageCode?: string,
) {
  const englishPrompt = isEnglishPrompt(languageCode);

  return toolOutputs
    .slice(-limit)
    .flatMap((toolOutput) => {
      const summary = formatToolOutputSummaryLine(toolOutput, languageCode);
      const createdAt = formatAiPromptTimestamp(toolOutput.createdAt);
      const lines = [`[${englishPrompt ? 'Tool' : '工具'} | ${createdAt}] ${summary.title}`];

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

export function buildAiPrompt(
  basePrompt: string,
  contextLines: string[],
  conversationContextLines?: string[],
  toolOutputLines: string[] = [],
  options?: {
    languageCode?: string;
  },
) {
  const englishPrompt = isEnglishPrompt(options?.languageCode);

  return buildAiTaskPrompt(
    englishPrompt ? 'Answer the user question' : '回答用户问题',
    englishPrompt
      ? 'Answer the user directly based on chat history.'
      : '根据聊天记录直接回答用户问题。',
    englishPrompt
      ? 'If information is sufficient, give the result directly; otherwise state what is still missing.'
      : '如果信息足够就直接给结果；如果信息不足就明确说明还缺什么。',
    basePrompt,
    contextLines,
    conversationContextLines || [],
    toolOutputLines,
    options,
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
  options?: {
    languageCode?: string;
  },
) {
  const englishPrompt = isEnglishPrompt(options?.languageCode);
  const contextText = contextLines.join('\n');
  const conversationText = conversationContextLines.join('\n');

  if (englishPrompt) {
    return joinPromptBlocks(
      [
        '## Task Prompt',
        `Current task: ${taskTitle}`,
        `Objective: ${taskObjective}`,
        `Output requirements: ${outputRequirements}`,
        'If information is insufficient, retrieve first; if sufficient, provide the result directly.',
        'If the user asks for general facts/background and chat history has no direct answer, you may answer from common knowledge, but clearly mark that this part is not from current chat history.',
        'When you are already in final-answer mode, do not stop at “need to continue retrieval”; either answer directly or clearly state that the chat record alone is insufficient, then add common-knowledge context when applicable.',
        'Prefer this short template: one-line conclusion first, one line saying whether there is direct chat evidence, and one line saying “this part is not from current chat history” when common/model knowledge is used.',
        'When retrieval is needed, output structured tool arguments only, not natural-language retrieval instructions.',
      ],
      [
        '## Inputs',
        userPrompt ? `User question: ${userPrompt}` : undefined,
        contextText ? `Chat records:\n${contextText}` : undefined,
        conversationText ? `Conversation context:\n${conversationText}` : undefined,
        toolOutputLines.length ? `Tool outputs:\n${toolOutputLines.join('\n')}` : undefined,
      ],
    );
  }

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
  options?: {
    languageCode?: string;
  },
) {
  const englishPrompt = isEnglishPrompt(options?.languageCode);
  const contextText = contextLines.join('\n');
  const conversationText = conversationContextLines.join('\n');

  if (englishPrompt) {
    return joinPromptBlocks(
      [
        '## Final Answer Task',
        `User question: ${userPrompt}`,
        'No more retrieval is allowed at this stage; do not request tool calls again.',
        'Use this structure: one-line conclusion, one line about whether direct chat evidence exists, and one line saying “this part is not from current chat history” if common/model knowledge is used.',
      ],
      [
        '## Inputs',
        contextText ? `Chat records:\n${contextText}` : undefined,
        conversationText ? `Conversation context:\n${conversationText}` : undefined,
        toolOutputLines.length ? `Existing tool outputs:\n${toolOutputLines.join('\n')}` : undefined,
      ],
    );
  }

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

function describeRawExportQuery(query: MessageFetchQuery, languageCode?: string) {
  const englishPrompt = isEnglishPrompt(languageCode);

  if (query.mode === 'person') {
    return englishPrompt
      ? `Sender: ${query.person.title || query.person.peerId}`
      : `发言人：${query.person.title || query.person.peerId}`;
  }

  if (query.mode === 'keyword') {
    return englishPrompt
      ? `Keyword: ${query.keyword.trim()}`
      : `关键词：${query.keyword.trim()}`;
  }

  if (query.mode === 'range') {
    if (query.timeRange.mode === 'preset') {
      return getPresetRangeLabel(query.timeRange.value, languageCode);
    }

    return englishPrompt ? 'Custom range' : '自定义范围';
  }

  return englishPrompt
    ? `Latest ${query.limit} messages`
    : `最近 ${query.limit} 条消息`;
}

export function formatRawMessageExport(
  query: MessageFetchQuery,
  result: MessageFetchResult,
  languageCode?: string,
) {
  const englishPrompt = isEnglishPrompt(languageCode);
  const header = englishPrompt
    ? `${describeRawExportQuery(query, languageCode)} raw message export (${result.total})`
    : `${describeRawExportQuery(query, languageCode)}原始消息导出（${result.total} 条）`;
  const lines = result.messages.map((message) => {
    const timestamp = formatAiPromptTimestamp(message.date);
    const text = message.text?.trim() || (englishPrompt ? '(no text)' : '（无文本）');
    return `[${message.messageId} | ${timestamp}] ${message.sender}: ${text}`;
  });

  return [header, ...lines].join('\n');
}

export function formatHistoryFetchPageProgress(
  pageIndex: number,
  accumulatedCount: number,
  result: Pick<MessageFetchResult, 'messages' | 'total' | 'truncated' | 'nextBeforeMessageId'>,
  options?: {
    localCount?: number;
    languageCode?: string;
  },
) {
  const englishPrompt = isEnglishPrompt(options?.languageCode);
  const dates = result.messages.map((message) => message.date).filter(Boolean);
  const minDate = dates.length ? Math.min(...dates) : undefined;
  const maxDate = dates.length ? Math.max(...dates) : undefined;
  const dateRange = minDate && maxDate
    ? `${formatAiPromptTimestamp(minDate).slice(0, 10)} ~ ${formatAiPromptTimestamp(maxDate).slice(0, 10)}`
    : undefined;
  const localCount = Math.max(0, options?.localCount || 0);
  const totalAvailable = localCount + accumulatedCount;

  return {
    title: englishPrompt ? `Page ${pageIndex}` : `第 ${pageIndex} 页`,
    detail: [
      localCount ? (englishPrompt ? `Local ${localCount}` : `本地 ${localCount} 条`) : undefined,
      englishPrompt ? `New local ${accumulatedCount}` : `本地新增 ${accumulatedCount} 条`,
      englishPrompt ? `Total usable ${totalAvailable}` : `累计可用 ${totalAvailable} 条`,
      englishPrompt ? `This page ${result.total}` : `本页 ${result.total} 条`,
      dateRange,
      result.nextBeforeMessageId
        ? (englishPrompt ? `Cursor ${result.nextBeforeMessageId}` : `游标 ${result.nextBeforeMessageId}`)
        : (englishPrompt ? 'No cursor' : '无游标'),
      result.nextBeforeMessageId
        ? (englishPrompt ? 'Fetching continues' : '继续抓取中')
        : (englishPrompt ? 'Round completed' : '本轮完成'),
      result.truncated
        ? (englishPrompt ? 'Truncated' : '已截断')
        : (englishPrompt ? 'Not truncated' : '未截断'),
    ].filter(Boolean).join(' · '),
  };
}

export function formatHistoryFetchFloodWaitProgress(seconds: number, languageCode?: string) {
  const englishPrompt = isEnglishPrompt(languageCode);

  return {
    title: englishPrompt ? 'Telegram flood wait' : 'Telegram 限流',
    detail: englishPrompt
      ? `Wait ${seconds}s before continuing`
      : `等待 ${seconds} 秒后继续抓取`,
  };
}

export function buildHistoryFetchFallbackAnswer(
  query: MessageFetchQuery,
  result: MessageFetchResult,
  languageCode?: string,
) {
  const englishPrompt = isEnglishPrompt(languageCode);
  const scopeLabel = describeRawExportQuery(query, languageCode);
  const messages = result.messages.filter((message) => message.text?.trim());
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
    .map(([sender, count]) => (englishPrompt ? `${sender} (${count})` : `${sender}（${count} 条）`))
    .join(englishPrompt ? ', ' : '、');

  const topDays = Array.from(dayCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([day, count]) => (englishPrompt ? `${day} (${count})` : `${day}（${count} 条）`))
    .join(englishPrompt ? ', ' : '、');

  const exampleLines = messages.slice(0, 5)
    .map((message) => `- [${formatAiPromptTimestamp(message.date)}] ${message.sender}: ${message.text.trim()}`);

  return [
    englishPrompt
      ? `Loaded ${scopeLabel} chat records, ${result.total} in total.`
      : `已读取${scopeLabel}的聊天记录，共 ${result.total} 条。`,
    topDays
      ? (englishPrompt ? `Activity is mainly concentrated on ${topDays}.` : `聊天量主要集中在 ${topDays}。`)
      : undefined,
    topSenders
      ? (englishPrompt
        ? `Most active senders: ${topSenders} (based on currently fetched messages).`
        : `较活跃的发言人有 ${topSenders}（按当前抓到的消息计）。`)
      : undefined,
    exampleLines.length
      ? [(englishPrompt ? 'A few direct quotes:' : '先摘几条原话：'), ...exampleLines].join('\n')
      : undefined,
  ].filter(Boolean).join('\n');
}

function appendEndpointPath(baseUrl: string, endpointPath: string) {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');

  if (!trimmedBaseUrl) {
    return trimmedBaseUrl;
  }

  if (trimmedBaseUrl.endsWith(endpointPath)) {
    return trimmedBaseUrl;
  }

  return `${trimmedBaseUrl}${endpointPath}`;
}

export function getAiApiUrl(provider: SupportedAiProvider, baseUrl?: string) {
  const normalizedBaseUrl = baseUrl?.trim();

  if (provider === 'gemini') {
    return normalizedBaseUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  if (provider === 'anthropic') {
    return normalizedBaseUrl
      ? appendEndpointPath(normalizedBaseUrl, '/messages')
      : 'https://api.anthropic.com/v1/messages';
  }

  if (!normalizedBaseUrl) {
    return 'https://api.openai.com/v1/chat/completions';
  }

  // OpenAI-compatible providers often require `/v1/chat/completions` for host-only URLs.
  try {
    const pathName = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, '');
    if (!pathName) {
      return appendEndpointPath(normalizedBaseUrl, '/v1/chat/completions');
    }
  } catch {
    // Ignore URL parse errors and fallback to path append logic below.
  }

  return appendEndpointPath(normalizedBaseUrl, '/chat/completions');
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

export function parseGeminiAssistantText(responseJson: any) {
  const text = responseJson?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || '')
    .join('') as string | undefined;

  return sanitizeAssistantText(text);
}

export function parseAnthropicAssistantText(responseJson: any) {
  const text = responseJson?.content
    ?.filter?.((part: { type?: string }) => part.type === 'text')
    ?.map?.((part: { text?: string }) => part.text || '')
    .join('') as string | undefined;

  return sanitizeAssistantText(text);
}
