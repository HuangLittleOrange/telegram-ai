import type { AiStreamEvent } from '../types/aiStream';

import { pause } from '../../util/schedulers';

type NormalizeChunksArgs = {
  runId: string;
  chunks: string[];
};

type AiStreamEventPayload = {
  [K in AiStreamEvent['type']]: Omit<Extract<AiStreamEvent, { type: K }>, 'runId' | 'createdAt'>;
}[AiStreamEvent['type']];

type StreamParseState = {
  text: string;
  insideThinkTag: boolean;
};

const STREAM_PACING_CHUNK_SIZE = 12;
const STREAM_PACING_DELAY_MS = 18;

function now() {
  return Date.now();
}

function isAbortError(err: unknown) {
  if (!err || typeof err !== 'object') {
    return false;
  }

  return 'name' in err && (err as any).name === 'AbortError';
}

function emitWithRunId(runId: string, event: AiStreamEventPayload): AiStreamEvent {
  return {
    ...event,
    runId,
    createdAt: now(),
  } as AiStreamEvent;
}

function extractOpenAiDeltaText(payload: any): string | undefined {
  const delta = payload?.choices?.[0]?.delta;
  const content = typeof delta?.content === 'string' ? delta.content : '';
  return content || undefined;
}

function extractGeminiDeltaText(payload: any): string | undefined {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return undefined;
  }

  const text = parts
    .map((part: { text?: string } | undefined) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');

  return text || undefined;
}

function splitVisibleDeltaText(text: string) {
  if (!text) {
    return [];
  }

  if (text.length <= STREAM_PACING_CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let buffer = '';
  const parts = text.split(/(?<=[\n。！？!?；;，,])/);

  for (const part of parts) {
    if (!part) {
      continue;
    }

    if ((buffer + part).length <= STREAM_PACING_CHUNK_SIZE) {
      buffer += part;
      continue;
    }

    if (buffer) {
      chunks.push(buffer);
      buffer = '';
    }

    if (part.length <= STREAM_PACING_CHUNK_SIZE) {
      buffer = part;
      continue;
    }

    for (let index = 0; index < part.length; index += STREAM_PACING_CHUNK_SIZE) {
      chunks.push(part.slice(index, index + STREAM_PACING_CHUNK_SIZE));
    }
  }

  if (buffer) {
    chunks.push(buffer);
  }

  return chunks;
}

function extractVisibleDeltaText(textDelta: string, state: StreamParseState) {
  let visibleText = '';

  for (let index = 0; index < textDelta.length; index++) {
    if (!state.insideThinkTag && textDelta.startsWith('<think', index)) {
      const closingBracketIndex = textDelta.indexOf('>', index);
      if (closingBracketIndex === -1) {
        state.insideThinkTag = true;
        break;
      }

      state.insideThinkTag = true;
      index = closingBracketIndex;
      continue;
    }

    if (state.insideThinkTag && textDelta.startsWith('</think>', index)) {
      state.insideThinkTag = false;
      index += '</think>'.length - 1;
      continue;
    }

    if (!state.insideThinkTag) {
      visibleText += textDelta[index];
    }
  }

  return visibleText;
}

function parseOpenAiDataLine(runId: string, data: string, state: StreamParseState): AiStreamEvent[] | 'done' {
  const trimmed = data.trim();
  if (!trimmed) return [];

  if (trimmed === '[DONE]') {
    const events: AiStreamEvent[] = [];
    if (state.text) {
      events.push(emitWithRunId(runId, {
        type: 'answer.final',
        text: state.text,
      }));
    }
    events.push(emitWithRunId(runId, { type: 'run.done' }));
    return events;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return [];
  }

  // Important: provider adapter never emits tool.output; tool calls are handled by orchestrator.
  const textDelta = extractOpenAiDeltaText(parsed) || extractGeminiDeltaText(parsed);
  if (!textDelta) {
    return [];
  }

  state.text += textDelta;
  const visibleTextDelta = extractVisibleDeltaText(textDelta, state);

  return splitVisibleDeltaText(visibleTextDelta).map((chunk) => emitWithRunId(runId, {
    type: 'answer.delta',
    textDelta: chunk,
  }));
}

function parseSseLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith(':'));
}

export function normalizeOpenAiStreamChunks(args: NormalizeChunksArgs): AiStreamEvent[] {
  const { runId, chunks } = args;
  const events: AiStreamEvent[] = [];
  const state: StreamParseState = { text: '', insideThinkTag: false };

  for (const chunk of chunks) {
    const lines = parseSseLines(chunk);
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trimStart();
      const result = parseOpenAiDataLine(runId, data, state);
      if (result === 'done') {
        // Not used currently; kept for parity with streaming reader.
        continue;
      }
      // The normalizer is a lightweight helper; for deterministic callers/tests we
      // keep only deltas + terminal signals. `answer.final` is emitted by the live reader.
      events.push(...result.filter((event) => event.type !== 'answer.final'));
    }
  }

  return events;
}

type ReadAiProviderStreamArgs = {
  runId: string;
  signal?: AbortSignal;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  onEvent: (event: AiStreamEvent) => void;
};

export async function readAiProviderStream(args: ReadAiProviderStreamArgs): Promise<void> {
  const {
    runId,
    signal,
    reader,
    onEvent,
  } = args;

  const decoder = new TextDecoder();
  const state: StreamParseState = { text: '', insideThinkTag: false };
  let buffer = '';

  const emit = (event: AiStreamEventPayload) => onEvent(emitWithRunId(runId, event));

  const emitEventsWithPacing = async (events: AiStreamEvent[]) => {
    for (let index = 0; index < events.length; index++) {
      onEvent(events[index]);
      if (
        index < events.length - 1
        && events[index].type === 'answer.delta'
        && events[index + 1].type === 'answer.delta'
      ) {
        await pause(STREAM_PACING_DELAY_MS);
      }
    }
  };

  const flushLine = async (line: string): Promise<boolean> => {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith(':')) return false;
    if (!trimmed.startsWith('data:')) return false;

    const data = trimmed.slice(5).trimStart();
    const result = parseOpenAiDataLine(runId, data, state);
    if (result === 'done') {
      // unreachable currently
      return true;
    }

    await emitEventsWithPacing(result);
    return result.some((e) => e.type === 'run.done');
  };

  try {
    while (true) {
      if (signal?.aborted) {
        emit({ type: 'run.cancelled' });
        break;
      }

      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          emit({ type: 'run.cancelled' });
          break;
        }

        emit({
          type: 'run.error',
          error: err instanceof Error ? err.message : 'AI stream failed',
        });
        break;
      }

      if (readResult.done) {
        if (state.text) {
          emit({ type: 'answer.final', text: state.text });
        }
        emit({ type: 'run.done' });
        break;
      }

      buffer += decoder.decode(readResult.value, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';

      let shouldStop = false;
      for (const part of parts) {
        if (await flushLine(part)) {
          shouldStop = true;
          break;
        }
      }

      if (shouldStop) {
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}
