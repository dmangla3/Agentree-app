import { devLog } from '../lib/appLogger';
import type { ProfilerOnRenderCallback } from 'react';

export type FocusInteractionSource =
  | 'graph.turn-node'
  | 'graph.commit-node'
  | 'graph.agent-card'
  | 'graph.external-cluster'
  | 'chat.origin-message'
  | 'chat.assistant-message'
  | 'chat.user-message'
  | 'chat.external-batch'
  | 'chat.external-commit-row'
  | 'chat.summary'
  | 'chat.breadcrumb'
  | 'chat.assistant-variant'
  | 'timeline.node'
  | 'unknown';

export type FocusInteractionTarget =
  | 'turn'
  | 'assistant-message'
  | 'user-message'
  | 'commit'
  | 'commit-batch'
  | 'summary'
  | 'breadcrumb'
  | 'unknown';

interface FocusInteraction {
  id: string;
  source: FocusInteractionSource;
  targetId: string;
  targetType: FocusInteractionTarget;
  startedAt: number;
  metadata?: Record<string, unknown>;
}

const INTERACTION_TTL_MS = 4000;
const PROFILER_LOG_MIN_DURATION_MS = 16;
const PERF_PREFIX = 'agentree.focus';

let interactionCounter = 0;
let phaseCounter = 0;
let activeInteraction: FocusInteraction | null = null;

const isPerfAvailable = () =>
  typeof window !== 'undefined' &&
  typeof performance !== 'undefined' &&
  typeof performance.mark === 'function' &&
  typeof performance.measure === 'function';

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, '_');

const getLatestMeasureDuration = (measureName: string): number | null => {
  if (!isPerfAvailable()) return null;
  const entries = performance.getEntriesByName(measureName, 'measure');
  if (entries.length === 0) return null;
  return entries[entries.length - 1]?.duration ?? null;
};

const logPerf = (label: string, payload: Record<string, unknown>) => {
  if (!import.meta.env.DEV) return;
  devLog(`[interaction-profiler] ${label}`, payload);
};

export const getActiveInteraction = (): FocusInteraction | null => {
  if (!activeInteraction) return null;
  if (performance.now() - activeInteraction.startedAt > INTERACTION_TTL_MS) {
    activeInteraction = null;
    return null;
  }
  return activeInteraction;
};

export const startFocusInteraction = ({
  source,
  targetId,
  targetType,
  metadata,
}: {
  source: FocusInteractionSource;
  targetId: string;
  targetType: FocusInteractionTarget;
  metadata?: Record<string, unknown>;
}): FocusInteraction => {
  const interaction: FocusInteraction = {
    id: `focus-${Date.now()}-${interactionCounter++}`,
    source,
    targetId,
    targetType,
    startedAt: isPerfAvailable() ? performance.now() : Date.now(),
    metadata,
  };

  activeInteraction = interaction;

  if (isPerfAvailable()) {
    performance.mark(`${PERF_PREFIX}.${interaction.id}.start`);
  }

  logPerf('focus.start', {
    interactionId: interaction.id,
    source,
    targetId,
    targetType,
    ...metadata,
  });

  return interaction;
};

export const startMeasuredPhase = (
  phase: string,
  interaction: FocusInteraction | null = getActiveInteraction(),
  metadata?: Record<string, unknown>
) => {
  if (!isPerfAvailable()) {
    return (endMetadata?: Record<string, unknown>) => {
      logPerf(phase, {
        interactionId: interaction?.id ?? null,
        source: interaction?.source ?? null,
        targetId: interaction?.targetId ?? null,
        ...metadata,
        ...endMetadata,
      });
      return null;
    };
  }

  const phaseId = `${sanitize(phase)}-${phaseCounter++}`;
  const startMark = `${PERF_PREFIX}.${interaction?.id ?? 'none'}.${phaseId}.start`;
  const endMark = `${PERF_PREFIX}.${interaction?.id ?? 'none'}.${phaseId}.end`;
  const measureName = `${PERF_PREFIX}.${interaction?.id ?? 'none'}.${phaseId}.measure`;

  performance.mark(startMark);

  return (endMetadata?: Record<string, unknown>) => {
    performance.mark(endMark);
    performance.measure(measureName, startMark, endMark);
    const duration = getLatestMeasureDuration(measureName);

    logPerf(phase, {
      interactionId: interaction?.id ?? null,
      source: interaction?.source ?? null,
      targetId: interaction?.targetId ?? null,
      durationMs: duration,
      ...metadata,
      ...endMetadata,
    });

    performance.clearMarks(startMark);
    performance.clearMarks(endMark);
    performance.clearMeasures(measureName);

    return duration;
  };
};

export const createProfilerOnRender = (
  surface: string,
  getAttribution?: () => Record<string, unknown>
): ProfilerOnRenderCallback => {
  return (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    if (actualDuration < PROFILER_LOG_MIN_DURATION_MS) return;
    const interaction = getActiveInteraction();
    logPerf(`react-profiler:${surface}`, {
      profilerId: id,
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
      interactionId: interaction?.id ?? null,
      source: interaction?.source ?? null,
      targetId: interaction?.targetId ?? null,
      ...(getAttribution?.() ?? {}),
    });
  };
};
