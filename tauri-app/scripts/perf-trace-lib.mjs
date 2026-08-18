import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PERF_CAPTURE_ROOT = 'runtime-logs/perf-captures';
const PILOT_REPORT_ROOT = 'runtime-logs/tauri-pilot-diagnostics';
const DEFAULT_OUTPUT_NAME = 'perfetto-trace.json';

const PROCESS_ID = 1;
const THREADS = {
  runtime: 1,
  sendFlow: 2,
  query: 3,
  graph: 4,
  chat: 5,
  workspace: 6,
  runStatus: 7,
  pilot: 8,
  perf: 9,
  other: 10,
};

const THREAD_NAMES = {
  [THREADS.runtime]: 'runtime',
  [THREADS.sendFlow]: 'send-flow',
  [THREADS.query]: 'query/cache',
  [THREADS.graph]: 'graph',
  [THREADS.chat]: 'chat',
  [THREADS.workspace]: 'workspace',
  [THREADS.runStatus]: 'run-status',
  [THREADS.pilot]: 'pilot',
  [THREADS.perf]: 'perf-recorder',
  [THREADS.other]: 'other',
};

const listFiles = async (dir) => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const safeJson = async (filePath, fallback = null) => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const latestByMtime = async (paths) => {
  const rows = [];
  for (const filePath of paths) {
    try {
      const info = await stat(filePath);
      rows.push({ filePath, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore stale paths.
    }
  }
  rows.sort((left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath));
  return rows[0]?.filePath ?? null;
};

export const findLatestPerfCaptureDir = async (root = process.cwd()) => {
  const captureRoot = path.join(root, PERF_CAPTURE_ROOT);
  const entries = await listFiles(captureRoot);
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(captureRoot, entry.name, 'perf-events.json'));
  const latestEventsPath = await latestByMtime(candidates);
  return latestEventsPath ? path.dirname(latestEventsPath) : null;
};

export const findLatestPilotReportPath = async (root = process.cwd()) => {
  const pilotRoot = path.join(root, PILOT_REPORT_ROOT);
  const entries = await listFiles(pilotRoot);
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(pilotRoot, entry.name));
  return latestByMtime(candidates);
};

export const findPilotReportPathByLabel = async (root = process.cwd(), label = null) => {
  if (!label) return null;
  const pilotRoot = path.join(root, PILOT_REPORT_ROOT);
  const entries = await listFiles(pilotRoot);
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(pilotRoot, entry.name));
  for (const candidate of candidates) {
    const data = await safeJson(candidate, null);
    if (data?.label === label) return candidate;
  }
  return null;
};

const parseTimestampUs = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed * 1000 : null;
};

const numberOrNull = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const durationUs = (value) => {
  const durationMs = numberOrNull(value);
  return durationMs === null ? null : Math.max(0, Math.round(durationMs * 1000));
};

const eventThread = (eventName = '', source = '') => {
  const combined = `${eventName} ${source}`.toLowerCase();
  if (combined.includes('runtime.')) return THREADS.runtime;
  if (combined.includes('send-flow')) return THREADS.sendFlow;
  if (combined.includes('query.') || combined.includes('cache-refresh')) return THREADS.query;
  if (combined.includes('graph.')) return THREADS.graph;
  if (combined.includes('chat.')) return THREADS.chat;
  if (combined.includes('workspace.')) return THREADS.workspace;
  if (combined.includes('run-status')) return THREADS.runStatus;
  if (combined.includes('perf.capture') || combined.includes('perf-recorder')) return THREADS.perf;
  return THREADS.other;
};

