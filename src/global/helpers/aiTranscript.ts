import type { AiChatMessage, AiToolCall } from './aiAgentRuntime';

import { resolveAiPromptLocale } from './aiLanguage';
import { sanitizeAssistantText } from './aiText';

type OpenAiCompatibleRole = 'system' | 'user' | 'assistant' | 'tool';

export type OpenAiCompatibleMessage = {
  role: OpenAiCompatibleRole;
  content?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AiToolCall[];
};

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

export function buildAiConversationMessages(args: {
  systemPrompt: string;
  evidenceLines: string[];
  toolOutputLines: string[];
  turns: AiChatMessage[];
  currentPrompt: string;
  languageCode?: string;
}) {
  const {
    systemPrompt,
    evidenceLines,
    toolOutputLines,
    turns,
    currentPrompt,
    languageCode,
  } = args;
  const isEnglishPrompt = resolveAiPromptLocale(languageCode) === 'en';

  const lastTurn = turns[turns.length - 1];
  const shouldAppendCurrentPrompt = !(
    lastTurn?.role === 'user'
    && lastTurn.content.trim() === currentPrompt.trim()
  );

  const systemContent = [
    systemPrompt,
    ...(evidenceLines.length ? [
      '',
      isEnglishPrompt ? 'Current chat records:' : '当前聊天记录：',
      ...evidenceLines,
    ] : []),
    ...(toolOutputLines.length ? [
      '',
      isEnglishPrompt ? 'Tool outputs:' : '工具结果：',
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
