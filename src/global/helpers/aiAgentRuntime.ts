export type AiChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type AiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type AiChatMessage = {
  role: AiChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AiToolCall[];
};

export type AiAgentCompletion = {
  content?: string;
  toolCalls?: AiToolCall[];
};

export type AiAgentLoopResult = {
  content: string;
  messages: AiChatMessage[];
};

export type RunAiAgentLoopArgs = {
  messages: AiChatMessage[];
  complete: (messages: AiChatMessage[]) => Promise<AiAgentCompletion>;
  executeTool: (toolCall: AiToolCall) => Promise<AiChatMessage>;
  maxSteps?: number;
};

export async function resolveAiAgentConversation(args: RunAiAgentLoopArgs): Promise<AiChatMessage[]> {
  const {
    messages,
    complete,
    executeTool,
    maxSteps = 8,
  } = args;

  const conversation = [...messages];

  for (let step = 0; step < maxSteps; step++) {
    const assistant = await complete(conversation);
    const content = assistant.content?.trim() || '';
    const toolCalls = assistant.toolCalls || [];

    if (toolCalls.length === 0) {
      return conversation;
    }

    conversation.push({
      role: 'assistant',
      content,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const toolMessage = await executeTool(toolCall);
      conversation.push(toolMessage);
    }
  }

  throw new Error(`AI agent loop exceeded ${maxSteps} steps`);
}

export async function runAiAgentLoop(args: RunAiAgentLoopArgs): Promise<AiAgentLoopResult> {
  const {
    messages,
    complete,
    executeTool,
    maxSteps = 8,
  } = args;

  const conversation = [...messages];

  for (let step = 0; step < maxSteps; step++) {
    const assistant = await complete(conversation);
    const content = assistant.content?.trim() || '';
    const toolCalls = assistant.toolCalls || [];

    if (toolCalls.length > 0) {
      conversation.push({
        role: 'assistant',
        content,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const toolMessage = await executeTool(toolCall);
        conversation.push(toolMessage);
      }
      continue;
    }

    return {
      content,
      messages: conversation,
    };
  }

  throw new Error(`AI agent loop exceeded ${maxSteps} steps`);
}
