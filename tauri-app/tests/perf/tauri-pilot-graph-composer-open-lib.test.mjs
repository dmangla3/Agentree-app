import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { installGraphComposerOpenHelpers } from './tauri-pilot-graph-composer-open-lib.mjs';

describe('graph composer open perf helpers', () => {
  it('collapses the chat panel and measures start-thread click to visible composer', async () => {
    const dom = new JSDOM(`
      <body>
        <button aria-label="Hide chat panel">Hide</button>
        <button aria-label="Start new thread">+</button>
      </body>
    `, { pretendToBeVisual: true, url: 'http://localhost/' });
    const { document } = dom.window;

    document.querySelector('[aria-label="Hide chat panel"]')?.addEventListener('click', () => {
      document.querySelector('[aria-label="Hide chat panel"]')?.remove();
      document.body.insertAdjacentHTML('beforeend', '<button aria-label="Restore chat panel">Restore</button>');
    });
    document.querySelector('[aria-label="Start new thread"]')?.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<textarea data-testid="chat-composer-textarea"></textarea>');
    });

    const helpers = installGraphComposerOpenHelpers(dom.window);
    const report = await helpers.measureGraphComposerOpen({ waitMs: 500 });

    expect(report.clickReturnMs).toBeGreaterThanOrEqual(0);
    expect(report.composerVisibleMs).toBeGreaterThanOrEqual(0);
    expect(document.querySelector('[aria-label="Restore chat panel"]')).toBeTruthy();
  });
});
