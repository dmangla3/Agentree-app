import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPH_COMPOSER_OPEN_HELPERS_SOURCE } from './tauri-pilot-graph-composer-open-lib.mjs';

const WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WAIT_MS ?? 120000);
const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-graph-composer-open-${Date.now()}`;

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

await requirePilotCli();
await waitForPilot();

const result = (await pilotEval(`
(async () => {
  ${GRAPH_COMPOSER_OPEN_HELPERS_SOURCE}
  const helpers = window.__AGENTREE_GRAPH_COMPOSER_OPEN__;
  return await helpers.measureGraphComposerOpen({ waitMs: 3000 });
})()
`, 30000)).value;

const report = {
  label: LABEL,
  capturedAt: new Date().toISOString(),
  ...result,
  validation: {
    ok: typeof result?.composerVisibleMs === 'number' && result.composerVisibleMs <= 250,
    thresholdMs: 250,
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `${LABEL}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, report }, null, 2));

if (!report.validation.ok) {
  process.exitCode = 1;
}
