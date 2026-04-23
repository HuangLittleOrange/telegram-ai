/* eslint-disable @stylistic/max-len */

import type { ThreadId } from '../../../types';
import type { ActionReturnType, GlobalState, RequiredGlobalState } from '../../types';
import type { AiStreamEvent, AiStreamStage } from '../../types/aiStream';
import type {
  MessageFetchQuery,
  MessageFetchResult,
  ToolOutput,
} from '../../types/tabState';
import { MAIN_THREAD_ID } from '../../../api/types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { forceUpdateCache } from '../../cache';
import {
  buildAiTaskPrompt,
  buildHistoryFetchFallbackAnswer,
  clampAiContextLimit,
  formatAiPromptConversationContextLines,
  formatAiPromptEvidenceLines,
  formatAiPromptToolOutputLines,
  getAiApiUrl,
  parseAnthropicAssistantText,
  parseGeminiAssistantText,
  parseOpenAiAssistantText,
  sanitizeAssistantText,
} from '../../helpers/ai';
import {
  buildAiRequestSystemPrompt,
} from '../../helpers/aiContext';
import { resolveAiPromptLocale } from '../../helpers/aiLanguage';
import { persistFetchedRangeCoverage } from '../../helpers/aiMessagePersistence';
import {
  buildHistoryFetchToolDefinition,
} from '../../helpers/aiSkills';
import { getMessageSummaryText } from '../../helpers/messageSummary';
import { getPeerTitle } from '../../helpers/peers';
export { buildHistoryFetchQueryFromToolHints } from '../../helpers/aiSkills';
import { getTranslationFn } from '../../../util/localization';
import {
  type AiChatMessage,
  type AiToolCall,
} from '../../helpers/aiAgentRuntime';
import {
  type AiEvidenceItem,
} from '../../helpers/aiOrchestrator';
import { runAiQueryLoop } from '../../helpers/aiQueryLoop';
import aiRunController from '../../helpers/aiRunController';
import {
  applyAiStreamEvent,
  createEmptyAiAssistantState,
  resetAiAssistantState,
} from '../../helpers/aiRunState';
import {
  consumeAssistantThinkDelta,
  createAssistantThinkStreamState,
  flushAssistantThinkState,
} from '../../helpers/aiText';
import { type AiThinkingLog, createAiThinkingTraceStep } from '../../helpers/aiThinking';
import {
  executeHistoryFetchToolCall,
  shouldOfferHistoryFetchTool,
} from '../../helpers/aiToolRuntime';
import {
  buildAiConversationMessages,
  buildPersistentAiHistoryMessages,
  resolveAiConversationTurnsForRequest,
  serializeOpenAiCompatibleMessages,
} from '../../helpers/aiTranscript';
import {
  describeMessageFetchQuery,
  runMessageFetch,
  runMessageFetchWithContinuation,
} from '../../helpers/messageFetch';
import {
  addActionHandler,
  getGlobal,
  setGlobal,
} from '../../index';
import { updateTabState } from '../../reducers/tabs';
import {
  selectChatMessage,
  selectCurrentMessageList,
  selectLanguageCode,
  selectSender,
  selectTabState,
} from '../../selectors';

function getQuickPrompts(languageCode?: string) {
  const isEnglish = resolveAiPromptLocale(languageCode) === 'en';

  return {
    summaryToday: buildAiTaskPrompt(
      isEnglish ? 'Summarize today chat records' : '整理今天聊天记录',
      isEnglish
        ? 'Read today chat records first, then extract key conclusions, important discussion points, unfinished items, and what should be reviewed next when context is still insufficient.'
        : '先读取今天相关的聊天记录，提炼关键结论、重要讨论点、未完成事项，以及如果信息还不够时应该继续补看的内容。',
      isEnglish
        ? 'Use concise output with short sentences. Put results first, then essential evidence. If suitable, provide a directly sendable group summary.'
        : '用简体中文输出，短句优先；先给结果，再补充必要依据；如果适合，给出可以直接发到群里的总结。',
      undefined,
      [],
      [],
      [],
      { languageCode },
    ),
    replySuggestions: buildAiTaskPrompt(
      isEnglish ? 'Generate reply drafts' : '生成回复草稿',
      isEnglish
        ? 'Read current chat context first, then produce 3 directly sendable reply suggestions that cover confirmation, follow-up question, and push-forward.'
        : '先读取当前聊天上下文，再根据用户的问题生成 3 条可以直接发送的回复建议，分别覆盖确认、追问和推进。',
      isEnglish
        ? 'Keep each suggestion to one or two sentences in Telegram group tone. If context is insufficient, first state what chat records are still needed.'
        : '每条控制在一句到两句，贴近 Telegram 群聊语气；如果上下文不足，先说明还需要哪些聊天记录。',
      undefined,
      [],
      [],
      [],
      { languageCode },
    ),
    extractTodos: buildAiTaskPrompt(
      isEnglish ? 'Extract todo items' : '整理待办',
      isEnglish
        ? 'Read recent chat records first, then extract todo items, owners, due dates, and statuses.'
        : '先读取最近聊天记录，提取待办事项、负责人、截止时间和状态。',
      isEnglish
        ? 'Use bullet points. If information is insufficient, mark missing fields and specify what records should be reviewed next.'
        : '按要点列出；信息不足时标出缺失项，并说明还需要继续补看的聊天记录。',
      undefined,
      [],
      [],
      [],
      { languageCode },
    ),
  };
}

const MAX_AI_TOOL_OUTPUTS = 8;
const MAX_PERSISTED_AI_ASSISTANT_SESSIONS = 120;
const AI_ASSISTANT_SESSION_KEY_PREFIX = 'ai';
const AI_ASSISTANT_SESSION_DEFAULT_SCOPE = 'default';
const MAX_HISTORY_FETCH_TOOL_ROUNDS = 8;

type SupportedAiProvider = 'openai' | 'anthropic' | 'gemini';

type AiStreamEventInput = AiStreamEvent extends infer Event
  ? Event extends { runId: string; createdAt: number }
    ? Omit<Event, 'runId' | 'createdAt'>
    : never
  : never;

const EMPTY_AI_ASSISTANT_STATE = createEmptyAiAssistantState();

function describeMessageFetchQueryForUi(query: MessageFetchQuery, languageCode?: string) {
  if (resolveAiPromptLocale(languageCode) !== 'en') {
    return describeMessageFetchQuery(query);
  }

  if (query.mode === 'person') {
    return `Read by person: ${query.person.title || query.person.peerId}`;
  }

  if (query.mode === 'keyword') {
    return `Read by keyword: ${query.keyword.trim()}`;
  }

  if (query.mode === 'range') {
    if (query.timeRange.mode === 'preset') {
      const presetLabels = {
        today: 'today',
        yesterday: 'yesterday',
        thisWeek: 'this week',
        lastWeek: 'last week',
        thisMonth: 'this month',
      } as const;

      return `Read by time: ${presetLabels[query.timeRange.value]}`;
    }

    return 'Read by time: custom range';
  }

  return `Read latest ${query.limit} messages`;
}

