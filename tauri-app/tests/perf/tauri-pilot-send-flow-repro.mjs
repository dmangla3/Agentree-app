import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-send-flow-${Date.now()}`;
const POLL_INTERVAL_MS = Number(process.env.AGENTREE_TAURI_PILOT_POLL_MS ?? 1000);
const WAIT_TIMEOUT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 240000);
const PROMPTS = (process.env.AGENTREE_TAURI_PILOT_PROMPTS
  ? JSON.parse(process.env.AGENTREE_TAURI_PILOT_PROMPTS)
  : [
      `Tauri Pilot send-flow reproduction 1 ${LABEL}. Reply briefly.`,
      `Tauri Pilot send-flow reproduction 2 ${LABEL}. Reply briefly.`,
      `Tauri Pilot send-flow reproduction 3 ${LABEL}. While replying, include a concise checklist of the current UI state so streaming has enough content to expose paint stalls.`,
    ]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        const parsed = stdout.trim() ? JSON.parse(stdout) : null;
        resolve({ value: parsed, roundTripMs: Date.now() - startedAt });
      } catch (error) {
        reject(new Error(`failed to parse tauri-pilot JSON: ${error.message}\n${stdout}`));
      }
    });
    child.stdin.end(script);
  });
};

const setupProbe = async () => {
  return await pilotEval(`
(() => {
  const label = ${JSON.stringify(LABEL)};
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);
  const existing = window.__SEND_FLOW_PILOT_REPRO__;
  if (existing?.cleanup) existing.cleanup();

  const probe = {
    label,
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    samples: [],
    sendResults: [],
    graphDrags: [],
    longTasks: [],
    intervalStalls: [],
    rafStalls: [],
    chatMutations: [],
    maxIntervalGapMs: 0,
    maxRafGapMs: 0,
    cleanup: null,
  };

  let expectedInterval = performance.now() + 100;
  const intervalId = window.setInterval(() => {
    const now = performance.now();
    const gap = now - expectedInterval;
    if (gap > probe.maxIntervalGapMs) probe.maxIntervalGapMs = Number(gap.toFixed(2));
    if (gap > 250) {
      probe.intervalStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)) });
    }
    expectedInterval = now + 100;
  }, 100);

  let lastRaf = performance.now();
  let rafId = 0;
  const rafLoop = () => {
    const now = performance.now();
    const gap = now - lastRaf;
    if (gap > probe.maxRafGapMs) probe.maxRafGapMs = Number(gap.toFixed(2));
    if (gap > 250) {
      probe.rafStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)) });
    }
    lastRaf = now;
    rafId = window.requestAnimationFrame(rafLoop);
  };
  rafId = window.requestAnimationFrame(rafLoop);

  let longTaskObserver = null;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        probe.longTasks.push({
          at: new Date().toISOString(),
          startTime: Number(entry.startTime.toFixed(2)),
          durationMs: Number(entry.duration.toFixed(2)),
        });
      }
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {}

  const chatRoot = document.querySelector('[data-radix-scroll-area-viewport]') ?? document.body;
  let lastTextLength = chatRoot.innerText?.length ?? 0;
  const mutationObserver = new MutationObserver(() => {
    const textLength = chatRoot.innerText?.length ?? 0;
    probe.chatMutations.push({
      at: new Date().toISOString(),
      delta: textLength - lastTextLength,
      textLength,
    });
    lastTextLength = textLength;
  });
  mutationObserver.observe(chatRoot, { subtree: true, childList: true, characterData: true });

  probe.cleanup = () => {
    window.clearInterval(intervalId);
    window.cancelAnimationFrame(rafId);
    mutationObserver.disconnect();
    longTaskObserver?.disconnect?.();
  };
  window.__SEND_FLOW_PILOT_REPRO__ = probe;
  return {
    label,
    url: location.href,
    hasPerf: Boolean(window.__AGENTREE_PERF__),
    hasTextarea: Boolean(document.querySelector('textarea[placeholder^="Ask anything"]')),
    startedAtIso: probe.startedAtIso,
  };
})()
`);
};

const sample = async (label) => {
  return await pilotEval(`
