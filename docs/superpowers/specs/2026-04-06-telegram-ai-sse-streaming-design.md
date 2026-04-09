# Telegram AI SSE Streaming Design

## Goal
Convert the existing Telegram AI request flow into a streaming interaction so the assistant can emit intermediate events as they happen:
- `thinking`
- `retriever`
- `judge`
- `tool`
- `answer`

The UI should update in real time while the request is in flight, and the user must be able to stop the run with a cancel button.

## Confirmed Product Decisions
1. The assistant keeps the current right-column entry point and prompt composer.
2. The AI run should stream intermediate events, not only the final answer.
3. The stream must surface planning, retrieval, judge, tool, and answer progress.
4. The user can cancel an active run from the same action button area.
5. Canceling should stop both the client-side stream consumption and any in-flight provider request.
6. The current `planner -> retriever -> judge -> answer` workflow stays conceptually intact.
7. The implementation should reuse the existing AI assistant panel state instead of introducing a separate chat surface.

## Scope
This design covers the AI assistant request path used by:
- free-form prompts
- quick actions such as summary, reply suggestions, and todo extraction
- future tool-driven skills such as message retrieval

This design does not add a separate backend service. The client will consume provider streaming responses directly and translate them into internal UI events.

## Streaming Model
### Run lifecycle
Each AI request becomes a single run with a unique `runId`.

1. `run.started`
   - The user submits a prompt.
   - The assistant enters loading state.
2. `thinking.stage`
   - The assistant publishes a stage label such as `planner`, `retriever`, `judge`, or `answer`.
3. `thinking.trace`
   - The assistant appends fine-grained trace entries for the visible thinking log.
4. `retriever.query`
   - The assistant describes what it is trying to retrieve or inspect.
5. `retriever.result`
   - The assistant emits retrieval progress or tool results.
6. `judge.decision`
   - The assistant reports whether evidence is sufficient and why.
7. `tool.output`
   - The assistant appends structured tool output for skills such as `message.fetch`.
8. `answer.delta`
   - The assistant streams incremental answer text into the UI.
9. `answer.final`
   - The assistant finalizes the assistant turn.
10. `run.done`
   - The run finishes successfully.
11. `run.error`
   - The run fails.
12. `run.cancelled`
   - The user stopped the run before completion.

### Event transport
The implementation should treat the provider response as a stream of text/event-style frames or chunked streaming output and normalize it into the run events above.

The app does not need to expose raw provider chunks to the UI. Instead, it should map provider-specific chunks into internal events with a stable schema.

## Event Schema
### Normalized event shape
```ts
type AiStreamEvent =
  | {
      type: 'run.started';
      runId: string;
      createdAt: number;
    }
  | {
      type: 'thinking.stage';
      runId: string;
      stage: 'planner' | 'retriever' | 'judge' | 'answer' | 'summary';
      title: string;
      detail?: string;
      createdAt: number;
    }
  | {
      type: 'thinking.trace';
      runId: string;
      stage: 'planner' | 'retriever' | 'judge' | 'answer' | 'summary';
      title: string;
      detail?: string;
      createdAt: number;
    }
  | {
      type: 'retriever.query';
      runId: string;
      title: string;
      detail?: string;
      createdAt: number;
    }
  | {
      type: 'retriever.result';
      runId: string;
      title: string;
      detail?: string;
      createdAt: number;
    }
  | {
      type: 'judge.decision';
      runId: string;
      title: string;
      detail?: string;
      createdAt: number;
    }
  | {
      type: 'tool.output';
      runId: string;
      toolType: 'message.fetch' | string;
      payload: unknown;
      createdAt: number;
    }
  | {
      type: 'answer.delta';
      runId: string;
      textDelta: string;
      createdAt: number;
    }
  | {
      type: 'answer.final';
      runId: string;
      text: string;
      createdAt: number;
    }
  | {
      type: 'run.done';
      runId: string;
      createdAt: number;
    }
  | {
      type: 'run.error';
      runId: string;
      error: string;
      createdAt: number;
    }
  | {
      type: 'run.cancelled';
      runId: string;
      createdAt: number;
    };
```

### Provider mapping
1. Provider chunks that contain incremental text map to `answer.delta`.
2. Provider chunks that represent tool calls map to `tool.output`.
3. Provider chunks that represent chain-of-thought or reasoning metadata map to `thinking.trace` or `thinking.stage`.
4. Completion and termination map to `answer.final`, `run.done`, `run.error`, or `run.cancelled`.

## State Model
### Tab state additions
Extend `TabState.aiAssistant` with streaming-oriented fields:
- `runId?: string`
- `streamStatus?: 'idle' | 'streaming' | 'cancelling' | 'cancelled' | 'error' | 'done'`
- `activeStage?: 'planner' | 'retriever' | 'judge' | 'answer' | 'summary'`
- `draftText?: string`
- `toolOutputs: ToolOutput[]`