type AiAssistantSessionScope = {
  chatId?: string;
  threadId?: ThreadId;
};

function buildAiAssistantSessionKey(
  global: GlobalState,
  chatId?: string,
  threadId?: ThreadId,
) {
  if (!chatId) {
    return undefined;
  }

  const accountId = global.currentUserId || AI_ASSISTANT_SESSION_DEFAULT_SCOPE;
  const normalizedThreadId = threadId ?? MAIN_THREAD_ID;

  return `${AI_ASSISTANT_SESSION_KEY_PREFIX}:${accountId}:${chatId}:${normalizedThreadId}`;
}

function resolveAiAssistantSessionKey(
  global: GlobalState,
  tabId: number,
  scope?: AiAssistantSessionScope,
) {
  const currentMessageList = selectCurrentMessageList(global, tabId);
  const chatId = scope?.chatId || currentMessageList?.chatId;
  const threadId = scope?.threadId ?? currentMessageList?.threadId ?? MAIN_THREAD_ID;

  return buildAiAssistantSessionKey(global, chatId, threadId);
}

function trimAiAssistantSessions(
  byKey: GlobalState['aiAssistantSessions']['byKey'],
): GlobalState['aiAssistantSessions']['byKey'] {
  const entries = Object.entries(byKey);
  if (entries.length <= MAX_PERSISTED_AI_ASSISTANT_SESSIONS) {
    return byKey;
  }

  return Object.fromEntries(entries
    .sort(([, left], [, right]) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(0, MAX_PERSISTED_AI_ASSISTANT_SESSIONS));
}

function getAiAssistantSessionByKey(
  global: GlobalState,
  key?: string,
) {
  return key ? global.aiAssistantSessions?.byKey?.[key] : undefined;
}

function buildPersistedAiAssistantState(
  aiAssistant: ReturnType<typeof createEmptyAiAssistantState>,
  fallbackContextLimit: number,
): GlobalState['aiAssistantSessions']['byKey'][string] {
  return {
    contextLimit: clampAiContextLimit(aiAssistant.contextLimit, fallbackContextLimit),
    turns: (aiAssistant.turns || []).map((turn) => ({
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt,
      thinkingLog: turn.thinkingLog ? {
        startedAt: turn.thinkingLog.startedAt,
        endedAt: turn.thinkingLog.endedAt,
        steps: (turn.thinkingLog.steps || []).map((step) => ({
          stage: step.stage,
          title: step.title,
          detail: step.detail,
          createdAt: step.createdAt,
        })),
      } : undefined,
    })),
    historyMessages: (aiAssistant.historyMessages || []).map((message) => ({
      role: message.role,
      content: message.content || '',
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    })),
    toolOutputHistory: [...(aiAssistant.toolOutputHistory || [])],
    updatedAt: Date.now(),
  };
}

function persistAiAssistantSession(
  global: RequiredGlobalState,
  tabId: number,
  aiAssistant: ReturnType<typeof createEmptyAiAssistantState>,
  scope?: AiAssistantSessionScope,
): RequiredGlobalState {
  const sessionKey = resolveAiAssistantSessionKey(global, tabId, scope);
  if (!sessionKey) {
    return global;
  }

  const fallbackContextLimit = global.settings.byKey.aiSettings.defaultContextLimit;
  const hasPersistedContent = Boolean(
    aiAssistant.turns.length
    || (aiAssistant.historyMessages || []).length
    || (aiAssistant.toolOutputHistory || []).length,
  );
  const hasCustomContextLimit = clampAiContextLimit(
    aiAssistant.contextLimit,
    fallbackContextLimit,
  ) !== fallbackContextLimit;
  const shouldPersist = hasPersistedContent || hasCustomContextLimit;

  const currentByKey = global.aiAssistantSessions?.byKey || {};
  if (!shouldPersist) {
    if (!currentByKey[sessionKey]) {
      return global;
    }

    const { [sessionKey]: _removed, ...rest } = currentByKey;
    return {
      ...global,
      aiAssistantSessions: {
        byKey: rest,
      },
    };
  }

  const nextByKey = trimAiAssistantSessions({
    ...currentByKey,
    [sessionKey]: buildPersistedAiAssistantState(aiAssistant, fallbackContextLimit),
  });

  return {
    ...global,
    aiAssistantSessions: {
      byKey: nextByKey,
    },
  };
}

function buildAiAssistantStateFromSession(
  global: GlobalState,
  tabId: number,
  scope?: AiAssistantSessionScope,
) {
  const tabState = selectTabState(global, tabId);
  const currentAiAssistant = tabState.aiAssistant || EMPTY_AI_ASSISTANT_STATE;
  const sessionKey = resolveAiAssistantSessionKey(global, tabId, scope);
  const session = getAiAssistantSessionByKey(global, sessionKey);
  const fallbackContextLimit = global.settings.byKey.aiSettings.defaultContextLimit;
  const contextLimit = clampAiContextLimit(session?.contextLimit, fallbackContextLimit);

  return {
    ...createEmptyAiAssistantState(contextLimit),
    isOpen: currentAiAssistant.isOpen,
    selectionContext: currentAiAssistant.selectionContext,
    turns: session?.turns || [],
    historyMessages: session?.historyMessages || [],
    toolOutputHistory: session?.toolOutputHistory || [],
  };
}

function buildThinkingLog(aiAssistant: {
  thinkingStartedAt?: number;
  thinkingEndedAt?: number;
  thinkingTrace?: AiThinkingLog['steps'];
}): AiThinkingLog | undefined {
  if (!aiAssistant.thinkingStartedAt) {
    return undefined;
  }

  return {
    startedAt: aiAssistant.thinkingStartedAt,
    endedAt: aiAssistant.thinkingEndedAt,
    steps: aiAssistant.thinkingTrace || [],
  };
}

function updateAiState(
  global: Parameters<typeof updateTabState>[0],
  tabId: number,
  update: Partial<ReturnType<typeof selectTabState>['aiAssistant']>,
  options?: {
    persistSession?: boolean;
    scope?: AiAssistantSessionScope;
  },
): RequiredGlobalState {
  const tabState = selectTabState(global, tabId);
  const aiAssistant = tabState.aiAssistant || EMPTY_AI_ASSISTANT_STATE;
  const nextAiAssistant = {
    ...aiAssistant,
    ...update,
  };

  let nextGlobal = updateTabState(global, {
    aiAssistant: nextAiAssistant,
  }, tabId) as RequiredGlobalState;

  if (options?.persistSession) {
    nextGlobal = persistAiAssistantSession(nextGlobal, tabId, nextAiAssistant, options.scope);
  }

  return nextGlobal;
}

function sortMessageIdsChronologically(
  global: GlobalState,
  chatId: string,
  messageIds: number[],
) {
  return [...messageIds].sort((leftId, rightId) => {
    const leftMessage = selectChatMessage(global, chatId, leftId);
    const rightMessage = selectChatMessage(global, chatId, rightId);
    const leftDate = leftMessage?.date || 0;
    const rightDate = rightMessage?.date || 0;

    if (leftDate !== rightDate) {
      return leftDate - rightDate;
    }

    return leftId - rightId;
  });
}

function buildSelectedMessageEvidenceLines(
  global: GlobalState,
  aiAssistant: ReturnType<typeof createEmptyAiAssistantState>,
) {
  const selectionContext = aiAssistant.selectionContext;
  if (!selectionContext?.messageIds.length) {
    return [];
  }

  const lang = getTranslationFn();

  const items = selectionContext.messageIds
    .map((messageId) => {
      const message = selectChatMessage(global, selectionContext.chatId, messageId);
      if (!message) {
        return undefined;
      }

      const sender = selectSender(global, message);
      const senderTitle = sender ? (getPeerTitle(lang, sender) || String(sender.id)) : 'Unknown';
      const text = getMessageSummaryText(lang, message, undefined, true, 500).trim();
      if (!text) {
        return undefined;
      }

      return {
        messageId: message.id,
        sender: senderTitle,
        text,
        date: message.date ? message.date * 1000 : undefined,
      };
    })
    .filter(Boolean) as Array<{
    messageId: number;
    sender: string;
    text: string;
    date?: number;
  }>;

  if (!items.length) {
    return [];
  }

  return [
    '用户显式选中了以下消息，请优先围绕这些消息回答；只有当这些消息不足以支撑回答时，才补充附近上下文。',
    ...formatAiPromptEvidenceLines(items),
  ];
}

function applyAiStreamEventForTab(tabId: number, event: AiStreamEvent) {
  let global = getGlobal();
  const tabState = selectTabState(global, tabId);
  const aiAssistant = tabState.aiAssistant || createEmptyAiAssistantState();
  const nextAiAssistant = applyAiStreamEvent(aiAssistant, event);

  global = updateTabState(global, {
    aiAssistant: nextAiAssistant,
  }, tabId);
  setGlobal(global);

  return nextAiAssistant;
}

function appendAiToolOutput(
  global: GlobalState,
  tabId: number,
  toolOutput: ToolOutput,
): RequiredGlobalState {
  const tabState = selectTabState(global, tabId);
  const aiAssistant = tabState.aiAssistant || EMPTY_AI_ASSISTANT_STATE;
  const toolOutputHistory = [
    ...(aiAssistant.toolOutputHistory || []),
    toolOutput,
  ].slice(-12);

  return updateAiState(global, tabId, {
    toolOutputs: [
      ...aiAssistant.toolOutputs.slice(-(MAX_AI_TOOL_OUTPUTS - 1)),
      toolOutput,
    ],
    toolOutputHistory,
  }, {
    persistSession: true,
  });
}

function getAiProviderDefaults(provider: SupportedAiProvider) {
  if (provider === 'gemini') {
    return {
      model: 'gemini-2.0-flash',
    };
  }

  if (provider === 'anthropic') {
    return {
      model: 'claude-3-5-sonnet-latest',
    };
  }

  return {
    model: 'gemma4:e4b',
  };
}

function toHistoryEvidenceItems(result: MessageFetchResult): AiEvidenceItem[] {
  return result.messages.map((message) => ({
    chatId: message.chatId,
    threadId: message.threadId,
    messageId: message.messageId,
    sender: message.sender,
    text: message.text,
    source: 'history',
    date: message.date,
  }));
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : Boolean(error && typeof error === 'object' && 'name' in error && (error as any).name === 'AbortError');
}

async function requestAiCompletion(
  provider: SupportedAiProvider,
  model: string,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  prompt: string,
  options?: {
    systemPrompt?: string;
    temperature?: number;
    stream?: boolean;
    languageCode?: string;
    signal?: AbortSignal;
  },
): Promise<string | ReadableStreamDefaultReader<Uint8Array>> {
  if (provider === 'gemini') {
    if (!apiKey) {
      throw new Error('Missing API key. Configure it in Settings > AI Settings.');
    }

    const endpoint = getAiApiUrl(provider, baseUrl);
    const isStream = Boolean(options?.stream);
    const baseModelPath = endpoint.includes(':')
      ? endpoint.slice(0, endpoint.indexOf(':'))
      : `${endpoint}/${encodeURIComponent(model)}`;
    const url = isStream
      ? `${baseModelPath}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
      : `${baseModelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: options?.signal,
      body: JSON.stringify({
        ...(options?.systemPrompt ? {
          systemInstruction: {
            parts: [{ text: options.systemPrompt }],
          },
        } : undefined),
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      }),
    });

    if (isStream) {
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `Gemini request failed (${response.status})`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Gemini stream is empty');
      }

      return reader;
    }

    const json = await response.json().catch(() => undefined);

    if (!response.ok) {
      const errorMessage = json?.error?.message || `Gemini request failed (${response.status})`;
      throw new Error(errorMessage);
    }

    const text = parseGeminiAssistantText(json);
    if (!text) {
      throw new Error('Gemini returned an empty response');
    }

    return text;
  }

  if (provider === 'anthropic') {
    if (!apiKey) {
      throw new Error('Missing API key. Configure it in Settings > AI Settings.');
    }

    if (options?.stream) {
      throw new Error('Anthropic streaming is not supported in this runtime');
    }

    const endpoint = getAiApiUrl(provider, baseUrl);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      signal: options?.signal,
      body: JSON.stringify({
        model,
        system: options?.systemPrompt || buildAiRequestSystemPrompt({ languageCode: options?.languageCode }),
        messages: [
          { role: 'user', content: prompt },
        ],
        temperature: options?.temperature ?? 0.4,
        max_tokens: 4096,
      }),
    });

    const json = await response.json().catch(() => undefined);

    if (!response.ok) {
      const errorMessage = json?.error?.message || `Anthropic request failed (${response.status})`;
      throw new Error(errorMessage);
    }

    const text = parseAnthropicAssistantText(json);
    if (!text) {
      throw new Error('Anthropic returned an empty response');
    }

    return text;
  }

  const endpoint = getAiApiUrl(provider, baseUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined),
    },
    signal: options?.signal,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: options?.systemPrompt || buildAiRequestSystemPrompt({ languageCode: options?.languageCode }),
        },
        { role: 'user', content: prompt },
      ],
      temperature: options?.temperature ?? 0.4,
      stream: Boolean(options?.stream),
    }),
  });

  if (options?.stream) {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `OpenAI request failed (${response.status})`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('OpenAI stream is empty');
    }

    return reader;
  }

  const json = await response.json().catch(() => undefined);

  if (!response.ok) {
    const errorMessage = json?.error?.message || `OpenAI request failed (${response.status})`;
    throw new Error(errorMessage);
  }

  const text = parseOpenAiAssistantText(json);
  if (!text) {
    throw new Error('OpenAI returned an empty response');
  }

  return text;
}

