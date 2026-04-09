# Telegram AI Message Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified `message.fetch` skill that can retrieve messages by person, by time range, or by recent N messages and expose the result to the Telegram AI assistant as a reusable tool output.

**Architecture:** Keep the retrieval logic in a dedicated helper module so the AI action layer only orchestrates state updates, loading, and result publication. The helper resolves the active chat/thread from the current tab, normalizes time windows, pages history with bounded `fetchMessages` calls, and returns a compact result payload with evidence IDs. The AI panel then renders tool outputs separately from conversational turns and reuses the same payload for later analysis skills.

**Tech Stack:** TypeScript, existing global action/reducer architecture, Telegram history API (`fetchMessages`), Teact, SCSS modules, existing message summary helpers.

---

## Constants
- `BATCH_SIZE = 100`
- `MAX_PAGES = 5`
- `MAX_SCANNED_MESSAGES = 500`
- `MAX_TOOL_OUTPUTS = 8`

Use these caps consistently in the helper, action flow, and UI.

---

## File Map
- Modify: `src/global/types/actions.ts`
- Modify: `src/global/types/tabState.ts`
- Modify: `src/global/initialState.ts`
- Create: `src/global/helpers/messageFetch.ts`
- Modify: `src/global/actions/ui/ai.ts`
- Modify: `src/components/right/AiAssistant.tsx`
- Modify: `src/components/right/AiAssistant.scss`
- Modify: `src/components/ui/InputText.tsx`
- Modify: `src/global/actions/all.ts` only if the new helper or action split requires a new import entry

### Task 1: Add state and action contracts

**Files:**
- Modify: `src/global/types/tabState.ts`
- Modify: `src/global/types/actions.ts`
- Modify: `src/global/initialState.ts`

- [ ] **Step 1: Add tab-scoped AI tool output state**
  - Extend `TabState.aiAssistant` with `toolOutputs[]` for raw `message.fetch` results.
  - Keep the existing `turns[]`, `thinkingTrace[]`, and loading fields unchanged.

- [ ] **Step 2: Add message fetch query/result contracts**
  - Add types for `MessageFetchQuery`, `TimeRange`, `PersonRef`, `MessageFetchResult`, and `ToolOutput`.
  - Make the `requestAiMessageFetch` action payload explicit and tab-scoped.

- [ ] **Step 3: Add defaults and reset behavior**
  - Initialize `toolOutputs` to an empty array.
  - Make the existing clear/reset flow remove both turns and tool outputs.

- [ ] **Step 4: Run a focused type check**
  - Run `npx tsc --noEmit`.
  - Expected: no new type errors from the added contracts.

### Task 2: Build the message fetch helper

**Files:**
- Create: `src/global/helpers/messageFetch.ts`

- [ ] **Step 1: Define the pure retrieval contract**
  - Implement helpers for time-range normalization, preset bucket boundaries, person resolution, and result shaping.
  - Keep the helper free of UI state mutations; it should only read global state and return a fetch result.
  - Use the spec’s deterministic time contract: custom ranges are half-open `[startAt, endAt)`, convert to seconds with `startSec = Math.floor(startAt / 1000)` and `endSec = Math.ceil(endAt / 1000)`, then filter with `message.date >= startSec && message.date < endSec`.
  - Make preset buckets follow the same half-open second-based rule so the helper and UI behave identically.
  - Merge live viewport candidates with `loadCachedGlobal()` cached messages before any API paging, then dedupe by messageId.

- [ ] **Step 2: Implement bounded paging**
  - Use the existing `fetchMessages` API with `offsetId` and `addOffset: -1`.
  - Support the three modes:
    - person
    - range
    - recent
  - `recent`: apply the other active filters first, then return the newest `N` matches.
  - `range`: if a cached/viewport message exists at or before `endSec`, start from that `offsetId`; otherwise start from the newest available message and discard messages newer than `endSec` until the boundary is crossed.
  - `person`: use the same backward paging strategy and stop once `limit` matches are found or the hard cap is reached.
  - Stop on limit, time boundary, empty history, or the hard scan cap.
  - Cap paging at `BATCH_SIZE` messages per page and `MAX_PAGES` / `MAX_SCANNED_MESSAGES` overall.
  - Set `truncated = true` whenever the helper hits `MAX_PAGES`, `MAX_SCANNED_MESSAGES`, or drops messages to satisfy the UI/response budget cap before fully satisfying the query.

