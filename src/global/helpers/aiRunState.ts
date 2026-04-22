import type { AiStreamEvent } from '../types/aiStream';
import type { AiAssistantState } from '../types/tabState';
import type { AiThinkingTraceStep, AiThinkingTraceStepInput } from './aiThinking';

import {
  createAiThinkingTraceStep,
} from './aiThinking';

function mergeThinkingTrace(
  trace: AiThinkingTraceStep[],
  entry: AiThinkingTraceStepInput,
): AiThinkingTraceStep[] {
  const normalized = createAiThinkingTraceStep(entry);
  const last = trace[trace.length - 1];

  if (
    last
    && last.stage === normalized.stage
    && last.title === normalized.title
    && last.detail === normalized.detail
  ) {
    return [
      ...trace.slice(0, -1),
      normalized,
    ];
  }

  return [
    ...trace.slice(-7),
    normalized,
  ];
}

const defaultContextLimit = 100;
const maxToolOutputHistory = 12;

function appendToolOutputHistory(
  history: NonNullable<AiAssistantState['toolOutputHistory']>,
  entry: NonNullable<AiAssistantState['toolOutputHistory']>[number],
) {
  return [
    ...history.slice(-(maxToolOutputHistory - 1)),
    entry,
  ];
}

export function createEmptyAiAssistantState(
  contextLimit = defaultContextLimit,
): AiAssistantState {
  return {
    isOpen: false,
    contextLimit,
    thinkingTrace: [],
    turns: [],
    historyMessages: [],
    toolOutputs: [],
    toolOutputHistory: [],
    streamStatus: 'idle',
    runId: undefined,
    activeStage: undefined,
  };
}

export function resetAiAssistantState(
  state: Pick<AiAssistantState, 'contextLimit' | 'isOpen' | 'selectionContext'>,
): AiAssistantState {
  return {
    ...createEmptyAiAssistantState(state.contextLimit),
    isOpen: state.isOpen,
  };
}

export function getAiAssistantCommitText(
  state: Pick<AiAssistantState, 'finalText' | 'draftText'>,
) {
  const text = state.finalText || state.draftText;
  return text?.trim() ? text : undefined;
}

export function applyAiStreamEvent(
  state: AiAssistantState,
  event: AiStreamEvent,
): AiAssistantState {
  if (event.type === 'run.started') {
    return {
      ...state,
      runId: event.runId,
      streamStatus: 'streaming',
      activeStage: undefined,
      draftText: undefined,
      finalText: undefined,
      error: undefined,
      actualUsedCount: undefined,
      thinkingTrace: [],
      thinkingStage: undefined,
      thinkingStartedAt: event.createdAt,
      thinkingEndedAt: undefined,
      toolOutputs: [],
      historyMessages: state.historyMessages || [],
      isLoading: true,
    };
  }

  if (state.runId !== event.runId) {
    return state;
  }

  switch (event.type) {
    case 'thinking.stage':
      return {
        ...state,
        thinkingStage: event.title,
        activeStage: event.stage,
      };
    case 'thinking.trace':
      return {
        ...state,
        thinkingTrace: mergeThinkingTrace(state.thinkingTrace, event),
      };
    case 'retriever.query':
      return {
        ...state,
        thinkingStage: event.title,
        activeStage: 'retriever',
        thinkingTrace: mergeThinkingTrace(state.thinkingTrace, {
          stage: 'retriever',
          title: event.title,
          detail: event.detail,
          createdAt: event.createdAt,
        }),
      };
    case 'retriever.result':
      return {
        ...state,
        thinkingStage: event.title,
        activeStage: 'retriever',
        thinkingTrace: mergeThinkingTrace(state.thinkingTrace, {
          stage: 'retriever',
          title: event.title,
          detail: event.detail,
          createdAt: event.createdAt,
        }),
      };
    case 'answer.delta':
      return {
        ...state,
        draftText: (state.draftText || '') + event.textDelta,
        activeStage: 'answer',
      };
    case 'answer.final':
      return {
        ...state,
        draftText: event.text,
        finalText: event.text,
        activeStage: 'answer',
      };
    case 'tool.output':
      return {
        ...state,
        toolOutputs: [
          ...state.toolOutputs,
          {
            type: event.toolType,
            description: event.description,
            payload: event.payload,
            createdAt: event.createdAt,
          },
        ],
        toolOutputHistory: appendToolOutputHistory(state.toolOutputHistory || [], {
          type: event.toolType,
          description: event.description,
          payload: event.payload,
          createdAt: event.createdAt,
        }),
      };
    case 'run.done':
      return {
        ...state,
        streamStatus: 'done',
        isLoading: false,
        runId: undefined,
        activeStage: undefined,
        thinkingStage: undefined,
        draftText: undefined,
        finalText: undefined,
        thinkingTrace: [],
        toolOutputs: [],
        thinkingEndedAt: event.createdAt,
      };
    case 'run.cancelled':
      return {
        ...state,
        streamStatus: 'cancelled',
        isLoading: false,
        runId: undefined,
        activeStage: undefined,
        thinkingStage: undefined,
        draftText: undefined,
        finalText: undefined,
        thinkingTrace: [],
        toolOutputs: [],
        thinkingEndedAt: event.createdAt,
      };
    case 'run.error':
      return {
        ...state,
        streamStatus: 'error',
        isLoading: false,
        error: event.error,
        runId: undefined,
        activeStage: undefined,
        thinkingStage: undefined,
        draftText: undefined,
        finalText: undefined,
        thinkingTrace: [],
        toolOutputs: [],
        thinkingEndedAt: event.createdAt,
      };
    default:
      return state;
  }
}