type OpenAiToolCall = AiToolCall;

type OpenAiToolCallChunk = {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAiChatCompletionChunk = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; type?: string; value?: string }>;
      reasoning_content?: string;
      reasoning_details?: Array<{
        text?: string;
        content?: string;
        type?: string;
      }>;
    };
    delta?: {
      content?: string | Array<{ text?: string; type?: string; value?: string }>;
      reasoning?: string | {
        text?: string;
        content?: string;
      } | Array<{
        text?: string;
        content?: string;
        type?: string;
      }>;
      reasoning_content?: string;
      reasoning_details?: Array<{
        text?: string;
        content?: string;
        type?: string;
      }>;
      tool_calls?: OpenAiToolCallChunk[];
    };
  }>;
  error?: {
    message?: string;
  };
};

function isReasoningContentType(type: string | undefined) {
  if (!type) {
    return false;
  }

  const normalizedType = type.toLowerCase();
  return normalizedType.includes('reasoning') || normalizedType === 'thinking';
}

function parseOpenAiReasoningDeltaText(chunk: OpenAiChatCompletionChunk) {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) {
    return '';
  }

  if (typeof delta.reasoning_content === 'string') {
    return delta.reasoning_content;
  }

  if (typeof delta.reasoning === 'string') {
    return delta.reasoning;
  }

  if (Array.isArray(delta.reasoning_details)) {
    return delta.reasoning_details
      .map((part) => (
        typeof part?.text === 'string'
          ? part.text
          : (typeof part?.content === 'string' ? part.content : '')
      ))
      .join('');
  }

  if (delta.reasoning && typeof delta.reasoning === 'object') {
    if (Array.isArray(delta.reasoning)) {
      return delta.reasoning
        .map((part) => (
          typeof part?.text === 'string'
            ? part.text
            : (typeof part?.content === 'string' ? part.content : '')
        ))
        .join('');
    }

    if (typeof delta.reasoning.text === 'string') {
      return delta.reasoning.text;
    }

    if (typeof delta.reasoning.content === 'string') {
      return delta.reasoning.content;
    }
  }

  const content = delta.content;
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => isReasoningContentType(part?.type))
    .map((part) => (
      typeof part?.text === 'string'
        ? part.text
        : (typeof part?.value === 'string' ? part.value : '')
    ))
    .join('');
}

