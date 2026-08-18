import { createRuntimeFreezeProbeDetails } from './freezeProbe';

type FreezeAttributionProbeRecorder = (
  name: string,
  details?: Record<string, unknown>,
  options?: { source?: string; durationMs?: number }
) => void;

export type FreezeAttributionProbeController = {
  stop: () => void;
};

type LoosePerformanceEntry = PerformanceEntry & Record<string, unknown>;

const PROBE_SOURCE = 'freeze-attribution-probe';
const MAX_ATTRIBUTION_ROWS = 5;
const MAX_STRING_LENGTH = 220;

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(2));
};

const boundedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
};

const compact = (value: Record<string, unknown>) => (
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
);

const compactArray = (value: unknown, mapper: (item: Record<string, unknown>) => Record<string, unknown>) => {
  if (!Array.isArray(value)) return undefined;
  return value
    .slice(0, MAX_ATTRIBUTION_ROWS)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map(mapper);
};

const baseEntryDetails = (entry: LoosePerformanceEntry) => ({
  ...createRuntimeFreezeProbeDetails(),
  entryType: entry.entryType,
  name: boundedString(entry.name),
  startTime: finiteNumber(entry.startTime),
});

const scriptAttributionDetails = (scripts: unknown) => compactArray(scripts, (script) => compact({
  invoker: boundedString(script.invoker),
  invokerType: boundedString(script.invokerType),
  sourceURL: boundedString(script.sourceURL),
  sourceFunctionName: boundedString(script.sourceFunctionName),
  sourceCharPosition: finiteNumber(script.sourceCharPosition),
  duration: finiteNumber(script.duration),
  pauseDuration: finiteNumber(script.pauseDuration),
  forcedStyleAndLayoutDuration: finiteNumber(script.forcedStyleAndLayoutDuration),
  executionStart: finiteNumber(script.executionStart),
}));

const longTaskAttributionDetails = (attribution: unknown) => compactArray(attribution, (item) => compact({
  name: boundedString(item.name),
  entryType: boundedString(item.entryType),
  containerType: boundedString(item.containerType),
  containerName: boundedString(item.containerName),
  containerSrc: boundedString(item.containerSrc),
  containerId: boundedString(item.containerId),
}));

const loafDetails = (entry: LoosePerformanceEntry) => compact({
  ...baseEntryDetails(entry),
  blockingDuration: finiteNumber(entry.blockingDuration),
  renderStart: finiteNumber(entry.renderStart),
  styleAndLayoutStart: finiteNumber(entry.styleAndLayoutStart),
  firstUIEventTimestamp: finiteNumber(entry.firstUIEventTimestamp),
  scripts: scriptAttributionDetails(entry.scripts),
});

const longTaskDetails = (entry: LoosePerformanceEntry) => compact({
  ...baseEntryDetails(entry),
  attribution: longTaskAttributionDetails(entry.attribution),
});

export const createFreezeAttributionProbeEntryHandler = (record: FreezeAttributionProbeRecorder) => (
  entries: PerformanceEntry[]
) => {
  for (const entry of entries as LoosePerformanceEntry[]) {
    const durationMs = finiteNumber(entry.duration);
    if (durationMs === undefined || durationMs <= 0) continue;
    if (entry.entryType === 'long-animation-frame') {
      record('runtime.long-animation-frame', loafDetails(entry), {
        source: PROBE_SOURCE,
        durationMs,
      });
      continue;
    }
    if (entry.entryType === 'longtask') {
      record('runtime.long-task', longTaskDetails(entry), {
        source: PROBE_SOURCE,
        durationMs,
      });
    }
  }
};

const tryObserve = (
  observers: PerformanceObserver[],
  handler: ReturnType<typeof createFreezeAttributionProbeEntryHandler>,
  entryType: string,
) => {
  try {
    const observer = new PerformanceObserver((list) => {
      handler(list.getEntries());
    });
    observer.observe({ entryTypes: [entryType] as string[] });
    observers.push(observer);
  } catch {
    // Performance entry support varies across WebView versions.
  }
};

export const startFreezeAttributionProbe = (
  record: FreezeAttributionProbeRecorder,
): FreezeAttributionProbeController => {
  if (typeof PerformanceObserver === 'undefined') {
    return { stop: () => {} };
  }

  const observers: PerformanceObserver[] = [];
  const handler = createFreezeAttributionProbeEntryHandler(record);
  tryObserve(observers, handler, 'long-animation-frame');
  tryObserve(observers, handler, 'longtask');

  return {
    stop: () => {
      for (const observer of observers) {
        observer.disconnect();
      }
    },
  };
};
