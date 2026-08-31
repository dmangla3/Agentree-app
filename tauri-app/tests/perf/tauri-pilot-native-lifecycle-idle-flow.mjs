import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeRuntimeStallsByPhase } from '../../scripts/perf-latest-summary-lib.mjs';

const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-native-lifecycle-idle-${Date.now()}`;
const CHILD_SCRIPT = './tests/perf/tauri-pilot-staggered-parent-parallel-flow.mjs';

const parseChildSummary = (stdout) => {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf('\n{');
    if (start === -1) return null;
    return JSON.parse(trimmed.slice(start + 1));
  }
};

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

const assertVisibleWebView = () => {
  const script = '(() => ({ visibility: document.visibilityState, hasFocus: document.hasFocus(), url: location.href }))()';
  const result = spawnSync('tauri-pilot', ['eval', '--json', '-'], {
    cwd: process.cwd(),
    input: script,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`native lifecycle preflight failed: ${result.stderr || result.stdout}`);
  }
  const state = JSON.parse(result.stdout || '{}');
  if (state.visibility !== 'visible' || state.hasFocus !== true) {
    throw new Error(`native lifecycle preflight failed: WebView must be visible and focused for RAF sampling, got ${JSON.stringify(state)}`);
  }
  return state;
};

const resolveExportPath = (summary, report) => {
  const explicitPath = summary.exportPath ?? report.collect?.exportStatus?.exportPath ?? null;
  if (explicitPath) return explicitPath;
  const sessionId = report.collect?.exportStatus?.sessionId ?? null;
  if (!sessionId) return null;
  const fallbackPath = join(process.cwd(), 'runtime-logs', 'perf-captures', sessionId);
  const eventsPath = join(fallbackPath, 'perf-events.json');
  const waitUntil = Date.now() + 10000;
  while (!existsSync(eventsPath) && Date.now() < waitUntil) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return existsSync(eventsPath) ? fallbackPath : null;
};

const main = () => {
  const visibilityPreflight = assertVisibleWebView();
  const env = {
    ...process.env,
    AGENTREE_TAURI_PILOT_LABEL: LABEL,
    AGENTREE_TAURI_PILOT_DISABLE_GRAPH_INTERACTIONS: 'true',
    AGENTREE_TAURI_PILOT_GRAPH_INTERACTIONS_DURING_LAUNCH: 'false',
    AGENTREE_TAURI_PILOT_SKIP_CONVERGENCE_COLLECTION: 'true',
    AGENTREE_TAURI_PILOT_PROMPTS: process.env.AGENTREE_TAURI_PILOT_PROMPTS ?? JSON.stringify([
      `Native lifecycle idle isolation ${LABEL} run 1. Reply with two concise paragraphs. Do not edit files.`,
      `Native lifecycle idle isolation commit run ${LABEL}. Create or update exactly one file named docs/tauri-pilot-native-lifecycle-${LABEL}.md with two short lines that include this label, commit that file change, and finish normally.`,
      `Native lifecycle idle isolation ${LABEL} run 3. Reply with a concise terminal-status checklist. Do not edit files.`,
    ]),
  };

  const child = spawnSync(process.execPath, [CHILD_SCRIPT], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (child.stderr) process.stderr.write(child.stderr);

  const childSummary = parseChildSummary(child.stdout || '');
  if (!childSummary?.reportPath) {
    if (child.stdout) process.stdout.write(child.stdout);
    process.exitCode = child.status ?? 1;
    return;
  }

  const report = readJson(childSummary.reportPath);
  const exportPath = resolveExportPath(childSummary, report);
  const perfEvents = exportPath ? readJson(join(exportPath, 'perf-events.json')) : [];
  const phaseBuckets = summarizeRuntimeStallsByPhase(perfEvents);
  report.collect ??= {};
  report.collect.nativeLifecycleIsolation = {
    mode: 'native-lifecycle-idle',
    graphInteractionsDisabled: true,
    graphInteractionsDuringLaunch: false,
    convergenceCollectionSkipped: true,
    visibilityPreflight,
    phaseBuckets,
  };
  writeFileSync(childSummary.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    ...childSummary,
    exportPath,
    isolationMode: 'native-lifecycle-idle',
    phaseBuckets,
  }, null, 2));

  process.exitCode = child.status ?? 0;
};

main();