function parseOpenAiReasoningMessageText(chunk: OpenAiChatCompletionChunk) {
  const message = chunk.choices?.[0]?.message;
  if (!message) {
    return '';
  }

  if (typeof message.reasoning_content === 'string') {
    return message.reasoning_content;
  }

  if (Array.isArray(message.reasoning_details)) {
    return message.reasoning_details
      .map((part) => (
        typeof part?.text === 'string'
          ? part.text
          : (typeof part?.content === 'string' ? part.content : '')
      ))
      .join('');
  }

  return '';
}

function parseOpenAiDeltaText(chunk: OpenAiChatCompletionChunk) {
  const content = chunk.choices?.[0]?.delta?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => !isReasoningContentType(part?.type))
      .map((part) => (
        typeof part?.text === 'string'
          ? part.text
          : (typeof part?.value === 'string' ? part.value : '')
      ))
      .join('');
    return text || '';
  }

  return '';
}

function parseOpenAiMessageText(chunk: OpenAiChatCompletionChunk) {
  const content = chunk.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => !isReasoningContentType(part?.type))
      .map((part) => (
        typeof part?.text === 'string'
          ? part.text
          : (typeof part?.value === 'string' ? part.value : '')
      ))
      .join('');

    return text || '';
  }

  return '';
}

const OPENAI_CHAT_COMPLETION_TIMEOUT_MS = 45_000;

function createAbortSignalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, timeoutMs);

  const abortFromSignal = () => {
    controller.abort(signal?.reason);
  };

  if (signal) {
    if (signal.aborted) {
      abortFromSignal();
    } else {
      signal.addEventListener('abort', abortFromSignal, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', abortFromSignal);
      }
    },
  };
}

async function requestOpenAiChatCompletion(args: {
  provider: SupportedAiProvider;
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  messages: AiChatMessage[];
  tools?: Array<ReturnType<typeof buildHistoryFetchToolDefinition>>;
  temperature?: number;
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<{ content: string; toolCalls: OpenAiToolCall[] }> {
  const {
    provider,
    model,
    apiKey,
    baseUrl,
    messages,
    tools,
    temperature = 0.3,
    onTextDelta,
    signal,
  } = args;

  if (provider !== 'openai') {
    throw new Error(`Chat tool calling is not supported for ${provider} in this runtime`);
  }

  const endpoint = getAiApiUrl(provider, baseUrl);
  const requestController = createAbortSignalWithTimeout(signal, OPENAI_CHAT_COMPLETION_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined),
      },
      signal: requestController.signal,
      body: JSON.stringify({
        model,
        messages: serializeOpenAiCompatibleMessages(messages),
        ...(tools?.length ? { tools } : undefined),
        temperature,
        stream: true,
      }),
    });
  } catch (error) {
    requestController.cleanup();
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(`OpenAI request timed out after ${OPENAI_CHAT_COMPLETION_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  }
  if (!response.ok) {
    const rawError = await response.text().catch(() => '');
    let errorMessage = `OpenAI request failed (${response.status})`;
    if (rawError) {
      try {
        const parsedError = JSON.parse(rawError) as OpenAiChatCompletionChunk;
        errorMessage = parsedError?.error?.message || rawError || errorMessage;
      } catch {
        errorMessage = rawError;
      }
    }
    requestController.cleanup();
    throw new Error(errorMessage);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    requestController.cleanup();
    throw new Error('OpenAI stream is empty');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let hasSeenReasoningDelta = false;
  const toolCallsByIndex = new Map<number, OpenAiToolCall>();

  const upsertToolCall = (rawToolCall: OpenAiToolCallChunk) => {
    const toolCallIndex = typeof rawToolCall.index === 'number' ? rawToolCall.index : toolCallsByIndex.size;
    const existing = toolCallsByIndex.get(toolCallIndex);
    const next: OpenAiToolCall = existing || {
      id: '',
      type: 'function',
      function: {
        name: '',
        arguments: '',
      },
    };

    if (typeof rawToolCall.id === 'string' && rawToolCall.id) {
      next.id = rawToolCall.id;
    }
    if (rawToolCall.type === 'function') {
      next.type = 'function';
    }
    if (typeof rawToolCall.function?.name === 'string' && rawToolCall.function.name) {
      next.function.name += rawToolCall.function.name;
    }
    if (typeof rawToolCall.function?.arguments === 'string' && rawToolCall.function.arguments) {
      next.function.arguments += rawToolCall.function.arguments;
    }

    toolCallsByIndex.set(toolCallIndex, next);
  };

  const parseDataLine = (rawData: string) => {
    const data = rawData.trim();
    if (!data || data === '[DONE]') {
      return data === '[DONE]';
    }

    let chunk: OpenAiChatCompletionChunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return false;
    }

    if (chunk.error?.message) {
      throw new Error(chunk.error.message);
    }

    const reasoningDelta = parseOpenAiReasoningDeltaText(chunk);
    const reasoningMessageFallback = !reasoningDelta && !hasSeenReasoningDelta
      ? parseOpenAiReasoningMessageText(chunk)
      : '';
    const reasoningText = reasoningDelta || reasoningMessageFallback;
    if (reasoningText) {
      hasSeenReasoningDelta = true;
      // Emit each reasoning chunk as an independent think block so the panel
      // can show progress immediately, instead of waiting for normal content.
      onTextDelta?.(`<think>${reasoningText}</think>`);
    }

    const textDelta = parseOpenAiDeltaText(chunk);
    const messageTextFallback = !textDelta && !content
      ? parseOpenAiMessageText(chunk)
      : '';
    const visibleText = textDelta || messageTextFallback;
    if (visibleText) {
      content += visibleText;
      onTextDelta?.(visibleText);
    }

    const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
    if (Array.isArray(toolCalls)) {
      toolCalls.forEach(upsertToolCall);
    }

    return false;
  };

  try {
    let hasDone = false;

    while (!hasDone) {
      const readResult = await reader.read();
      if (readResult.done) {
        break;
      }

      buffer += decoder.decode(readResult.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue;
        }

        hasDone = parseDataLine(line.slice(5));
        if (hasDone) {
          break;
        }
      }
    }

    if (buffer.trim().startsWith('data:')) {
      parseDataLine(buffer.trim().slice(5));
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(`OpenAI request timed out after ${OPENAI_CHAT_COMPLETION_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    requestController.cleanup();
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failures.
    }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, toolCall]) => toolCall)
    .filter((toolCall): toolCall is OpenAiToolCall => Boolean(
      toolCall.id
      && toolCall.function?.name
      && typeof toolCall.function.arguments === 'string',
    ));

  return {
    content,
    toolCalls,
  };
}

