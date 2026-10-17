import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { hasPromptToken, installChatHotPathHelpers } from './tauri-pilot-chat-hot-path-lib.mjs';

describe('Tauri Pilot chat hot path helpers', () => {
  it('switches from the merge panel to chat before resolving composer and send controls', async () => {
    const dom = new JSDOM(`
      <body>
        <button>Merge</button>
        <button>Chat</button>
        <section id="merge-panel">
          <textarea id="merge-textarea">merge draft</textarea>
          <button disabled>Merge Using AI</button>
        </section>
      </body>
    `, { pretendToBeVisual: true, url: 'http://localhost/' });
    const { document } = dom.window;
    const chatTab = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Chat');
    chatTab.addEventListener('click', () => {
      document.getElementById('merge-panel')?.remove();
      document.body.insertAdjacentHTML('beforeend', `
        <section id="chat-panel">
          <textarea data-testid="chat-composer-textarea" placeholder="Ask anything... Type @ to reference files"></textarea>
          <button data-testid="chat-send-button" aria-label="Send">Send</button>
        </section>
      `);
    });

    const helpers = installChatHotPathHelpers(dom.window);
    const ready = await helpers.ensureChatHotPathReady({ waitMs: 500, settleMs: 0 });

    expect(ready.switchedToChat).toBe(true);
    expect(ready.composer?.getAttribute('data-testid')).toBe('chat-composer-textarea');
    expect(ready.sendButton?.getAttribute('data-testid')).toBe('chat-send-button');
  });

  it('counts a prompt token found in the chat card as visible', () => {
    expect(hasPromptToken({
      bodyText: 'workspace text without the token',
      chatText: 'assistant card contains perf-label-123',
      label: 'perf-label-123',
    })).toBe(true);
  });

  it('does not treat a cancel control as ready for a new send', async () => {
    const dom = new JSDOM(`
      <body>
        <button>Chat</button>
        <textarea data-testid="chat-composer-textarea" placeholder="Ask anything... Type @ to reference files"></textarea>
        <button data-testid="chat-send-button" aria-label="Cancel running agent">Cancel</button>
      </body>
    `, { pretendToBeVisual: true, url: 'http://localhost/' });
    const helpers = installChatHotPathHelpers(dom.window);

    expect(helpers.findSendButton({ includeCancel: true })?.getAttribute('aria-label')).toBe('Cancel running agent');

    await expect(helpers.ensureChatHotPathReady({ waitMs: 80, settleMs: 0 })).rejects.toThrow(/sendButtonFound/);
  });
});