const eventCategory = (eventName = '') => {
  if (eventName === 'runtime.raf-stall' || eventName === 'runtime.event-loop-stall') return 'runtime,freeze';
  if (eventName === 'runtime.long-animation-frame' || eventName === 'runtime.long-task') return 'runtime,freeze-attribution';
  if (eventName.startsWith('runtime.')) return 'runtime';
  if (eventName.startsWith('send-flow.')) return 'send-flow';
  if (eventName.startsWith('query.cache-refresh.')) return 'query,cache-refresh';
  if (eventName.startsWith('query.')) return 'query';
  if (eventName.startsWith('graph.')) return 'graph';
  if (eventName.startsWith('chat.')) return 'chat';
  if (eventName.startsWith('workspace.')) return 'workspace';
  if (eventName.startsWith('run-status.')) return 'run-status';
  if (eventName.startsWith('perf.')) return 'perf';
  return 'app';
};

const compactArgs = (value) => {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
  );
};

const traceMetadataEvents = (sessionLabel) => [
  {
    name: 'process_name',
    ph: 'M',
    pid: PROCESS_ID,
    tid: 0,
    args: { name: `Agentree Perf${sessionLabel ? `: ${sessionLabel}` : ''}` },
  },
  ...Object.entries(THREAD_NAMES).map(([tid, name]) => ({
    name: 'thread_name',
    ph: 'M',
    pid: PROCESS_ID,
    tid: Number(tid),
    args: { name },
  })),
];

const phasePairKey = (event) => {
  const details = event?.details ?? {};
  if (event?.name !== 'query.cache-refresh.phase.start' && event?.name !== 'query.cache-refresh.phase.end') return null;
  return [
    details.operationId ?? '',
    details.phase ?? '',
    details.workspaceId ?? '',
    details.queryKey ?? '',
  ].join('|');
};

const phaseSpanName = (event) => {
  const phase = event?.details?.phase;
  return phase ? `query.cache-refresh.phase:${phase}` : event.name;
};

const makeInstant = ({ name, cat, ts, tid, args }) => ({
  name,
  cat,
  ph: 'i',
  s: 't',
  pid: PROCESS_ID,
  tid,
  ts,
  args: compactArgs(args),
});

const makeComplete = ({ name, cat, ts, dur, tid, args }) => ({
  name,
  cat,
  ph: 'X',
  pid: PROCESS_ID,
  tid,
  ts,
  dur,
  args: compactArgs(args),
});

const normalizeEventName = (event) => {
  const markName = event?.details?.markName;
  if (event?.name === 'send-flow.mark' && typeof markName === 'string' && markName) {
    return `${event.name}:${markName}`;
  }
  return event?.name ?? 'event';
};

const perfEventsToTraceEvents = (perfEvents) => {
  const traceEvents = [];
  const pendingPhaseStarts = new Map();
  const skipEvents = new Set();

  for (const event of Array.isArray(perfEvents) ? perfEvents : []) {
    const key = phasePairKey(event);
    if (!key) continue;
    if (event.name === 'query.cache-refresh.phase.start') {
      pendingPhaseStarts.set(key, event);
      skipEvents.add(event);
      continue;
    }
    const started = pendingPhaseStarts.get(key);
    if (!started) continue;
    const startTs = parseTimestampUs(started.ts);
    const endTs = parseTimestampUs(event.ts);
    if (startTs === null || endTs === null || endTs < startTs) continue;
    const explicitDuration = durationUs(event.durationMs);
    traceEvents.push(makeComplete({
      name: phaseSpanName(event),
      cat: 'query,cache-refresh',
      ts: startTs,
      dur: explicitDuration ?? (endTs - startTs),
      tid: THREADS.query,
      args: {
        ...started.details,
        endDetails: event.details,
        source: event.source,
      },
    }));
    skipEvents.add(event);
  }

  for (const event of Array.isArray(perfEvents) ? perfEvents : []) {
    if (skipEvents.has(event)) continue;
    const ts = parseTimestampUs(event?.ts);
    if (ts === null) continue;
    const name = normalizeEventName(event);
    const dur = durationUs(event?.durationMs);
    const tid = eventThread(event?.name, event?.source);
    const base = {
      name,
      cat: eventCategory(event?.name),
      ts,
      tid,
      args: {
        ...(event?.details ?? {}),
        source: event?.source,
        sessionId: event?.sessionId,
        sessionLabel: event?.sessionLabel,
      },
    };
    if (dur !== null && dur > 0) {
      traceEvents.push(makeComplete({ ...base, dur }));
    } else {
      traceEvents.push(makeInstant(base));
    }
  }

  return traceEvents;
};

