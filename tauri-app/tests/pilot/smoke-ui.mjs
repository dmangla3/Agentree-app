import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 120000);
const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `pilot-smoke-${Date.now()}`;

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
  } catch (error) {
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

const readProbe = async () => (await pilotEval(`
(() => {
  const visible = (element) => Boolean(element && (element.offsetParent || element.getClientRects().length));
  const composer = document.querySelector('[data-testid="chat-composer-textarea"]')
    || [...document.querySelectorAll('textarea')].find(visible)
    || null;
  const sendButton = document.querySelector('[data-testid="chat-send-button"]')
    || [...document.querySelectorAll('button')].find((button) => {
      const label = button.getAttribute('aria-label') || button.textContent || '';
      return /send|run/i.test(label);
    })
    || null;
  const bodyText = document.body?.innerText ?? '';
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    bodyTextSample: bodyText.slice(0, 500),
    isInitialLoading: /Loading Agentree/i.test(bodyText),
    hasLoginUi: /sign in|log in|continue/i.test(bodyText),
    hasErrorUi: /error loading|failed to load|something went wrong/i.test(bodyText),
    composerFound: Boolean(composer),
    composerVisible: visible(composer),
    sendButtonFound: Boolean(sendButton),
    graphNodeCount: document.querySelectorAll('.react-flow__node,[data-agentree-graph-node-id]').length,
    buttonCount: document.querySelectorAll('button').length,
    textareaCount: document.querySelectorAll('textarea').length,
  };
})()
`, 30000)).value;

const waitForUiReady = async () => {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < WAIT_MS) {
    latest = await readProbe();
    const documentReady = latest?.readyState === 'complete' || latest?.readyState === 'interactive';
    const visible = latest?.visibility === 'visible';
    const focused = latest?.hasFocus === true;
    const appLoaded = !latest?.isInitialLoading && (
      latest?.composerFound ||
      latest?.hasLoginUi ||
      latest?.buttonCount > 0 ||
      latest?.hasErrorUi
    );
    if (documentReady && visible && focused && appLoaded) {
      return latest;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for Agentree UI to leave loading state after ${WAIT_MS}ms: ${JSON.stringify(latest)}`);
};

const main = async () => {
  await requirePilotCli();
  await waitForPilot();

  const stateText = await execText('tauri-pilot', ['--json', 'state']);
  const state = stateText.trim() ? JSON.parse(stateText) : null;
  const probe = await waitForUiReady();

  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    label: LABEL,
    capturedAt: new Date().toISOString(),
    state,
    probe,
  };
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (probe?.readyState !== 'complete' && probe?.readyState !== 'interactive') {
    throw new Error(`App document is not ready: ${JSON.stringify(probe)}`);
  }
  if (probe?.visibility !== 'visible') {
    throw new Error(`App webview is not visible to Pilot: ${JSON.stringify(probe)}`);
  }
  if (probe?.hasFocus !== true) {
    throw new Error(`App webview is not focused to Pilot: ${JSON.stringify(probe)}`);
  }
  if (probe?.isInitialLoading) {
    throw new Error(`App is still on initial loading screen: ${JSON.stringify(probe)}`);
  }

  console.log(JSON.stringify({ ok: true, reportPath, state, probe }, null, 2));
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
