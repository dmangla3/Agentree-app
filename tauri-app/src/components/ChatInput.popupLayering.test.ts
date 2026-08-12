import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('chat composer popup layering', () => {
  it('keeps composer popups above both docked and floating composer shells', () => {
    const chatInterfaceSource = readSource('src/components/ChatInterface.tsx');
    const chatInputSource = readSource('src/components/ChatInput.tsx');
    const homePageSource = readSource('src/pages/HomePage.tsx');

    expect(chatInterfaceSource).toContain('relative z-[60] overflow-visible');
    expect(homePageSource).toContain('fixed inset-x-0 bottom-5 z-[70]');
    expect(chatInputSource).toContain('const composerPopupLayerClass = "z-[90]"');
    expect(chatInputSource.match(/composerPopupLayerClass/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it('does not show the cancel affordance when new thread is selected over a running node', () => {
    const chatInputSource = readSource('src/components/ChatInput.tsx');

    expect(chatInputSource).toContain('const showCancel = isSelectedNodeRunning && !isNewThreadTarget;');
  });
});
