import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CHAT_HOT_PATH_HELPERS_SOURCE } from './tauri-pilot-chat-hot-path-lib.mjs';
import {
  recordClickFeedbackMetricsFromSample,
  validateClickFeedbackReport,
} from './tauri-pilot-click-feedback-lib.mjs';
import { writeCompactPilotReport } from './tauri-pilot-report-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-click-feedback-${Date.now()}`;
const THRESHOLD_MS = Number(process.env.AGENTREE_TAURI_PILOT_CLICK_FEEDBACK_THRESHOLD_MS ?? 300);
const WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_CLICK_FEEDBACK_WAIT_MS ?? 5000);
const PROMPT = process.env.AGENTREE_TAURI_PILOT_PROMPT ?? `Tauri Pilot click feedback ${LABEL}. Reply briefly.`;

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
        resolve({ value: stdout.trim() ? JSON.parse(stdout) : null, roundTripMs: Date.now() - startedAt });
      } catch (error) {
        reject(new Error(`failed to parse tauri-pilot JSON: ${error.message}\n${stdout}`));
      }
    });
    child.stdin.end(script);
  });
};

const installProbe = async () => pilotEval(`
(async () => {
  ${CHAT_HOT_PATH_HELPERS_SOURCE}
  const label = ${JSON.stringify(LABEL)};
  const prompt = ${JSON.stringify(PROMPT)};
  const waitMs = ${JSON.stringify(WAIT_MS)};
  const chatHotPath = window.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__;
  const recordClickFeedbackMetricsFromSample = ${recordClickFeedbackMetricsFromSample.toString()};
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const nowMs = () => performance.now();
  const elementLabel = (element) => (element?.getAttribute?.('aria-label') || element?.textContent || '').trim();
  const waitForStableAnimationFrames = ({ frames = 5, maxGapMs = 80, timeoutMs = 2500 } = {}) => new Promise((resolve) => {
    const startedAt = nowMs();
    let stableFrames = 0;
    let lastFrameAt = nowMs();
    let maxObservedGapMs = 0;
    const tick = () => {
      const current = nowMs();
      const gap = current - lastFrameAt;
      maxObservedGapMs = Math.max(maxObservedGapMs, gap);
      stableFrames = gap <= maxGapMs ? stableFrames + 1 : 0;
      lastFrameAt = current;
      if (stableFrames >= frames || current - startedAt >= timeoutMs) {
        resolve({
          stable: stableFrames >= frames,
          stableFrames,
          maxObservedGapMs: Number(maxObservedGapMs.toFixed(2)),
          elapsedMs: Number((current - startedAt).toFixed(2)),
        });
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
  const hasPromptVisible = () => {
    const chatRoot = document.querySelector('[data-radix-scroll-area-viewport]') ?? document.body;
    const chatText = chatRoot.innerText || chatRoot.textContent || '';
    return chatText.includes(label) || chatText.includes(prompt);
  };

  const probe = {
    label,
    promptLength: prompt.length,
    startedAt: new Date().toISOString(),
    metrics: {
      clickReturnMs: null,
      firstCancelMs: null,
      firstComposerClearedMs: null,
      firstPromptVisibleMs: null,
    },
    maxRafGapMs: 0,
    rafStalls: [],
    preClickStability: null,
    samples: [],
    errors: [],
    done: false,
  };
  window.__SEND_CLICK_FEEDBACK_PROBE__ = probe;

  const sampleDom = (sampleLabel, elapsedMs = null) => {
    const textareas = [...document.querySelectorAll('textarea')]
      .map((textarea, index) => ({
        index,
        testId: textarea.getAttribute('data-testid') || null,
        disabled: textarea.disabled,
        valueLength: textarea.value.length,
        valuePreview: textarea.value.slice(0, 80),
        visible: Boolean(textarea.offsetParent || textarea.getClientRects().length),
      }));
    const buttons = [...document.querySelectorAll('button')]
      .map((button, index) => ({
        index,
        testId: button.getAttribute('data-testid') || null,
        aria: button.getAttribute('aria-label') || null,
        text: (button.textContent || '').trim().slice(0, 80),
        disabled: button.disabled,
        visible: Boolean(button.offsetParent || button.getClientRects().length),
      }))
      .filter((button) => button.visible && (button.testId === 'chat-send-button' || button.aria === 'Send' || button.aria === 'Cancel sending message'));
    const sample = {
      label: sampleLabel,
      elapsedMs,
      hasFocus: document.hasFocus(),
      promptVisible: hasPromptVisible(),
      textareas,
      buttons,
    };
    probe.samples.push(sample);
    recordClickFeedbackMetricsFromSample(probe.metrics, sample);
  };

  try {
    await chatHotPath.ensureChatHotPathReady({ waitMs: 8000, requireSendButton: false });
    const textarea = chatHotPath.findComposer();
    if (!textarea) throw new Error('composer textarea not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, '');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    await sleep(50);
    setter?.call(textarea, prompt);
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(100);

    let sendButton = chatHotPath.findSendButton({ includeCancel: false });
    const readyStartedAt = nowMs();
    while (sendButton?.disabled && nowMs() - readyStartedAt < 3000) {
      await sleep(50);
      sendButton = chatHotPath.findSendButton({ includeCancel: false });
    }
    if (!sendButton) throw new Error('send button not found');
    if (sendButton.disabled) throw new Error('send button disabled before click');
    probe.preClickStability = await waitForStableAnimationFrames();
    sampleDom('before-click', 0);

    const clickStartedAt = nowMs();
    sendButton.click();
    probe.metrics.clickReturnMs = Number((nowMs() - clickStartedAt).toFixed(2));
    const observeStartedAt = nowMs();
    probe.documentHadFocusAtClick = document.hasFocus();
    sampleDom('after-click-return', probe.metrics.clickReturnMs);
    let lastRaf = nowMs();
    let rafId = 0;
    const rafLoop = () => {
      const current = nowMs();
      const gap = current - lastRaf;
      if (gap > probe.maxRafGapMs) probe.maxRafGapMs = Number(gap.toFixed(2));
      if (gap > 250) probe.rafStalls.push({ at: new Date().toISOString(), gapMs: Number(gap.toFixed(2)) });
      lastRaf = current;
      rafId = window.requestAnimationFrame(rafLoop);
    };
    rafId = window.requestAnimationFrame(rafLoop);

    await new Promise((resolve) => {
      const tick = () => {
        const current = nowMs();
        const elapsed = current - observeStartedAt;
        sampleDom('tick', Number(elapsed.toFixed(2)));
        const done = Object.values(probe.metrics).every((value) => typeof value === 'number');
        if (done || elapsed >= waitMs) {
          window.cancelAnimationFrame(rafId);
          const cancelButton = chatHotPath.findSendButton({ includeCancel: true });
          if (elementLabel(cancelButton) === 'Cancel sending message') cancelButton.click();
          probe.done = true;
          resolve();
          return;
        }
        window.setTimeout(tick, 16);
      };
      window.setTimeout(tick, 16);
    });
  } catch (error) {
    probe.errors.push({ at: new Date().toISOString(), message: String(error?.message || error), stack: error?.stack || null });
    probe.done = true;
  }

  return { label, url: location.href, done: probe.done, errors: probe.errors, metrics: probe.metrics };
})()
`, Math.max(60000, WAIT_MS + 10000));

