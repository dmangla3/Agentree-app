import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeCompactPilotReport } from './tauri-pilot-report-lib.mjs';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-workspace-switch-${Date.now()}`;
const WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_WORKSPACE_SWITCH_WAIT_MS ?? 15000);

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

const installAndRunProbe = async () => pilotEval(`
(async () => {
  const label = ${JSON.stringify(LABEL)};
  const waitMs = ${JSON.stringify(WAIT_MS)};
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const nowMs = () => performance.now();
  const events = () => window.__AGENTREE_PERF__?.readLatestSession?.() ?? [];
  const textIncludesLoading = () => (document.body?.innerText ?? '').includes('Loading thread index');
  const queryWorkspaceButtons = () => [...document.querySelectorAll('[data-workspace-select-button]')];
  const summarizeWorkspaceButtons = () => queryWorkspaceButtons().map((button) => ({
    id: button.getAttribute('data-workspace-id'),
    selected: button.getAttribute('data-workspace-selected') === 'true',
    label: button.getAttribute('aria-label') || button.textContent?.trim() || '',
    visible: Boolean(button.offsetParent || button.getClientRects().length),
  }));
  const relevantEvent = (event) => (
    String(event?.name || '').startsWith('query.workspace-switch.') ||
    String(event?.name || '').startsWith('query.local-nodes.') ||
    String(event?.name || '').startsWith('query.thread-sessions.') ||
    String(event?.name || '').startsWith('query.local-commit-graph.') ||
    String(event?.name || '').startsWith('query.messages.') ||
    String(event?.name || '').startsWith('query.graph-snapshot.') ||
    String(event?.name || '').startsWith('graph.data-ready') ||
    String(event?.name || '').startsWith('graph.first-content-render') ||
    String(event?.name || '').startsWith('runtime.') ||
    event?.name === 'browser.long-task'
  );
  const round = (value) => typeof value === 'number' && Number.isFinite(value)
    ? Number(value.toFixed(2))
    : value;

  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);

  const workspaceStoreModule = await import(new URL('/src/stores/workspaceStore.ts', location.origin).href);
  const useWorkspaceStore = workspaceStoreModule.useWorkspaceStore;
  const beforeImportedStoreWorkspaceId = useWorkspaceStore.getState().selectedWorkspaceId ?? null;

  const collapsedRepoTriggers = [...document.querySelectorAll('[data-repo-trigger][aria-expanded="false"]')];
  for (const trigger of collapsedRepoTriggers) {
    trigger.click();
    await sleep(25);
  }

  const beforeButtons = summarizeWorkspaceButtons();
  const beforeSelectedWorkspaceId = beforeButtons.find((button) => button.selected)?.id ?? beforeImportedStoreWorkspaceId;
  const targetButton = queryWorkspaceButtons().find((button) => {
    const workspaceId = button.getAttribute('data-workspace-id');
    return workspaceId && workspaceId !== beforeSelectedWorkspaceId;
  });
  if (!targetButton) {
    throw new Error('workspace switch probe requires at least two visible workspace rows: ' + JSON.stringify(beforeButtons));
  }
  const targetWorkspaceId = targetButton.getAttribute('data-workspace-id');
  const targetLabel = targetButton.getAttribute('aria-label') || targetButton.textContent?.trim() || targetWorkspaceId;
  const loadingBeforeClick = textIncludesLoading();

  const clickStartedAt = nowMs();
  targetButton.click();
  const clickReturnMs = nowMs() - clickStartedAt;

  let selectedEvent = null;
  let readyEvent = null;
  let loadingFirstVisibleMs = null;
  let loadingGoneMs = null;
  let selectedImportedStoreMs = null;
  let selectedDomMs = null;
  let readyEventSeenAtMs = null;
  let maxRafGapMs = 0;
  const rafStalls = [];
  let lastRafAt = nowMs();
  let rafId = 0;
  const rafLoop = () => {
    const current = nowMs();
    const gap = current - lastRafAt;
    maxRafGapMs = Math.max(maxRafGapMs, gap);
    if (gap >= 250) rafStalls.push({ elapsedMs: round(current - clickStartedAt), gapMs: round(gap) });
    lastRafAt = current;
    rafId = window.requestAnimationFrame(rafLoop);
  };
  rafId = window.requestAnimationFrame(rafLoop);

  const startedObserveAt = nowMs();
  while (nowMs() - startedObserveAt < waitMs) {
    const elapsed = nowMs() - clickStartedAt;
    const loadingVisible = textIncludesLoading();
    if (loadingVisible && loadingFirstVisibleMs === null) loadingFirstVisibleMs = elapsed;
    if (loadingFirstVisibleMs !== null && !loadingVisible && loadingGoneMs === null) loadingGoneMs = elapsed;
    if (selectedImportedStoreMs === null && useWorkspaceStore.getState().selectedWorkspaceId === targetWorkspaceId) {
      selectedImportedStoreMs = elapsed;
    }
    const selectedButton = document.querySelector('[data-workspace-select-button][data-workspace-selected="true"]');
    if (selectedDomMs === null && selectedButton?.getAttribute('data-workspace-id') === targetWorkspaceId) {
      selectedDomMs = elapsed;
    }
    const currentEvents = events();
    selectedEvent = currentEvents.find((event) => event.name === 'query.workspace-switch.selected' && event.details?.toWorkspaceId === targetWorkspaceId) ?? selectedEvent;
    readyEvent = currentEvents.find((event) => event.name === 'query.workspace-switch.thread-navigation-ready' && event.details?.workspaceId === targetWorkspaceId) ?? readyEvent;
    if (readyEvent && readyEventSeenAtMs === null) readyEventSeenAtMs = elapsed;
    const settledAfterReady = readyEventSeenAtMs !== null && elapsed - readyEventSeenAtMs >= 500;
    const settledAfterLoadingGone = loadingGoneMs !== null && elapsed - loadingGoneMs >= 500;
    if (settledAfterLoadingGone || (loadingFirstVisibleMs === null && settledAfterReady)) break;
    await sleep(50);
  }

  window.cancelAnimationFrame(rafId);
  const perfEventsBeforeStop = events().filter(relevantEvent);
  const activeSession = window.__AGENTREE_PERF__?.getActiveSession?.() ?? null;
  await window.__AGENTREE_PERF__?.stopCapture?.();
  const perfEventsAfterStop = (window.__AGENTREE_PERF__?.read?.() ?? []).filter((event) => event.sessionId === activeSession?.id && relevantEvent(event));
  const afterButtons = summarizeWorkspaceButtons();
  const finalSelectedWorkspaceId = afterButtons.find((button) => button.selected)?.id ?? null;
  const finalImportedStoreWorkspaceId = useWorkspaceStore.getState().selectedWorkspaceId ?? null;

  return {
    label,
    url: location.href,
    activeSession,
    beforeSelectedWorkspaceId,
    beforeImportedStoreWorkspaceId,
    targetWorkspaceId,
    targetLabel,
    finalSelectedWorkspaceId,
    finalImportedStoreWorkspaceId,
    loadingBeforeClick,
    loadingStillVisible: textIncludesLoading(),
    timings: {
      clickReturnMs: round(clickReturnMs),
      selectedImportedStoreMs: round(selectedImportedStoreMs),
      selectedDomMs: round(selectedDomMs),
      loadingFirstVisibleMs: round(loadingFirstVisibleMs),
      loadingGoneMs: round(loadingGoneMs),
      threadNavigationReadyEventSeen: Boolean(readyEvent),
      maxRafGapMs: round(maxRafGapMs),
    },
    selectedEvent,
    readyEvent,
    beforeButtons,
    afterButtons,
    rafStalls,
    perfEvents: perfEventsAfterStop.length > 0 ? perfEventsAfterStop : perfEventsBeforeStop,
    exportStatus: window.__AGENTREE_PERF__?.getExportStatus?.() ?? null,
  };
})()
`, Math.max(60000, WAIT_MS + 10000));

const main = async () => {
  const result = await installAndRunProbe();
  const report = {
    label: LABEL,
    capturedAt: new Date().toISOString(),
    result: result.value,
    pilotRoundTripMs: result.roundTripMs,
  };
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  writeCompactPilotReport({
    reportPath,
    report,
    limits: {
      perfEvents: 200,
      samples: 20,
      stalls: 30,
    },
  });
  console.log(JSON.stringify({
    ok: true,
    reportPath,
    targetWorkspaceId: result.value?.targetWorkspaceId,
    finalSelectedWorkspaceId: result.value?.finalSelectedWorkspaceId,
    timings: result.value?.timings,
    loadingStillVisible: result.value?.loadingStillVisible,
    perfEventCount: result.value?.perfEvents?.length ?? 0,
    exportStatus: result.value?.exportStatus,
  }, null, 2));
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
