import { execFile, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCompactPilotReport } from '../perf/tauri-pilot-report-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `pilot-graph-node-hover-${Date.now()}`;

const argValue = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
};

const hasFlag = (name) => process.argv.includes(name);

const NODE_ID = argValue('--node-id') ?? process.argv[2];
const DURATION_MS = Number(argValue('--duration-ms', process.env.AGENTREE_TAURI_PILOT_HOVER_DURATION_MS ?? 8000));
const INTERVAL_MS = Number(argValue('--interval-ms', process.env.AGENTREE_TAURI_PILOT_HOVER_INTERVAL_MS ?? 200));
const MOVE_THRESHOLD_PX = Number(argValue('--move-threshold-px', process.env.AGENTREE_TAURI_PILOT_HOVER_MOVE_THRESHOLD_PX ?? 24));
const REAL_HOVER = !hasFlag('--no-real-hover');
const DIRECT_HOVER = !hasFlag('--no-direct-hover');
const ASSERT_STABLE = hasFlag('--assert-stable');
const FAIL_ON_LAYOUT = hasFlag('--fail-on-layout');

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

const requirePilotCli = async () => {
  try {
    await execText('tauri-pilot', ['--help']);
  } catch {
    throw new Error('tauri-pilot CLI is not available. Run `npm run pilot:install` first.');
  }
};

const selectorForNodeId = (nodeId) => `[data-agentree-graph-node-id="${String(nodeId).replace(/["\\]/g, '\\$&')}"]`;

const installProbe = async () => (await pilotEval(`
(() => {
  const nodeId = ${JSON.stringify(NODE_ID)};
  const intervalMs = ${JSON.stringify(INTERVAL_MS)};
  if (!window.__agentreeDebug?.installGraphNodeProbe) {
    throw new Error('window.__agentreeDebug.installGraphNodeProbe is unavailable. Start the dev Tauri app and reload after this change.');
  }
  return window.__agentreeDebug.installGraphNodeProbe(nodeId, { intervalMs });
})()
`)).value;

const readProbe = async () => (await pilotEval(`
(() => window.__agentreeDebug?.readGraphNodeProbe?.() ?? null)()
`, 30000)).value;

const clearProbe = async () => {
  await pilotEval(`(() => window.__agentreeDebug?.clearGraphNodeProbe?.())()`, 15000);
};

const directHover = async () => (await pilotEval(`
(() => {
  const nodeId = ${JSON.stringify(NODE_ID)};
  const escaped = CSS.escape(nodeId);
  const node = document.querySelector('[data-agentree-graph-node-id="' + escaped + '"]')?.closest('.react-flow__node')
    || document.querySelector('.react-flow__node[data-id="' + escaped + '"]')
    || document.querySelector('[data-agentree-graph-node-id="' + escaped + '"]');
  if (!node) return { ok: false, reason: 'node-not-found' };
  const rect = node.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  };
  const fired = [];
  for (const target of [node, ...node.querySelectorAll('*')].slice(0, 12)) {
    const reactPropsKey = Object.keys(target).find((key) => key.startsWith('__reactProps$'));
    const props = reactPropsKey ? target[reactPropsKey] : null;
    for (const [name, factory] of [
      ['onPointerEnter', () => new PointerEvent('pointerenter', eventInit)],
      ['onMouseEnter', () => new MouseEvent('mouseenter', eventInit)],
      ['onMouseMove', () => new MouseEvent('mousemove', eventInit)],
    ]) {
      if (typeof props?.[name] === 'function') {
        props[name](factory());
        fired.push(name);
      }
    }
  }
  node.dispatchEvent(new PointerEvent('pointerover', eventInit));
  node.dispatchEvent(new PointerEvent('pointerenter', eventInit));
  node.dispatchEvent(new MouseEvent('mouseover', eventInit));
  node.dispatchEvent(new MouseEvent('mouseenter', eventInit));
  node.dispatchEvent(new MouseEvent('mousemove', eventInit));
  return { ok: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, fired };
})()
`, 30000)).value;

