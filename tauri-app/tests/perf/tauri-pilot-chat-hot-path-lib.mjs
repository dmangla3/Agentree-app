export const hasPromptToken = ({ bodyText = '', chatText = '', label = '' } = {}) => (
  Boolean(label) && (String(bodyText).includes(label) || String(chatText).includes(label))
);

export const installChatHotPathHelpers = (windowObject = globalThis.window) => {
  if (!windowObject?.document) {
    throw new Error('window with document is required');
  }

  const { document } = windowObject;
  const sleep = (ms) => new Promise((resolve) => windowObject.setTimeout(resolve, ms));
  const elementText = (element) => (element?.textContent || '').trim();
  const hasLayoutBox = (element) => {
    const rects = element?.getClientRects?.();
    return Boolean(element && (element.offsetParent || (rects && rects.length > 0)));
  };
  const isVisiblyHidden = (element) => {
    if (!element) return true;
    const style = windowObject.getComputedStyle?.(element);
    return element.hidden ||
      element.getAttribute('aria-hidden') === 'true' ||
      style?.display === 'none' ||
      style?.visibility === 'hidden';
  };
  const visible = (element) => {
    if (!element || isVisiblyHidden(element)) return false;
    return hasLayoutBox(element) || !document.defaultView?.visualViewport;
  };

  const findComposer = () =>
    document.querySelector('[data-testid="chat-composer-textarea"]') ||
    document.querySelector('textarea[placeholder^="Ask anything"]') ||
    null;

  const isCancelLabel = (label) => (
    label === 'Cancel running agent' || label === 'Cancel sending message' || label === 'Cancel'
  );

  const isSendButton = (button, { includeCancel = false } = {}) => {
    if (!button || !visible(button)) return false;
    const label = button.getAttribute('aria-label') || elementText(button);
    if (label === 'Send' || label === 'Edit and run') return true;
    return includeCancel && isCancelLabel(label);
  };

  const findSendButton = ({ includeCancel = false } = {}) => {
    const byTestId = document.querySelector('[data-testid="chat-send-button"]');
    if (isSendButton(byTestId, { includeCancel })) return byTestId;
    return [...document.querySelectorAll('button')].find((button) => {
      if (!visible(button)) return false;
      return isSendButton(button, { includeCancel });
    }) ||
    null;
  };

  const findChatTabButton = () =>
    [...document.querySelectorAll('button')].find((button) => {
      if (!visible(button)) return false;
      const label = button.getAttribute('aria-label') || button.getAttribute('title') || elementText(button);
      return label === 'Chat' || label === 'Chat View';
    }) ||
    null;

  const restoreChatPanel = async () => {
    const restoreButton = [...document.querySelectorAll('button')]
      .find((button) => (button.getAttribute('aria-label') || button.getAttribute('title') || '') === 'Restore chat panel');
    if (!restoreButton) return false;
    restoreButton.click();
    await sleep(120);
    return true;
  };

  const clickChatTab = async ({ settleMs = 120 } = {}) => {
    const chatTab = findChatTabButton();
    if (!chatTab) return false;
    chatTab.click();
    if (settleMs > 0) await sleep(settleMs);
    return true;
  };

  const controlsReady = ({ requireSendButton = true } = {}) => {
    const composer = findComposer();
    const sendButton = findSendButton({ includeCancel: false });
    return {
      composer,
      sendButton,
      ready: Boolean(
        composer &&
        visible(composer) &&
        composer.disabled === false &&
        (!requireSendButton || (sendButton && visible(sendButton) && sendButton.disabled === false))
      ),
    };
  };

  const ensureChatHotPathReady = async ({
    waitMs = 5000,
    settleMs = 120,
    requireSendButton = true,
  } = {}) => {
    await restoreChatPanel();
    let switchedToChat = false;
    let current = controlsReady({ requireSendButton });
    if (!current.ready) {
      switchedToChat = await clickChatTab({ settleMs });
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      current = controlsReady({ requireSendButton });
      if (current.ready) {
        return {
          switchedToChat,
          composer: current.composer,
          sendButton: current.sendButton,
        };
      }
      if (!switchedToChat) {
        switchedToChat = await clickChatTab({ settleMs });
      }
      await sleep(50);
    }

    throw new Error(`chat hot path controls not ready: ${JSON.stringify({
      switchedToChat,
      composerFound: Boolean(current.composer),
      composerDisabled: current.composer?.disabled ?? null,
      sendButtonFound: Boolean(current.sendButton),
      sendButtonDisabled: current.sendButton?.disabled ?? null,
      bodyTextSample: (document.body?.innerText || document.body?.textContent || '').slice(0, 500),
    })}`);
  };

  const helpers = {
    clickChatTab,
    ensureChatHotPathReady,
    findComposer,
    findSendButton,
    isCancelLabel,
    hasPromptToken: ({ bodyText = '', chatText = '', label = '' } = {}) => (
      Boolean(label) && (String(bodyText).includes(label) || String(chatText).includes(label))
    ),
    visible,
  };
  windowObject.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__ = helpers;
  return helpers;
};

export const CHAT_HOT_PATH_HELPERS_SOURCE = `
(${installChatHotPathHelpers.toString()})(window);
`;