const collectProbe = async () => pilotEval(`
(async () => {
  const probe = window.__SEND_CLICK_FEEDBACK_PROBE__;
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return {
    probe,
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
    perfEvents: window.__AGENTREE_PERF__?.readLatestSession?.() ?? [],
  };
})()
`, 60000);

const main = async () => {
  const report = {
    label: LABEL,
    thresholdMs: THRESHOLD_MS,
    startedAt: new Date().toISOString(),
    install: null,
    collect: null,
    validation: null,
    errors: [],
  };

  try {
    report.install = (await installProbe()).value;
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'install', message: error.message, stack: error.stack });
  }

  await sleep(500);

  try {
    report.collect = (await collectProbe()).value;
  } catch (error) {
    report.errors.push({ at: new Date().toISOString(), phase: 'collect', message: error.message, stack: error.stack });
  }

  const metrics = report.collect?.probe?.metrics ?? report.install?.metrics ?? {};
  report.validation = validateClickFeedbackReport(metrics, { thresholdMs: THRESHOLD_MS });

  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  const written = writeCompactPilotReport({ reportPath, report });

  const output = {
    reportPath,
    artifactDir: written.artifacts.length > 0 ? written.artifactDir : null,
    exportPath: report.collect?.exportStatus?.exportPath ?? null,
    thresholdMs: THRESHOLD_MS,
    metrics,
    validation: report.validation,
    errors: [
      ...report.errors.map((error) => error.message),
      ...(report.collect?.probe?.errors ?? []).map((error) => error.message),
    ],
    maxRafGapMs: report.collect?.probe?.maxRafGapMs ?? null,
    rafStallCount: report.collect?.probe?.rafStalls?.length ?? null,
  };
  console.log(JSON.stringify(output, null, 2));

  if (output.errors.length > 0 || !report.validation.ok) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