addActionHandler('toggleAiAssistant', (global, actions, payload): ActionReturnType => {
  const { force, tabId = getCurrentTabId() } = payload || {};
  const tabState = selectTabState(global, tabId);
  const aiAssistant = tabState.aiAssistant || EMPTY_AI_ASSISTANT_STATE;
  const isOpen = force !== undefined ? force : !aiAssistant.isOpen;

  return updateTabState(global, {
    aiAssistant: {
      ...aiAssistant,
      isOpen,
      error: undefined,
      selectionContext: isOpen ? aiAssistant.selectionContext : undefined,
      contextLimit: clampAiContextLimit(
        aiAssistant.contextLimit,
        global.settings.byKey.aiSettings.defaultContextLimit,
      ),
    },
    chatInfo: {
      ...tabState.chatInfo,
      isOpen: isOpen ? false : tabState.chatInfo.isOpen,
    },
  }, tabId);
});

addActionHandler('openAiAssistantWithSelectedMessages', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const tabState = selectTabState(global, tabId);
  const { selectedMessages } = tabState;
  if (!selectedMessages?.messageIds.length) {
    return global;
  }

  const currentMessageList = selectCurrentMessageList(global, tabId);
  const threadId = currentMessageList?.threadId || MAIN_THREAD_ID;
  const aiAssistant = tabState.aiAssistant || EMPTY_AI_ASSISTANT_STATE;

  return updateTabState(global, {
    selectedMessages: undefined,
    aiAssistant: {
      ...aiAssistant,
      isOpen: true,
      error: undefined,
      selectionContext: {
        source: 'message-selection',
        chatId: selectedMessages.chatId,
        threadId,
        messageIds: sortMessageIdsChronologically(global, selectedMessages.chatId, selectedMessages.messageIds),
        createdAt: Date.now(),
      },
      contextLimit: clampAiContextLimit(
        aiAssistant.contextLimit,
        global.settings.byKey.aiSettings.defaultContextLimit,
      ),
    },
    chatInfo: {
      ...tabState.chatInfo,
      isOpen: false,
    },
  }, tabId);
});

addActionHandler('clearAiSelectionContext', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};

  return updateAiState(global, tabId, {
    selectionContext: undefined,
  });
});

addActionHandler('setAiContextLimit', (global, actions, payload): ActionReturnType => {
  const { contextLimit, tabId = getCurrentTabId() } = payload;
  const fallback = global.settings.byKey.aiSettings.defaultContextLimit;

  return updateAiState(global, tabId, {
    contextLimit: clampAiContextLimit(contextLimit, fallback),
  }, {
    persistSession: true,
  });
});

addActionHandler('setAiActualUsedCount', (global, actions, payload): ActionReturnType => {
  const { actualUsedCount, tabId = getCurrentTabId() } = payload;

  return updateAiState(global, tabId, {
    actualUsedCount,
  });
});

addActionHandler('setAiLoading', (global, actions, payload): ActionReturnType => {
  const { isLoading, tabId = getCurrentTabId() } = payload;

  return updateAiState(global, tabId, {
    isLoading,
  });
});

addActionHandler('setAiThinkingStage', (global, actions, payload): ActionReturnType => {
  const { thinkingStage, tabId = getCurrentTabId() } = payload;

  return updateAiState(global, tabId, {
    thinkingStage,
  });
});

addActionHandler('setAiThinkingStartedAt', (global, actions, payload): ActionReturnType => {
  const { thinkingStartedAt, tabId = getCurrentTabId() } = payload;

  return updateAiState(global, tabId, {
    thinkingStartedAt,
  });
});

addActionHandler('setAiThinkingEndedAt', (global, actions, payload): ActionReturnType => {
  const { thinkingEndedAt, tabId = getCurrentTabId() } = payload;

  return updateAiState(global, tabId, {
    thinkingEndedAt,
  });
});

addActionHandler('appendAiThinkingTrace', (global, actions, payload): ActionReturnType => {
  const {
    trace,
    tabId = getCurrentTabId(),
  } = payload;

  const currentTrace = (selectTabState(global, tabId).aiAssistant || EMPTY_AI_ASSISTANT_STATE).thinkingTrace || [];
  const normalizedTrace = createAiThinkingTraceStep({
    ...trace,
    createdAt: trace.createdAt || Date.now(),
  });
  if (!normalizedTrace.title) {
    return global;
  }

  if (
    currentTrace[currentTrace.length - 1]?.stage === normalizedTrace.stage
    && currentTrace[currentTrace.length - 1]?.title === normalizedTrace.title
    && currentTrace[currentTrace.length - 1]?.detail === normalizedTrace.detail
  ) {
    return updateAiState(global, tabId, {
      thinkingTrace: [
        ...currentTrace.slice(0, -1),
        normalizedTrace,
      ],
    });
  }

  return updateAiState(global, tabId, {
    thinkingTrace: [
      ...currentTrace.slice(-7),
      normalizedTrace,
    ],
  });
});

addActionHandler('clearAiThinkingTrace', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};

  return updateAiState(global, tabId, {
    thinkingStage: undefined,
    thinkingStartedAt: undefined,
    thinkingEndedAt: undefined,
    thinkingTrace: [],
  });
});

