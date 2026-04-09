# AI Thinking Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show AI reasoning progress live while a request runs, then auto-collapse the full process log under the final answer while keeping it expandable.

**Architecture:** Keep the existing Planner / Retriever / Judge pipeline, but treat its observable steps as a persistent reasoning log attached to each assistant turn. A small helper module will format elapsed time and build log snapshots, the AI action flow will populate and finalize the log, and the right-column UI will render a disclosure row that is expanded while running and collapsed after completion.

**Tech Stack:** TypeScript, React/teact, existing global action/reducer flow, SCSS, current test runner.

---

### Task 1: Add reasoning-log helpers and tests

**Files:**
- Create: `src/global/helpers/aiThinking.ts`
- Create: `src/global/helpers/aiThinking.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { formatAiThinkingDuration, buildAiThinkingSummary } from './aiThinking';

test('formats elapsed time as minutes and seconds', () => {
  expect(formatAiThinkingDuration(2000)).toBe('2s');
  expect(formatAiThinkingDuration(3 * 60 * 1000 + 20 * 1000)).toBe('3m 20s');
});

test('builds a collapsed summary for a finished reasoning log', () => {
  const summary = buildAiThinkingSummary({
    startedAt: 1000,
    endedAt: 201000,
    steps: [
      { text: '正在理解你的问题...', createdAt: 1000 },
      { text: '正在规划检索路径...', createdAt: 2000 },
    ],
  });

  expect(summary.label).toContain('已处理');
  expect(summary.label).toContain('3m 20s');
  expect(summary.stepCount).toBe(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- aiThinking.test.ts --runInBand`

Expected: FAIL because `aiThinking.ts` does not exist yet, or the exported helpers are missing.

- [ ] **Step 3: Write the minimal implementation**

Implement only the formatting and summary helpers needed by the test. Keep the API small and reusable by the AI action and UI.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- aiThinking.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/global/helpers/aiThinking.ts src/global/helpers/aiThinking.test.ts
git commit -m "test: add ai thinking log helpers"
```

### Task 2: Thread reasoning logs through AI state and request flow

**Files:**
- Modify: `src/global/types/tabState.ts`
- Modify: `src/global/types/actions.ts`
- Modify: `src/global/initialState.ts`
- Modify: `src/global/actions/ui/ai.ts`
- Modify: `src/global/helpers/ai.ts`
- Modify: `src/global/helpers/ai.test.ts`
- Modify: `src/global/helpers/aiOrchestrator.ts` only if the stored log needs a new field for the retrieved rounds summary

- [ ] **Step 1: Write the failing test**

Add a test that verifies a finished AI request leaves a persisted reasoning log on the assistant turn, including:
- start time
- end time
- step list
- collapsed-by-default state

Prefer a unit-level test around a helper such as `finalizeAiThinkingLog(...)` if that keeps the test focused and stable.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- aiThinking.test.ts ai.test.ts --runInBand`

Expected: FAIL because the persisted reasoning log fields are not wired yet.

- [ ] **Step 3: Write the minimal implementation**

Update the AI state so request processing:
- starts a reasoning session when the prompt begins
- appends readable stage steps as Planner / Retriever / Judge progress
- snapshots the full log into the final assistant turn on success
- keeps the completed log instead of clearing it away

Keep the existing `<think>` sanitization and response flow intact.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- aiThinking.test.ts ai.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/global/types/tabState.ts src/global/types/actions.ts src/global/initialState.ts src/global/actions/ui/ai.ts src/global/helpers/ai.ts src/global/helpers/ai.test.ts
git commit -m "feat: persist ai reasoning logs"
```

### Task 3: Render collapsible reasoning logs in the AI panel

**Files:**
- Modify: `src/components/right/AiAssistant.tsx`
- Modify: `src/components/right/AiAssistant.scss`

- [ ] **Step 1: Write the failing test**

Add a focused component-level test or snapshot-equivalent check that verifies:
- active reasoning renders expanded while the request is loading
- completed reasoning renders as a collapsed header
- clicking the header toggles the full log visibility

If a pure rendering test is too heavy in this codebase, use a small helper test that validates the summary label and keep the UI code narrowly driven by that helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- aiThinking.test.ts ai.test.ts --runInBand`

Expected: FAIL because the disclosure UI and collapsed state are not implemented yet.

- [ ] **Step 3: Write the minimal implementation**

Render the reasoning log as a disclosure:
- while loading, default expanded with stage updates and full step list
- after completion, collapse automatically to a header like `已处理 3m 20s`
- allow the user to expand/collapse the full step history manually
- keep AI answer text selectable and message-like

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- aiThinking.test.ts ai.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/right/AiAssistant.tsx src/components/right/AiAssistant.scss
git commit -m "feat: collapse ai thinking logs"
```

### Task 4: Final verification

**Files:**
- All touched files

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`

Expected: exit code `0`.

- [ ] **Step 2: Run targeted lint**

Run: `npx eslint src/components/right/AiAssistant.tsx src/components/right/AiAssistant.scss src/global/actions/ui/ai.ts src/global/helpers/ai.ts src/global/helpers/aiThinking.ts src/global/helpers/aiOrchestrator.ts src/global/initialState.ts src/global/types/actions.ts src/global/types/tabState.ts`

Expected: no errors.

- [ ] **Step 3: Run the focused test suite**

Run: `npm test -- aiThinking.test.ts ai.test.ts aiOrchestrator.test.ts --runInBand`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/right/AiAssistant.tsx src/components/right/AiAssistant.scss src/global/actions/ui/ai.ts src/global/helpers/ai.ts src/global/helpers/aiThinking.ts src/global/helpers/aiOrchestrator.ts src/global/initialState.ts src/global/types/actions.ts src/global/types/tabState.ts src/global/helpers/ai.test.ts src/global/helpers/aiThinking.test.ts
git commit -m "feat: show collapsible ai reasoning logs"
```
