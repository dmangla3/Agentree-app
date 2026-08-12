import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const PERF_CAPTURE_ROOT = 'runtime-logs/perf-captures';
const PILOT_REPORT_ROOT = 'runtime-logs/tauri-pilot-diagnostics';

const rel = (root, filePath) => path.relative(root, filePath) || filePath;

const safeJson = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const listFiles = async (dir) => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const latestByMtime = async (files) => {
  const rows = [];
  for (const filePath of files) {
    try {
      const info = await stat(filePath);
      if (info.isFile()) rows.push({ filePath, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Ignore stale paths.
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
  return rows[0] ?? null;
};

const latestPerfSummaryPath = async (root) => {
  const captureRoot = path.join(root, PERF_CAPTURE_ROOT);
  const entries = await listFiles(captureRoot);
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(captureRoot, entry.name, 'send-flow-summary.json'));
  return latestByMtime(candidates);
};

const latestPilotReportPath = async (root) => {
  const pilotRoot = path.join(root, PILOT_REPORT_ROOT);
  const entries = await listFiles(pilotRoot);
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== '.json')
    .map((entry) => path.join(pilotRoot, entry.name));
  return latestByMtime(candidates);
};

const numberOrNull = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const valueOrDash = (value, suffix = '') => (
  value === null || value === undefined || value === '' ? '-' : `${value}${suffix}`
);

const shortId = (value) => (
  typeof value === 'string' && value.length > 18 ? value.slice(0, 18) : valueOrDash(value)
);

const boolValue = (value) => (
  typeof value === 'boolean' ? String(value) : valueOrDash(value)
);

const duration = (value) => valueOrDash(numberOrNull(value), 'ms');

const coalesce = (...values) => values.find((value) => value !== null && value !== undefined);

const summarizeFlow = (flow) => {
  const durations = flow?.durationsMs ?? {};
  const findings = Array.isArray(flow?.findings) ? flow.findings : [];
  return {
    flowId: shortId(flow?.flowId),
    status: valueOrDash(flow?.status),
    promptLength: valueOrDash(flow?.promptLength),
    firstRuntime: duration(durations.sendToFirstRuntimeEvent),
    firstText: duration(durations.sendToFirstAssistantText ?? durations.sendToFirstVisibleText),
    textToProject: duration(durations.firstAssistantTextToProjection),
    projectToVisible: duration(durations.firstProjectionToVisibleText),
    textToVisible: duration(durations.firstAssistantTextToVisibleText),
    terminal: duration(durations.sendToTerminal),
    findings: findings.map((finding) => finding?.code).filter(Boolean).join(',') || '-',
  };
};

const summarizePerfCapture = (root, entry, data) => {
  if (!entry || !data) return null;
  const flows = Array.isArray(data.flows) ? data.flows.map(summarizeFlow) : [];
  const runtime = data.runtime ?? {};
  return {
    path: rel(root, entry.filePath),
    generatedAt: data.generatedAt ?? null,
    sessionId: data.sessionId ?? null,
    sessionLabel: data.sessionLabel ?? null,
    runtime: {
      eventLoopStallCount: runtime.eventLoopStallCount ?? 0,
      eventLoopFreezeCount: runtime.eventLoopFreezeCount ?? 0,
      maxEventLoopStallMs: runtime.maxEventLoopStallMs ?? null,
      rafStallCount: runtime.rafStallCount ?? 0,
      rafFreezeCount: runtime.rafFreezeCount ?? 0,
      maxRafStallMs: runtime.maxRafStallMs ?? null,
      longTaskCount: runtime.longTaskCount ?? 0,
      maxLongTaskMs: runtime.maxLongTaskMs ?? null,
    },
    flowCount: flows.length,
    findingsCount: Array.isArray(data.findings) ? data.findings.length : 0,
    flows,
  };
};

const summarizePilotReport = (root, entry, data) => {
  if (!entry || !data) return null;
  const collect = data.collect ?? {};
  const probe = collect.probe ?? data.wait?.summary ?? {};
  const convergence = collect.convergence ?? {};
  const runRows = Array.isArray(convergence.runRows) ? convergence.runRows : [];
  const commitRunRow = runRows.find((row) => row?.outputCommitSha) ?? null;
  const graph = collect.graphEventContract ?? {};
  const validationErrors = Array.isArray(collect.validationErrors) ? collect.validationErrors : [];
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const lifecycleFailures = Array.isArray(collect.lifecycleFailures) ? collect.lifecycleFailures : [];
  return {
    path: rel(root, entry.filePath),
    label: data.label ?? null,
    errors: errors.length,
    validationErrors: validationErrors.length,
    lifecycleFailures: lifecycleFailures.length,
    sendsStarted: coalesce(collect.sendsStarted, graph.sendsStarted, probe.sends?.length, runRows.length || null),
    convergence: {
      sendCount: coalesce(convergence.sendCount, convergence.sendsStarted, runRows.length || null),
      allTerminal: convergence.allTerminal ?? (runRows.length > 0
        ? runRows.every((row) => Boolean(row?.terminalStatus))
        : null),
      commitVisibleInLocalGraph: convergence.commitVisibleInLocalGraph ?? (commitRunRow
        ? Boolean(commitRunRow.commitVisibleInLocalGraph)
        : null),
      outputCommitSha: convergence.outputCommitSha ?? commitRunRow?.outputCommitSha ?? null,
    },
    stalls: {
      maxIntervalGapMs: probe.maxIntervalGapMs ?? null,
      maxRafGapMs: probe.maxRafGapMs ?? null,
      intervalActiveMaxMs: probe.intervalStallBreakdown?.maxActiveGapMs ?? null,
      intervalIdleMaxMs: probe.intervalStallBreakdown?.maxIdleGapMs ?? null,
      rafActiveMaxMs: probe.rafStallBreakdown?.maxActiveGapMs ?? null,
      rafIdleMaxMs: probe.rafStallBreakdown?.maxIdleGapMs ?? null,
    },
    graph: {
      graphChangingComputationPerSend: graph.graphChangingComputationPerSend ?? null,
      graphComputationPerSend: graph.graphComputationPerSend ?? null,
      graphLayoutCount: graph.graphLayoutCount ?? null,
      graphVisualApplyCount: graph.graphVisualApplyCount ?? null,
    },
  };
};

export const collectLatestPerfSummary = async (root = process.cwd()) => {
  const [perfEntry, pilotEntry] = await Promise.all([
    latestPerfSummaryPath(root),
    latestPilotReportPath(root),
  ]);
  const [perfData, pilotData] = await Promise.all([
    perfEntry ? safeJson(perfEntry.filePath) : null,
    pilotEntry ? safeJson(pilotEntry.filePath) : null,
  ]);
  return {
    root,
    perfCapture: summarizePerfCapture(root, perfEntry, perfData),
    pilotReport: summarizePilotReport(root, pilotEntry, pilotData),
  };
};

const section = (title, lines) => [
  title,
  ...lines.map((line) => `  ${line}`),
];

export const formatPerfSummary = (summary) => {
  const lines = [];
  const perf = summary.perfCapture;
  if (perf) {
    lines.push(...section('Perf Capture', [
      `path: ${perf.path}`,
      `session: ${valueOrDash(perf.sessionLabel)} (${valueOrDash(perf.sessionId)})`,
      `runtime: event-loop: stalls=${perf.runtime.eventLoopStallCount} freezes=${perf.runtime.eventLoopFreezeCount} max=${duration(perf.runtime.maxEventLoopStallMs)} | raf: stalls=${perf.runtime.rafStallCount} freezes=${perf.runtime.rafFreezeCount} max=${duration(perf.runtime.maxRafStallMs)} | longTasks=${perf.runtime.longTaskCount} max=${duration(perf.runtime.maxLongTaskMs)}`,
      `flows: ${perf.flowCount} findings=${perf.findingsCount}`,
      ...perf.flows.slice(0, 5).map((flow) => (
        `flow ${flow.flowId}: status=${flow.status} prompt=${flow.promptLength} firstRuntime=${flow.firstRuntime} firstText=${flow.firstText} text->project=${flow.textToProject} project->visible=${flow.projectToVisible} text->visible=${flow.textToVisible} terminal=${flow.terminal} findings=${flow.findings}`
      )),
    ]));
  } else {
    lines.push(...section('Perf Capture', ['none found']));
  }

  const pilot = summary.pilotReport;
  if (pilot) {
    lines.push('', ...section('Pilot Report', [
      `path: ${pilot.path}`,
      `label: ${valueOrDash(pilot.label)}`,
      `health: errors=${pilot.errors} validation=${pilot.validationErrors} lifecycleFailures=${pilot.lifecycleFailures}`,
      `convergence: sends=${valueOrDash(pilot.sendsStarted)} allTerminal=${boolValue(pilot.convergence.allTerminal)} commitVisible=${boolValue(pilot.convergence.commitVisibleInLocalGraph)} outputCommit=${shortId(pilot.convergence.outputCommitSha)}`,
      `stalls: intervalMax=${duration(pilot.stalls.maxIntervalGapMs)} active=${duration(pilot.stalls.intervalActiveMaxMs)} idle=${duration(pilot.stalls.intervalIdleMaxMs)} | rafMax=${duration(pilot.stalls.maxRafGapMs)} active=${duration(pilot.stalls.rafActiveMaxMs)} idle=${duration(pilot.stalls.rafIdleMaxMs)}`,
      `graph: graphChanging/send=${valueOrDash(pilot.graph.graphChangingComputationPerSend)} graphComputations/send=${valueOrDash(pilot.graph.graphComputationPerSend)} layoutCount=${valueOrDash(pilot.graph.graphLayoutCount)} visualApply=${valueOrDash(pilot.graph.graphVisualApplyCount)}`,
    ]));
  } else {
    lines.push('', ...section('Pilot Report', ['none found']));
  }

  return `${lines.join('\n')}\n`;
};
