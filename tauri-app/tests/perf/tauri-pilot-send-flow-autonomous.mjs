import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CHAT_HOT_PATH_HELPERS_SOURCE } from './tauri-pilot-chat-hot-path-lib.mjs';
import { writeCompactPilotReport } from './tauri-pilot-report-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-send-flow-auto-${Date.now()}`;
const RUN_DURATION_MS = Number(process.env.AGENTREE_TAURI_PILOT_AUTO_WAIT_MS ?? 300000);
const SEND_READY_TIMEOUT_MS = Number(process.env.AGENTREE_TAURI_PILOT_SEND_READY_TIMEOUT_MS ?? 240000);
const TEST_AGENT_MODEL = process.env.AGENTREE_TAURI_PILOT_AGENT_MODEL ?? 'gpt-5.4-mini';
const PROMPTS = (process.env.AGENTREE_TAURI_PILOT_PROMPTS
  ? JSON.parse(process.env.AGENTREE_TAURI_PILOT_PROMPTS)
  : [
      `Tauri Pilot autonomous send 1 ${LABEL}. Reply briefly.`,
      `Tauri Pilot autonomous send 2 ${LABEL}. Reply briefly.`,
      `Tauri Pilot autonomous send 3 ${LABEL}. Reply with a concise checklist so streaming and painting are observable.`,
    ]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pilotEval = async (script, timeoutMs = 120000) => {
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
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
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

const install = async () => {
  return await pilotEval(`
(() => {
  ${CHAT_HOT_PATH_HELPERS_SOURCE}
  const label = ${JSON.stringify(LABEL)};
  const prompts = ${JSON.stringify(PROMPTS)};
  const sendReadyTimeoutMs = ${JSON.stringify(SEND_READY_TIMEOUT_MS)};
  const testAgentModel = ${JSON.stringify(TEST_AGENT_MODEL)};
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);
  window.__SEND_FLOW_AUTO_REPRO__?.cleanup?.();

  const probe = {
    label,
    prompts,
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    sends: [],
    samples: [],
    errors: [],
    rafStalls: [],
    intervalStalls: [],
    chatMutations: [],
    maxRafGapMs: 0,
    maxIntervalGapMs: 0,
    done: false,
    cleanup: null,
  };

  const briefButtons = () => [...document.querySelectorAll('button')]
    .map((button, index) => ({
      index,
      testId: button.getAttribute('data-testid') || null,
      aria: button.getAttribute('aria-label') || null,
      text: (button.textContent || '').trim().slice(0, 80),
      disabled: button.disabled,
      visible: Boolean(button.offsetParent || button.getClientRects().length),
    }))
    .filter((button) => button.visible)
    .slice(-20);

  const chatHotPath = window.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__;
  const findComposer = () => chatHotPath.findComposer();

  const findSendControl = ({ includeCancel = true } = {}) => {
    return chatHotPath.findSendButton({ includeCancel });
  };

  const ensureTestAgentModel = async () => {
    if (!testAgentModel) return { selected: null, changed: false };
    const normalizeModelText = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const targetModelText = normalizeModelText(testAgentModel);
    const triggerStartedAt = performance.now();
    let trigger = null;
    while (performance.now() - triggerStartedAt < 1500) {
      trigger = document.querySelector('button[aria-label="Select model"]');
      if (trigger) break;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (!trigger) return { selected: testAgentModel, changed: false, skipped: 'model-selector-trigger-not-found' };
    const currentText = (trigger.textContent || '').toLowerCase();
    if (normalizeModelText(currentText).includes(targetModelText)) {
      return { selected: testAgentModel, changed: false };
    }
    trigger.click();
    const startedAt = performance.now();
    let option = null;
    while (performance.now() - startedAt < 2500) {
      option = [...document.querySelectorAll('button')].find((button) => {
        const text = normalizeModelText(button.textContent || '');
        return text.includes(targetModelText);
      }) || null;
      if (option) break;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (!option) return { selected: testAgentModel, changed: false, skipped: 'model-option-not-found' };
    option.click();
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    return { selected: testAgentModel, changed: true };
  };

  const clearComposer = () => {
    const textarea = findComposer();
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, '');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const settleDom = () => new Promise((resolve) => window.setTimeout(resolve, 50));

  const sample = (sampleLabel) => {
    const textarea = findComposer();
    const sendButton = findSendControl();
    const chatRoot = document.querySelector('[data-radix-scroll-area-viewport]') ?? document.body;
    const viewport = document.querySelector('.react-flow__viewport');
    const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    const latestTerminal = perfEvents
      .filter((event) => event?.name === 'run-status.changed' || event?.name === 'run-status.cleared')
      .slice()
      .reverse()
      .find((event) => ['failed', 'completed', 'cancelled'].includes(event?.details?.nextStatus || event?.details?.status));
    const item = {
      label: sampleLabel,
      at: new Date().toISOString(),
      elapsedMs: Number((performance.now() - probe.startedAt).toFixed(2)),
      buttonLabel: sendButton ? (sendButton.getAttribute('aria-label') || sendButton.textContent || '').trim() : null,
      buttonTestId: sendButton ? sendButton.getAttribute('data-testid') || null : null,
      buttonDisabled: sendButton ? sendButton.disabled : null,
      textareaDisabled: textarea ? textarea.disabled : null,
      textareaValueLength: textarea ? textarea.value.length : null,
      chatTextLength: chatRoot.innerText?.length ?? 0,
      graphNodeCount: document.querySelectorAll('.react-flow__node').length,
      graphEdgeCount: document.querySelectorAll('.react-flow__edge').length,
      graphTransform: viewport?.style.transform || null,
      maxRafGapMs: probe.maxRafGapMs,
      maxIntervalGapMs: probe.maxIntervalGapMs,
      latestTerminal,
      visibleButtons: sampleLabel === 'error' ? briefButtons() : undefined,
    };
    probe.samples.push(item);
    return item;
  };

  let expectedInterval = performance.now() + 100;
  const intervalId = window.setInterval(() => {
    const now = performance.now();
    const gap = now - expectedInterval;
    if (gap > probe.maxIntervalGapMs) probe.maxIntervalGapMs = Number(gap.toFixed(2));
    if (gap > 250) probe.intervalStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)) });
    expectedInterval = now + 100;
  }, 100);

  let lastRaf = performance.now();
  let rafId = 0;
  const rafLoop = () => {
    const now = performance.now();
    const gap = now - lastRaf;
    if (gap > probe.maxRafGapMs) probe.maxRafGapMs = Number(gap.toFixed(2));
    if (gap > 250) probe.rafStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)) });
    lastRaf = now;
    rafId = window.requestAnimationFrame(rafLoop);
  };
  rafId = window.requestAnimationFrame(rafLoop);

  const chatRoot = document.querySelector('[data-radix-scroll-area-viewport]') ?? document.body;
  let lastTextLength = chatRoot.innerText?.length ?? 0;
  const mutationObserver = new MutationObserver(() => {
    const textLength = chatRoot.innerText?.length ?? 0;
    probe.chatMutations.push({ at: new Date().toISOString(), delta: textLength - lastTextLength, textLength });
    lastTextLength = textLength;
  });
  mutationObserver.observe(chatRoot, { subtree: true, childList: true, characterData: true });

  const setPromptAndSend = async (prompt, index) => {
    await chatHotPath.ensureChatHotPathReady({ waitMs: sendReadyTimeoutMs, requireSendButton: false });
    const textarea = findComposer();
    if (!textarea) throw new Error('composer textarea not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, prompt);
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await settleDom();
    await settleDom();
    const waitStartedAt = performance.now();
    let sendButton = findSendControl({ includeCancel: false });
    while (sendButton && sendButton.disabled && performance.now() - waitStartedAt < 3000) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      sendButton = findSendControl({ includeCancel: false });
    }
    if (!sendButton) throw new Error('send button not found');
    if (sendButton.disabled) {
      throw new Error('send button disabled before click; promptLength=' + textarea.value.length + '; buttons=' + JSON.stringify(briefButtons()));
    }
    sendButton.click();
    probe.sends.push({ index, at: new Date().toISOString(), elapsedMs: performance.now() - probe.startedAt, promptLength: prompt.length });
    sample('send-' + index + '-clicked');
  };

  const latestTerminalAfterLastSend = () => {
    const lastSend = probe.sends[probe.sends.length - 1];
    if (!lastSend) return null;
    const sentAt = Date.parse(lastSend.at);
    const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
    return perfEvents
      .filter((event) => event?.name === 'run-status.changed' || event?.name === 'run-status.cleared')
      .slice()
      .reverse()
      .find((event) => {
        const status = event?.details?.nextStatus || event?.details?.status;
        if (!['failed', 'completed', 'cancelled'].includes(status)) return false;
        const eventAt = Date.parse(event?.ts || '');
        return Number.isFinite(eventAt) && eventAt >= sentAt;
      }) || null;
  };

  const waitForTerminalDone = () => {
    const startedAt = performance.now();
    const tick = () => {
      const current = sample('wait-terminal');
      const terminal = latestTerminalAfterLastSend();
      const readyAfterRun = current.buttonLabel !== 'Cancel sending message' && current.textareaDisabled === false;
      if (terminal || readyAfterRun) {
        probe.done = true;
        probe.terminal = terminal;
        sample('done');
        return;
      }
      if (performance.now() - startedAt > sendReadyTimeoutMs) {
        probe.errors.push({ at: new Date().toISOString(), message: 'timed out waiting for terminal completion after final send' });
        probe.done = true;
        return;
      }
      window.setTimeout(tick, 500);
    };
    tick();
  };

  const waitForReadyThenSend = (index) => {
    if (index >= prompts.length) {
      waitForTerminalDone();
      return;
    }
    const startedAt = performance.now();
    const tick = async () => {
      const current = sample('wait-' + (index + 1));
      const terminalStatus = current.latestTerminal?.details?.nextStatus || current.latestTerminal?.details?.status || null;
      if (index > 0 && (terminalStatus === 'failed' || terminalStatus === 'cancelled')) {
        probe.errors.push({
          at: new Date().toISOString(),
          message: 'terminal ' + terminalStatus + ' before send ' + (index + 1),
          terminal: current.latestTerminal,
        });
        sample('terminal-stop');
        probe.done = true;
        return;
      }
      if (current.buttonLabel !== 'Cancel sending message' && current.textareaDisabled === false) {
        try {
          await setPromptAndSend(prompts[index], index + 1);
          window.setTimeout(() => waitForReadyThenSend(index + 1), 1000);
        } catch (error) {
          probe.errors.push({ at: new Date().toISOString(), message: String(error?.message || error) });
          sample('error');
          probe.done = true;
        }
        return;
      }
      if (performance.now() - startedAt > sendReadyTimeoutMs) {
        probe.errors.push({ at: new Date().toISOString(), message: 'timed out waiting for ready before send ' + (index + 1) });
        probe.done = true;
        return;
      }
      window.setTimeout(tick, 500);
    };
    tick();
  };

  probe.cleanup = () => {
    window.clearInterval(intervalId);
    window.cancelAnimationFrame(rafId);
    mutationObserver.disconnect();
  };
  window.__SEND_FLOW_AUTO_REPRO__ = probe;
  clearComposer();
  return ensureTestAgentModel()
    .then((modelSelection) => {
      probe.modelSelection = modelSelection;
      sample('installed');
      window.setTimeout(() => waitForReadyThenSend(0), 250);
      return { label, url: location.href, promptCount: prompts.length, modelSelection };
    })
    .catch((error) => {
      const modelSelection = { selected: testAgentModel, changed: false, error: String(error?.message || error) };
      probe.modelSelection = modelSelection;
      sample('installed');
      window.setTimeout(() => waitForReadyThenSend(0), 250);
      return { label, url: location.href, promptCount: prompts.length, modelSelection };
    });
})()
`);
};

const collect = async () => {
  return await pilotEval(`
(async () => {
  const probe = window.__SEND_FLOW_AUTO_REPRO__;
  probe?.cleanup?.();
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return {
    probe,
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    perfEvents: window.__AGENTREE_PERF__?.readLatestSession?.() ?? [],
  };
})()
`, 120000);
};

const waitForProbeDone = async () => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < RUN_DURATION_MS) {
    const { value } = await pilotEval(`
(() => {
  const probe = window.__SEND_FLOW_AUTO_REPRO__;
  return {
    done: Boolean(probe?.done),
    sendsAttempted: probe?.sends?.length ?? 0,
    errors: probe?.errors ?? [],
  };
})()
`, 30000);
    if (value?.done) {
      await sleep(1500);
      return value;
    }
    await sleep(1000);
  }
  return { done: false, timedOut: true };
};

