# AI Retrieval Planner Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed recent-N AI context with a model-driven Planner / Retriever / Judge flow that can inspect cached local messages first and fetch older history when evidence is insufficient.

**Architecture:** Keep UI state in the existing AI assistant tab state, but move orchestration into helper modules. The Planner model emits structured retrieval intent, the Retriever gathers evidence from in-memory messages, IndexedDB cached state, and paged Telegram history, and the Judge model decides whether more evidence is needed before the final answer prompt is built.

**Tech Stack:** TypeScript, existing Teact global actions, IndexedDB (`idb-keyval`), Telegram history API (`fetchMessages`), Jest.

---

## File Map
- Create: `src/global/helpers/aiOrchestrator.ts`
- Modify: `src/global/helpers/ai.ts`
- Modify: `src/global/helpers/ai.test.ts`
- Modify: `src/global/actions/ui/ai.ts`
- Optional create: `src/global/helpers/aiOrchestrator.test.ts`

### Task 1: Define orchestration contracts

**Files:**
- Create: `src/global/helpers/aiOrchestrator.ts`
- Test: `src/global/helpers/aiOrchestrator.test.ts`

- [ ] Step 1: Define planner, retriever, judge, and evidence contracts.
- [ ] Step 2: Add parser helpers for planner/judge JSON output with safe fallbacks.
- [ ] Step 3: Write failing tests for JSON parsing and orchestration defaults.
- [ ] Step 4: Run targeted tests and confirm failures are for missing behavior.

### Task 2: Implement retrieval loop

**Files:**
- Create: `src/global/helpers/aiOrchestrator.ts`
- Test: `src/global/helpers/aiOrchestrator.test.ts`

- [ ] Step 1: Write a failing test for multi-round retrieval when judge says evidence is insufficient.
- [ ] Step 2: Implement minimal retrieval loop with bounded rounds and deduped evidence.
- [ ] Step 3: Write a failing test for stop conditions when judge says evidence is sufficient.
- [ ] Step 4: Verify tests pass.

### Task 3: Add prompt builders and local evidence extraction

**Files:**
- Modify: `src/global/helpers/ai.ts`
- Test: `src/global/helpers/ai.test.ts`

- [ ] Step 1: Add planner, judge, and final-answer prompt builders.
- [ ] Step 2: Add helpers to format evidence lines and merged context.
- [ ] Step 3: Write failing tests for evidence formatting and prompt assembly.
- [ ] Step 4: Implement minimal code to pass.

### Task 4: Wire orchestration into AI action flow

**Files:**
- Modify: `src/global/actions/ui/ai.ts`

- [ ] Step 1: Replace fixed recent-only request path with planner-first orchestration.
- [ ] Step 2: Read current-memory and cached IndexedDB messages as initial local evidence.
- [ ] Step 3: Reuse `fetchMessages` API for bounded backfill when judge requests more evidence.
- [ ] Step 4: Preserve existing loading/error/turn state behavior.

### Task 5: Verify end-to-end logic

**Files:**
- N/A

- [ ] Step 1: Run targeted Jest tests for AI helpers.
- [ ] Step 2: Run `npx tsc --noEmit`.
- [ ] Step 3: Run targeted `eslint` on touched files.
- [ ] Step 4: Report any remaining limitations honestly, especially around partial local cache coverage.
