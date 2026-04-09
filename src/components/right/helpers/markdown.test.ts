import {
  parseMarkdownBlocks,
} from './markdown';

describe('markdown helper', () => {
  it('parses standard markdown blocks and inline formatting', () => {
    expect(parseMarkdownBlocks([
      '# Title',
      '',
      'Hello **world** with *italics*, `inline code`, and [link](https://example.com).',
      '',
      '> quoted line',
      '',
      '- item one',
      '- item two',
      '',
      '1. first',
      '2. second',
    ].join('\n'))).toEqual([
      {
        type: 'heading',
        level: 1,
        children: [
          { type: 'text', value: 'Title' },
        ],
      },
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'Hello ' },
          { type: 'strong', children: [{ type: 'text', value: 'world' }] },
          { type: 'text', value: ' with ' },
          { type: 'em', children: [{ type: 'text', value: 'italics' }] },
          { type: 'text', value: ', ' },
          { type: 'code', value: 'inline code' },
          { type: 'text', value: ', and ' },
          { type: 'link', href: 'https://example.com', children: [{ type: 'text', value: 'link' }] },
          { type: 'text', value: '.' },
        ],
      },
      {
        type: 'blockquote',
        children: [{ type: 'text', value: 'quoted line' }],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          [{ type: 'text', value: 'item one' }],
          [{ type: 'text', value: 'item two' }],
        ],
      },
      {
        type: 'list',
        ordered: true,
        items: [
          [{ type: 'text', value: 'first' }],
          [{ type: 'text', value: 'second' }],
        ],
      },
    ]);
  });

  it('parses fenced code blocks with language', () => {
    expect(parseMarkdownBlocks([
      '```ts',
      'const answer = 42;',
      '```',
    ].join('\n'))).toEqual([
      {
        type: 'code',
        language: 'ts',
        value: 'const answer = 42;',
      },
    ]);
  });
});
