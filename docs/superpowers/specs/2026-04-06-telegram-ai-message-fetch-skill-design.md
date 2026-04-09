# Telegram AI Message Fetch Skill Design

## Goal
Add a reusable `message.fetch` skill to the existing Telegram AI assistant so the agent can retrieve chat messages by person, by time range, or by recent N messages without introducing a separate backend service.

## Confirmed Product Decisions
1. Expose one unified skill: `message.fetch`.
2. Keep the three user-facing retrieval intents:
   - by person
   - by time range
   - by recent N messages
3. Support both preset time buckets and custom ranges.
4. Reuse existing client data, cached state, and the current `fetchMessages` API.
5. The skill is read-only and never sends messages or mutates Telegram state.
6. Returned results must include evidence message IDs so later skills can reference them.
7. The skill only searches the current chat/thread in v1.
8. The action contract is implicit current context: `requestAiMessageFetch({ query, tabId? })` resolves the active chat/thread from the current tab and does not require `chatId` or `threadId` in the query payload.

## Skill Model
### Core skill
`message.fetch` is the only public retrieval skill. It acts like a tool wrapper around the current message store and existing API calls.

### Supported scopes
1. `person`
   - Fetch messages from one person in the current chat/thread.
2. `range`
   - Fetch messages inside a date/time window.
3. `recent`
   - Fetch the latest N messages in the current chat/thread.

### Time range model
`range` and `person` support the same time filter:
1. Preset buckets:
   - `today`
   - `yesterday`
   - `thisWeek`
   - `thisMonth`
2. Custom interval:
   - `startAt`
   - `endAt`

Time semantics:
1. `startAt` and `endAt` are Unix timestamps in milliseconds, matching `Date.now()` and the existing UI date picker output.
2. Custom ranges are half-open intervals in milliseconds: `[startAt, endAt)`.
3. Preset buckets are computed in the user's local timezone, matching how the UI presents chat time.
4. `yesterday` means the previous local day from 00:00 to 00:00 of the current day.
5. `thisWeek` starts on Monday 00:00 local time and ends at the next Monday 00:00 local time.
6. `thisMonth` starts at the first day of the month 00:00 local time and ends at the first day of the next month 00:00 local time.
7. When comparing against Telegram message timestamps, convert local boundaries to Unix seconds before filtering.
8. Preset buckets use half-open intervals `[startAt, endAt)` in local time so a message exactly at the next bucket boundary belongs to the next bucket and is never double-counted.
9. All comparisons happen in whole seconds: convert `startAt` with `Math.floor(startAt / 1000)` and `endAt` with `Math.ceil(endAt / 1000)`, then filter with `message.date >= startSec && message.date < endSec`.
10. Example: a custom range from `2026-04-06 00:00:00.000` to `2026-04-07 00:00:00.000` includes all messages on April 6 local time.
11. Example: a message exactly at `2026-04-07 00:00:00.000` belongs to the next bucket, not the previous day.

## UX
### Entry points
1. Add a retrieval mode switch in the AI assistant side panel.
2. The default view should make the three retrieval intents obvious:
   - `By person`
   - `By time`
   - `Recent N`
3. Keep the existing free-form prompt area for follow-up questions, but make retrieval the first-class entry point for this feature.

### Controls
1. `By person`
   - Person picker bound to the current chat participants / visible senders.
   - Optional time filter.
   - Optional max message count.
2. `By time`
   - Preset chips for `Today`, `Yesterday`, `This week`, `This month`.
   - Custom start/end picker for explicit ranges.
   - Optional max message count.
3. `Recent N`
   - Numeric input for N.
   - Optional person filter.
   - Optional time filter.

### Results
1. Show the total number of matched messages.
2. Show whether the result was truncated by the limit.
3. Show message snippets in chronological order.
4. Preserve evidence links or message IDs for follow-up skills.

## Technical Design
### Scope resolution
1. The skill always starts from the current chat and active thread.
2. The active chat/thread comes from the current tab's message list, i.e. the same `chatId` / `threadId` the right-column AI assistant is already operating on.
   - if the current message list is a saved dialog, the implementation must use the existing saved-dialog detection and `fetchMessages` parameters already supported by the client
