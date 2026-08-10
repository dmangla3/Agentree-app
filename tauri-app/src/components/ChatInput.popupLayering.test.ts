import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('chat composer popup layering', () => {
  it('keeps the composer and inline mention popup above chat messages', () => {
    const chatInterfaceSource = readSource('src/components/ChatInterface.tsx');
    const chatInputSource = readSource('src/components/ChatInput.tsx');

    expect(chatInterfaceSource).toContain('relative z-[60] overflow-visible');
    expect(chatInputSource).toContain('z-[80]');
  });
});
