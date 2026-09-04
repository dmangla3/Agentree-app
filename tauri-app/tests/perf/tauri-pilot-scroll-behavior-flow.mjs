import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { CHAT_HOT_PATH_HELPERS_SOURCE } from './tauri-pilot-chat-hot-path-lib.mjs';
import { writeCompactPilotReport } from './tauri-pilot-report-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-scroll-behavior-${Date.now()}`;
const WAIT_TIMEOUT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 240000);
const TEST_AGENT_MODEL = process.env.AGENTREE_TAURI_PILOT_AGENT_MODEL ?? 'gpt-5.4-mini';
const PROMPT = process.env.AGENTREE_TAURI_PILOT_PROMPT ?? [
  `Scroll behavior probe ${LABEL}.`,
  'Write 8 short numbered paragraphs about keeping a chat viewport stable while background agents stream.',
  'Use enough text that the response streams visibly for several seconds.',
].join(' ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execFileText = (cmd, args, options = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

const pilotEval = async (script, timeoutMs = 60000) => {
  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn('tauri-pilot', ['eval', '--json', '-'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`tauri-pilot eval timed out after ${timeoutMs}ms: ${stderr || stdout}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`tauri-pilot eval exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve({ value: stdout.trim() ? JSON.parse(stdout) : null, roundTripMs: Date.now() - startedAt });
      } catch (error) {
        reject(new Error(`failed to parse tauri-pilot JSON: ${error.message}\n${stdout}`));
      }
    });
    child.stdin.end(script);
  });
};

const parseProcessInventory = (text) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const devRuntime = [];
  const packaged = [];
  const tauriDev = [];
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);
    const pid = match ? Number(match[1]) : null;
    const command = match ? match[2] : line;
    if (/\/Applications\/agentree\.app\/Contents\/MacOS\/agentree$/.test(command)) {
      packaged.push({ pid, command });
    } else if (/(^| )target\/debug\/agentree$/.test(command)) {
      devRuntime.push({ pid, command });
    } else if (/npm run dev|npm run tauri dev|node .*tauri-cli\.mjs dev|node .*tauri dev/.test(command)) {
      tauriDev.push({ pid, command });
    }
  }
  return { lines, devRuntime, packaged, tauriDev };
};

