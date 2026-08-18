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

const perfEventsPathForSummaryPath = (summaryPath) => (
  summaryPath ? path.join(path.dirname(summaryPath), 'perf-events.json') : null
);

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

const parseTimestampMs = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

const stallKind = (eventName) => {
  if (eventName === 'runtime.raf-stall') return 'raf';
  if (eventName === 'runtime.event-loop-stall') return 'eventLoop';
  return null;
};

const lifecyclePhaseForRuntimeActivity = (event) => {
  const category = String(event?.details?.runtimeActivityCategory ?? '').toLowerCase();
  const name = String(event?.details?.runtimeActivityName ?? '').toLowerCase();
  if (category === 'cache-refresh' || name.includes('cache-refresh')) return 'cache-refresh';
  if (name.includes('worktree')) return 'worktree';
  if (name.includes('spawn')) return 'spawn';
  if (name.includes('commit-graph') || name.includes('commit graph')) return 'commit-graph';
  return null;
};

const lifecyclePhaseForEvent = (event) => {
  const name = event?.name ?? '';
  const markName = event?.details?.markName ?? '';
  const combined = `${name} ${markName}`.toLowerCase();
  if (combined.includes('worktree')) return 'worktree';
  if (combined.includes('spawn')) return 'spawn';
  if (combined.includes('mcp_setup') || combined.includes('mcp-setup')) return 'mcp-setup';
  if (combined.includes('finalize') || combined.includes('lifecycle.completed') || combined.includes('lifecycle.failed') || combined.includes('lifecycle.cancelled')) {
    return 'finalization';
  }
  if (combined.includes('query.cache-refresh') || combined.includes('query.messages.refresh') || combined.includes('local-first') || combined.includes('local_node') || combined.includes('local-node')) {
    return 'cache-refresh';
  }
  if (combined.includes('graph.commit') || combined.includes('commit graph') || combined.includes('commit-graph')) return 'commit-graph';
  if (combined.includes('first_tauri') || combined.includes('first_assistant') || combined.includes('tauri_stream_registered')) return 'streaming';
  return null;
};

const emptyPhaseBucket = () => ({
  eventLoopCount: 0,
  eventLoopMaxMs: null,
  rafCount: 0,
  rafMaxMs: null,
  totalCount: 0,
});

const addStallToBucket = (bucket, kind, durationMs) => {
  bucket.totalCount += 1;
  if (kind === 'eventLoop') {
    bucket.eventLoopCount += 1;
    bucket.eventLoopMaxMs = Math.max(bucket.eventLoopMaxMs ?? 0, durationMs);
    return;
  }
  if (kind === 'raf') {
    bucket.rafCount += 1;
    bucket.rafMaxMs = Math.max(bucket.rafMaxMs ?? 0, durationMs);
  }
};

export const summarizeRuntimeStallsByPhase = (events, options = {}) => {
  const windowMs = options.windowMs ?? 2000;
  const phaseEvents = [];
  const stalls = [];

  for (const event of Array.isArray(events) ? events : []) {
    const tsMs = parseTimestampMs(event?.ts);
    if (tsMs === null) continue;
    const kind = stallKind(event?.name);
    if (kind) {
      const durationMs = numberOrNull(event?.durationMs);
      if (durationMs === null) continue;
      stalls.push({ kind, tsMs, durationMs, phaseHint: lifecyclePhaseForRuntimeActivity(event) });
      continue;
    }
    const phase = lifecyclePhaseForEvent(event);
    if (phase) {
      phaseEvents.push({ phase, tsMs });
    }
  }

  const buckets = {};
  for (const stall of stalls) {
    let phase = stall.phaseHint ?? null;
    if (!phase) {
      let nearest = null;
      for (const phaseEvent of phaseEvents) {
        const distanceMs = Math.abs(stall.tsMs - phaseEvent.tsMs);
        if (distanceMs > windowMs) continue;
        if (!nearest || distanceMs < nearest.distanceMs) {
          nearest = { phase: phaseEvent.phase, distanceMs };
        }
      }
      phase = nearest?.phase ?? 'unclassified';
    }
    buckets[phase] ??= emptyPhaseBucket();
    addStallToBucket(buckets[phase], stall.kind, stall.durationMs);
  }

  return Object.fromEntries(Object.entries(buckets).sort(([left], [right]) => left.localeCompare(right)));
};

export const summarizeRuntimeStallsByActivity = (events) => {
  const buckets = {};
  for (const event of Array.isArray(events) ? events : []) {
    const kind = stallKind(event?.name);
    if (!kind) continue;
    const durationMs = numberOrNull(event?.durationMs);
    if (durationMs === null) continue;
    const category = typeof event?.details?.runtimeActivityCategory === 'string'
      ? event.details.runtimeActivityCategory
      : null;
    const activityName = typeof event?.details?.runtimeActivityName === 'string'
      ? event.details.runtimeActivityName
      : null;
    if (!category && !activityName) continue;
    const key = `${category ?? 'activity'}:${activityName ?? 'unknown'}`;
    buckets[key] ??= emptyPhaseBucket();
    addStallToBucket(buckets[key], kind, durationMs);
  }
  return Object.fromEntries(Object.entries(buckets).sort(([left], [right]) => left.localeCompare(right)));
};

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
      longAnimationFrameCount: runtime.longAnimationFrameCount ?? 0,
      maxLongAnimationFrameMs: runtime.maxLongAnimationFrameMs ?? null,
    },
    flowCount: flows.length,
    findingsCount: Array.isArray(data.findings) ? data.findings.length : 0,
    flows,
  };
};

const summarizePhaseBuckets = (phaseBuckets) => (
  Object.entries(phaseBuckets ?? {})
    .map(([phase, bucket]) => `${phase}:raf=${bucket.rafCount}/${duration(bucket.rafMaxMs)},event=${bucket.eventLoopCount}/${duration(bucket.eventLoopMaxMs)}`)
    .join(' | ') || '-'
);

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
  const perfEventsPath = perfEntry ? perfEventsPathForSummaryPath(perfEntry.filePath) : null;
  const perfEvents = perfEventsPath ? await safeJson(perfEventsPath) : null;
  const perfCapture = summarizePerfCapture(root, perfEntry, perfData);
  return {
    root,
    perfCapture: perfCapture ? {
      ...perfCapture,
      runtimePhaseBuckets: summarizeRuntimeStallsByPhase(perfEvents),
      runtimeActivityBuckets: summarizeRuntimeStallsByActivity(perfEvents),
    } : null,
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
      `runtime: event-loop: stalls=${perf.runtime.eventLoopStallCount} freezes=${perf.runtime.eventLoopFreezeCount} max=${duration(perf.runtime.maxEventLoopStallMs)} | raf: stalls=${perf.runtime.rafStallCount} freezes=${perf.runtime.rafFreezeCount} max=${duration(perf.runtime.maxRafStallMs)} | longTasks=${perf.runtime.longTaskCount} max=${duration(perf.runtime.maxLongTaskMs)} | loaf=${perf.runtime.longAnimationFrameCount} max=${duration(perf.runtime.maxLongAnimationFrameMs)}`,
      `runtime phases: ${summarizePhaseBuckets(perf.runtimePhaseBuckets)}`,
      `runtime active: ${summarizePhaseBuckets(perf.runtimeActivityBuckets)}`,
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