(() => {
  const probe = window.__SEND_FLOW_PILOT_REPRO__;
  const textarea = document.querySelector('textarea[placeholder^="Ask anything"]');
  const sendButton = [...document.querySelectorAll('button')].find((button) => {
    const aria = button.getAttribute('aria-label') || '';
    const text = button.textContent || '';
    return aria === 'Send' || aria === 'Edit and run' || aria === 'Cancel sending message' || text.trim() === 'Send';
  });
  const viewport = document.querySelector('.react-flow__viewport');
  const chatRoot = document.querySelector('[data-radix-scroll-area-viewport]') ?? document.body;
  const perfEvents = window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
  const sendFlowEvents = perfEvents.filter((event) => String(event?.name || '').includes('send-flow'));
  const runStatusEvents = perfEvents.filter((event) => event?.name === 'run-status.changed' || event?.name === 'run-status.cleared');
  const latestCleanup = sendFlowEvents
    .slice()
    .reverse()
    .find((event) => event?.name === 'send-flow.cleanup.finished');
  const latestTerminalRunStatus = runStatusEvents
    .slice()
    .reverse()
    .find((event) => ['failed', 'completed', 'cancelled'].includes(event?.details?.nextStatus || event?.details?.status));
  const result = {
    label: ${JSON.stringify(label)},
    at: new Date().toISOString(),
    elapsedMs: probe ? Number((performance.now() - probe.startedAt).toFixed(2)) : null,
    url: location.href,
    activeElement: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
    textareaDisabled: textarea ? textarea.disabled : null,
    sendButtonLabel: sendButton ? (sendButton.getAttribute('aria-label') || sendButton.textContent || '').trim() : null,
    sendButtonDisabled: sendButton ? sendButton.disabled : null,
    chatTextLength: chatRoot.innerText?.length ?? 0,
    graphTransform: viewport?.style.transform || null,
    graphNodeCount: document.querySelectorAll('.react-flow__node').length,
    graphEdgeCount: document.querySelectorAll('.react-flow__edge').length,
    maxIntervalGapMs: probe?.maxIntervalGapMs ?? null,
    maxRafGapMs: probe?.maxRafGapMs ?? null,
    recentIntervalStalls: probe?.intervalStalls?.slice(-5) ?? [],
    recentRafStalls: probe?.rafStalls?.slice(-5) ?? [],
    recentLongTasks: probe?.longTasks?.slice(-5) ?? [],
    recentChatMutations: probe?.chatMutations?.slice(-5) ?? [],
    latestCleanup,
    latestTerminalRunStatus,
    latestSendFlowEvents: sendFlowEvents.slice(-8),
    latestRunStatusEvents: runStatusEvents.slice(-8),
    longTaskEventCount: perfEvents.filter((event) => event?.name === 'browser.long-task').length,
  };
  probe?.samples?.push(result);
  return result;
})()
`, 45000);
};

const sendPrompt = async (prompt, index) => {
  return await pilotEval(`
(() => {
  const prompt = ${JSON.stringify(prompt)};
  const index = ${JSON.stringify(index)};
  const textarea = document.querySelector('textarea[placeholder^="Ask anything"]');
  if (!textarea) throw new Error('composer textarea not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, prompt);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  const sendButton = [...document.querySelectorAll('button')].find((button) => {
    const aria = button.getAttribute('aria-label') || '';
    const text = button.textContent || '';
    return aria === 'Send' || aria === 'Edit and run' || text.trim() === 'Send';
  });
  if (!sendButton) throw new Error('send button not found');
  if (sendButton.disabled) throw new Error('send button disabled before click');
  sendButton.click();
  const result = {
    index,
    promptLength: prompt.length,
    clickedAt: new Date().toISOString(),
    buttonLabel: sendButton.getAttribute('aria-label') || sendButton.textContent || '',
  };
  window.__SEND_FLOW_PILOT_REPRO__?.sendResults?.push(result);
  return result;
})()
`, 45000);
};

const dragGraph = async (label) => {
  return await pilotEval(`
(() => {
  const pane = document.querySelector('.react-flow__pane');
  const viewport = document.querySelector('.react-flow__viewport');
  const rect = pane?.getBoundingClientRect();
  if (!pane || !rect) {
    return { label: ${JSON.stringify(label)}, changed: false, error: 'missing pane' };
  }
  const before = viewport?.style.transform || null;
  const x = rect.left + rect.width * 0.5;
  const y = rect.top + rect.height * 0.5;
  const target = document.elementFromPoint(x, y) || pane;
  const eventInit = { bubbles: true, cancelable: true, view: window, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
  target.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, clientX: x, clientY: y }));
  target.dispatchEvent(new PointerEvent('pointermove', { ...eventInit, clientX: x + 180, clientY: y + 80 }));
  target.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, buttons: 0, clientX: x + 180, clientY: y + 80 }));
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
  target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x + 180, clientY: y + 80, button: 0, buttons: 1 }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x + 180, clientY: y + 80, button: 0, buttons: 0 }));
  const after = viewport?.style.transform || null;
  const result = {
    label: ${JSON.stringify(label)},
    at: new Date().toISOString(),
    before,
    after,
    changed: before !== after,
  };
  window.__SEND_FLOW_PILOT_REPRO__?.graphDrags?.push(result);
  return result;
})()
`, 45000);
};

const waitForReady = async (sendIndex, samples) => {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
    const roundTripStartedAt = Date.now();
    const result = await sample(`send-${sendIndex}-poll-${samples.length}`);
    const value = result.value;
    value.evalRoundTripMs = result.roundTripMs;
    value.wallRoundTripMs = Date.now() - roundTripStartedAt;
    samples.push(value);
    last = value;
    const latestCleanup = value.latestCleanup;
    if (latestCleanup?.details?.finalStatus && latestCleanup.details.finalStatus !== 'completed') {
      return { ready: false, terminalStatus: latestCleanup.details.finalStatus, last };
    }
    const latestTerminalRunStatus = value.latestTerminalRunStatus;
    if (latestTerminalRunStatus) {
      return {
        ready: latestTerminalRunStatus.details?.nextStatus === 'completed' || latestTerminalRunStatus.details?.status === 'completed',
        terminalStatus: latestTerminalRunStatus.details?.nextStatus || latestTerminalRunStatus.details?.status,
        last,
      };
    }
    if (value.sendButtonLabel !== 'Cancel sending message' && value.sendButtonDisabled === false) {
      return { ready: true, last };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ready: false, last };
};

const finish = async (report) => {
  try {
    report.finalProbe = (await pilotEval(`
