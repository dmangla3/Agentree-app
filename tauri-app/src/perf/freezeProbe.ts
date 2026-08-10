export type RuntimeGapSeverity = 'stall' | 'freeze';

export type RuntimeGapClassification = {
  severity: RuntimeGapSeverity;
  gapMs: number;
};

export type RuntimeGapThresholds = {
  stallThresholdMs?: number;
  freezeThresholdMs?: number;
};

type RuntimeFreezeProbeRecorder = (
  name: string,
  details?: Record<string, unknown>,
  options?: { source?: string; durationMs?: number }
) => void;

export type RuntimeFreezeProbeController = {
  stop: () => void;
};

const DEFAULT_STALL_THRESHOLD_MS = 250;
const DEFAULT_FREEZE_THRESHOLD_MS = 1000;
const DEFAULT_INTERVAL_MS = 100;

const roundGap = (gapMs: number) => Number(gapMs.toFixed(2));

export const classifyRuntimeGap = (
  gapMs: number,
  thresholds: RuntimeGapThresholds = {}
): RuntimeGapClassification | null => {
  if (!Number.isFinite(gapMs)) return null;
  const stallThresholdMs = thresholds.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const freezeThresholdMs = thresholds.freezeThresholdMs ?? DEFAULT_FREEZE_THRESHOLD_MS;
  if (gapMs < stallThresholdMs) return null;
  return {
    severity: gapMs >= freezeThresholdMs ? 'freeze' : 'stall',
    gapMs: roundGap(gapMs),
  };
};

export const startRuntimeFreezeProbe = (
  record: RuntimeFreezeProbeRecorder,
  options: RuntimeGapThresholds & { intervalMs?: number } = {}
): RuntimeFreezeProbeController => {
  if (
    typeof window === 'undefined' ||
    typeof performance === 'undefined' ||
    typeof window.setInterval !== 'function' ||
    typeof window.requestAnimationFrame !== 'function'
  ) {
    return { stop: () => {} };
  }

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let expectedIntervalAt = performance.now() + intervalMs;
  let lastRafAt = performance.now();
  let rafId: number | null = null;

  const commonDetails = () => ({
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
  });

  const intervalId = window.setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    const gap = now - expectedIntervalAt;
    expectedIntervalAt = now + intervalMs;
    const classification = classifyRuntimeGap(gap, options);
    if (!classification) return;
    record('runtime.event-loop-stall', {
      ...commonDetails(),
      expectedIntervalMs: intervalMs,
      severity: classification.severity,
    }, {
      source: 'runtime-freeze-probe',
      durationMs: classification.gapMs,
    });
  }, intervalMs);

  const rafLoop = () => {
    if (stopped) return;
    const now = performance.now();
    const gap = now - lastRafAt;
    lastRafAt = now;
    const classification = document.visibilityState === 'visible'
      ? classifyRuntimeGap(gap, options)
      : null;
    if (classification) {
      record('runtime.raf-stall', {
        ...commonDetails(),
        severity: classification.severity,
      }, {
        source: 'runtime-freeze-probe',
        durationMs: classification.gapMs,
      });
    }
    rafId = window.requestAnimationFrame(rafLoop);
  };
  rafId = window.requestAnimationFrame(rafLoop);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(intervalId);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    },
  };
};
