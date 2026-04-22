import type { AiAssistantState, ToolOutput } from '../types/tabState';
import type { AiThinkingTraceStep } from './aiThinking';

import {
  applyAiStreamEvent,
  createEmptyAiAssistantState,
  getAiAssistantCommitText,
  resetAiAssistantState,
} from './aiRunState';

describe('aiRunState', () => {
  it('applies events only to the active run and accumulates draft text', () => {
    const empty = createEmptyAiAssistantState(80);
    const started = applyAiStreamEvent(empty, {
      type: 'run.started',
      runId: 'run-1',
      createdAt: 1000,
    });
    const addedDraft = applyAiStreamEvent(started, {
      type: 'answer.delta',
      runId: 'run-1',
      textDelta: 'Hello',
      createdAt: 1001,
    });
    const withStage = applyAiStreamEvent(addedDraft, {
      type: 'thinking.stage',
      runId: 'run-1',
      stage: 'retriever',
      title: '检索上下文',
      detail: '拉取聊天消息',
      createdAt: 1002,
    });
    const restarted = applyAiStreamEvent(withStage, {
      type: 'run.started',
      runId: 'run-2',
      createdAt: 1003,
    });
    const stale = applyAiStreamEvent(withStage, {
      type: 'answer.delta',
      runId: 'old-run',
      textDelta: ' ignored',
      createdAt: 1004,
    });

    expect(withStage.activeStage).toBe('retriever');
    expect(stale.draftText).toBe('Hello');
    expect(stale.runId).toBe('run-1');
    expect(restarted.runId).toBe('run-2');
    expect(restarted.streamStatus).toBe('streaming');
    expect(restarted.toolOutputs).toHaveLength(0);
    expect(restarted.toolOutputHistory).toHaveLength(0);
    expect(restarted.draftText).toBeUndefined();
    expect(restarted.isLoading).toBe(true);
  });

  it('resets transient fields on run started while keeping turns', () => {
    const base: AiAssistantState = {
      ...createEmptyAiAssistantState(60),
      turns: [{
        role: 'user' as const,
        text: 'hi',
        createdAt: 1,
      }],
      draftText: 'pending',
      toolOutputs: [{
        type: 'message.fetch',
        query: {
          mode: 'recent',
          limit: 3,
        },
        result: {
          messages: [],
          total: 0,
          truncated: false,
          evidenceIds: [],
        },
        createdAt: 1,
      }],
      toolOutputHistory: [{
        type: 'message.fetch',
        query: {
          mode: 'recent',
          limit: 3,
        },
        result: {
          messages: [],
          total: 0,
          truncated: false,
          evidenceIds: [],
        },
        createdAt: 1,
      }],
      thinkingTrace: [{
        stage: 'retriever' as const,
        title: 'foo',
        createdAt: 1,
      }] as AiThinkingTraceStep[],
    };

    const restarted = applyAiStreamEvent(base, {
      type: 'run.started',
      runId: 'new-run',
      createdAt: 2000,
    });

    expect(restarted.turns).toHaveLength(1);
    expect(restarted.draftText).toBeUndefined();
    expect(restarted.toolOutputs).toHaveLength(0);
    expect(restarted.toolOutputHistory).toHaveLength(1);
    expect(restarted.thinkingTrace).toHaveLength(0);
    expect(restarted.error).toBeUndefined();
    expect(restarted.streamStatus).toBe('streaming');
  });

  it('fully resets the assistant state while preserving open state and context limit', () => {
    const reset = resetAiAssistantState({
      contextLimit: 40,
      isOpen: true,
    });

    expect(reset).toEqual(expect.objectContaining({
      isOpen: true,
      contextLimit: 40,
      turns: [],
      toolOutputs: [],
      toolOutputHistory: [],
      streamStatus: 'idle',
      runId: undefined,
      activeStage: undefined,
      thinkingTrace: [],
    }));
    expect(reset.selectionContext).toBeUndefined();
  });

  it('drops temporary selection context when resetting the assistant state', () => {
    const reset = resetAiAssistantState({
      contextLimit: 40,
      isOpen: true,
      selectionContext: {
        source: 'message-selection',
        chatId: 'chat-1',
        threadId: 1,
        messageIds: [7, 9],
        createdAt: 123,
      },
    });

    expect(reset.selectionContext).toBeUndefined();
  });

  it('handles terminal statuses and errors', () => {
    const start = applyAiStreamEvent(createEmptyAiAssistantState(90), {
      type: 'run.started',
      runId: 'term',
      createdAt: 3000,
    });
    const done = applyAiStreamEvent(start, {
      type: 'run.done',
      runId: 'term',
      createdAt: 3001,
    });
    expect(done.streamStatus).toBe('done');
    expect(done.isLoading).toBe(false);
    expect(done.toolOutputs).toHaveLength(0);
    expect(done.toolOutputHistory).toHaveLength(0);
    expect(done.activeStage).toBeUndefined();
    expect(done.draftText).toBeUndefined();
    expect(done.runId).toBeUndefined();

    const error = applyAiStreamEvent(start, {
      type: 'run.error',
      runId: 'term',
      error: 'boom',
      createdAt: 3002,
    });
    expect(error.streamStatus).toBe('error');
    expect(error.error).toBe('boom');
    expect(error.toolOutputs).toHaveLength(0);
    expect(error.toolOutputHistory).toHaveLength(0);
    expect(error.activeStage).toBeUndefined();

    const cancelled = applyAiStreamEvent(start, {
      type: 'run.cancelled',
      runId: 'term',
      createdAt: 3003,
    });
    expect(cancelled.streamStatus).toBe('cancelled');
    expect(cancelled.toolOutputs).toHaveLength(0);
    expect(cancelled.toolOutputHistory).toHaveLength(0);
    expect(cancelled.thinkingTrace).toHaveLength(0);
  });

  it('appends tool outputs', () => {
    const start = applyAiStreamEvent(createEmptyAiAssistantState(), {
      type: 'run.started',
      runId: 'tool',
      createdAt: 4000,
    });
    const withTool = applyAiStreamEvent(start, {
      type: 'tool.output',
      runId: 'tool',
      toolType: 'message.fetch',
      description: '继续向前补回历史上下文',
      payload: {
        type: 'message.fetch',
        query: {
          mode: 'recent',
          limit: 2,
        },
        result: {
          messages: [],
          total: 0,
          truncated: false,
          evidenceIds: [],
        },
        createdAt: 0,
      } as ToolOutput,
      createdAt: 4001,
    });

    expect(withTool.toolOutputs).toHaveLength(1);
    expect(withTool.toolOutputs[0]).toEqual(expect.objectContaining({
      description: '继续向前补回历史上下文',
    }));
    expect(withTool.toolOutputHistory).toHaveLength(1);
  });

  it('falls back to the latest draft text when no final text was committed', () => {
    expect(getAiAssistantCommitText({
      finalText: undefined,
      draftText: '最终答案',
    })).toBe('最终答案');
  });
});
