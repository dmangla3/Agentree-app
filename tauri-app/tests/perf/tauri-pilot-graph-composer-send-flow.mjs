import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPH_COMPOSER_OPEN_HELPERS_SOURCE } from './tauri-pilot-graph-composer-open-lib.mjs';

const WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 120000);
const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-graph-composer-send-${Date.now()}`;
const MARKER = process.env.AGENTREE_TAURI_PILOT_MARKER ?? `graph-send-${LABEL.split('-').at(-1)}`;
const PROMPT = process.env.AGENTREE_TAURI_PILOT_PROMPT ?? `Graph dock send smoke ${MARKER}. Reply exactly: OK.`;

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
    throw new Error('tauri-pilot CLI is not available. Run `npm run pilot:install` first.');
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

await requirePilotCli();
await waitForPilot();

const setup = (await pilotEval(`
(async () => {
  ${GRAPH_COMPOSER_OPEN_HELPERS_SOURCE}

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const prompt = ${JSON.stringify(PROMPT)};
  const marker = ${JSON.stringify(MARKER)};
  const label = ${JSON.stringify(LABEL)};
  const helpers = window.__AGENTREE_GRAPH_COMPOSER_OPEN__;
  const startedAt = performance.now();

  const visibleText = () => document.body?.innerText || '';
  const graphNodeCount = () => document.querySelectorAll('.react-flow__node').length;
  const findSendButton = () => document.querySelector('[data-testid="graph-dock-send-button"]');
  const setTextareaValue = (textarea, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  };

  await helpers.ensureGraphOnlyMode();
  const before = {
    bodyTextLength: visibleText().length,
    graphNodeCount: graphNodeCount(),
    hasGraphComposer: Boolean(document.querySelector('[data-testid="graph-dock-composer"]')),
  };

  const openProbe = await helpers.measureGraphComposerOpen({ waitMs: 2000 });
  const textarea = helpers.findComposer();
  if (!textarea) throw new Error('Graph dock composer textarea not found after opening.');

  setTextareaValue(textarea, prompt);

  const sendReadyStartedAt = performance.now();
  let sendButton = findSendButton();
  while (performance.now() - sendReadyStartedAt < 3000) {
    sendButton = findSendButton();
    if (sendButton && !sendButton.disabled) break;
    await sleep(16);
  }
  if (!sendButton || sendButton.disabled) {
    throw new Error('Graph dock send button did not become enabled.');
  }

  const clickedAt = performance.now();
  sendButton.click();
  const clickReturnMs = Number((performance.now() - clickedAt).toFixed(2));

  return {
    label,
    marker,
    prompt,
    startedAt,
    openProbe,
    clickReturnMs,
    before,
  };
})()
`, 9000)).value;

let textareaClearedMs = null;
let markerVisibleMs = null;
let after = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(1000);
  after = (await pilotEval(`
(() => {
  ${GRAPH_COMPOSER_OPEN_HELPERS_SOURCE}
  const marker = ${JSON.stringify(MARKER)};
  const startedAt = ${JSON.stringify(setup.startedAt)};
  const helpers = window.__AGENTREE_GRAPH_COMPOSER_OPEN__;
  const visibleText = () => document.body?.innerText || '';
  const graphNodeCount = () => document.querySelectorAll('.react-flow__node').length;
  const findSendButton = () => document.querySelector('[data-testid="graph-dock-send-button"]');
  const currentTextarea = helpers.findComposer();
  const composer = document.querySelector('[data-testid="graph-dock-composer"]');
  const composerText = composer?.innerText || '';
  const bodyText = visibleText();
  const elapsed = Number((performance.now() - startedAt).toFixed(2));
  return {
    elapsed,
    bodyTextLength: bodyText.length,
    graphNodeCount: graphNodeCount(),
    hasMarkerInDom: bodyText.includes(marker),
    hasGraphComposer: Boolean(composer),
    textareaValueLength: currentTextarea?.value.length ?? null,
    textareaClearedOrGone: !currentTextarea || currentTextarea.value.length === 0,
    sendButtonDisabled: findSendButton()?.disabled ?? null,
    errorText: /Select an agent|No base commit|Failed to send|required|status code 400/i.test(composerText) ? composerText : null,
    statusText: bodyText.match(/(Sending|Starting[^\\n]*|running|pending|failed|completed)/i)?.[0] ?? null,
  };
})()
  `, 9000)).value;

  if (textareaClearedMs === null && after.textareaClearedOrGone) {
    textareaClearedMs = after.elapsed;
  }
  if (markerVisibleMs === null && after.hasMarkerInDom) {
    markerVisibleMs = after.elapsed;
  }
  if (after.errorText || (textareaClearedMs !== null && markerVisibleMs !== null)) break;
}

const result = {
  ...setup,
  textareaClearedMs,
  markerVisibleMs,
  after,
};

const report = {
  label: LABEL,
  capturedAt: new Date().toISOString(),
  ...result,
  validation: {
    ok: result?.after?.hasMarkerInDom === true &&
      typeof result?.textareaClearedMs === 'number' &&
      !result?.after?.errorText,
    requiresMarkerInDom: true,
    requiresTextareaClear: true,
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `${LABEL}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, report }, null, 2));

if (!report.validation.ok) {
  process.exitCode = 1;
}
