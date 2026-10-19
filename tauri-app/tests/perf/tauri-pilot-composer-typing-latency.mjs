import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAT_HOT_PATH_HELPERS_SOURCE } from './tauri-pilot-chat-hot-path-lib.mjs';

const WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 120000);
const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-composer-typing-${Date.now()}`;
const TARGET = '[data-testid="chat-composer-textarea"]';
const TEST_TEXT = process.env.AGENTREE_TAURI_PILOT_TYPING_TEXT ?? [
  `Composer typing latency probe ${LABEL}. `,
  'This is ordinary prose typed into the input box without file mentions, slash commands, or paste shortcuts. ',
  'The measurement records per-character input completion and the next-frame delay in the real Tauri WebView.',
].join('');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execText = (cmd, args, options = {}) => new Promise((resolve, reject) => {
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

const requirePilotCli = async () => {
  try {
    await execText('tauri-pilot', ['--help']);
  } catch {
    throw new Error('tauri-pilot CLI is not available. Run `pnpm run pilot:install` first.');
  }
};

const waitForPilot = async () => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < WAIT_MS) {
    try {
      await execText('tauri-pilot', ['ping']);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for Tauri Pilot after ${WAIT_MS}ms: ${lastError?.stderr || lastError?.stdout || lastError?.message || 'no response'}`);
};

const pilotEval = async (script, timeoutMs = 30000) => {
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

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
};

const summarize = (events) => {
  const microtaskDelayMs = events
    .map((event) => event.microtaskDelayMs)
    .filter((value) => Number.isFinite(value));
  const nextRafDelayMs = events
    .map((event) => event.nextRafDelayMs)
    .filter((value) => Number.isFinite(value));
  return {
    inputEvents: events.length,
    microtaskDelayMs: {
      p50: percentile(microtaskDelayMs, 50),
      p95: percentile(microtaskDelayMs, 95),
      max: percentile(microtaskDelayMs, 100),
    },
    nextRafDelayMs: {
      p50: percentile(nextRafDelayMs, 50),
      p95: percentile(nextRafDelayMs, 95),
      max: percentile(nextRafDelayMs, 100),
    },
  };
};

