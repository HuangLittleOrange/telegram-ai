import { readFileSync } from 'fs';
import { join } from 'path';

describe('MessageList scrollbar styling', () => {
  it('keeps the WebKit scrollbar track fully transparent over chat wallpapers', () => {
    const styles = readFileSync(
      join(process.cwd(), 'src/components/middle/MessageList.scss'),
      'utf8',
    );

    expect(styles).toContain('&::-webkit-scrollbar-track-piece');
    expect(styles).toMatch(
      new RegExp([
        '&::-webkit-scrollbar-track,',
        '\\s*&::-webkit-scrollbar-track-piece,',
        '\\s*&::-webkit-scrollbar-corner\\s*\\{',
        '\\s*background: transparent;',
      ].join('')),
    );
  });

  it('hides the native macOS Tauri scrollbar so the system gutter cannot cover the chat wallpaper', () => {
    const styles = readFileSync(
      join(process.cwd(), 'src/components/middle/MessageList.scss'),
      'utf8',
    );

    expect(styles).toMatch(
      new RegExp([
        'body\\.is-tauri\\.is-macos &\\s*\\{',
        '[\\s\\S]*?scrollbar-width: none;',
        '[\\s\\S]*?&::-webkit-scrollbar\\s*\\{',
        '[\\s\\S]*?display: none;',
      ].join('')),
    );
  });

  it('draws a custom gray scrollbar thumb from message list CSS variables', () => {
    const styles = readFileSync(
      join(process.cwd(), 'src/components/middle/MessageList.scss'),
      'utf8',
    );
    const component = readFileSync(
      join(process.cwd(), 'src/components/middle/MessageList.tsx'),
      'utf8',
    );

    expect(styles).toContain('&.with-custom-scrollbar');
    expect(styles).toMatch(/background-image:\s*linear-gradient/);
    expect(styles).toContain('var(--message-list-scrollbar-thumb-top)');
    expect(styles).toContain('var(--message-list-scrollbar-thumb-height)');
    expect(component).toContain('with-custom-scrollbar');
    expect(component).toContain('--message-list-scrollbar-thumb-top');
    expect(component).toContain('--message-list-scrollbar-thumb-height');
  });
});