const preflight = async () => {
  const raw = await execFileText('ps', ['-axo', 'pid=,command=']);
  const inventory = parseProcessInventory(raw);
  if (inventory.packaged.length > 0) {
    throw new Error(`Packaged Agentree app is running; close it before scroll QA: ${JSON.stringify(inventory.packaged)}`);
  }
  if (inventory.devRuntime.length !== 1) {
    throw new Error(`Expected exactly one target/debug/agentree process, found ${inventory.devRuntime.length}: ${JSON.stringify(inventory.devRuntime)}`);
  }
  const devPid = inventory.devRuntime[0].pid;
  await execFileText('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${devPid}) to true`]);
  await sleep(500);
  const visible = (await pilotEval(`
(() => ({
  visibility: document.visibilityState,
  hidden: document.hidden,
  hasFocus: document.hasFocus(),
  url: location.href,
  composerCount: document.querySelectorAll('textarea').length,
  chatFocusTargetCount: document.querySelectorAll('[data-chat-focus-id]').length,
  graphNodeCount: document.querySelectorAll('.react-flow__node,[data-agentree-graph-node-id]').length,
}))()
`, 30000)).value;
  if (visible?.visibility !== 'visible' || visible?.hidden === true || visible?.hasFocus !== true) {
    throw new Error(`Tauri webview is not visible and focused: ${JSON.stringify(visible)}`);
  }
  let readyVisible = visible;
  const startedAt = Date.now();
  while (!readyVisible?.composerCount && Date.now() - startedAt < 5000) {
    await sleep(150);
    readyVisible = (await pilotEval(`
(() => ({
  visibility: document.visibilityState,
  hidden: document.hidden,
  hasFocus: document.hasFocus(),
  url: location.href,
  composerCount: document.querySelectorAll('textarea').length,
  chatFocusTargetCount: document.querySelectorAll('[data-chat-focus-id]').length,
  graphNodeCount: document.querySelectorAll('.react-flow__node,[data-agentree-graph-node-id]').length,
}))()
`, 30000)).value;
  }
  if (!readyVisible?.composerCount) {
    throw new Error(`Composer not found in visible Tauri webview: ${JSON.stringify(readyVisible)}`);
  }
  if (readyVisible?.visibility !== 'visible' || readyVisible?.hidden === true || readyVisible?.hasFocus !== true) {
    throw new Error(`Tauri webview lost visible/focused state: ${JSON.stringify(readyVisible)}`);
  }
  return { inventory, visible: readyVisible };
};

const install = async () => pilotEval(`
(() => {
  ${CHAT_HOT_PATH_HELPERS_SOURCE}
  const label = ${JSON.stringify(LABEL)};
  const prompt = ${JSON.stringify(PROMPT)};
  const testAgentModel = ${JSON.stringify(TEST_AGENT_MODEL)};
  const waitTimeoutMs = ${JSON.stringify(WAIT_TIMEOUT_MS)};
  window.__AGENTREE_SCROLL_BEHAVIOR__?.cleanup?.();
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'error']);
  const probe = {
    label,
    prompt,
    testAgentModel,
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    sentAtIso: null,
    flowId: null,
    assistantId: null,
    samples: [],
    actions: [],
    scrollEvents: [],
    scrollJumps: [],
    assertionFailures: [],
    errors: [],
    rafStalls: [],
    intervalStalls: [],
    maxRafGapMs: 0,
    maxIntervalGapMs: 0,
    done: false,
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const elapsedMs = () => Number((performance.now() - probe.startedAt).toFixed(2));
  const logAction = (type, details = {}) => {
    probe.actions.push({ type, at: new Date().toISOString(), elapsedMs: elapsedMs(), ...details });
  };
  const escapeSelector = (value) => (
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : String(value).replace(/"/g, '\\\\$&')
  );
  const chatHotPath = window.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__;
  const findComposer = () => chatHotPath.findComposer();
  const findSendButton = () => chatHotPath.findSendButton();
  const chatViewport = () => {
    const focusTarget = document.querySelector('[data-chat-focus-id]');
    const viewportFromTarget = focusTarget?.closest?.('[data-radix-scroll-area-viewport]');
    if (viewportFromTarget) return viewportFromTarget;
    return [...document.querySelectorAll('[data-radix-scroll-area-viewport]')]
      .find((element) => element.querySelector('[data-chat-focus-id]')) || null;
  };
  const latestSession = () => window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
  const latestSendFlowEvent = (name) => latestSession().slice().reverse().find((event) => event?.name === name) || null;
  const latestTerminalEvent = () => latestSession()
    .filter((event) => event?.name === 'run-status.changed' || event?.name === 'run-status.cleared')
    .slice()
    .reverse()
    .find((event) => terminalStatuses.has(event?.details?.nextStatus || event?.details?.status)) || null;
  const latestAssistantEvent = () => latestSession()
    .filter((event) => event?.name === 'run-status.changed' && event?.details?.role === 'assistant' && event?.details?.nodeId)
    .slice()
    .reverse()[0] || null;
  const focusEventsSince = (startedAtIso) => latestSession()
    .filter((event) => String(event?.name || '').startsWith('chat.focus-scroll.'))
    .filter((event) => !startedAtIso || Date.parse(event?.ts || '') >= Date.parse(startedAtIso));
  const scrollSnapshot = () => {
    const viewport = chatViewport();
    if (!viewport) return null;
    return {
      top: Math.round(viewport.scrollTop),
      height: Math.round(viewport.scrollHeight),
      client: Math.round(viewport.clientHeight),
      max: Math.max(0, Math.round(viewport.scrollHeight - viewport.clientHeight)),
      nearTop: viewport.scrollTop <= 4,
      nearBottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 12,
    };
  };
  const sample = (label) => {
    const assistantEvent = latestAssistantEvent();
    if (assistantEvent?.details?.nodeId) probe.assistantId = assistantEvent.details.nodeId;
    const terminal = latestTerminalEvent();
    const item = {
      label,
      at: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      flowId: probe.flowId,
      assistantId: probe.assistantId,
      scroll: scrollSnapshot(),
      terminalStatus: terminal?.details?.nextStatus || terminal?.details?.status || null,
      focus: latestSession().filter((event) => String(event?.name || '').startsWith('chat.focus-scroll.')).slice(-8)
        .map((event) => ({
          name: event.name,
          ts: event.ts,
          source: event.details?.source ?? null,
          reason: event.details?.reason ?? null,
          focusNonce: event.details?.focusNonce ?? null,
          flowId: event.details?.flowId ?? null,
          focusedMessageId: event.details?.focusedMessageId ?? null,
        })),
    };
    probe.samples.push(item);
    return item;
  };

  let previousScroll = null;
  let currentPhase = 'install';
  let userScrollIntentUntil = 0;
  const onScroll = () => {
    const viewport = chatViewport();
    if (!viewport) return;
    const current = scrollSnapshot();
    if (!current) return;
    const previous = previousScroll;
    previousScroll = current;
    const delta = previous ? current.top - previous.top : 0;
    const event = {
      at: new Date().toISOString(),
      elapsedMs: elapsedMs(),
      phase: currentPhase,
      top: current.top,
      max: current.max,
      delta,
      userIntent: performance.now() <= userScrollIntentUntil,
    };
    probe.scrollEvents.push(event);
    if (previous && Math.abs(delta) >= 120 && !event.userIntent) {
      probe.scrollJumps.push(event);
    }
  };
  const markUserScrollIntent = () => {
    userScrollIntentUntil = performance.now() + 1200;
  };
  const installScrollListeners = () => {
    const viewport = chatViewport();
    if (!viewport) throw new Error('chat viewport not found');
    previousScroll = scrollSnapshot();
    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener('wheel', markUserScrollIntent, { passive: true });
    viewport.addEventListener('pointerdown', markUserScrollIntent);
    return viewport;
  };
  let expectedInterval = performance.now() + 100;
  const intervalId = window.setInterval(() => {
    const now = performance.now();
    const gap = now - expectedInterval;
    if (gap > probe.maxIntervalGapMs) probe.maxIntervalGapMs = Number(gap.toFixed(2));
    if (gap > 250) probe.intervalStalls.push({ at: new Date().toISOString(), elapsedMs: elapsedMs(), gapMs: Number(gap.toFixed(2)) });
    expectedInterval = now + 100;
  }, 100);
  let lastRaf = performance.now();
  let rafId = 0;
  const rafLoop = () => {
    const now = performance.now();
    const gap = now - lastRaf;
    if (gap > probe.maxRafGapMs) probe.maxRafGapMs = Number(gap.toFixed(2));
    if (gap > 250) probe.rafStalls.push({ at: new Date().toISOString(), elapsedMs: elapsedMs(), gapMs: Number(gap.toFixed(2)) });
    lastRaf = now;
    rafId = window.requestAnimationFrame(rafLoop);
  };
  rafId = window.requestAnimationFrame(rafLoop);

  const ensureTestAgentModel = async () => {
    if (!testAgentModel) return { selected: null, changed: false };
    const normalize = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const target = normalize(testAgentModel);
    const trigger = document.querySelector('button[aria-label="Select model"]');
    if (!trigger) return { selected: testAgentModel, changed: false, skipped: 'model-selector-trigger-not-found' };
    if (normalize(trigger.textContent || '').includes(target)) return { selected: testAgentModel, changed: false };
    trigger.click();
    const startedAt = performance.now();
    let option = null;
    while (performance.now() - startedAt < 2500) {
      option = [...document.querySelectorAll('button')].find((button) => normalize(button.textContent || '').includes(target)) || null;
      if (option) break;
      await sleep(100);
    }
    if (!option) return { selected: testAgentModel, changed: false, skipped: 'model-option-not-found' };
    option.click();
    await sleep(150);
    return { selected: testAgentModel, changed: true };
  };

  const sendPrompt = async () => {
    await chatHotPath.ensureChatHotPathReady({ waitMs: 5000, requireSendButton: false });
    await ensureTestAgentModel();
    const textarea = findComposer();
    if (!textarea) throw new Error('composer textarea not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, prompt);
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    const button = findSendButton();
    if (!button) throw new Error('send button not found');
    if (button.disabled) throw new Error('send button disabled');
    probe.sentAtIso = new Date().toISOString();
    button.click();
    await sleep(200);
    const startEvent = latestSendFlowEvent('send-flow.lifecycle.started') || latestSendFlowEvent('send-flow.stream.registered');
    probe.flowId = startEvent?.details?.flowId ?? null;
    logAction('send-clicked', { flowId: probe.flowId, buttonLabel: button.getAttribute('aria-label') || button.textContent || null });
    sample('sent');
  };

  const waitForActiveStreaming = async () => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 60000) {
      const terminal = latestTerminalEvent();
      if (terminal) return { terminalBeforeStreaming: terminal };
      const mark = latestSession().slice().reverse().find((event) => (
        event?.name === 'send-flow.mark' &&
        (!probe.flowId || event?.details?.flowId === probe.flowId) &&
        ['first_visible_text_rendered', 'first_assistant_delta'].includes(event?.details?.markName)
      ));
      const activeRun = latestSession().slice().reverse().find((event) => (
        event?.name === 'run-status.changed' &&
        ['running', 'streaming'].includes(event?.details?.nextStatus)
      ));
      if (mark || activeRun) {
        logAction('active-streaming-observed', { markName: mark?.details?.markName ?? null });
        sample('active-streaming');
        return { mark, activeRun };
      }
      await sleep(250);
    }
    throw new Error('timed out waiting for active streaming');
  };

  const setChatScroll = async (top, phase) => {
    const viewport = chatViewport();
    if (!viewport) throw new Error('chat viewport not found');
    currentPhase = phase;
    markUserScrollIntent();
    const rect = viewport.getBoundingClientRect();
    const pointerInit = {
      bubbles: true,
      clientX: rect.left + Math.min(24, Math.max(1, rect.width / 2)),
      clientY: rect.top + Math.min(24, Math.max(1, rect.height / 2)),
      pointerId: 1,
      pointerType: 'mouse',
    };
    viewport.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
    viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: top < viewport.scrollTop ? -600 : 600 }));
    viewport.scrollTop = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight));
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    viewport.dispatchEvent(new PointerEvent('pointerup', pointerInit));
    await sleep(80);
    return sample(phase + '-positioned');
  };

  const holdScroll = async (phase, durationMs, tolerancePx = 12) => {
    const before = sample(phase + '-hold-start');
    const beforeFocusCount = focusEventsSince(before.at).length;
    await sleep(durationMs);
    const after = sample(phase + '-hold-end');
    const delta = (after.scroll?.top ?? 0) - (before.scroll?.top ?? 0);
    const focusEvents = focusEventsSince(before.at);
    const badFocusEvents = focusEvents.filter((event) => {
      const source = event?.details?.source ?? null;
      const reason = event?.details?.reason ?? null;
      return event?.name === 'chat.focus-scroll.start' && source !== 'graph' && source !== 'chat' && source !== 'timeline' && reason !== 'target';
    });
    const result = {
      phase,
      before: before.scroll,
      after: after.scroll,
      delta,
      focusEventsAdded: focusEvents.length - beforeFocusCount,
      badFocusEvents: badFocusEvents.map((event) => ({
        name: event.name,
        ts: event.ts,
        source: event.details?.source ?? null,
        reason: event.details?.reason ?? null,
        flowId: event.details?.flowId ?? null,
        focusedMessageId: event.details?.focusedMessageId ?? null,
      })),
    };
    logAction('hold-scroll-result', result);
    if (Math.abs(delta) > tolerancePx) {
      probe.assertionFailures.push({ message: phase + ' chat scroll moved while user was reading', ...result });
    }
    if ((before.scroll?.top ?? 0) > 30 && (after.scroll?.top ?? 0) <= 4) {
      probe.assertionFailures.push({ message: phase + ' chat scroll snapped to top', ...result });
    }
    if (badFocusEvents.length > 0) {
      probe.assertionFailures.push({ message: phase + ' had non-user focus scroll during hold', ...result });
    }
    return result;
  };

  const clickEmptyGraphPane = async () => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) {
      logAction('graph-empty-click-skipped', { reason: 'pane-not-found' });
      return false;
    }
    const rect = pane.getBoundingClientRect();
    const eventInit = { bubbles: true, clientX: rect.left + Math.min(40, rect.width / 2), clientY: rect.top + Math.min(40, rect.height / 2) };
    pane.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    pane.dispatchEvent(new PointerEvent('pointerup', eventInit));
    pane.dispatchEvent(new MouseEvent('click', eventInit));
    logAction('graph-empty-clicked');
    await sleep(250);
    return true;
  };

  const run = async () => {
    try {
      installScrollListeners();
      sample('installed');
      await sendPrompt();
      await waitForActiveStreaming();
      const initial = scrollSnapshot();
      if (!initial || initial.max < 160) {
        probe.assertionFailures.push({ message: 'chat viewport was not scrollable enough for scroll behavior checks', initial });
      } else {
        await setChatScroll(Math.max(80, Math.round(initial.max * 0.35)), 'manual-middle-active');
        await holdScroll('manual-middle-active', 6000, 18);
        await clickEmptyGraphPane();
        await holdScroll('graph-empty-click-active', 2500, 18);
        await setChatScroll(Math.min(140, Math.max(40, initial.max - 80)), 'manual-near-top-active');
        await holdScroll('manual-near-top-active', 3500, 18);
      }
      const waitStartedAt = performance.now();
      while (performance.now() - waitStartedAt < waitTimeoutMs) {
        const terminal = latestTerminalEvent();
        if (terminal) {
          currentPhase = 'terminal-observed';
          await sleep(500);
          sample('done');
          probe.done = true;
          return;
        }
        await sleep(500);
      }
      probe.assertionFailures.push({ message: 'timed out waiting for terminal status' });
      probe.done = true;
    } catch (error) {
      probe.errors.push({ at: new Date().toISOString(), elapsedMs: elapsedMs(), message: String(error?.message || error), stack: error?.stack || null });
      sample('error');
      probe.done = true;
    }
  };

  probe.cleanup = () => {
    window.clearInterval(intervalId);
    window.cancelAnimationFrame(rafId);
    const viewport = chatViewport();
    viewport?.removeEventListener?.('scroll', onScroll);
    viewport?.removeEventListener?.('wheel', markUserScrollIntent);
    viewport?.removeEventListener?.('pointerdown', markUserScrollIntent);
  };
  window.__AGENTREE_SCROLL_BEHAVIOR__ = probe;
  window.setTimeout(run, 250);
  return { label, promptLength: prompt.length, testAgentModel, url: location.href };
})()
`, 60000);

const waitDone = async () => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_TIMEOUT_MS + 30000) {
    const { value } = await pilotEval(`
(() => {
  const probe = window.__AGENTREE_SCROLL_BEHAVIOR__;
  return {
    done: Boolean(probe?.done),
    actionCount: probe?.actions?.length ?? 0,
    sampleCount: probe?.samples?.length ?? 0,
    assertionFailureCount: probe?.assertionFailures?.length ?? 0,
    errorCount: probe?.errors?.length ?? 0,
    latestSample: probe?.samples?.slice?.(-1)?.[0] ?? null,
  };
})()
`, 30000);
    if (value?.done) return value;
    await sleep(1000);
  }
  return { done: false, timedOut: true };
};

