import type { ExecutionTimelineModel } from './executionTimelineModel';

export type ExecutionTimelineDisplaySegment = {
  kind: 'time' | 'break';
  startMs: number;
  endMs: number;
  displayStartMs: number;
  displayEndMs: number;
};

export type ExecutionTimelineDisplayScale = {
  minMs: number;
  maxMs: number;
  displaySpanMs: number;
  segments: ExecutionTimelineDisplaySegment[];
};

export type ExecutionTimelineRulerTick = {
  timeMs: number;
  fraction: number;
  label: string;
  major: boolean;
};

export type ExecutionTimelinePreferredRulerTick = {
  timeMs: number;
  priority: number;
  label?: string;
  major?: boolean;
};

type BuildScaleOptions = {
  idleGapThresholdMs?: number;
  compressedGapMs?: number;
};

type BuildRulerTickOptions = {
  minDisplayGapFraction?: number;
  preferredTicks?: ExecutionTimelinePreferredRulerTick[];
  viewportStartMs?: number;
  viewportEndMs?: number;
};

const DEFAULT_IDLE_GAP_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_COMPRESSED_GAP_MS = 90 * 1000;
const MIN_RULER_TICK_FRACTION_GAP = 0.075;

const TICK_STEPS_MS = [
  30 * 1000,
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  10 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  8 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const formatClockLabel = (timeMs: number): string => (
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timeMs))
);

export function formatIdleGapLabel(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m idle`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m idle` : `${hours}h idle`;
}

