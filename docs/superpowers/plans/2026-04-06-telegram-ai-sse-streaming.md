# Telegram AI SSE Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream Telegram AI assistant runs as live events, including thinking, retriever, judge, tool, and answer updates, with a cancel button that stops the active run.

**Architecture:** Keep `src/global/actions/ui/ai.ts` as the orchestration entry point, but move streaming parsing, run-state mutation, and abort bookkeeping into small helpers. The provider stream adapter normalizes provider-specific chunks into internal events, a pure run-state reducer applies those events to `TabState.aiAssistant`, and the UI consumes the live state to render stage updates, streamed answer text, and cancel affordances.

**Tech Stack:** TypeScript, existing Teact/Redux-style global state, `fetch` streaming APIs, `AbortController`, Jest, ESLint, webpack dev server.

**Event Contract:** Reuse the spec’s normalized `AiStreamEvent` shape throughout the implementation. Every event must carry `runId` and `createdAt`. Keep provider-specific parsing in the adapter layer, and keep run-state mutation in the reducer layer. Reuse the existing `aiThinking.ts` stage labels and `aiOrchestrator.ts` planner/judge concepts instead of inventing a parallel workflow.

---

### Task 1: Normalize provider streams into internal AI events

**Files:**
- Create: `src/global/types/aiStream.ts`
- Create: `src/global/helpers/aiProviderStream.ts`
- Create: `src/global/helpers/aiProviderStream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('aiProviderStream', () => {
  it('normalizes OpenAI-style streaming chunks into answer and termination events', () => {
    const events = normalizeOpenAiStreamChunks({
      runId: 'run-1',
      chunks: [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: [DONE]',
      ],
    });

    expect(events).toEqual([
      {
        type: 'answer.delta',
        runId: 'run-1',
        createdAt: expect.any(Number),
        textDelta: 'Hello',
      },
      {
        type: 'run.done',
        runId: 'run-1',
        createdAt: expect.any(Number),
      },
    ]);
  });

  it('stops consuming chunks when the abort signal is triggered', async () => {
    const controller = new AbortController();
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n'),
        })
        .mockImplementationOnce(async () => {
          controller.abort();
          throw new DOMException('The operation was aborted.', 'AbortError');
        }),
      cancel: jest.fn(),
    };

    const events: unknown[] = [];
    await expect(readAiProviderStream({
      runId: 'run-1',
      signal: controller.signal,
      reader: reader as any,
      onEvent: (event) => events.push(event),
    })).resolves.toBeUndefined();

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'answer.delta',
      runId: 'run-1',
      textDelta: 'Hel',
    }));
    expect(events[1]).toEqual(expect.objectContaining({
      type: 'run.cancelled',
      runId: 'run-1',
    }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/global/helpers/aiProviderStream.test.ts --runInBand`
Expected: FAIL because `aiProviderStream` helpers do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement:
- `normalizeOpenAiStreamChunks(...)`
- `normalizeGeminiStreamChunks(...)`
- `readAiProviderStream(...)`

The normalizer should accept `runId` up front so every emitted event satisfies the event contract without the caller having to patch ids later.

The provider adapter is responsible for:
- `answer.delta`
- `answer.final`
- `run.done`
- `run.error`
- `run.cancelled`
- optional `thinking.stage` / `thinking.trace` if the provider exposes reasoning metadata

The parser must handle SSE framing details cleanly:
- split JSON chunks across boundaries
- multiple `data:` lines in one response chunk
- empty keep-alive frames
- `AbortError` should become `run.cancelled`, not `run.error`

The shared event type lives in `src/global/types/aiStream.ts` and is imported by both helpers and actions. `tool.output` uses the normalized event contract (`toolType` + `payload`) and is emitted only by the orchestrator after a completed tool result exists. The reducer maps completed `message.fetch` tool output into the existing persisted `ToolOutput` shape (`query` + `result`) used by `TabState.aiAssistant.toolOutputs`.

The orchestrator is responsible for synthesizing:
- `thinking.stage`
- `thinking.trace`
- `retriever.query`
- `retriever.result`
- `judge.decision`
- `tool.output`

That split keeps provider streaming focused on the model stream and preserves the existing local planner/retriever/judge flow.

The provider adapter never emits `tool.output`; it only handles streamed model text, reasoning metadata, and terminal events.