### Existing state reuse
1. Keep `turns[]` for committed user and assistant turns.
2. Keep `thinkingTrace[]` for the visible progress log.
3. Keep `thinkingStage`, `thinkingStartedAt`, and `thinkingEndedAt` as the run envelope.
4. Keep `actualUsedCount` if the UI still needs to surface a final evidence count.

### Run isolation
1. A new prompt starts a new `runId`.
2. Stream events only mutate the state if their `runId` matches the active run.
3. Late events from a canceled or superseded run are ignored.
4. The UI must never mix output from two concurrent runs.

## UX
### Composer behavior
1. While idle, the button behaves like send.
2. While streaming, the same action button becomes cancel.
3. Cancelling should be immediate and visible.
4. The prompt input should stay editable only after the run leaves the streaming state.

### Visible progress
1. The panel should show stage changes in real time.
2. The thinking disclosure should expand as events arrive.
3. Tool outputs should appear as dedicated result cards, not as assistant turns.
4. Answer text should appear progressively while the model is still streaming.

### Cancellation feedback
1. Canceling a run should preserve any already received progress.
2. The UI should clearly mark the run as canceled.
3. No additional tokens or tool outputs should be appended after cancellation.

## Technical Design
### Client request flow
1. The user submits a prompt.
2. The action handler creates a new `runId` and an `AbortController`.
3. The handler clears prior transient stream state but keeps committed history.
4. The handler starts the provider request in streaming mode.
5. Each incoming chunk is normalized into `AiStreamEvent`.
6. The action handler updates tab state incrementally.
7. On completion, the assistant turn is committed.
8. On cancel, the stream is aborted and the run becomes cancelable/cancelled.

### Cancellation flow
1. Clicking the stop button calls `abort()` on the active controller.
2. The provider request should stop reading immediately.
3. The app should mark the run as `cancelling`, then `cancelled`.
4. If the provider returns after cancel, its events are ignored by `runId`.
5. Canceling must not clear the already visible thinking trace unless the user explicitly starts a new run.

### Provider integration
1. OpenAI-compatible providers should use streaming completions.
2. Gemini-compatible providers should use the provider's streaming API if available.
3. Anthropic-compatible providers, if used, should also stream events through the same normalizer.
4. The adapter layer should hide provider differences from the UI.
5. If a provider does not support a specific intermediate signal, the adapter may synthesize a coarse event instead of dropping the stage entirely.

### Tool integration
1. Tool responses become `tool.output` events.
2. `message.fetch` should emit its raw result into the stream as a tool event.
3. Tool outputs should still be appended to `TabState.aiAssistant.toolOutputs` for persistence in the UI.
4. The stream should preserve the evidence IDs returned by tools.

### Answer assembly
1. `answer.delta` updates a draft buffer.
2. The draft buffer is rendered in place as the assistant's live response.
3. `answer.final` commits the completed assistant turn to `turns[]`.
4. The assistant turn should include the final thinking log snapshot as it does today.

## Action Contract
### New or updated actions
1. `requestAiPrompt`
   - becomes streaming-aware
   - emits intermediate events as the provider responds
2. `cancelAiPrompt`
   - aborts the current active run
3. `setAiRunState`
   - optional helper for status changes and UI updates
4. Existing actions such as `appendAiTurn`, `appendAiThinkingTrace`, and `setAiLoading` remain usable

### Recommendation
Use one orchestrator action that owns the `AbortController` and run lifecycle, instead of splitting streaming logic across many reducers.

## Error Handling
1. Network failures should produce `run.error` and a visible error banner.
2. Provider response parse failures should be surfaced as errors, not silently swallowed.
3. Partial progress before an error should remain visible.
4. Canceled runs should not show as failures.
5. A stale event from an old run should be ignored rather than crashing the panel.

## Testing
### Unit tests
1. Event normalizer maps provider chunks into the correct internal events.
2. `runId` isolation prevents cross-run state contamination.
3. Cancel logic aborts streaming and prevents late updates.
4. Tool output events still append to the tool output array.

### UI tests
1. Button swaps from send to cancel while streaming.
2. Thinking trace updates visibly as stages arrive.
3. Answer text grows incrementally during a run.
4. Canceling preserves visible progress and stops further updates.

### Integration checks
1. OpenAI-compatible streaming works in the existing AI settings flow.
2. Gemini-compatible requests still complete.
3. Existing quick actions continue to work with the new stream handler.

## Non-goals
1. WebSocket migration.
2. Server-side request brokering.
3. Multi-run concurrent rendering.
4. Rewriting the AI skill planner or retrieval logic from scratch.

## Validation
1. A prompt starts a visible streaming run.
2. Thinking, retriever, judge, tool, and answer updates appear before completion.
3. The cancel button stops the active run.
4. Final assistant messages are still persisted in the current conversation history.
5. Existing quick actions still produce the expected results.
