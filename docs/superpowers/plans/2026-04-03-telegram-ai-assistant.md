# Telegram AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-column AI assistant and AI settings page with configurable provider/model/key and recent-N context control.

**Architecture:** Reuse existing right-column content state machine by introducing a new `AiAssistant` content key and a tab-scoped AI session state. Persist provider/model/key/default-context in account settings and render a new Settings section. Keep message extraction and AI request logic in global actions to avoid UI-side side effects.

**Tech Stack:** Teact, TypeScript, existing global action/reducer architecture, SCSS modules.

---

## File Map
- Modify: `src/types/index.ts`
- Modify: `src/global/types/actions.ts`
- Modify: `src/global/types/tabState.ts`
- Modify: `src/global/initialState.ts`
- Modify: `src/global/selectors/ui.ts`
- Modify: `src/global/actions/ui/misc.ts`
- Modify: `src/components/right/RightColumn.tsx`
- Modify: `src/components/right/RightHeader.tsx`
- Create: `src/components/right/AiAssistant.tsx`
- Create: `src/components/right/AiAssistant.scss`
- Modify: `src/components/middle/HeaderActions.tsx`
- Modify: `src/components/left/settings/SettingsMain.tsx`
- Modify: `src/components/left/settings/Settings.tsx`
- Modify: `src/components/left/settings/SettingsHeader.tsx`
- Create: `src/components/left/settings/SettingsAi.tsx`
- Modify: localization strings if required by compile checks

### Task 1: Add state and action contracts
**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/global/types/tabState.ts`
- Modify: `src/global/types/actions.ts`
- Modify: `src/global/initialState.ts`

- [ ] Step 1: Add `RightColumnContent.AiAssistant`, `SettingsScreens.Ai`, and `AccountSettings.aiSettings`.
- [ ] Step 2: Add `TabState.aiAssistant` state shape and defaults.
- [ ] Step 3: Add UI action payloads for AI open/close, context limit, loading/error/turn updates.
- [ ] Step 4: Run type check for contract changes.

### Task 2: Wire right-column content selection and UI actions
**Files:**
- Modify: `src/global/selectors/ui.ts`
- Modify: `src/global/actions/ui/misc.ts`

- [ ] Step 1: Prioritize AI content in `selectRightColumnContentKey`.
- [ ] Step 2: Implement `toggleAiAssistant` and related AI state updaters.
- [ ] Step 3: Ensure opening AI does not break existing chat info behavior.
- [ ] Step 4: Run targeted checks for selector/action compile integrity.

### Task 3: Build right-column AI panel
**Files:**
- Create: `src/components/right/AiAssistant.tsx`
- Create: `src/components/right/AiAssistant.scss`
- Modify: `src/components/right/RightColumn.tsx`
- Modify: `src/components/right/RightHeader.tsx`
- Modify: `src/components/middle/HeaderActions.tsx`

- [ ] Step 1: Add AI entry button in middle header actions.
- [ ] Step 2: Add AI content rendering branch in `RightColumn`.
- [ ] Step 3: Add right-header handling for AI mode title and close.
- [ ] Step 4: Implement panel UI with context selector, quick actions, turns, and input.
- [ ] Step 5: Implement “insert to composer” action hook.
- [ ] Step 6: Verify desktop + mobile open/close behavior.

### Task 4: Add AI settings page
**Files:**
- Create: `src/components/left/settings/SettingsAi.tsx`
- Modify: `src/components/left/settings/SettingsMain.tsx`
- Modify: `src/components/left/settings/Settings.tsx`
- Modify: `src/components/left/settings/SettingsHeader.tsx`

- [ ] Step 1: Add settings entry and route switch case.
- [ ] Step 2: Implement provider/model/key/baseUrl/defaultN form.
- [ ] Step 3: Add local storage warning text and clear-key action.
- [ ] Step 4: Persist through existing `setSettingOption` path.
- [ ] Step 5: Verify settings survive page reload.

### Task 5: Verification
**Files:**
- N/A

- [ ] Step 1: Run lint/type check for touched files.
- [ ] Step 2: Run targeted tests if available for modified areas.
- [ ] Step 3: Manual flow check: open AI, change N, run quick action, insert reply.
- [ ] Step 4: Manual flow check: configure settings, reload, verify persistence.