- [ ] **Step 3: Normalize message snippets**
  - Use `getMessageSummaryText(lang, message, undefined, true, 500)` to cap `text` snippets.
  - Return stable `evidenceIds`, `total`, and `truncated` values.

- [ ] **Step 4: Run a focused compile check**
  - Run `npx tsc --noEmit`.
  - Expected: the helper compiles cleanly and exposes the new query/result shapes.

### Task 3: Wire the action flow

**Files:**
- Modify: `src/global/actions/ui/ai.ts`

- [ ] **Step 1: Add the `requestAiMessageFetch` action**
  - Resolve the active `chatId/threadId` from the current tab's message list.
  - Return an empty `MessageFetchResult` and still publish a `toolOutputs[]` entry when there is no active context.

- [ ] **Step 2: Orchestrate fetch execution**
  - Call the new helper with the current global state and query.
  - Handle saved-dialog paging by reusing `getIsSavedDialog` and the existing `realChatId` / `threadId` / `isSavedDialog` mapping pattern already used by `fetchMessages` callers in the codebase.
  - Update `thinkingTrace` so the UI can show retrieval progress.

- [ ] **Step 3: Publish tool outputs**
  - Append the raw result to `tabState.aiAssistant.toolOutputs`.
  - Keep tool output rendering separate from conversational turns.
  - Cap retained tool outputs at `MAX_TOOL_OUTPUTS` entries per tab.

- [ ] **Step 4: Preserve existing AI turns and quick actions**
  - Leave the current free-form prompt flow intact.
  - Make sure summary / reply / TODO actions can continue to work on top of fetched evidence.

- [ ] **Step 5: Run targeted lint/type checks**
  - Run `npx tsc --noEmit`.
  - Run `npx eslint src/global/actions/ui/ai.ts src/global/helpers/messageFetch.ts src/global/types/actions.ts src/global/types/tabState.ts src/global/initialState.ts`.

### Task 4: Update the AI assistant panel

**Files:**
- Modify: `src/components/right/AiAssistant.tsx`
- Modify: `src/components/right/AiAssistant.scss`

- [ ] **Step 1: Render tool outputs separately**
  - Add a dedicated tool-results section above the conversational turns list.
  - Render each `message.fetch` tool output with its query summary, match count, and truncation state.

- [ ] **Step 2: Add retrieval controls**
  - Add a mode switch for:
    - by person
    - by time
    - recent N
  - For `person`, populate choices from unique `senderId` values found in the current viewport and cached messages, falling back to visible senders when needed.
  - Extend `InputText` to accept a `type` prop, then use two `datetime-local` inputs for custom time range and convert them to millisecond timestamps for the query payload.
  - Add the required inputs for person, preset/custom time range, and recent N.

- [ ] **Step 3: Show retrieval metadata**
  - Show the resolved chat scope, total matched messages, and whether the result was truncated.
  - Show snippets in chronological order with evidence-friendly formatting.

- [ ] **Step 4: Keep the existing conversational experience intact**
  - Preserve the current prompt box, quick actions, copy/insert/retry behavior, and loading indicators.
  - Make sure the panel still reads naturally when there are no tool outputs yet.

- [ ] **Step 5: Run a UI-focused smoke check**
  - Start the dev server with `npm run dev` and verify the AI panel opens.
  - Verify a fetch result appears as a tool output and does not replace the existing turns list.

### Task 5: Verification and cleanup

**Files:**
- N/A

- [ ] **Step 1: Run a project-wide type check**
  - Run `npx tsc --noEmit`.
  - Expected: no new type errors.

- [ ] **Step 2: Run targeted lint on touched files**
  - Run `npx eslint` on the modified TypeScript files.
  - Expected: no new lint failures from the implementation.

- [ ] **Step 3: Manual smoke check**
  - Open a chat with visible history.
  - Try `message.fetch` by person, by preset time bucket, by custom range, and by recent N.
  - Confirm the results are bounded, evidence IDs are stable, and empty/no-context cases behave predictably.

- [ ] **Step 4: Commit in a small follow-up chunk if needed**
  - If any task lands in a separate slice, commit that slice before moving to the next one.
  - Keep commits focused on one subsystem at a time.
