type AssistantThinkStreamState = {
  inThink: boolean;
  carry: string;
  thinkBuffer: string;
};

type AssistantThinkDeltaResult = {
  visibleText: string;
  thinkBlocks: string[];
};

const THINK_OPEN_TAG_PATTERN = /<think\b[^>]*>/i;
const THINK_CLOSE_TAG_PATTERN = /<\/think\s*>/i;
const ESCAPED_THINK_OPEN_TAG_PATTERN = /&lt;think\b[^&]*&gt;/i;
const ESCAPED_THINK_CLOSE_TAG_PATTERN = /&lt;\/think&gt;/i;

function normalizeThinkBlock(text: string) {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findSuffixPrefixLength(text: string, token: string) {
  const normalizedText = text.toLowerCase();
  const normalizedToken = token.toLowerCase();
  const maxLength = Math.min(normalizedText.length, normalizedToken.length - 1);

  for (let length = maxLength; length > 0; length--) {
    if (normalizedText.endsWith(normalizedToken.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

function findSuffixPrefixLengthFromTokens(text: string, tokens: string[]) {
  return tokens.reduce((maxLength, token) => (
    Math.max(maxLength, findSuffixPrefixLength(text, token))
  ), 0);
}

export function createAssistantThinkStreamState(): AssistantThinkStreamState {
  return {
    inThink: false,
    carry: '',
    thinkBuffer: '',
  };
}

export function consumeAssistantThinkDelta(
  state: AssistantThinkStreamState,
  textDelta: string,
): AssistantThinkDeltaResult {
  if (!textDelta) {
    return {
      visibleText: '',
      thinkBlocks: [],
    };
  }

  let input = `${state.carry}${textDelta}`;
  state.carry = '';
  let visibleText = '';
  const thinkBlocks: string[] = [];

  while (input) {
    if (state.inThink) {
      const closeMatch = input.match(THINK_CLOSE_TAG_PATTERN) || input.match(ESCAPED_THINK_CLOSE_TAG_PATTERN);
      if (closeMatch && closeMatch.index !== undefined) {
        state.thinkBuffer += input.slice(0, closeMatch.index);
        const normalizedThink = normalizeThinkBlock(state.thinkBuffer);
        if (normalizedThink) {
          thinkBlocks.push(normalizedThink);
        }
        state.thinkBuffer = '';
        state.inThink = false;
        input = input.slice(closeMatch.index + closeMatch[0].length);
        continue;
      }

      const partialCloseLength = findSuffixPrefixLengthFromTokens(input, ['</think>', '&lt;/think&gt;']);
      if (partialCloseLength > 0) {
        state.thinkBuffer += input.slice(0, -partialCloseLength);
        state.carry = input.slice(-partialCloseLength);
      } else {
        state.thinkBuffer += input;
      }
      break;
    }

    const openMatch = input.match(THINK_OPEN_TAG_PATTERN) || input.match(ESCAPED_THINK_OPEN_TAG_PATTERN);
    if (openMatch && openMatch.index !== undefined) {
      visibleText += input.slice(0, openMatch.index);
      state.inThink = true;
      input = input.slice(openMatch.index + openMatch[0].length);
      continue;
    }

    const partialOpenTagMatch = input.match(/<think\b[^>]*$/i) || input.match(/&lt;think\b[^&]*$/i);
    if (partialOpenTagMatch && partialOpenTagMatch.index !== undefined) {
      visibleText += input.slice(0, partialOpenTagMatch.index);
      state.carry = partialOpenTagMatch[0];
      break;
    }

    const partialOpenLength = findSuffixPrefixLengthFromTokens(input, ['<think', '&lt;think']);
    if (partialOpenLength > 0) {
      visibleText += input.slice(0, -partialOpenLength);
      state.carry = input.slice(-partialOpenLength);
      break;
    }

    visibleText += input;
    break;
  }

  return {
    visibleText,
    thinkBlocks,
  };
}

export function flushAssistantThinkState(
  state: AssistantThinkStreamState,
): AssistantThinkDeltaResult {
  let visibleText = '';
  const thinkBlocks: string[] = [];

  if (state.carry) {
    if (state.inThink) {
      state.thinkBuffer += state.carry;
    } else {
      visibleText += state.carry;
    }
    state.carry = '';
  }

  if (state.inThink && state.thinkBuffer) {
    const normalizedThink = normalizeThinkBlock(state.thinkBuffer);
    if (normalizedThink) {
      thinkBlocks.push(normalizedThink);
    }
  }

  state.inThink = false;
  state.thinkBuffer = '';

  return {
    visibleText,
    thinkBlocks,
  };
}

export function sanitizeAssistantText(text: string | undefined) {
  if (!text) return undefined;

  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/&lt;think\b[^&]*&gt;[\s\S]*?&lt;\/think&gt;/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/&lt;think\b[^&]*&gt;[\s\S]*$/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