const main = async () => {
  const report = {
    label: LABEL,
    startedAt: new Date().toISOString(),
    testAgentModel: TEST_AGENT_MODEL,
    prompts: PROMPTS.map((prompt) => ({ length: prompt.length, preview: prompt.slice(0, 120) })),
    install: null,
    collect: null,
    errors: [],
  };
  try {
    report.install = (await install()).value;
    report.wait = await waitForProbeDone();
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'install-or-wait', message: error.message, stack: error.stack });
  }
  try {
    report.collect = (await collect()).value;
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'collect', message: error.message, stack: error.stack });
  }
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  const written = writeCompactPilotReport({ reportPath, report });
  console.log(JSON.stringify({
    reportPath,
    artifactDir: written.artifacts.length > 0 ? written.artifactDir : null,
    exportPath: report.collect?.exportStatus?.exportPath ?? null,
    sendsAttempted: report.collect?.probe?.sends?.length ?? 0,
    done: report.collect?.probe?.done ?? false,
    errors: [
      ...report.errors.map((error) => error.message),
      ...(report.collect?.probe?.errors ?? []).map((error) => error.message),
    ],
    maxRafGapMs: report.collect?.probe?.maxRafGapMs ?? null,
    maxIntervalGapMs: report.collect?.probe?.maxIntervalGapMs ?? null,
    rafStallCount: report.collect?.probe?.rafStalls?.length ?? null,
    intervalStallCount: report.collect?.probe?.intervalStalls?.length ?? null,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