export function buildExecutionTimelineDisplayScale(
  model: ExecutionTimelineModel,
  options: BuildScaleOptions = {},
): ExecutionTimelineDisplayScale {
  const minMs = model.minMs;
  const maxMs = Math.max(model.maxMs, minMs + 1);
  const idleGapThresholdMs = options.idleGapThresholdMs ?? DEFAULT_IDLE_GAP_THRESHOLD_MS;
  const compressedGapMs = options.compressedGapMs ?? DEFAULT_COMPRESSED_GAP_MS;

  const intervals = [
    ...model.bars.map((bar) => ({
      startMs: clamp(bar.startMs, minMs, maxMs),
      endMs: clamp(Math.max(bar.endMs, bar.startMs + 1), minMs, maxMs),
    })),
    ...model.markers.map((marker) => ({
      startMs: clamp(marker.timeMs, minMs, maxMs),
      endMs: clamp(marker.timeMs, minMs, maxMs),
    })),
  ]
    .filter((interval) => interval.endMs >= minMs && interval.startMs <= maxMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  if (intervals.length === 0) {
    return {
      minMs,
      maxMs,
      displaySpanMs: maxMs - minMs,
      segments: [{
        kind: 'time',
        startMs: minMs,
        endMs: maxMs,
        displayStartMs: 0,
        displayEndMs: maxMs - minMs,
      }],
    };
  }

  const breakGaps: Array<{ startMs: number; endMs: number }> = [];
  if (intervals[0].startMs - minMs > idleGapThresholdMs) {
    breakGaps.push({ startMs: minMs, endMs: intervals[0].startMs });
  }

  let activeEndMs = Math.max(intervals[0].endMs, intervals[0].startMs + 1);
  for (const interval of intervals.slice(1)) {
    if (interval.startMs - activeEndMs > idleGapThresholdMs) {
      breakGaps.push({ startMs: activeEndMs, endMs: interval.startMs });
    }
    activeEndMs = Math.max(activeEndMs, interval.endMs, interval.startMs + 1);
  }
  if (maxMs - activeEndMs > idleGapThresholdMs) {
    breakGaps.push({ startMs: activeEndMs, endMs: maxMs });
  }

  const segments: ExecutionTimelineDisplaySegment[] = [];
  let cursorMs = minMs;
  let displayCursorMs = 0;

  const pushSegment = (kind: ExecutionTimelineDisplaySegment['kind'], startMs: number, endMs: number) => {
    if (endMs <= startMs) return;
    const realDurationMs = endMs - startMs;
    const displayDurationMs = kind === 'break'
      ? Math.min(realDurationMs, Math.max(1, compressedGapMs))
      : realDurationMs;
    segments.push({
      kind,
      startMs,
      endMs,
      displayStartMs: displayCursorMs,
      displayEndMs: displayCursorMs + displayDurationMs,
    });
    displayCursorMs += displayDurationMs;
  };

  for (const gap of breakGaps) {
    pushSegment('time', cursorMs, gap.startMs);
    pushSegment('break', gap.startMs, gap.endMs);
    cursorMs = gap.endMs;
  }
  pushSegment('time', cursorMs, maxMs);

  if (segments.length === 0) {
    pushSegment('time', minMs, maxMs);
  }

  return {
    minMs,
    maxMs,
    displaySpanMs: Math.max(1, displayCursorMs),
    segments,
  };
}

export function scaleTimelineMs(scale: ExecutionTimelineDisplayScale, timeMs: number): number {
  const clampedTimeMs = clamp(timeMs, scale.minMs, scale.maxMs);
  const segment = scale.segments.find((candidate) => (
    clampedTimeMs >= candidate.startMs && clampedTimeMs <= candidate.endMs
  )) ?? scale.segments[scale.segments.length - 1];
  if (!segment) return 0;
  const realSpanMs = Math.max(1, segment.endMs - segment.startMs);
  const displaySpanMs = Math.max(1, segment.displayEndMs - segment.displayStartMs);
  const ratio = (clampedTimeMs - segment.startMs) / realSpanMs;
  return segment.displayStartMs + ratio * displaySpanMs;
}

export function unscaleTimelineDisplayMs(scale: ExecutionTimelineDisplayScale, displayMs: number): number {
  const clampedDisplayMs = clamp(displayMs, 0, scale.displaySpanMs);
  const segment = scale.segments.find((candidate) => (
    clampedDisplayMs >= candidate.displayStartMs && clampedDisplayMs <= candidate.displayEndMs
  )) ?? scale.segments[scale.segments.length - 1];
  if (!segment) return scale.minMs;
  const realSpanMs = Math.max(1, segment.endMs - segment.startMs);
  const displaySpanMs = Math.max(1, segment.displayEndMs - segment.displayStartMs);
  const ratio = (clampedDisplayMs - segment.displayStartMs) / displaySpanMs;
  return segment.startMs + ratio * realSpanMs;
}

export function getTimelineDisplayFraction(timeMs: number, scale: ExecutionTimelineDisplayScale): number {
  return scaleTimelineMs(scale, timeMs) / Math.max(1, scale.displaySpanMs);
}

export function buildTimelineRulerTicks(
  scale: ExecutionTimelineDisplayScale,
  targetTickCount = 8,
  options: BuildRulerTickOptions = {},
): ExecutionTimelineRulerTick[] {
  type CandidateTick = ExecutionTimelineRulerTick & { priority: number };
  const minDisplayGapFraction = options.minDisplayGapFraction ?? MIN_RULER_TICK_FRACTION_GAP;
  const viewportStartMs = options.viewportStartMs ?? scale.minMs;
  const viewportEndMs = options.viewportEndMs ?? scale.maxMs;
  const candidates: CandidateTick[] = [];

  const addCandidate = (tick: CandidateTick) => {
    if (tick.timeMs < viewportStartMs || tick.timeMs > viewportEndMs) return;
    candidates.push(tick);
  };

  for (const segment of scale.segments) {
    if (segment.kind !== 'time') continue;
    const segmentStartMs = Math.max(segment.startMs, viewportStartMs);
    const segmentEndMs = Math.min(segment.endMs, viewportEndMs);
    const durationMs = segment.endMs - segment.startMs;
    if (durationMs <= 0 || segmentEndMs <= segmentStartMs) continue;
    const targetStepMs = (viewportEndMs - viewportStartMs) / Math.max(2, targetTickCount);
    const stepMs = TICK_STEPS_MS.find((step) => step >= targetStepMs) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
    const firstTickMs = Math.ceil(segmentStartMs / stepMs) * stepMs;
    for (let timeMs = firstTickMs; timeMs <= segmentEndMs; timeMs += stepMs) {
      if (timeMs < segmentStartMs) continue;
      addCandidate({
        timeMs,
        fraction: getTimelineDisplayFraction(timeMs, scale),
        label: formatClockLabel(timeMs),
        major: true,
        priority: 0,
      });
    }
  }

  for (const preferredTick of options.preferredTicks ?? []) {
    addCandidate({
      timeMs: preferredTick.timeMs,
      fraction: getTimelineDisplayFraction(preferredTick.timeMs, scale),
      label: preferredTick.label ?? formatClockLabel(preferredTick.timeMs),
      major: preferredTick.major ?? true,
      priority: preferredTick.priority,
    });
  }

  const candidateByTimeMs = new Map<number, CandidateTick>();
  for (const candidate of candidates) {
    const existing = candidateByTimeMs.get(candidate.timeMs);
    if (!existing || candidate.priority > existing.priority) {
      candidateByTimeMs.set(candidate.timeMs, candidate);
    }
  }

  const prioritySortedCandidates = Array.from(candidateByTimeMs.values())
    .sort((left, right) => right.priority - left.priority || left.timeMs - right.timeMs);

  if (prioritySortedCandidates.length > 0) {
    const selectedTicks: CandidateTick[] = [];
    for (const candidate of prioritySortedCandidates) {
      if (selectedTicks.some((tick) => Math.abs(tick.fraction - candidate.fraction) < minDisplayGapFraction)) {
        continue;
      }
      selectedTicks.push(candidate);
    }
    return selectedTicks
      .sort((left, right) => left.timeMs - right.timeMs)
      .map(({ priority: _priority, ...tick }) => tick);
  }

  return [scale.minMs, scale.maxMs].map((timeMs) => ({
    timeMs,
    fraction: getTimelineDisplayFraction(timeMs, scale),
    label: formatClockLabel(timeMs),
    major: true,
  }));
}
