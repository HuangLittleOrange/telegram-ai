---
name: history-fetch
description: Fetch local synced Telegram chat history by person, keyword, or time range.
user-invocable: false
---

# history.fetch

Use this skill when the assistant needs chat history to complete a Telegram task.

## Purpose
- Fetch messages from locally synced data of the current chat and thread.
- Support `person`, `keyword`, and `range` retrieval modes.
- Filters are combinable: `keyword` + `person` + `timeRange` can be used together.
- `keyword` is fuzzy and can match both sender names and message text.
- Return structured evidence for downstream reasoning.

## When to Use
- The user asks what someone said.
- The user asks what happened in a time window.
- The assistant needs older context before answering.
- The current context is insufficient to complete the task.

## Inputs
- `mode`: `person` | `keyword` | `range`
- `person`: optional
- `keyword`: optional
- `timeRange`: optional
- `limit`: optional
- `beforeMessageId`: optional

## Output
- `messages`
- `total`
- `truncated`
- `evidenceIds`
- `summary`

## Rules
- Read only.
- Local only: do not trigger remote history fetching.
- Do not guess missing facts.
- Do not turn fetch results into a final answer.
- After fetching, reassess the task and decide the next action.
