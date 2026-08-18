export const installGraphComposerOpenHelpers = (windowObject = globalThis.window) => {
  if (!windowObject?.document) {
    throw new Error('window with document is required');
  }

  const { document } = windowObject;
  const sleep = (ms) => new Promise((resolve) => windowObject.setTimeout(resolve, ms));
  const elementText = (element) => (element?.textContent || '').trim();
  const isVisiblyHidden = (element) => {
    if (!element) return true;
    const style = windowObject.getComputedStyle?.(element);
    return element.hidden ||
      element.getAttribute('aria-hidden') === 'true' ||
      style?.display === 'none' ||
      style?.visibility === 'hidden';
  };
  const hasLayoutBox = (element) => {
    const rects = element?.getClientRects?.();
    return Boolean(element && (element.offsetParent || (rects && rects.length > 0)));
  };
  const visible = (element) => Boolean(element && !isVisiblyHidden(element) && (hasLayoutBox(element) || !document.defaultView?.visualViewport));
  const labelFor = (element) => element?.getAttribute?.('aria-label') || element?.getAttribute?.('title') || elementText(element);
  const findButton = (label) => [...document.querySelectorAll('button')].find((button) => visible(button) && labelFor(button) === label) || null;
  const findComposer = () => document.querySelector('[data-testid="chat-composer-textarea"]') || null;

  const ensureGraphOnlyMode = async () => {
    const hideChat = findButton('Hide chat panel');
    if (hideChat) {
      hideChat.click();
      await sleep(120);
    }
    return Boolean(findButton('Restore chat panel') || findButton('Start new thread'));
  };

  const collapseComposerIfOpen = async () => {
    const collapse = findButton('Collapse graph composer');
    if (collapse) {
      collapse.click();
      await sleep(50);
      return true;
    }
    return false;
  };

  const measureGraphComposerOpen = async ({ waitMs = 5000 } = {}) => {
    await ensureGraphOnlyMode();
    await collapseComposerIfOpen();
    const startThread = findButton('Start new thread');
    if (!startThread) {
      throw new Error(`Start new thread button not found: ${(document.body?.innerText || '').slice(0, 500)}`);
    }

    const probe = {
      startedAt: windowObject.performance.now(),
      clickReturnMs: null,
      composerVisibleMs: null,
      focusedMs: null,
      maxRafGapMs: 0,
      maxIntervalGapMs: 0,
      rafGaps: [],
      intervalGaps: [],
    };

    let lastRaf = windowObject.performance.now();
    let rafId = 0;
    const rafLoop = () => {
      const now = windowObject.performance.now();
      const gap = now - lastRaf;
      probe.maxRafGapMs = Math.max(probe.maxRafGapMs, Number(gap.toFixed(2)));
      if (gap > 50) probe.rafGaps.push({ atMs: Number((now - probe.startedAt).toFixed(2)), gapMs: Number(gap.toFixed(2)) });
      lastRaf = now;
      rafId = windowObject.requestAnimationFrame(rafLoop);
    };
    rafId = windowObject.requestAnimationFrame(rafLoop);

    let expectedInterval = windowObject.performance.now() + 25;
    const intervalId = windowObject.setInterval(() => {
      const now = windowObject.performance.now();
      const gap = now - expectedInterval;
      probe.maxIntervalGapMs = Math.max(probe.maxIntervalGapMs, Number(gap.toFixed(2)));
      if (gap > 50) probe.intervalGaps.push({ atMs: Number((now - probe.startedAt).toFixed(2)), gapMs: Number(gap.toFixed(2)) });
      expectedInterval = now + 25;
    }, 25);

    startThread.click();
    probe.clickReturnMs = Number((windowObject.performance.now() - probe.startedAt).toFixed(2));

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const composer = findComposer();
      const elapsed = Number((windowObject.performance.now() - probe.startedAt).toFixed(2));
      if (probe.composerVisibleMs === null && visible(composer) && composer.disabled === false) {
        probe.composerVisibleMs = elapsed;
      }
      if (probe.focusedMs === null && composer && document.activeElement === composer) {
        probe.focusedMs = elapsed;
      }
      if (probe.composerVisibleMs !== null) break;
      await sleep(16);
    }

    windowObject.clearInterval(intervalId);
    windowObject.cancelAnimationFrame(rafId);
    return probe;
  };

  const helpers = {
    collapseComposerIfOpen,
    ensureGraphOnlyMode,
    findComposer,
    measureGraphComposerOpen,
    visible,
  };
  windowObject.__AGENTREE_GRAPH_COMPOSER_OPEN__ = helpers;
  return helpers;
};

export const GRAPH_COMPOSER_OPEN_HELPERS_SOURCE = `
(${installGraphComposerOpenHelpers.toString()})(window);
`;
