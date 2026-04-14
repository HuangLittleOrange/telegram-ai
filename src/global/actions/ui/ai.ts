import type { ThreadId } from '../../../types';
import type { ActionReturnType, GlobalState, RequiredGlobalState } from '../../types';
import type { AiStreamEvent, AiStreamStage } from '../../types/aiStream';
import type {
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
import { persistFetchedRangeCoverage } from '../../helpers/aiMessagePersistence';
import {
  buildHistoryFetchToolDefinition,
} from '../../helpers/aiSkills';
export { buildHistoryFetchQueryFromToolHints } from '../../helpers/aiSkills';
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
  selectCurrentMessageList,
  selectTabState,
} from '../../selectors';

const QUICK_PROMPTS = {
  summaryToday: buildAiTaskPrompt(
    '整理今天聊天记录',
    '先读取今天相关的聊天记录，提炼关键结论、重要讨论点、未完成事项，以及如果信息还不够时应该继续补看的内容。',
    '用简体中文输出，短句优先；先给结果，再补充必要依据；如果适合，给出可以直接发到群里的总结。',
  ),
  replySuggestions: buildAiTaskPrompt(
    '生成回复草稿',
    '先读取当前聊天上下文，再根据用户的问题生成 3 条可以直接发送的回复建议，分别覆盖确认、追问和推进。',
    '每条控制在一句到两句，贴近 Telegram 群聊语气；如果上下文不足，先说明还需要哪些聊天记录。',
  ),
  extractTodos: buildAiTaskPrompt(
    '整理待办',
    '先读取最近聊天记录，提取待办事项、负责人、截止时间和状态。',
    '按要点列出；信息不足时标出缺失项，并说明还需要继续补看的聊天记录。',
  ),
};

const MAX_AI_TOOL_OUTPUTS = 8;
const MAX_PERSISTED_AI_ASSISTANT_SESSIONS = 120;
const AI_ASSISTANT_SESSION_KEY_PREFIX = 'ai';
const AI_ASSISTANT_SESSION_DEFAULT_SCOPE = 'default';

type SupportedAiProvider = 'openai' | 'anthropic' | 'gemini';

type AiStreamEventInput = AiStreamEvent extends infer Event
  ? Event extends { runId: string; createdAt: number }
    ? Omit<Event, 'runId' | 'createdAt'>
    : never
  : never;

const EMPTY_AI_ASSISTANT_STATE = createEmptyAiAssistantState();

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
    model: 'gpt-4.1-mini',
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
  apiKey: string,
  baseUrl: string | undefined,
  prompt: string,
  options?: {
    systemPrompt?: string;
    temperature?: number;
    stream?: boolean;
    signal?: AbortSignal;
  },
): Promise<string | ReadableStreamDefaultReader<Uint8Array>> {
  if (provider === 'gemini') {
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
        system: options?.systemPrompt || buildAiRequestSystemPrompt(),
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
      Authorization: `Bearer ${apiKey}`,
    },
    signal: options?.signal,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: options?.systemPrompt || buildAiRequestSystemPrompt() },
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

type OpenAiChatCompletionChoice = {
  message?: {
    content?: string | Array<{ text?: string; type?: string }>;
    tool_calls?: OpenAiToolCall[];
  };
};

type OpenAiChatCompletionResponse = {
  choices?: OpenAiChatCompletionChoice[];
  error?: {
    message?: string;
  };
};

