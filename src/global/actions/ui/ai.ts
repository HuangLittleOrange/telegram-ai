import type { ApiMessage } from '../../../api/types';
import type { ActionReturnType, GlobalState, RequiredGlobalState } from '../../types';
import type { AiStreamEvent, AiStreamStage } from '../../types/aiStream';
import type {
  MessageFetchQuery,
  MessageFetchResult,
  ToolOutput,
} from '../../types/tabState';
import { MAIN_THREAD_ID } from '../../../api/types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { getTranslationFn } from '../../../util/localization';
import { forceUpdateCache, loadCachedGlobal } from '../../cache';
import {
  buildAiFinalAnswerTaskPrompt,
  buildAiTaskPrompt,
  buildHistoryFetchFallbackAnswer,
  clampAiContextLimit,
  formatAiPromptConversationContextLines,
  formatAiPromptEvidenceLines,
  formatAiPromptToolOutputLines,
  formatHistoryFetchFloodWaitProgress,
  formatHistoryFetchPageProgress,
  formatHistoryFetchToolResultForModel,
  getAiApiUrl,
  parseGeminiAssistantText,
  parseOpenAiAssistantText,
  pickRecentMessageIds,
  sanitizeAssistantText,
  shouldOfferHistoryFetchTool,
} from '../../helpers/ai';
import {
  buildAiFinalAnswerSystemPrompt,
  buildAiRequestSystemPrompt,
  getAiPromptTimeContext,
} from '../../helpers/aiContext';
import { persistFetchedMessages, persistFetchedRangeCoverage } from '../../helpers/aiMessagePersistence';
import {
  buildHistoryFetchToolDefinition,
  resolveHistoryFetchToolArgs,
} from '../../helpers/aiSkills';
export { buildHistoryFetchQueryFromToolHints } from '../../helpers/aiSkills';
import {
  type AiChatMessage,
  type AiToolCall,
  resolveAiAgentConversation,
} from '../../helpers/aiAgentRuntime';
import {
  buildAiConversationMessages,
  buildPersistentAiHistoryMessages,
  resolveAiConversationTurnsForRequest,
  serializeOpenAiCompatibleMessages,
} from '../../helpers/aiTranscript';
import {
  type AiEvidenceItem,
  type AiEvidenceSource,
  dedupeAiEvidence,
} from '../../helpers/aiOrchestrator';
import { readAiProviderStream } from '../../helpers/aiProviderStream';
import aiRunController from '../../helpers/aiRunController';
import {
  applyAiStreamEvent,
  createEmptyAiAssistantState,
  getAiAssistantCommitText,
  resetAiAssistantState,
} from '../../helpers/aiRunState';
import { type AiThinkingLog, createAiThinkingTraceStep } from '../../helpers/aiThinking';
import {
  describeMessageFetchQuery,
  runMessageFetch,
  runMessageFetchWithContinuation,
} from '../../helpers/messageFetch';
import { getMessageSummaryText } from '../../helpers/messageSummary';
import { getPeerTitle } from '../../helpers/peers';
import {
  addActionHandler,
  getGlobal,
  setGlobal,
} from '../../index';
import { addMessages } from '../../reducers/messages';
import { updateTabState } from '../../reducers/tabs';
import {
  selectChatMessages,
  selectCurrentMessageList,
  selectSender,
  selectTabState,
  selectViewportIds,
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

type AiStreamEventInput = AiStreamEvent extends infer Event
  ? Event extends { runId: string; createdAt: number }
    ? Omit<Event, 'runId' | 'createdAt'>
    : never
  : never;

const EMPTY_AI_ASSISTANT_STATE = createEmptyAiAssistantState();

function buildThinkingLog(aiAssistant: typeof EMPTY_AI_ASSISTANT_STATE & {
  thinkingStartedAt?: number;
  thinkingEndedAt?: number;
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
): RequiredGlobalState {
  const tabState = selectTabState(global, tabId);
  const aiAssistant = tabState.aiAssistant || EMPTY_AI_ASSISTANT_STATE;

  return updateTabState(global, {
    aiAssistant: {
      ...aiAssistant,
      ...update,
    },
  }, tabId) as RequiredGlobalState;
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

  return updateTabState(global, {
    aiAssistant: {
      ...aiAssistant,
      toolOutputs: [
        ...aiAssistant.toolOutputs.slice(-(MAX_AI_TOOL_OUTPUTS - 1)),
        toolOutput,
      ],
      toolOutputHistory,
    },
  }, tabId) as RequiredGlobalState;
}

function appendRetrieverPageTrace(
  actions: any,
  tabId: number,
  pageIndex: number,
  accumulatedCount: number,
  pageResult: MessageFetchResult,
  options?: {
    localCount?: number;
  },
) {
  const progress = formatHistoryFetchPageProgress(pageIndex, accumulatedCount, pageResult, options);
  actions.appendAiThinkingTrace({
    tabId,
    trace: {
      stage: 'retriever',
      title: progress.title,
      detail: progress.detail,
    },
  });
}

function appendRetrieverFloodWaitTrace(
  actions: any,
  tabId: number,
  seconds: number,
) {
  const progress = formatHistoryFetchFloodWaitProgress(seconds);
  actions.appendAiThinkingTrace({
    tabId,
    trace: {
      stage: 'retriever',
      title: progress.title,
      detail: progress.detail,
    },
  });
}

function getAiProviderDefaults(provider: 'openai' | 'gemini') {
  if (provider === 'gemini') {
    return {
      model: 'gemini-2.0-flash',
    };
  }

  return {
    model: 'gpt-4.1-mini',
  };
}

function buildEvidenceItem(
  global: GlobalState,
  message: ApiMessage,
  source: AiEvidenceSource,
): AiEvidenceItem | undefined {
  const lang = getTranslationFn();
  const text = getMessageSummaryText(lang, message, undefined, true, 500).trim();
  if (!text) {
    return undefined;
  }

  const sender = message.isOutgoing
    ? '我'
    : (() => {
      const senderPeer = selectSender(global, message);
      return senderPeer ? (getPeerTitle(lang, senderPeer) || '未知用户') : '未知用户';
    })();

  return {
    chatId: message.chatId,
    threadId: MAIN_THREAD_ID,
    messageId: message.id,
    sender,
    text,
    source,
    date: message.date,
  };
}

function buildContextEvidence(global: ReturnType<typeof getGlobal>, tabId: number, contextLimit: number) {
  const currentMessageList = selectCurrentMessageList(global, tabId);
  if (!currentMessageList) {
    return {
      chatId: undefined,
      threadId: undefined,
      evidence: [] as AiEvidenceItem[],
    };
  }

  const { chatId, threadId = MAIN_THREAD_ID } = currentMessageList;
  const messagesById = selectChatMessages(global, chatId);
  const viewportIds = selectViewportIds(global, chatId, threadId, tabId)
    || Object.keys(messagesById || {}).map(Number).sort((a, b) => a - b);
  const selectedIds = pickRecentMessageIds(viewportIds, contextLimit);
  const evidence = selectedIds
    .map((messageId) => {
      const message = messagesById?.[messageId];
      return message ? buildEvidenceItem(global, message, 'recent') : undefined;
    })
    .filter((item): item is AiEvidenceItem => Boolean(item));

  return {
    chatId,
    threadId,
    evidence,
  };
}

async function buildCachedEvidence(
  chatId: string,
  threadId: number | string,
  contextLimit: number,
): Promise<AiEvidenceItem[]> {
  const cachedGlobal = await loadCachedGlobal();
  const messagesById = cachedGlobal?.messages?.byChatId?.[chatId]?.byId;
  if (!cachedGlobal || !messagesById) {
    return [];
  }

  const threadStore = cachedGlobal.messages.byChatId[chatId]?.threadsById?.[threadId];
  const threadIds = threadStore?.localState?.listedIds || threadStore?.localState?.lastViewportIds;
  const ids = threadIds?.length
    ? threadIds.map(Number)
    : Object.keys(messagesById).map(Number).sort((a, b) => a - b);
  const selectedIds = pickRecentMessageIds(ids, contextLimit);

  return selectedIds
    .map((messageId) => {
      const message = messagesById[messageId];
      return message ? buildEvidenceItem(cachedGlobal, message, 'cache') : undefined;
    })
    .filter((item): item is AiEvidenceItem => Boolean(item));
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
  provider: 'openai' | 'gemini',
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
  provider: 'openai' | 'gemini';
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

  if (provider === 'gemini') {
    throw new Error('Chat tool calling is not supported for Gemini in this runtime');
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
  });
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
  emitThinking('retriever', '正在理解你的问题', '准备读取当前聊天上下文');

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

  const isFirstConversationTurn = !(aiAssistant.turns || []).some((turn) => turn.role === 'assistant');
  const {
    chatId,
    threadId = MAIN_THREAD_ID,
    evidence: recentEvidence,
  } = isFirstConversationTurn
    ? {
      chatId: selectCurrentMessageList(global, tabId)?.chatId,
      threadId: selectCurrentMessageList(global, tabId)?.threadId || MAIN_THREAD_ID,
      evidence: [],
    }
    : buildContextEvidence(global, tabId, aiAssistant.contextLimit);

  try {
    if (!isFirstConversationTurn) {
      emitThinking('retriever', '正在读取最近聊天记录', '先拿当前可见的消息和本地缓存');
      emitEvent({
        type: 'retriever.query',
        title: '初始聊天记录收集',
        detail: '读取当前可见消息与本地缓存',
      });
    } else {
      emitThinking('retriever', '首次对话不预置聊天记录', '如信息不足将调用 history-fetch 精准读取');
      emitEvent({
        type: 'retriever.query',
        title: '首次对话',
        detail: '跳过自动注入当前聊天记录',
      });
    }

    const cachedEvidence = (!isFirstConversationTurn && chatId)
      ? await buildCachedEvidence(chatId, threadId, aiAssistant.contextLimit)
      : [];
    if (!isRunActive()) {
      return;
    }
    const localEvidence = dedupeAiEvidence([...cachedEvidence, ...recentEvidence]);
    emitEvent({
      type: 'retriever.result',
      title: isFirstConversationTurn
        ? '首次对话：未自动注入聊天记录'
        : `已汇总 ${localEvidence.length} 条本地聊天记录`,
      detail: isFirstConversationTurn
        ? '如信息不足会按需调用 history-fetch'
        : '仅使用本地已同步聊天记录',
    });
    const contextEvidenceLines = formatAiPromptEvidenceLines(
      localEvidence.slice(-Math.min(localEvidence.length, 12)),
    );
    const toolOutputContextLines = formatAiPromptToolOutputLines(
      aiAssistant.toolOutputHistory || [],
      4,
    );
    let collectedToolOutputs = [...(aiAssistant.toolOutputHistory || [])];
    const conversationContextLines = formatAiPromptConversationContextLines(aiAssistant.turns, 6);
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
      });
      setGlobal(global);
      actions.setAiActualUsedCount({ actualUsedCount, tabId });
    };

    const streamFinalAnswer = async (args: {
      historyMessageSource: AiChatMessage[];
      toolOutputLines: string[];
      actualUsedCount: number;
    }) => {
      const fullPrompt = buildAiFinalAnswerTaskPrompt(
        trimmedPrompt,
        contextEvidenceLines,
        conversationContextLines,
        args.toolOutputLines,
      );
      const streamReader = await requestAiCompletion(
        provider,
        model,
        apiKey,
        settings.baseUrl,
        fullPrompt,
        {
          systemPrompt: buildAiFinalAnswerSystemPrompt(getAiPromptTimeContext()),
          temperature: 0.3,
          stream: true,
          signal,
        },
      ) as ReadableStreamDefaultReader<Uint8Array>;

      let assistantCommitted = false;
      await readAiProviderStream({
        runId,
        signal,
        reader: streamReader,
        onEvent: (event) => {
          if (!isRunActive()) {
            return;
          }

          applyAiStreamEventForTab(tabId, event);
          if (event.type === 'answer.final' && !assistantCommitted) {
            const visibleFinalText = sanitizeAssistantText(event.text) || '';
            if (visibleFinalText.trim()) {
              assistantCommitted = true;
              commitFinalAnswer(visibleFinalText, args.historyMessageSource, args.actualUsedCount, event.createdAt);
            }
          }
        },
      });

      if (!assistantCommitted) {
        global = getGlobal();
        const aiAssistantState = selectTabState(global, tabId).aiAssistant;
        const committedText = sanitizeAssistantText(getAiAssistantCommitText(aiAssistantState)) || '';
        if (committedText.trim()) {
          commitFinalAnswer(committedText, args.historyMessageSource, args.actualUsedCount);
          return;
        }

        throw new Error(
          'AI returned no visible answer.'
          + ' The final-answer phase attempted to continue retrieval instead of answering.',
        );
      }
    };

    let historyMessageSource = conversationMessages;
    let finalToolOutputLines = toolOutputContextLines;
    let actualUsedCount = localEvidence.length;
    let fallbackFinalText: string | undefined;

    emitThinking('answer', '正在补充答案上下文', '必要时会继续检索历史消息');

    if (provider === 'openai') {
      let fetchedCount = 0;
      let fallbackQuery: MessageFetchQuery | undefined;
      let fallbackResult: MessageFetchResult | undefined;

      historyMessageSource = await resolveAiAgentConversation({
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

          const parsedArgs = (() => {
            try {
              return JSON.parse(toolCall.function.arguments);
            } catch {
              return undefined;
            }
          })();

          const resolvedQuery = resolveHistoryFetchToolArgs(
            parsedArgs,
            Math.min(100, Math.max(aiAssistant.contextLimit, 20)),
          );
          const query = resolvedQuery;

          if (!query) {
            throw new Error('Invalid history-fetch tool arguments');
          }

          const queryTitle = `正在${describeMessageFetchQuery(query)}`;
          emitThinking('retriever', queryTitle, '在当前聊天和历史记录中查找相关消息');
          emitEvent({
            type: 'retriever.query',
            title: queryTitle,
            detail: localEvidence.length
              ? `本地先命中 ${localEvidence.length} 条，开始补抓远程历史`
              : describeMessageFetchQuery(query),
          });

          global = getGlobal();
          let fetchedPageIndex = 0;
          let fetchedAccumulatedCount = 0;
          const result = await runMessageFetchWithContinuation({
            query,
            fetchOnce: (nextQuery) => runMessageFetch(global, nextQuery, tabId, {
              onRemotePageFetched: (pageResult) => {
                fetchedPageIndex += 1;
                fetchedAccumulatedCount += pageResult.total;
                appendRetrieverPageTrace(actions, tabId, fetchedPageIndex, fetchedAccumulatedCount, pageResult, {
                  localCount: localEvidence.length,
                });
                global = persistFetchedMessages({
                  messages: pageResult.sourceMessages,
                  chatId: selectCurrentMessageList(global, tabId)?.chatId,
                  threadId: selectCurrentMessageList(global, tabId)?.threadId || MAIN_THREAD_ID,
                  getGlobal,
                  setGlobal,
                  forceUpdateCache,
                  addMessages,
                });
              },
              onRemoteFloodWait: (seconds) => {
                appendRetrieverFloodWaitTrace(actions, tabId, seconds);
              },
            }),
            onPageFetched: undefined,
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
              `远程新增 ${fetched.length} 条`,
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

          const toolOutput: ToolOutput = {
            type: 'message.fetch',
            query,
            result,
            createdAt: Date.now(),
          };
          collectedToolOutputs = [...collectedToolOutputs, toolOutput].slice(-12);
          global = getGlobal();
          global = appendAiToolOutput(global, tabId, toolOutput);
          setGlobal(global);

          return {
            role: 'tool' as const,
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: formatHistoryFetchToolResultForModel(query, result),
          };
        },
        maxSteps: 6,
      }).catch((error) => {
        if (fallbackQuery && fallbackResult) {
          emitThinking('answer', '正在整理任务结果', '模型未完成回答，改用历史结果兜底输出');
          fallbackFinalText = buildHistoryFetchFallbackAnswer(fallbackQuery, fallbackResult);
          return conversationMessages;
        }

        throw error;
      });

      actualUsedCount = localEvidence.length + fetchedCount;
      finalToolOutputLines = formatAiPromptToolOutputLines(
        collectedToolOutputs,
        4,
      );
    } else {
      historyMessageSource = conversationMessages;
    }

    if (fallbackFinalText) {
      commitFinalAnswer(fallbackFinalText, historyMessageSource, actualUsedCount);
      emitEvent({ type: 'run.done' });
      return;
    }

    emitThinking('answer', '正在生成最终回答', '开始流式输出结果');
    await streamFinalAnswer({
      historyMessageSource,
      toolOutputLines: finalToolOutputLines,
      actualUsedCount,
    });
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
    let fetchedPageIndex = 0;
    let fetchedAccumulatedCount = 0;
    const result = await runMessageFetchWithContinuation({
      query,
      fetchOnce: (nextQuery) => runMessageFetch(global, nextQuery, tabId, {
        onRemotePageFetched: (pageResult) => {
          fetchedPageIndex += 1;
          fetchedAccumulatedCount += pageResult.total;
          appendRetrieverPageTrace(actions, tabId, fetchedPageIndex, fetchedAccumulatedCount, pageResult);
          global = persistFetchedMessages({
            messages: pageResult.sourceMessages,
            chatId: selectCurrentMessageList(global, tabId)?.chatId,
            threadId: selectCurrentMessageList(global, tabId)?.threadId || MAIN_THREAD_ID,
            getGlobal,
            setGlobal,
            forceUpdateCache,
            addMessages,
          });
        },
        onRemoteFloodWait: (seconds) => {
          appendRetrieverFloodWaitTrace(actions, tabId, seconds);
        },
      }),
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
        detail: [`远程新增 ${result.total} 条`, '已写入本地缓存', result.truncated ? '结果已截断' : '结果完整'].join(' · '),
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