addActionHandler('setAiError', (global, actions, payload): ActionReturnType => {
  const { error, tabId = getCurrentTabId() } = payload;

  return updateAiState(global, tabId, {
    error,
  });
});

addActionHandler('clearAiTurns', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const activeRun = aiRunController.getActiveRun(tabId);
  if (activeRun) {
    aiRunController.cancelRun(tabId);
  }

  return updateAiState(global, tabId, {
    ...resetAiAssistantState(selectTabState(global, tabId).aiAssistant || createEmptyAiAssistantState()),
  }, {
    persistSession: true,
  });
});

addActionHandler('appendAiTurn', (global, actions, payload): ActionReturnType => {
  const {
    role,
    text,
    createdAt = Date.now(),
    attachedMessageCount,
    thinkingLog,
    tabId = getCurrentTabId(),
  } = payload;

  const normalizedText = text;
  if (!normalizedText.trim()) {
    return global;
  }

  const turns = (selectTabState(global, tabId).aiAssistant || EMPTY_AI_ASSISTANT_STATE).turns;

  return updateAiState(global, tabId, {
    turns: [
      ...turns,
      {
        role,
        text: normalizedText,
        createdAt,
        attachedMessageCount,
        thinkingLog,
      },
    ],
  }, {
    persistSession: true,
  });
});

addActionHandler('hydrateAiAssistantSession', (global, actions, payload): ActionReturnType => {
  const {
    tabId = getCurrentTabId(),
    chatId,
    threadId,
  } = payload || {};
  const activeRun = aiRunController.getActiveRun(tabId);
  if (activeRun) {
    aiRunController.cancelRun(tabId);
  }

  return updateTabState(global, {
    aiAssistant: buildAiAssistantStateFromSession(global, tabId, {
      chatId,
      threadId,
    }),
  }, tabId);
});

addActionHandler('requestAiSummaryToday', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const languageCode = selectLanguageCode(global);
  const quickPrompts = getQuickPrompts(languageCode);
  actions.requestAiPrompt({ prompt: quickPrompts.summaryToday, tabId });
});

addActionHandler('requestAiReplySuggestions', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const languageCode = selectLanguageCode(global);
  const quickPrompts = getQuickPrompts(languageCode);
  actions.requestAiPrompt({ prompt: quickPrompts.replySuggestions, tabId });
});

addActionHandler('requestAiExtractTodos', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const languageCode = selectLanguageCode(global);
  const quickPrompts = getQuickPrompts(languageCode);
  actions.requestAiPrompt({ prompt: quickPrompts.extractTodos, tabId });
});

