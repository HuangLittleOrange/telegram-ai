# Telegram AI Assistant Design

## Goal
Add an AI assistant to the existing Telegram Web UI with minimal layout risk by reusing the right column architecture.

## Confirmed Product Decisions
1. Use right-column mode switch (`Info | AI Assistant`), not a fourth column.
2. AI context scope is current chat recent N messages.
3. Default context N is 100.
4. UI must clearly show actual used message count per generation.
5. User can adjust N in AI panel.
6. Add a dedicated AI settings page in Settings.
7. API key input is plain text (not password field).
8. API key is persisted locally.

## UX
### Entry points
1. Add AI action button in middle header actions.
2. Clicking AI opens right column in `AiAssistant` content mode.
3. Right column keeps existing behavior on desktop/tablet/mobile.

### AI Panel
1. Title: `AI Assistant`.
2. Context strip: `Based on last X messages` and context selector (50/100/200/custom).
3. Quick actions:
   - Summarize today
   - Generate 3 replies
   - Extract TODOs
4. Conversation area with user and assistant turns.
5. Bottom input for free-form prompts.
6. Assistant output actions:
   - Insert into composer
   - Copy
   - Retry

### Safety and expectation messaging
1. Show message under key setting: key is stored locally.
2. If key is missing, show explicit setup guidance in AI panel.
3. Never auto-send generated replies; only insert into composer.

## Technical Design
### State
1. Add `RightColumnContent.AiAssistant`.
2. Add `TabState.aiAssistant`:
   - `isOpen`
   - `contextLimit` (default 100)
   - `actualUsedCount`
   - `isLoading`
   - `error`
   - `turns[]`
3. Add AI config in `AccountSettings.aiSettings`:
   - `provider`
   - `model`
   - `apiKey`
   - `baseUrl`
   - `defaultContextLimit`

### Actions and selectors
1. UI actions:
   - `toggleAiAssistant`
   - `setAiContextLimit`
   - `appendAiTurn`
   - `setAiLoading`
   - `setAiError`
2. Async actions:
   - `requestAiSummaryToday`
   - `requestAiReplySuggestions`
   - `requestAiPrompt`
3. Selector ordering: in `selectRightColumnContentKey`, `aiAssistant.isOpen` has priority over `chatInfo`.

### Right column integration
1. Add `AiAssistant` component rendered via existing `RightColumn` switch.
2. Extend right header title and close behavior for AI mode.
3. Reuse existing right-column transition and overlay logic.

### Settings integration
1. Add `SettingsScreens.Ai`.
2. Add `SettingsAi` section and entry in `SettingsMain`.
3. Add header title mapping in `SettingsHeader`.
4. Persist with existing `setSettingOption` and cache flow.

## Non-goals (M1)
1. Server-side key vault/token exchange.
2. Multi-model orchestration.
3. Cross-chat/global memory.

## Validation
1. AI panel opens and closes reliably from header action.
2. Changing N updates displayed context and request behavior.
3. `actualUsedCount` reflects real extracted message count.
4. AI settings persist after refresh.
5. Generated text insertion works in composer without auto-send.