const realHover = async () => {
  const selector = selectorForNodeId(NODE_ID);
  try {
    const stdout = await execText('tauri-pilot', ['hover', selector, '--duration', String(Math.min(DURATION_MS, 3000))], {
      timeout: Math.max(10000, DURATION_MS + 5000),
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return {
      ok: false,
      message: error?.stderr || error?.stdout || error?.message || String(error),
    };
  }
};

const summarizeProbe = (probe) => {
  const samples = (probe?.events ?? []).filter((event) => event?.type === 'sample');
  const firstPresent = samples.find((sample) => sample.present && sample.rect);
  const firstRect = firstPresent?.rect ?? null;
  let maxMovePx = 0;
  let absentCount = 0;
  let invisibleCount = 0;
  const rectTransitions = [];
  let previousRectKey = null;
  let previousHoverCount = null;
  const hoverCardTransitions = [];

  for (const sample of samples) {
    if (!sample.present) absentCount += 1;
    if (
      sample.present &&
      (sample.style?.display === 'none' || sample.style?.visibility === 'hidden' || Number(sample.style?.opacity) === 0)
    ) {
      invisibleCount += 1;
    }
    if (firstRect && sample.rect) {
      maxMovePx = Math.max(maxMovePx, Math.abs(sample.rect.x - firstRect.x), Math.abs(sample.rect.y - firstRect.y));
    }
    const rectKey = sample.rect
      ? `${Math.round(sample.rect.x)},${Math.round(sample.rect.y)},${Math.round(sample.rect.width)},${Math.round(sample.rect.height)},${sample.style?.transform ?? ''}`
      : 'missing';
    if (rectKey !== previousRectKey) {
      rectTransitions.push({
        elapsedMs: sample.elapsedMs,
        reason: sample.reason,
        present: sample.present,
        rect: sample.rect,
        transform: sample.style?.transform ?? null,
        topElementAtCenter: sample.topElementAtCenter,
      });
      previousRectKey = rectKey;
    }
    if (sample.hoverCardCount !== previousHoverCount) {
      hoverCardTransitions.push({
        elapsedMs: sample.elapsedMs,
        hoverCardCount: sample.hoverCardCount,
        hoverCardText: sample.hoverCardText,
      });
      previousHoverCount = sample.hoverCardCount;
    }
  }

  const graphLayoutEvents = (probe?.perfEvents ?? []).filter((event) => event?.name === 'graph.layout.attribution');
  const consoleErrors = (probe?.events ?? []).filter((event) => event?.type === 'console' && event.level === 'error');
  const runtimeErrors = (probe?.events ?? []).filter((event) => event?.type === 'runtime-error');

  return {
    sampleCount: samples.length,
    absentCount,
    invisibleCount,
    maxMovePx: Number(maxMovePx.toFixed(2)),
    graphLayoutEventCount: graphLayoutEvents.length,
    consoleErrorCount: consoleErrors.length,
    runtimeErrorCount: runtimeErrors.length,
    rectTransitions: rectTransitions.slice(0, 60),
    hoverCardTransitions: hoverCardTransitions.slice(0, 40),
  };
};

const stabilityFailures = (summary) => {
  const failures = [];
  if (summary.absentCount > 0) failures.push(`node missing in ${summary.absentCount} samples`);
  if (summary.invisibleCount > 0) failures.push(`node invisible in ${summary.invisibleCount} samples`);
  if (summary.maxMovePx > MOVE_THRESHOLD_PX) failures.push(`node moved ${summary.maxMovePx}px, threshold ${MOVE_THRESHOLD_PX}px`);
  if (summary.consoleErrorCount > 0) failures.push(`${summary.consoleErrorCount} console errors`);
  if (summary.runtimeErrorCount > 0) failures.push(`${summary.runtimeErrorCount} runtime errors`);
  if (FAIL_ON_LAYOUT && summary.graphLayoutEventCount > 0) failures.push(`${summary.graphLayoutEventCount} graph layout attribution events`);
  return failures;
};

const usage = () => {
  console.error([
    'Usage: npm run pilot:graph-node-hover -- --node-id <id> [--duration-ms 8000] [--assert-stable]',
    '       node ./tests/pilot/graph-node-hover-probe.mjs <id> [--no-real-hover] [--no-direct-hover]',
  ].join('\n'));
};

const main = async () => {
  if (!NODE_ID) {
    usage();
    process.exit(2);
  }
  await requirePilotCli();

  const stateText = await execText('tauri-pilot', ['--json', 'state']);
  const state = stateText.trim() ? JSON.parse(stateText) : null;
  const install = await installProbe();
  const before = await readProbe();
  const actions = [];

  if (DIRECT_HOVER) {
    actions.push({ type: 'direct-hover', result: await directHover() });
  }
  if (REAL_HOVER) {
    actions.push({ type: 'real-hover', result: await realHover() });
  }

  await sleep(DURATION_MS);
  const after = await readProbe();
  const summary = summarizeProbe(after);
  const failures = ASSERT_STABLE ? stabilityFailures(summary) : [];
  const report = {
    label: LABEL,
    capturedAt: new Date().toISOString(),
    nodeId: NODE_ID,
    durationMs: DURATION_MS,
    intervalMs: INTERVAL_MS,
    moveThresholdPx: MOVE_THRESHOLD_PX,
    assertStable: ASSERT_STABLE,
    failOnLayout: FAIL_ON_LAYOUT,
    state,
    install,
    before,
    actions,
    after,
    summary,
    failures,
  };

  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  const written = writeCompactPilotReport({
    reportPath,
    report,
    limits: { perfEvents: 200, samples: 80, actions: 80 },
  });
  writeFileSync(join(OUT_DIR, `${LABEL}.summary.json`), `${JSON.stringify({ reportPath, summary, failures }, null, 2)}\n`, 'utf8');
  await clearProbe();

  const result = { ok: failures.length === 0, reportPath: written.reportPath, artifactDir: written.artifactDir, summary, failures };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) {
    process.exit(1);
  }
};

main().catch(async (error) => {
  try {
    await clearProbe();
  } catch {
    // Best effort cleanup only.
  }
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