addActionHandler('requestAiPrompt', async (global, actions, payload): Promise<void> => {
  const { prompt, tabId = getCurrentTabId() } = payload;
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return;
  }
  const languageCode = selectLanguageCode(global);
  const isEnglishPrompt = resolveAiPromptLocale(languageCode) === 'en';

  const run = aiRunController.startRun(tabId);
  const { runId } = run;

  const isRunActive = () => aiRunController.isActiveRun(tabId, runId);

  const emitEvent = (event: AiStreamEventInput) => {
    if (!isRunActive()) {
      return undefined;
    }

    return applyAiStreamEventForTab(tabId, {
      ...event,
      runId,
      createdAt: Date.now(),
    } as AiStreamEvent);
  };

  const emitThinking = (stage: AiStreamStage, title: string, detail?: string) => {
    emitEvent({
      type: 'thinking.stage',
      stage,
      title,
      detail,
    });
    emitEvent({
      type: 'thinking.trace',
      stage,
      title,
      detail,
    });
  };

  emitEvent({ type: 'run.started' });
  global = getGlobal();
  let aiAssistant = (selectTabState(global, tabId).aiAssistant || EMPTY_AI_ASSISTANT_STATE);
  actions.appendAiTurn({
    role: 'user',
    text: trimmedPrompt,
    attachedMessageCount: aiAssistant.selectionContext?.messageIds.length,
    tabId,
  });
  emitThinking(
    'answer',
    isEnglishPrompt ? 'Understanding your request' : '正在理解你的问题',
    isEnglishPrompt
      ? 'I will answer directly first, and retrieve history only when necessary.'
      : '先直接回答你的问题，必要时再检索历史消息',
  );

  global = getGlobal();
  const tabState = selectTabState(global, tabId);
  aiAssistant = tabState.aiAssistant || EMPTY_AI_ASSISTANT_STATE;
  const settings = global.settings.byKey.aiSettings;
  const provider = settings.provider;
  const modelInput = settings.model?.trim();
  const baseUrlInput = settings.baseUrl?.trim();
  const apiKey = settings.apiKey?.trim();
  const hasAnyAiConfig = Boolean(modelInput || apiKey || baseUrlInput);
  const model = modelInput || getAiProviderDefaults(provider).model;
  const signal = run.abortController.signal;

  if (!hasAnyAiConfig) {
    emitEvent({
      type: 'run.error',
      error: 'Missing AI settings. Configure at least one of Model ID / API Key / Base URL in Settings > AI Settings.',
    });
    aiRunController.finishRun(tabId, runId);
    return;
  }

  if (provider !== 'openai' && !apiKey) {
    emitEvent({
      type: 'run.error',
      error: 'Missing API key. Configure it in Settings > AI Settings.',
    });
    aiRunController.finishRun(tabId, runId);
    return;
  }

  try {
    const currentMessageList = selectCurrentMessageList(global, tabId);
    const currentChatId = currentMessageList?.chatId;
    const currentChatSyncState = currentChatId
      ? global.chatSync.byChatId[currentChatId]
      : undefined;
    const baseRequestSystemPrompt = buildAiRequestSystemPrompt({
      languageCode,
      syncCoverage: currentChatId ? {
        chatId: currentChatId,
        oldestSyncedDate: currentChatSyncState?.oldestSyncedDate,
        newestSyncedDate: currentChatSyncState?.newestSyncedDate,
        syncedMessages: currentChatSyncState?.syncedMessages,
        totalMessages: currentChatSyncState?.totalMessages,
      } : undefined,
    });
    const selectedMessageEvidenceLines = buildSelectedMessageEvidenceLines(global, aiAssistant);
    if (aiAssistant.selectionContext) {
      global = updateAiState(global, tabId, {
        selectionContext: undefined,
      });
      setGlobal(global);
    }
    const requestSystemPrompt = selectedMessageEvidenceLines.length
      ? [
        baseRequestSystemPrompt,
        '## Selected Message Context',
        '用户显式框选了当前问题的焦点消息。优先基于这些消息回答，不要默认扩展成整个聊天的宽泛总结；只有这些消息不足时，才补充邻近上下文。',
      ].join('\n\n')
      : baseRequestSystemPrompt;

    const localEvidence: AiEvidenceItem[] = [];
    const contextEvidenceLines = [
      ...selectedMessageEvidenceLines,
      ...formatAiPromptEvidenceLines(
        localEvidence.slice(-Math.min(localEvidence.length, 12)),
      ),
    ];
    const toolOutputContextLines = formatAiPromptToolOutputLines(
      aiAssistant.toolOutputHistory || [],
      4,
      languageCode,
    );
    let collectedToolOutputs = [...(aiAssistant.toolOutputHistory || [])];
    const conversationContextLines = formatAiPromptConversationContextLines(aiAssistant.turns, 6, languageCode);
    const isFirstConversationTurn = !(aiAssistant.turns || []).some((turn) => turn.role === 'assistant');
    const conversationTurns = resolveAiConversationTurnsForRequest({
      isFirstConversationTurn,
      historyMessages: aiAssistant.historyMessages,
      turns: (aiAssistant.turns || []).map((turn) => ({
        role: turn.role,
        content: turn.text,
      })) as AiChatMessage[],
    });

    const conversationMessages: AiChatMessage[] = buildAiConversationMessages({
      systemPrompt: requestSystemPrompt,
      evidenceLines: contextEvidenceLines,
      toolOutputLines: toolOutputContextLines,
      turns: conversationTurns,
      currentPrompt: trimmedPrompt,
      languageCode,
    });

    const commitFinalAnswer = (
      finalText: string,
      historyMessageSource: AiChatMessage[],
      actualUsedCount: number,
      committedAt = Date.now(),
    ) => {
      const normalizedFinalText = sanitizeAssistantText(finalText) || finalText;
      actions.setAiThinkingEndedAt({ thinkingEndedAt: committedAt, tabId });
      global = getGlobal();
      actions.appendAiTurn({
        role: 'assistant',
        text: normalizedFinalText,
        tabId,
        thinkingLog: buildThinkingLog(selectTabState(global, tabId).aiAssistant),
      });
      global = updateAiState(global, tabId, {
        historyMessages: buildPersistentAiHistoryMessages(historyMessageSource, normalizedFinalText),
      }, {
        persistSession: true,
      });
      setGlobal(global);
      actions.setAiActualUsedCount({ actualUsedCount, tabId });
    };

    let historyMessageSource = conversationMessages;
    let actualUsedCount = localEvidence.length;
    let finalAnswerText: string | undefined;
    let fallbackFinalText: string | undefined;

    emitThinking(
      'answer',
      isEnglishPrompt ? 'Generating answer' : '正在生成回答',
      isEnglishPrompt ? 'If needed, I will retrieve additional history messages.' : '若信息不足会按需检索历史消息',
    );

    if (provider === 'openai') {
      let fetchedCount = 0;
      let fallbackQuery: Parameters<typeof buildHistoryFetchFallbackAnswer>[0] | undefined;
      let fallbackResult: Parameters<typeof buildHistoryFetchFallbackAnswer>[1] | undefined;

      const loopResult = await runAiQueryLoop({
        messages: conversationMessages,
        complete: async (messages) => {
          const tools = shouldOfferHistoryFetchTool(messages, MAX_HISTORY_FETCH_TOOL_ROUNDS)
            ? [buildHistoryFetchToolDefinition()]
            : undefined;
          const thinkStreamState = createAssistantThinkStreamState();
          const emitThinkTrace = (thinkText: string) => {
            const detail = thinkText.trim();
            if (!detail) {
              return;
            }

            emitEvent({
              type: 'thinking.trace',
              stage: 'answer',
              title: isEnglishPrompt ? 'Model thinking' : '模型思考中',
              detail: isEnglishPrompt ? detail : undefined,
            });
          };
          const completion = await requestOpenAiChatCompletion({
            provider,
            model,
            apiKey,
            baseUrl: settings.baseUrl,
            messages,
            tools,
            temperature: 0.3,
            onTextDelta: (textDelta) => {
              const parsedDelta = consumeAssistantThinkDelta(thinkStreamState, textDelta);
              parsedDelta.thinkBlocks.forEach(emitThinkTrace);
              if (!parsedDelta.visibleText) {
                return;
              }

              emitEvent({
                type: 'answer.delta',
                textDelta: parsedDelta.visibleText,
              });
            },
            signal,
          });
          const flushedThink = flushAssistantThinkState(thinkStreamState);
          flushedThink.thinkBlocks.forEach(emitThinkTrace);
          if (flushedThink.visibleText) {
            emitEvent({
              type: 'answer.delta',
              textDelta: flushedThink.visibleText,
            });
          }

          return {
            ...completion,
            content: sanitizeAssistantText(completion.content) || '',
          };
        },
        executeTool: async (toolCall) => {
          if (!isRunActive()) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }

          const { query, result, toolOutput, message } = await executeHistoryFetchToolCall({
            toolCall,
            userPrompt: trimmedPrompt,
            defaultLimit: Math.min(100, Math.max(aiAssistant.contextLimit, 20)),
            onQueryStart: (resolvedQuery) => {
              const queryDescription = describeMessageFetchQueryForUi(resolvedQuery, languageCode);
              const queryTitle = isEnglishPrompt ? `Searching: ${queryDescription}` : `正在${queryDescription}`;
              emitThinking(
                'retriever',
                queryTitle,
                isEnglishPrompt
                  ? 'Searching relevant messages in the current chat and local history.'
                  : '在当前聊天和历史记录中查找相关消息',
              );
              emitEvent({
                type: 'retriever.query',
                title: queryTitle,
                detail: localEvidence.length
                  ? (isEnglishPrompt
                    ? `Local hits first: ${localEvidence.length}. Continue reading local indexed history.`
                    : `本地先命中 ${localEvidence.length} 条，开始读取本地索引历史`)
                  : queryDescription,
              });
            },
            executeQuery: async ({ query: nextQuery }) => {
              global = getGlobal();

              return runMessageFetchWithContinuation({
                query: nextQuery,
                fetchOnce: (continuationQuery) => runMessageFetch(global, continuationQuery, tabId),
                onPageFetched: undefined,
              });
            },
          });
          if (!isRunActive()) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }

          global = persistFetchedRangeCoverage({
            query,
            result,
            chatId: selectCurrentMessageList(global, tabId)?.chatId,
            threadId: selectCurrentMessageList(global, tabId)?.threadId || MAIN_THREAD_ID,
            getGlobal,
            setGlobal,
            forceUpdateCache,
          });

          const fetched = toHistoryEvidenceItems(result);
          fetchedCount += fetched.length;
          fallbackQuery = query;
          fallbackResult = result;
          emitEvent({
            type: 'retriever.result',
            title: isEnglishPrompt ? `Found ${fetched.length} relevant messages` : `已找到 ${fetched.length} 条相关消息`,
            detail: [
              isEnglishPrompt ? `Local ${localEvidence.length}` : `本地 ${localEvidence.length} 条`,
              isEnglishPrompt ? `New local ${fetched.length}` : `本地新增 ${fetched.length} 条`,
              isEnglishPrompt
                ? `Total usable ${localEvidence.length + fetched.length}`
                : `累计可用 ${localEvidence.length + fetched.length} 条`,
              result.truncated
                ? (isEnglishPrompt ? 'Truncated' : '结果已截断')
                : (isEnglishPrompt ? 'Complete' : '结果完整'),
            ].join(' · '),
          });
          emitEvent({
            type: 'tool.output',
            toolType: 'history-fetch',
            description: describeMessageFetchQueryForUi(query, languageCode),
            payload: {
              query,
              result,
            },
          });

          collectedToolOutputs = [...collectedToolOutputs, toolOutput].slice(-12);
          global = getGlobal();
          global = appendAiToolOutput(global, tabId, toolOutput);
          setGlobal(global);

          return message;
        },
        maxSteps: 20,
      }).catch((error) => {
        if (fallbackQuery && fallbackResult) {
          emitThinking(
            'answer',
            isEnglishPrompt ? 'Finalizing fallback result' : '正在整理任务结果',
            isEnglishPrompt
              ? 'Model answer was incomplete; using fetched history as fallback output.'
              : '模型未完成回答，改用历史结果兜底输出',
          );
          fallbackFinalText = buildHistoryFetchFallbackAnswer(fallbackQuery, fallbackResult, languageCode);
          return undefined;
        }

        throw error;
      });

      if (loopResult) {
        historyMessageSource = loopResult.messages;
        finalAnswerText = loopResult.content || '';
      }
      actualUsedCount = localEvidence.length + fetchedCount;
    } else {
      const fullPrompt = buildAiTaskPrompt(
        isEnglishPrompt ? 'Answer user question' : '回答用户问题',
        isEnglishPrompt
          ? 'Answer the user directly based on chat history.'
          : '根据聊天记录直接回答用户问题。',
        isEnglishPrompt
          ? 'If information is sufficient, provide the answer directly; otherwise explain what is missing.'
          : '如果信息足够就直接给结果；如果信息不足就明确说明还缺什么。',
        trimmedPrompt,
        contextEvidenceLines,
        conversationContextLines,
        formatAiPromptToolOutputLines(collectedToolOutputs, 4, languageCode),
        { languageCode },
      );
      const responseText = await requestAiCompletion(
        provider,
        model,
        apiKey,
        settings.baseUrl,
        fullPrompt,
        {
          systemPrompt: requestSystemPrompt,
          temperature: 0.3,
          languageCode,
          signal,
        },
      ) as string;
      historyMessageSource = conversationMessages;
      finalAnswerText = responseText;
    }

    if (fallbackFinalText) {
      commitFinalAnswer(fallbackFinalText, historyMessageSource, actualUsedCount);
      emitEvent({ type: 'run.done' });
      return;
    }

    if (!finalAnswerText?.trim()) {
      throw new Error('AI returned no visible answer.');
    }

    emitThinking(
      'answer',
      isEnglishPrompt ? 'Generating final answer' : '正在生成最终回答',
      isEnglishPrompt ? 'Finalizing the result now.' : '开始整理结果',
    );
    commitFinalAnswer(finalAnswerText, historyMessageSource, actualUsedCount);
    emitEvent({
      type: 'answer.final',
      text: finalAnswerText,
    });
    emitEvent({ type: 'run.done' });
  } catch (err: any) {
    if (isAbortError(err) || signal.aborted) {
      emitEvent({ type: 'run.cancelled' });
      return;
    }
    emitEvent({
      type: 'run.error',
      error: err?.message || 'AI request failed. Please try again.',
    });
  } finally {
    aiRunController.finishRun(tabId, runId);
  }
});