Keep the adapter focused on translation only:
- provider chunks in
- normalized internal events out
- no tab state mutation here

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/global/helpers/aiProviderStream.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/global/helpers/aiProviderStream.ts src/global/helpers/aiProviderStream.test.ts
git commit -m "feat: normalize ai provider streams"
```

### Task 2: Apply streaming events to AI run state

**Files:**
- Create: `src/global/helpers/aiRunState.ts`
- Create: `src/global/helpers/aiRunState.test.ts`
- Modify: `src/global/types/tabState.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('aiRunState', () => {
  it('applies live stream events to the active run only', () => {
    const initial = createEmptyAiAssistantState();
    const started = applyAiStreamEvent(initial, {
      type: 'run.started',
      runId: 'run-1',
      createdAt: 1000,
    });
    const withDraft = applyAiStreamEvent(started, {
      type: 'answer.delta',
      runId: 'run-1',
      textDelta: 'Hello',
      createdAt: 1001,
    });
    const withStage = applyAiStreamEvent(withDraft, {
      type: 'thinking.stage',
      runId: 'run-1',
      stage: 'retriever',
      title: '正在读取聊天',
      createdAt: 1002,
    });
    const restarted = applyAiStreamEvent(withDraft, {
      type: 'run.started',
      runId: 'run-2',
      createdAt: 1002,
    });
    const stale = applyAiStreamEvent(withDraft, {
      type: 'answer.delta',
      runId: 'stale-run',
      textDelta: 'ignored',
      createdAt: 1002,
    });

    expect(stale.draftText).toBe('Hello');
    expect(stale.runId).toBe('run-1');
    expect(withStage.activeStage).toBe('retriever');
    expect(withStage.thinkingStage).toBe('正在读取聊天');
    expect(withStage.isLoading).toBe(true);
    expect(restarted.draftText).toBeUndefined();
    expect(restarted.error).toBeUndefined();
    expect(restarted.thinkingEndedAt).toBeUndefined();
    expect(restarted.toolOutputs).toHaveLength(0);
  });

  it('marks the run as errored or cancelled without clobbering committed turns', () => {
    const initial = createEmptyAiAssistantState();
    const withTurn = {
      ...initial,
      turns: [{ role: 'user', text: 'hi', createdAt: 1 }],
    };
    const errored = applyAiStreamEvent(withTurn, {
      type: 'run.error',
      runId: 'run-1',
      error: 'boom',
      createdAt: 1003,
    });
    const cancelled = applyAiStreamEvent(errored, {
      type: 'run.cancelled',
      runId: 'run-1',
      createdAt: 1004,
    });

    expect(errored.streamStatus).toBe('error');
    expect(cancelled.streamStatus).toBe('cancelled');
    expect(cancelled.turns).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/global/helpers/aiRunState.test.ts --runInBand`
Expected: FAIL because the reducer and new stream state fields are not implemented yet.

- [ ] **Step 3: Write the minimal implementation**

Add to `TabState.aiAssistant`:
- `runId?: string`
- `streamStatus?: 'idle' | 'streaming' | 'cancelling' | 'cancelled' | 'error' | 'done'`
- `activeStage?: 'planner' | 'retriever' | 'judge' | 'answer' | 'summary'`
- `draftText?: string`

Add a small `createEmptyAiAssistantState()` helper in `src/global/helpers/aiRunState.ts` so the reducer, action layer, and tests share the same baseline state.

Treat `toolOutputs` as a per-run scratchpad: clear it on `run.started`, populate it from orchestrated tool results, and render it separately from committed `turns[]`.

Implement `applyAiStreamEvent(...)` so it:
- stores the active `runId`
- resets transient per-run fields on `run.started` while preserving committed `turns[]`
- clears `draftText`, `error`, `thinkingEndedAt`, `thinkingTrace`, and `toolOutputs` on `run.started`
- appends `thinkingTrace`
- updates `thinkingStage`
- keeps `activeStage` and `isLoading` in sync with the current stream state
- treats `streamStatus` as the authoritative state machine and mirrors it to `isLoading` for compatibility while the UI migrates
- appends `draftText` for answer deltas
- persists `toolOutputs`
- sets `streamStatus: 'done' | 'error' | 'cancelled'` with `isLoading: false` on terminal events
- ignores stale events from older runs

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/global/helpers/aiRunState.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/global/helpers/aiRunState.ts src/global/helpers/aiRunState.test.ts src/global/types/tabState.ts
git commit -m "feat: add ai streaming run state"
```

### Task 3: Wire request and cancel actions through the stream helpers

**Files:**
- Create: `src/global/helpers/aiRunController.ts`
- Create: `src/global/helpers/aiRunController.test.ts`
- Modify: `src/global/types/actions.ts`
- Modify: `src/global/actions/ui/ai.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('aiRunController', () => {
  it('cancels the active run and prevents late events from applying', () => {
    const controller = createAiRunController();
    const run = controller.startRun('tab-1');
    expect(controller.getActiveRun('tab-1')?.runId).toBe(run.runId);

    const cancelled = controller.cancelRun('tab-1');

    expect(cancelled?.streamStatus).toBe('cancelled');
    expect(controller.getActiveRun('tab-1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/global/helpers/aiRunController.test.ts --runInBand`
Expected: FAIL because the run controller does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Add a small module-scope run registry that owns:
- current `runId` per tab
- active `AbortController`
- `startRun(...)`
- `cancelRun(...)` with `cancelling -> cancelled` transitions and a returned cancelled snapshot
- `getActiveRun(...)`

Make the cancel flow explicit:
- mark the run as `cancelling`
- abort the fetch/reader
- emit or apply `run.cancelled`
- mark the run as `cancelled`
- ignore any late chunks from the aborted run

Update `src/global/actions/ui/ai.ts` so `requestAiPrompt`:
- starts a new run
- streams provider chunks through `readAiProviderStream(...)` with the active `AbortSignal`
- forwards provider stream events into `applyAiStreamEvent(...)`
- emits `thinking.stage` / `thinking.trace` / `retriever.query` / `retriever.result` / `judge.decision` from the existing planner, retriever, and judge calls
- emits `tool.output` when `message.fetch` returns a completed tool result
- commits the final assistant turn on `answer.final`

Concrete request changes:
- OpenAI-compatible requests should set `stream: true` and pass the active `AbortSignal` directly to `fetch`
- Gemini-compatible requests should use the provider streaming endpoint/body and also pass the active `AbortSignal`
- `requestAiCompletion` should accept `signal?: AbortSignal` and pass it through every `fetch` call
- GramJS-backed history/tool fetches should use the existing abort-controller support where available, or short-circuit before applying late results if the run has been canceled

Add `cancelAiPrompt` to `src/global/types/actions.ts` and handle it in `src/global/actions/ui/ai.ts` so the UI can stop the active stream immediately.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/global/helpers/aiRunController.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/global/helpers/aiRunController.ts src/global/helpers/aiRunController.test.ts src/global/types/actions.ts src/global/actions/ui/ai.ts
git commit -m "feat: wire ai streaming runs and cancel"
```

### Task 4: Render live stream progress and cancel state in the AI panel

**Files:**
- Modify: `src/components/right/AiAssistant.tsx`
- Modify: `src/components/right/AiAssistant.scss`

- [ ] **Step 1: Update the panel to consume live stream state**

Render:
- current `thinkingStage`
- live `thinkingTrace`
- streaming draft answer text
- current `toolOutputs` cards for completed tool results
- stream status badges
- cancel button when `streamStatus === 'streaming'`

Keep the existing turn history, quick actions, and insert/copy/retry actions. Do not bring back the manual retrieval form.

- [ ] **Step 2: Make the send button behave like stop while streaming**

When the assistant is streaming:
- disable prompt submission
- disable prompt editing until the run leaves the streaming state
- switch the button icon/label to cancel
- call `cancelAiPrompt`

When idle:
- keep the current send behavior

- [ ] **Step 3: Restyle the panel for live progress**

Update the stylesheet so the live trace, tool cards, and streamed answer preview fit the existing right-column look without reintroducing the old retrieval panel.

- [ ] **Step 4: Verify the UI builds cleanly**

Run:
`npx eslint src/components/right/AiAssistant.tsx src/components/right/AiAssistant.scss src/global/actions/ui/ai.ts src/global/helpers/aiProviderStream.ts src/global/helpers/aiRunState.ts src/global/helpers/aiRunController.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/right/AiAssistant.tsx src/components/right/AiAssistant.scss
git commit -m "feat: stream ai assistant progress in the panel"
```

### Task 5: Full regression sweep and final verification

**Files:**
- None expected unless a regression fix is needed

- [ ] **Step 0: Confirm the manual checklist**

Check that the implementation supports:
- OpenAI-compatible streaming
- Gemini-compatible streaming
- `thinking / retriever / judge / tool / answer` updates in the panel
- quick actions still working
- cancel preserving already received progress

- [ ] **Step 1: Run the helper and integration tests**

Run:
`npx jest src/global/helpers/aiProviderStream.test.ts src/global/helpers/aiRunState.test.ts src/global/helpers/aiRunController.test.ts --runInBand`

Expected: PASS

- [ ] **Step 2: Run type and lint checks**

Run:
`npx tsc --noEmit`

Run:
`npx eslint src/components/right/AiAssistant.tsx src/components/right/AiAssistant.scss src/global/actions/ui/ai.ts src/global/helpers/aiProviderStream.ts src/global/helpers/aiRunState.ts src/global/helpers/aiRunController.ts src/global/types/actions.ts src/global/types/tabState.ts`

Expected: PASS

- [ ] **Step 3: Run the development build**

Run:
`npm run dev`

Expected: webpack dev server starts and the AI panel compiles with no stream-related errors.

- [ ] **Step 4: Commit the final state**

```bash
git add src/global/helpers/aiProviderStream.ts src/global/helpers/aiProviderStream.test.ts src/global/helpers/aiRunState.ts src/global/helpers/aiRunState.test.ts src/global/helpers/aiRunController.ts src/global/helpers/aiRunController.test.ts src/global/types/actions.ts src/global/types/tabState.ts src/global/actions/ui/ai.ts src/components/right/AiAssistant.tsx src/components/right/AiAssistant.scss
git commit -m "feat: stream telegram ai assistant with cancel"
```
