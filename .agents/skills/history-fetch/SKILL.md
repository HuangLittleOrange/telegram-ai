---
name: history-fetch
description: Fetch Telegram chat history by person, time range, or recent N messages.
user-invocable: false
---

# history.fetch

Use this skill when the assistant needs chat history to complete a Telegram task.

## Purpose
- Fetch messages from the current chat and thread.
- Support `person`, `keyword`, `range`, and `recent` retrieval modes.
- Return structured evidence for downstream reasoning.

## When to Use
- The user asks what someone said.
- The user asks what happened in a time window.
- The assistant needs older context before answering.
- The current context is insufficient to complete the task.

## Inputs
- `mode`: `person` | `range` | `recent`
- `mode`: `person` | `keyword` | `range` | `recent`
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
- Do not guess missing facts.
- Do not turn fetch results into a final answer.
- After fetching, reassess the task and decide the next action.