(async () => {
  const probe = window.__SEND_FLOW_PILOT_REPRO__;
  probe?.cleanup?.();
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return {
    probe: {
      label: probe?.label,
      startedAtIso: probe?.startedAtIso,
      sendResults: probe?.sendResults ?? [],
      graphDrags: probe?.graphDrags ?? [],
      samples: probe?.samples ?? [],
      longTasks: probe?.longTasks ?? [],
      intervalStalls: probe?.intervalStalls ?? [],
      rafStalls: probe?.rafStalls ?? [],
      chatMutations: probe?.chatMutations ?? [],
      maxIntervalGapMs: probe?.maxIntervalGapMs ?? null,
      maxRafGapMs: probe?.maxRafGapMs ?? null,
    },
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    perfEvents: window.__AGENTREE_PERF__?.readLatestSession?.() ?? [],
  };
})()
`, 120000)).value;
  } catch (error) {
    report.finishError = error.message;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
};

const main = async () => {
  const report = {
    label: LABEL,
    startedAt: new Date().toISOString(),
    prompts: PROMPTS.map((prompt) => ({ length: prompt.length, preview: prompt.slice(0, 120) })),
    setup: null,
    samples: [],
    drags: [],
    sends: [],
    waitResults: [],
    errors: [],
  };

  try {
    report.setup = (await setupProbe()).value;
    report.samples.push((await sample('loaded')).value);
    report.drags.push((await dragGraph('before-send')).value);

    for (let index = 0; index < PROMPTS.length; index += 1) {
      const sendIndex = index + 1;
      report.sends.push((await sendPrompt(PROMPTS[index], sendIndex)).value);
      report.samples.push((await sample(`send-${sendIndex}-clicked`)).value);
      report.drags.push((await dragGraph(`send-${sendIndex}-immediate-drag`)).value);
      const waitResult = await waitForReady(sendIndex, report.samples);
      report.waitResults.push({
        sendIndex,
        ready: waitResult.ready,
        terminalStatus: waitResult.terminalStatus ?? null,
        last: waitResult.last,
      });
      report.drags.push((await dragGraph(`send-${sendIndex}-after-ready-drag`)).value);
      if (!waitResult.ready) break;
      await sleep(500);
    }
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), message: error.message, stack: error.stack });
  }

  const reportPath = await finish(report);
  const maxEvalRoundTripMs = Math.max(0, ...report.samples.map((sample) => sample.evalRoundTripMs ?? 0));
  const maxRafGapMs = report.finalProbe?.probe?.maxRafGapMs ?? null;
  const maxIntervalGapMs = report.finalProbe?.probe?.maxIntervalGapMs ?? null;
  const exportPath = report.finalProbe?.exportStatus?.exportPath ?? null;
  console.log(JSON.stringify({
    reportPath,
    exportPath,
    sendsAttempted: report.sends.length,
    waitResults: report.waitResults.map(({ sendIndex, ready, last }) => ({
      sendIndex,
      ready,
      lastLabel: last?.label,
      lastButton: last?.sendButtonLabel,
      lastEvalRoundTripMs: last?.evalRoundTripMs,
      lastMaxRafGapMs: last?.maxRafGapMs,
      lastMaxIntervalGapMs: last?.maxIntervalGapMs,
    })),
    errors: report.errors.map((error) => error.message),
    maxEvalRoundTripMs,
    maxRafGapMs,
    maxIntervalGapMs,
    longTaskCount: report.finalProbe?.probe?.longTasks?.length ?? null,
    intervalStallCount: report.finalProbe?.probe?.intervalStalls?.length ?? null,
    rafStallCount: report.finalProbe?.probe?.rafStalls?.length ?? null,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