const waitForComposer = async () => {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < WAIT_MS) {
    latest = (await pilotEval(`
(async () => {
  ${CHAT_HOT_PATH_HELPERS_SOURCE}
  const helpers = window.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__;
  await helpers.ensureChatHotPathReady({ waitMs: 5000, requireSendButton: false });
  const visible = helpers.visible;
  const textarea = helpers.findComposer();
  const bodyText = document.body?.innerText ?? '';
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    composerFound: Boolean(textarea),
    composerVisible: visible(textarea),
    composerDisabled: textarea ? textarea.disabled : null,
    textareaValueLength: textarea ? textarea.value.length : null,
    bodyTextSample: bodyText.slice(0, 500),
  };
})()
`, 30000)).value;

    if (
      (latest?.readyState === 'complete' || latest?.readyState === 'interactive') &&
      latest?.visibility === 'visible' &&
      latest?.composerFound &&
      latest?.composerVisible &&
      latest?.composerDisabled === false
    ) {
      return latest;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for enabled composer after ${WAIT_MS}ms: ${JSON.stringify(latest)}`);
};

const installProbe = async () => (await pilotEval(`
(async () => {
  ${CHAT_HOT_PATH_HELPERS_SOURCE}
  const helpers = window.__AGENTREE_TAURI_PILOT_CHAT_HOT_PATH__;
  await helpers.ensureChatHotPathReady({ waitMs: 5000, requireSendButton: false });
  const target = ${JSON.stringify(TARGET)};
  const textarea = helpers.findComposer();
  if (!textarea) throw new Error('composer textarea not found');
  if (textarea.disabled) throw new Error('composer textarea is disabled');

  window.__AGENTREE_COMPOSER_TYPING_PROBE__?.cleanup?.();

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, '');
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.focus();

  const probe = {
    label: ${JSON.stringify(LABEL)},
    target,
    startedAt: performance.now(),
    startedAtIso: new Date().toISOString(),
    inputEvents: [],
    longTasks: [],
    rafGaps: [],
    intervalGaps: [],
    maxRafGapMs: 0,
    maxIntervalGapMs: 0,
    cleanup: null,
  };

  let longTaskObserver = null;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        probe.longTasks.push({
          name: entry.name,
          startTime: Number(entry.startTime.toFixed(2)),
          durationMs: Number(entry.duration.toFixed(2)),
        });
      }
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    longTaskObserver = null;
  }

  let expectedInterval = performance.now() + 25;
  const intervalId = window.setInterval(() => {
    const now = performance.now();
    const gap = now - expectedInterval;
    if (gap > probe.maxIntervalGapMs) probe.maxIntervalGapMs = Number(gap.toFixed(2));
    if (gap > 50) probe.intervalGaps.push({ atMs: Number((now - probe.startedAt).toFixed(2)), gapMs: Number(gap.toFixed(2)) });
    expectedInterval = now + 25;
  }, 25);

  let lastRaf = performance.now();
  let rafId = 0;
  const rafLoop = () => {
    const now = performance.now();
    const gap = now - lastRaf;
    if (gap > probe.maxRafGapMs) probe.maxRafGapMs = Number(gap.toFixed(2));
    if (gap > 50) probe.rafGaps.push({ atMs: Number((now - probe.startedAt).toFixed(2)), gapMs: Number(gap.toFixed(2)) });
    lastRaf = now;
    rafId = window.requestAnimationFrame(rafLoop);
  };
  rafId = window.requestAnimationFrame(rafLoop);

  const onInputCapture = (event) => {
    const at = performance.now();
    const record = {
      index: probe.inputEvents.length,
      atMs: Number((at - probe.startedAt).toFixed(2)),
      eventTimeStampMs: Number(event.timeStamp.toFixed(2)),
      dataLength: typeof event.data === 'string' ? event.data.length : null,
      inputType: event.inputType || null,
      valueLength: textarea.value.length,
      microtaskDelayMs: null,
      nextRafDelayMs: null,
    };
    probe.inputEvents.push(record);
    queueMicrotask(() => {
      record.microtaskDelayMs = Number((performance.now() - at).toFixed(2));
    });
    window.requestAnimationFrame(() => {
      record.nextRafDelayMs = Number((performance.now() - at).toFixed(2));
    });
  };
  textarea.addEventListener('input', onInputCapture, true);

  probe.cleanup = () => {
    textarea.removeEventListener('input', onInputCapture, true);
    window.clearInterval(intervalId);
    window.cancelAnimationFrame(rafId);
    longTaskObserver?.disconnect?.();
  };

  window.__AGENTREE_COMPOSER_TYPING_PROBE__ = {
    cleanup: probe.cleanup,
    read: () => ({
      ...probe,
      elapsedMs: Number((performance.now() - probe.startedAt).toFixed(2)),
      valueLength: textarea.value.length,
      valueTail: textarea.value.slice(-80),
      cleanup: undefined,
    }),
  };

  return {
    installed: true,
    focused: document.activeElement === textarea,
    disabled: textarea.disabled,
    valueLength: textarea.value.length,
  };
})()
`, 30000)).value;

const collectProbe = async () => (await pilotEval(`
(() => {
  const probe = window.__AGENTREE_COMPOSER_TYPING_PROBE__;
  if (!probe) throw new Error('composer typing probe not installed');
  const report = probe.read();
  probe.cleanup?.();
  return report;
})()
`, 30000)).value;

const syntheticTypeWithPilotEval = async (text) => (await pilotEval(`
(async () => {
  const target = ${JSON.stringify(TARGET)};
  const text = ${JSON.stringify(text)};
  const textarea = document.querySelector(target);
  if (!textarea) throw new Error('composer textarea not found');
  if (textarea.disabled) throw new Error('composer textarea is disabled');

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('HTMLTextAreaElement value setter not found');

  textarea.focus();
  const startedAt = performance.now();
  for (const char of text) {
    setter.call(textarea, textarea.value + char);
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: char,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  return {
    mode: 'tauri-pilot-eval-synthetic-input',
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
    valueLength: textarea.value.length,
  };
})()
`, 120000)).value;

const main = async () => {
  await requirePilotCli();
  await waitForPilot();
  const initialProbe = await waitForComposer();
  const installResult = await installProbe();

  const clickStartedAt = Date.now();
  await execText('tauri-pilot', ['click', TARGET]);
  const clickMs = Date.now() - clickStartedAt;

  const typeStartedAt = Date.now();
  let typeMode = 'tauri-pilot-type';
  let typeFallbackError = null;
  let syntheticTypeResult = null;
  try {
    await execText('tauri-pilot', ['type', TARGET, TEST_TEXT]);
  } catch (error) {
    typeMode = 'tauri-pilot-eval-synthetic-input';
    typeFallbackError = error?.stderr || error?.stdout || error?.message || String(error);
    syntheticTypeResult = await syntheticTypeWithPilotEval(TEST_TEXT);
  }
  const typeMs = Date.now() - typeStartedAt;

  await sleep(500);
  const probe = await collectProbe();
  const summary = {
    ...summarize(probe.inputEvents),
    typedCharacters: TEST_TEXT.length,
    finalValueLength: probe.valueLength,
    cliClickMs: clickMs,
    cliTypeMs: typeMs,
    cliTypeMsPerChar: Number((typeMs / Math.max(TEST_TEXT.length, 1)).toFixed(2)),
    typeMode,
    syntheticTypeDurationMs: syntheticTypeResult?.durationMs ?? null,
    maxRafGapMs: probe.maxRafGapMs,
    maxIntervalGapMs: probe.maxIntervalGapMs,
    longTasks: probe.longTasks.length,
    rafGapsOver50Ms: probe.rafGaps.length,
    intervalGapsOver50Ms: probe.intervalGaps.length,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    label: LABEL,
    capturedAt: new Date().toISOString(),
    target: TARGET,
    testTextLength: TEST_TEXT.length,
    initialProbe,
    installResult,
    typeFallbackError,
    syntheticTypeResult,
    summary,
    probe,
  };
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (summary.inputEvents < TEST_TEXT.length) {
    throw new Error(`Expected at least ${TEST_TEXT.length} input events, captured ${summary.inputEvents}. Report: ${reportPath}`);
  }
  if (summary.finalValueLength !== TEST_TEXT.length) {
    throw new Error(`Expected final textarea length ${TEST_TEXT.length}, got ${summary.finalValueLength}. Report: ${reportPath}`);
  }

  console.log(JSON.stringify({ ok: true, reportPath, summary }, null, 2));
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