3. If there is no active chat/thread, return an empty result with `truncated: false` rather than guessing a fallback context.
4. Person resolution should prefer stable peer identity over raw text:
   - use a selected user/peer when available
   - fall back to matching the visible sender list in the current chat
5. If a person cannot be resolved reliably, return an explicit empty/error state rather than guessing.
6. The query should resolve to a stable peer reference before execution; display names are only for UI convenience.
7. If multiple peers share the same display title, the UI must require an explicit selection instead of guessing.
8. `PersonRef.peerId` is the existing serialized peer id string used throughout the client, the same stable id consumed by `selectPeer(global, peerId)` and the other peer selectors.
9. `global.currentUserId` is the fallback self peer id for outgoing messages when `message.senderId` is missing.

### Retrieval pipeline
1. Gather candidate IDs from the current viewport or the local cache first.
2. If the requested scope is not fully covered locally, use the existing `fetchMessages` API to page additional history.
3. Normalize all messages into one shape.
4. Deduplicate by message ID.
5. Sort in ascending chronological order.
6. Page history in bounded batches and stop once one of these conditions is met:
   - enough matches were found to satisfy `limit`
   - the time boundary has been fully crossed
   - no older history is available
   - the hard fetch cap is reached

### Paging algorithm
1. Use the newest known message in the current viewport or cache as the initial `offsetId` when possible.
2. Request history with `addOffset: -1` so the page walks backward from the offset.
3. Use a fixed batch size of 100 messages per call.
4. `recent`
   - stop once `limit` messages are collected or the hard cap is reached
   - if no local offset exists, start from the newest available message in cache
5. `range`
   - compute the range end boundary first
   - if the cache or viewport already contains a message at or before the computed `endSec`, use that message id as the initial `offsetId`
   - otherwise start from the newest available message and discard messages newer than `endSec` until the boundary is crossed
   - stop when fetched pages are older than `startAt`
6. `person`
   - use the same backward paging strategy
   - stop once `limit` matches are found or the hard cap is reached
   - if a `timeRange` is present, stop when pages are older than the lower time boundary
7. The skill does not attempt an unbounded full-chat scan for `person` without a time range; the hard scan cap is the final safety net.

### Data sources and precedence
1. Live viewport messages in the current tab.
2. Cached global state from the local cache.
3. `fetchMessages` API for missing history.

This order keeps the common cases fast and minimizes network calls.

### Paging limits
1. Use a fixed batch size per API call to keep history traversal predictable.
2. Cap the total scanned history per request to avoid unbounded scans in large chats.
3. A reasonable first version is a batch size of 100 messages and a hard scan cap of 500 messages or 5 pages, whichever is reached first.

### Result schema
`message.fetch` should return a stable structure that downstream skills can reuse:

```ts
type MessageFetchResult = {
  messages: Array<{
    chatId: string;
    threadId: number | string;
    messageId: number;
    sender: string;
    date: number;
    text: string;
  }>;
  total: number;
  truncated: boolean;
  evidenceIds: number[];
  summary?: string;
};
```

`date` is Unix seconds and should match `ApiMessage.date`. Time-range boundaries are converted from milliseconds to seconds before filtering.

`text` is a snippet, not a raw full message body. Reuse `getMessageSummaryText(lang, message, undefined, true, 500)` so the result stays compact enough for UI rendering and downstream LLM use. The overall returned message list should still obey the hard cap from the Limits section.

The raw fetch result should be rendered as a tool result entry in the AI panel, not as a normal user or assistant turn. Downstream skills may consume the same payload for summarization or decision extraction.

### Query schema
The agent should be able to express the three scopes through one query object:

