export type MarkdownInlineNode =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: MarkdownInlineNode[] }
  | { type: 'em'; children: MarkdownInlineNode[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: MarkdownInlineNode[] };

export type MarkdownBlock =
  | { type: 'heading'; level: number; children: MarkdownInlineNode[] }
  | { type: 'paragraph'; children: MarkdownInlineNode[] }
  | { type: 'blockquote'; children: MarkdownInlineNode[] }
  | { type: 'list'; ordered: boolean; items: MarkdownInlineNode[][] }
  | { type: 'code'; language?: string; value: string }
  | { type: 'hr' };

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_RE = /^[-*+]\s+(.+)$/;
const ORDERED_LIST_RE = /^\d+\.\s+(.+)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^```([\w-]+)?\s*$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;

const INLINE_TOKEN_RE = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`)/g;

function parseInlineText(text: string): MarkdownInlineNode[] {
  const result: MarkdownInlineNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    const token = match[0];
    const tokenIndex = match.index || 0;

    if (tokenIndex > lastIndex) {
      result.push({ type: 'text', value: text.slice(lastIndex, tokenIndex) });
    }

    if (token.startsWith('**') || token.startsWith('__')) {
      result.push({
        type: 'strong',
        children: parseInlineText(token.slice(2, -2)),
      });
    } else if (token.startsWith('*') || token.startsWith('_')) {
      result.push({
        type: 'em',
        children: parseInlineText(token.slice(1, -1)),
      });
    } else if (token.startsWith('`')) {
      result.push({
        type: 'code',
        value: token.slice(1, -1),
      });
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        result.push({
          type: 'link',
          href: linkMatch[2],
          children: parseInlineText(linkMatch[1]),
        });
      } else {
        result.push({ type: 'text', value: token });
      }
    }

    lastIndex = tokenIndex + token.length;
  }

  if (lastIndex < text.length) {
    result.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return result.length ? result : [{ type: 'text', value: text }];
}

function collectParagraph(lines: string[], startIndex: number) {
  const collected: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      break;
    }

    if (HEADING_RE.test(line) || FENCE_RE.test(line) || HR_RE.test(line) || BLOCKQUOTE_RE.test(line)
      || UNORDERED_LIST_RE.test(line) || ORDERED_LIST_RE.test(line)) {
      break;
    }

    collected.push(line.trim());
    index += 1;
  }

  return {
    nextIndex: index,
    text: collected.join(' '),
  };
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = trimmed.match(FENCE_RE);
    if (fenceMatch) {
      const language = fenceMatch[1]?.trim() || undefined;
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !FENCE_RE.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length && FENCE_RE.test(lines[index].trim())) {
        index += 1;
      }

      blocks.push({
        type: 'code',
        language,
        value: codeLines.join('\n'),
      });
      continue;
    }

    const headingMatch = trimmed.match(HEADING_RE);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        children: parseInlineText(headingMatch[2].trim()),
      });
      index += 1;
      continue;
    }

    if (HR_RE.test(trimmed)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quoteMatch = lines[index].trim().match(BLOCKQUOTE_RE);
        if (!quoteMatch) {
          break;
        }

        quoteLines.push(quoteMatch[1]);
        index += 1;
      }

      blocks.push({
        type: 'blockquote',
        children: parseInlineText(quoteLines.join(' ')),
      });
      continue;
    }

    if (UNORDERED_LIST_RE.test(trimmed) || ORDERED_LIST_RE.test(trimmed)) {
      const ordered = Boolean(ORDERED_LIST_RE.test(trimmed));
      const items: MarkdownInlineNode[][] = [];

      while (index < lines.length) {
        const listLine = lines[index].trim();
        if (!listLine) {
          break;
        }

        const itemMatch = ordered
          ? listLine.match(ORDERED_LIST_RE)
          : listLine.match(UNORDERED_LIST_RE);

        if (!itemMatch) {
          break;
        }

        items.push(parseInlineText(itemMatch[1].trim()));
        index += 1;
      }

      blocks.push({
        type: 'list',
        ordered,
        items,
      });
      continue;
    }

    const paragraph = collectParagraph(lines, index);
    if (paragraph.text) {
      blocks.push({
        type: 'paragraph',
        children: parseInlineText(paragraph.text),
      });
    }

    index = paragraph.nextIndex + (paragraph.nextIndex < lines.length && !lines[paragraph.nextIndex].trim() ? 1 : 0);
  }

  return blocks;
}
