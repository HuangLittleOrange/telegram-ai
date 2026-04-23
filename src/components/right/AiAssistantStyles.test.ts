import { readFileSync } from 'fs';
import { join } from 'path';

describe('AiAssistant modal layering', () => {
  it('renders takeout help as a confirm-level modal', () => {
    const styles = readFileSync(join(process.cwd(), 'src/components/right/AiAssistant.scss'), 'utf8');
    const takeoutModalBlock = styles.match(/&__takeoutHelpModal\s*\{(?<body>[^}]+)\}/);

    expect(takeoutModalBlock?.groups?.body).toContain('z-index: var(--z-modal-confirm);');
  });
});