const collect = async () => pilotEval(`
(async () => {
  const probe = window.__AGENTREE_SCROLL_BEHAVIOR__;
  probe?.cleanup?.();
  await window.__AGENTREE_PERF__?.stopCapture?.();
  const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
  return {
    probe,
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    fundamentals: window.__AGENTREE_FUNDAMENTALS__?.read?.() ?? null,
    focusScrollEvents: perfEvents
      .filter((event) => String(event?.name || '').startsWith('chat.focus-scroll.'))
      .map((event) => ({
        name: event.name,
        ts: event.ts,
        source: event.details?.source ?? null,
        reason: event.details?.reason ?? null,
        focusNonce: event.details?.focusNonce ?? null,
        flowId: event.details?.flowId ?? null,
        focusedMessageId: event.details?.focusedMessageId ?? null,
      })),
    userScrollEvents: perfEvents
      .filter((event) => String(event?.name || '').startsWith('chat.user-scroll'))
      .map((event) => ({ name: event.name, ts: event.ts, details: event.details ?? null })),
    graphScrollResetEvents: perfEvents
      .filter((event) => event?.name === 'graph.geometry.internal-scroll-reset')
      .map((event) => ({ ts: event.ts, details: event.details ?? null })),
  };
})()
`, 120000);

const main = async () => {
  const report = {
    label: LABEL,
    startedAt: new Date().toISOString(),
    preflight: null,
    install: null,
    wait: null,
    collect: null,
    errors: [],
  };
  try {
    report.preflight = await preflight();
    report.install = (await install()).value;
    report.wait = await waitDone();
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'preflight-install-or-wait', message: error.message, stack: error.stack });
  }
  try {
    report.collect = (await collect()).value;
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'collect', message: error.message, stack: error.stack });
  }

  const probe = report.collect?.probe ?? null;
  const validationErrors = [
    ...report.errors.map((error) => error.message),
    ...(probe?.errors ?? []).map((error) => error.message),
    ...(probe?.assertionFailures ?? []).map((failure) => failure.message),
  ];
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  const written = writeCompactPilotReport({ reportPath, report });
  console.log(JSON.stringify({
    reportPath,
    artifactDir: written.artifacts.length > 0 ? written.artifactDir : null,
    exportPath: report.collect?.exportStatus?.exportPath ?? null,
    done: probe?.done ?? report.wait?.done ?? false,
    errors: validationErrors,
    assertionFailures: probe?.assertionFailures ?? [],
    scrollJumpCount: probe?.scrollJumps?.length ?? null,
    maxRafGapMs: probe?.maxRafGapMs ?? null,
    maxIntervalGapMs: probe?.maxIntervalGapMs ?? null,
    focusScrollEventCount: report.collect?.focusScrollEvents?.length ?? null,
    userScrollEventCount: report.collect?.userScrollEvents?.length ?? null,
    graphScrollResetEventCount: report.collect?.graphScrollResetEvents?.length ?? null,
  }, null, 2));
  if (validationErrors.length > 0 || !probe?.done) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