```ts
type MessageFetchQuery =
  | {
      mode: 'person';
      person: PersonRef;
      timeRange?: TimeRange;
      limit?: number;
    }
  | {
      mode: 'range';
      timeRange: TimeRange;
      person?: PersonRef;
      limit?: number;
    }
  | {
      mode: 'recent';
      limit: number;
      person?: PersonRef;
      timeRange?: TimeRange;
    };

type PersonRef = {
  peerId: string;
  title?: string;
};

type TimeRange =
  | {
      mode: 'preset';
      value: 'today' | 'yesterday' | 'thisWeek' | 'thisMonth';
    }
  | {
      mode: 'custom';
      startAt: number;
      endAt: number;
    };
```

### Filtering rules
1. If multiple filters are present, apply them as an intersection.
2. `recent` defines the upper bound of returned messages.
3. `limit` is a soft cap for `person` and `range`, and a hard requirement for `recent`.
4. Deleted, inaccessible, or empty-text messages should be skipped unless they are still needed as evidence for surrounding context.
5. Service messages should be included only when they materially affect the conversation flow.
6. If total returned text would exceed the response budget, drop the excess messages, keep evidence IDs for the kept subset, and set `truncated: true`.
7. For `person` filtering, derive the sender peer id from the existing message fields/selectors in this order:
   - `message.senderId` when present
   - `global.currentUserId` when the message is outgoing and `senderId` is missing
   - `selectSender(global, message)?.id` as a fallback for incoming messages
   - if no stable sender peer id can be resolved, skip the message for `person` filtering
   Compare the resolved sender peer id against `PersonRef.peerId`.
8. `recent` always means "apply the other active filters first, then return the newest N matches from that filtered result."

### Limits
1. Default limit should match the current AI context default where possible.
2. Use a hard upper bound to avoid returning an unbounded history slice.
3. If the query exceeds the cap, return `truncated: true` and keep the evidence chain intact.
4. The first implementation should keep the hard cap in the same order of magnitude as the current AI context limit, not the entire chat history.

## Integration With Existing AI Assistant
### State
1. Reuse the current right-column AI assistant entry point.
2. Add a retrieval mode state to the AI panel so the user can switch between:
   - person
   - range
   - recent
3. Keep the existing `turns[]`, `thinkingTrace[]`, and loading state.
4. Add an explicit `actualUsedCount` or similar field if the UI needs to surface the real number of messages fetched.
5. Add a dedicated tool output state at `TabState.aiAssistant.toolOutputs`, separate from `turns[]`.
6. Keep only the latest 8 tool outputs per tab and clear them together with `turns[]` in the existing clear/reset flow.
7. Minimal tool output shape:

```ts
type ToolOutput = {
  type: 'message.fetch';
  query: MessageFetchQuery;
  result: MessageFetchResult;
  createdAt: number;
};
```

### Actions
1. Add a retrieval action that accepts the `MessageFetchQuery`.
2. The action should:
   - resolve the scope
   - load missing history if needed
   - update `thinkingTrace`
   - publish the raw result as a tool output entry and expose the payload to downstream skills
3. Keep the existing free-form prompt action for follow-up analysis on top of fetched messages.
4. The tool output entry should store the original query, the raw result, and a creation timestamp so the panel can re-render it without recomputing the fetch.
5. The AI panel should render `toolOutputs[]` in a dedicated tool-results section above the conversational `turns[]` list.
6. `clearAiTurns` should also clear `toolOutputs[]` so a reset fully clears the panel state.

### UI behavior
1. Retrieval should be visible as a distinct step in the AI panel.
2. The panel should show what scope is being fetched before the query runs.
3. When the fetch completes, the assistant should show:
   - count
   - range/person scope
   - any truncation warning
   - message snippets or evidence list

## Non-goals
1. No server-side indexing service.
2. No cross-chat global memory in this first version.
3. No automatic message sending.
4. No mutation of Telegram history.
5. No attempt to infer a person across unrelated chats.

## Validation
1. Fetching by person returns only messages from the selected sender within the current chat/thread.
2. Fetching by preset range returns messages in the correct local-time window.
3. Fetching by custom range respects explicit `startAt` and `endAt`.
4. Fetching recent N messages returns the latest N messages in chronological order.
5. Results are deduplicated, evidence IDs are stable, and truncation is reported.
6. The AI panel can reuse the same fetch result for later summarization or decision-extraction skills.