const pilotActions = (pilotReport) => {
  const waitActions = pilotReport?.wait?.summary?.actions;
  const collectActions = pilotReport?.collect?.probe?.actions;
  const actions = Array.isArray(collectActions) && collectActions.length > 0
    ? collectActions
    : waitActions;
  return Array.isArray(actions) ? actions : [];
};

const pilotReportToTraceEvents = (pilotReport) => (
  pilotActions(pilotReport)
    .map((action) => {
      const ts = parseTimestampUs(action?.at);
      if (ts === null) return null;
      return makeInstant({
        name: `pilot.${action.type ?? 'action'}`,
        cat: 'pilot',
        ts,
        tid: THREADS.pilot,
        args: {
          ...action,
          reportLabel: pilotReport?.label ?? null,
        },
      });
    })
    .filter(Boolean)
);

export const buildTraceFromArtifacts = ({
  sessionLabel = null,
  perfEvents = [],
  pilotReport = null,
} = {}) => {
  const label = sessionLabel
    ?? perfEvents.find((event) => typeof event?.sessionLabel === 'string')?.sessionLabel
    ?? pilotReport?.label
    ?? null;
  const traceEvents = [
    ...traceMetadataEvents(label),
    ...perfEventsToTraceEvents(perfEvents),
    ...pilotReportToTraceEvents(pilotReport),
  ].sort((left, right) => (
    (left.ts ?? -1) - (right.ts ?? -1) ||
    (left.tid ?? 0) - (right.tid ?? 0) ||
    String(left.name).localeCompare(String(right.name))
  ));

  return {
    displayTimeUnit: 'ms',
    metadata: {
      exporter: 'agentree-perf-trace',
      sessionLabel: label,
      generatedAt: new Date().toISOString(),
    },
    traceEvents,
  };
};

export const writeTraceForCapture = async ({
  root = process.cwd(),
  captureDir = null,
  pilotReportPath = null,
  outputPath = null,
} = {}) => {
  const resolvedCaptureDir = captureDir
    ? path.resolve(root, captureDir)
    : await findLatestPerfCaptureDir(root);
  if (!resolvedCaptureDir) {
    throw new Error(`No perf capture found under ${path.join(root, PERF_CAPTURE_ROOT)}`);
  }

  const perfEventsPath = path.join(resolvedCaptureDir, 'perf-events.json');
  const perfEvents = await safeJson(perfEventsPath, []);
  if (!Array.isArray(perfEvents)) {
    throw new Error(`Expected array in ${perfEventsPath}`);
  }

  const summary = await safeJson(path.join(resolvedCaptureDir, 'send-flow-summary.json'), null);
  const matchingPilotReportPath = !pilotReportPath && summary?.sessionLabel
    ? await findPilotReportPathByLabel(root, summary.sessionLabel)
    : null;
  const resolvedPilotReportPath = pilotReportPath
    ? path.resolve(root, pilotReportPath)
    : matchingPilotReportPath ?? await findLatestPilotReportPath(root);
  const pilotReport = resolvedPilotReportPath
    ? await safeJson(resolvedPilotReportPath, null)
    : null;

  const trace = buildTraceFromArtifacts({
    sessionLabel: summary?.sessionLabel ?? null,
    perfEvents,
    pilotReport,
  });
  const resolvedOutputPath = outputPath
    ? path.resolve(root, outputPath)
    : path.join(resolvedCaptureDir, DEFAULT_OUTPUT_NAME);

  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(trace)}\n`, 'utf8');

  return {
    captureDir: resolvedCaptureDir,
    perfEventsPath,
    pilotReportPath: resolvedPilotReportPath,
    outputPath: resolvedOutputPath,
    eventCount: trace.traceEvents.length,
  };
};