addActionHandler('cancelAiPrompt', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const activeRun = aiRunController.getActiveRun(tabId);
  if (activeRun) {
    global = updateTabState(global, {
      aiAssistant: {
        ...(selectTabState(global, tabId).aiAssistant || createEmptyAiAssistantState()),
        streamStatus: 'cancelling',
        isLoading: true,
      },
    }, tabId);
  }

  const cancelled = aiRunController.cancelRun(tabId);
  if (!cancelled) {
    return global;
  }

  return updateTabState(global, {
    aiAssistant: applyAiStreamEvent(
      selectTabState(global, tabId).aiAssistant || createEmptyAiAssistantState(),
      {
        type: 'run.cancelled',
        runId: cancelled.runId,
        createdAt: Date.now(),
      },
    ),
  }, tabId);
});

addActionHandler('requestAiMessageFetch', async (global, actions, payload): Promise<void> => {
  const { query, tabId = getCurrentTabId() } = payload;
  const languageCode = selectLanguageCode(global);
  const isEnglishPrompt = resolveAiPromptLocale(languageCode) === 'en';
  const queryDescription = describeMessageFetchQueryForUi(query, languageCode);

  actions.setAiError({ error: undefined, tabId });
  actions.setAiLoading({ isLoading: true, tabId });
  actions.clearAiThinkingTrace({ tabId });
  actions.setAiThinkingStartedAt({ thinkingStartedAt: Date.now(), tabId });
  actions.setAiThinkingStage({
    thinkingStage: queryDescription,
    tabId,
  });
  actions.appendAiThinkingTrace({
    trace: {
      stage: 'retriever',
      title: isEnglishPrompt ? 'Fetching messages' : '正在抓取消息',
      detail: queryDescription,
    },
    tabId,
  });

  try {
    global = getGlobal();
    const result = await runMessageFetchWithContinuation({
      query,
      fetchOnce: (nextQuery) => runMessageFetch(global, nextQuery, tabId),
      onPageFetched: undefined,
    });

    global = persistFetchedRangeCoverage({
      query,
      result,
      chatId: selectCurrentMessageList(global, tabId)?.chatId,
      threadId: selectCurrentMessageList(global, tabId)?.threadId || MAIN_THREAD_ID,
      getGlobal,
      setGlobal,
      forceUpdateCache,
    });

    global = appendAiToolOutput(global, tabId, {
      type: 'message.fetch',
      query,
      result,
      createdAt: Date.now(),
    });
    setGlobal(global);

    actions.setAiActualUsedCount({ actualUsedCount: result.total, tabId });
    actions.appendAiThinkingTrace({
      trace: {
        stage: 'summary',
        title: isEnglishPrompt ? `Fetched ${result.total} messages` : `已获取 ${result.total} 条消息`,
        detail: [
          isEnglishPrompt ? `New local ${result.total}` : `本地新增 ${result.total} 条`,
          isEnglishPrompt ? 'Saved to local cache' : '已写入本地缓存',
          result.truncated
            ? (isEnglishPrompt ? 'Truncated' : '结果已截断')
            : (isEnglishPrompt ? 'Complete' : '结果完整'),
        ].join(' · '),
      },
      tabId,
    });
  } catch (err: any) {
    actions.setAiError({
      error: err?.message || (isEnglishPrompt ? 'Message retrieval failed. Please try again later.' : '消息检索失败，请稍后重试。'),
      tabId,
    });
  } finally {
    actions.setAiThinkingEndedAt({ thinkingEndedAt: Date.now(), tabId });
    actions.setAiLoading({ isLoading: false, tabId });
  }
});