function parseOpenAiChatCompletionResponse(json: OpenAiChatCompletionResponse) {
  const message = json.choices?.[0]?.message;
  const content = parseOpenAiAssistantText(json);
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.filter((toolCall): toolCall is OpenAiToolCall => Boolean(
      toolCall?.id
      && toolCall?.function?.name
      && typeof toolCall.function.arguments === 'string',
    ))
    : [];

  return {
    content: content || '',
    toolCalls,
  };
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
  apiKey: string;
  baseUrl: string | undefined;
  messages: AiChatMessage[];
  tools?: Array<ReturnType<typeof buildHistoryFetchToolDefinition>>;
  temperature?: number;
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
        Authorization: `Bearer ${apiKey}`,
      },
      signal: requestController.signal,
      body: JSON.stringify({
        model,
        messages: serializeOpenAiCompatibleMessages(messages),
        ...(tools?.length ? { tools } : undefined),
        temperature,
        stream: false,
      }),
    });
  } catch (error) {
    requestController.cleanup();
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(`OpenAI request timed out after ${OPENAI_CHAT_COMPLETION_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  }
  requestController.cleanup();

  const json: OpenAiChatCompletionResponse = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage = json?.error?.message || `OpenAI request failed (${response.status})`;
    throw new Error(errorMessage);
  }

  return parseOpenAiChatCompletionResponse(json);
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
    thinkingLog,
    tabId = getCurrentTabId(),
  } = payload;

  const normalizedText = role === 'assistant'
    ? (sanitizeAssistantText(text) || '')
    : text;
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
  actions.requestAiPrompt({ prompt: QUICK_PROMPTS.summaryToday, tabId });
});

addActionHandler('requestAiReplySuggestions', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  actions.requestAiPrompt({ prompt: QUICK_PROMPTS.replySuggestions, tabId });
});

addActionHandler('requestAiExtractTodos', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  actions.requestAiPrompt({ prompt: QUICK_PROMPTS.extractTodos, tabId });
});

addActionHandler('requestAiPrompt', async (global, actions, payload): Promise<void> => {
  const { prompt, tabId = getCurrentTabId() } = payload;
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return;
  }

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
  actions.appendAiTurn({ role: 'user', text: trimmedPrompt, tabId });
  emitThinking('answer', '正在理解你的问题', '先直接回答你的问题，必要时再检索历史消息');

  global = getGlobal();
  const tabState = selectTabState(global, tabId);
  const aiAssistant = tabState.aiAssistant || EMPTY_AI_ASSISTANT_STATE;
  const settings = global.settings.byKey.aiSettings;
  const provider = settings.provider;
  const model = settings.model?.trim() || getAiProviderDefaults(provider).model;
  const apiKey = settings.apiKey?.trim();
  const signal = run.abortController.signal;

  if (!apiKey) {
    emitEvent({
      type: 'run.error',
      error: 'Missing API key. Configure it in Settings > AI Settings.',
    });
    aiRunController.finishRun(tabId, runId);
    return;
  }

  try {
    const localEvidence: AiEvidenceItem[] = [];
    const contextEvidenceLines = formatAiPromptEvidenceLines(
      localEvidence.slice(-Math.min(localEvidence.length, 12)),
    );
    const toolOutputContextLines = formatAiPromptToolOutputLines(
      aiAssistant.toolOutputHistory || [],
      4,
    );
    let collectedToolOutputs = [...(aiAssistant.toolOutputHistory || [])];
    const conversationContextLines = formatAiPromptConversationContextLines(aiAssistant.turns, 6);
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
      systemPrompt: buildAiRequestSystemPrompt(),
      evidenceLines: contextEvidenceLines,
      toolOutputLines: toolOutputContextLines,
      turns: conversationTurns,
      currentPrompt: trimmedPrompt,
    });

    const commitFinalAnswer = (
      finalText: string,
      historyMessageSource: AiChatMessage[],
      actualUsedCount: number,
      committedAt = Date.now(),
    ) => {
      actions.setAiThinkingEndedAt({ thinkingEndedAt: committedAt, tabId });
      global = getGlobal();
      actions.appendAiTurn({
        role: 'assistant',
        text: finalText,
        tabId,
        thinkingLog: buildThinkingLog(selectTabState(global, tabId).aiAssistant),
      });
      global = updateAiState(global, tabId, {
        historyMessages: buildPersistentAiHistoryMessages(historyMessageSource, finalText),
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

    emitThinking('answer', '正在生成回答', '若信息不足会按需检索历史消息');

    if (provider === 'openai') {
      let fetchedCount = 0;
      let fallbackQuery: Parameters<typeof buildHistoryFetchFallbackAnswer>[0] | undefined;
      let fallbackResult: Parameters<typeof buildHistoryFetchFallbackAnswer>[1] | undefined;

      const loopResult = await runAiQueryLoop({
        messages: conversationMessages,
        complete: async (messages) => {
          const tools = shouldOfferHistoryFetchTool(messages)
            ? [buildHistoryFetchToolDefinition()]
            : undefined;
          const completion = await requestOpenAiChatCompletion({
            provider,
            model,
            apiKey,
            baseUrl: settings.baseUrl,
            messages,
            tools,
            temperature: 0.3,
            signal,
          });

          return completion;
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
              const queryTitle = `正在${describeMessageFetchQuery(resolvedQuery)}`;
              emitThinking('retriever', queryTitle, '在当前聊天和历史记录中查找相关消息');
              emitEvent({
                type: 'retriever.query',
                title: queryTitle,
                detail: localEvidence.length
                  ? `本地先命中 ${localEvidence.length} 条，开始读取本地索引历史`
                  : describeMessageFetchQuery(resolvedQuery),
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
            title: `已找到 ${fetched.length} 条相关消息`,
            detail: [
              `本地 ${localEvidence.length} 条`,
              `本地新增 ${fetched.length} 条`,
              `累计可用 ${localEvidence.length + fetched.length} 条`,
              result.truncated ? '结果已截断' : '结果完整',
            ].join(' · '),
          });
          emitEvent({
            type: 'tool.output',
            toolType: 'history-fetch',
            description: describeMessageFetchQuery(query),
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
          emitThinking('answer', '正在整理任务结果', '模型未完成回答，改用历史结果兜底输出');
          fallbackFinalText = buildHistoryFetchFallbackAnswer(fallbackQuery, fallbackResult);
          return undefined;
        }

        throw error;
      });

      if (loopResult) {
        historyMessageSource = loopResult.messages;
        finalAnswerText = sanitizeAssistantText(loopResult.content) || '';
      }
      actualUsedCount = localEvidence.length + fetchedCount;
    } else {
      const fullPrompt = buildAiTaskPrompt(
        '回答用户问题',
        '根据聊天记录直接回答用户问题。',
        '如果信息足够就直接给结果；如果信息不足就明确说明还缺什么。',
        trimmedPrompt,
        contextEvidenceLines,
        conversationContextLines,
        formatAiPromptToolOutputLines(collectedToolOutputs, 4),
      );
      const responseText = await requestAiCompletion(
        provider,
        model,
        apiKey,
        settings.baseUrl,
        fullPrompt,
        {
          systemPrompt: buildAiRequestSystemPrompt(),
          temperature: 0.3,
          signal,
        },
      );
      historyMessageSource = conversationMessages;
      finalAnswerText = sanitizeAssistantText(responseText as string) || '';
    }

    if (fallbackFinalText) {
      commitFinalAnswer(fallbackFinalText, historyMessageSource, actualUsedCount);
      emitEvent({ type: 'run.done' });
      return;
    }

    if (!finalAnswerText?.trim()) {
      throw new Error('AI returned no visible answer.');
    }

    emitThinking('answer', '正在生成最终回答', '开始整理结果');
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

  actions.setAiError({ error: undefined, tabId });
  actions.setAiLoading({ isLoading: true, tabId });
  actions.clearAiThinkingTrace({ tabId });
  actions.setAiThinkingStartedAt({ thinkingStartedAt: Date.now(), tabId });
  actions.setAiThinkingStage({
    thinkingStage: describeMessageFetchQuery(query),
    tabId,
  });
  actions.appendAiThinkingTrace({
    trace: {
      stage: 'retriever',
      title: '正在抓取消息',
      detail: describeMessageFetchQuery(query),
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
        title: `已获取 ${result.total} 条消息`,
        detail: [`本地新增 ${result.total} 条`, '已写入本地缓存', result.truncated ? '结果已截断' : '结果完整'].join(' · '),
      },
      tabId,
    });
  } catch (err: any) {
    actions.setAiError({
      error: err?.message || '消息检索失败，请稍后重试。',
      tabId,
    });
  } finally {
    actions.setAiThinkingEndedAt({ thinkingEndedAt: Date.now(), tabId });
    actions.setAiLoading({ isLoading: false, tabId });
  }
});
