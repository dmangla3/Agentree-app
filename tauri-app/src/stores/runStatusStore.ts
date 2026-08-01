import { create } from 'zustand';
import type { AgentStatus } from '@shared/agentStatus';
import { recordPerfEvent } from '../lib/perfRecorder';
import { resolveAgentRunStatus } from '../agent-runs/agentRun.machine';

/**
 * Render-facing status projection cache.
 *
 * AgentRunActor is the lifecycle authority. This store exists so chat, graph,
 * timeline, and counters can select cheap status/progress values without
 * subscribing to XState actors directly. Do not write run lifecycle transitions
 * here from UI code; dispatch AgentRunEvent through agentRunManager instead.
 */
export type RunStatus =
  | AgentStatus
  | 'pending'
  | 'creating'
  | 'initializing'
  | 'streaming'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RunStatusEntry {
  nodeId: string;
  workspaceId: string | null;
  role: string | null;
  status: RunStatus | null;
  progress: string | null;
  updatedAt: string;
}

interface RunStatusState {
  // Derived actor projections by message/node id.
  byNodeId: Record<string, RunStatusEntry>;
  revision: number;

  // Projection cache mutation. Production lifecycle updates should come from
  // agentRunEffects.ts after an AgentRunActor transition.
  setRunStatus: (nodeId: string, entry: Partial<Omit<RunStatusEntry, 'nodeId' | 'updatedAt'>>) => void;
  clearRunStatus: (nodeId: string) => void;
  clearAllRunStatus: () => void;
  pruneTerminalRunStatuses: (retentionMs?: number, maxTerminalEntries?: number) => void;
  getRunningCount: (workspaceId?: string | null) => number;
  hasHotSendActivity: (workspaceId: string | null, terminalGraceMs: number) => boolean;
}

export const TERMINAL_RUN_STATUS_RETENTION_MS = 60_000;
export const MAX_TERMINAL_RUN_STATUS_ENTRIES = 500;

const ACTIVE_STATUSES = new Set<RunStatus | string>([
  'pending',
  'creating',
  'initializing',
  'running',
  'streaming',
]);

const TERMINAL_STATUSES = new Set<RunStatus | string>([
  'completed',
  'failed',
  'cancelled',
  'error',
]);

let terminalPruneTimer: ReturnType<typeof setTimeout> | null = null;

const isTerminalRunStatus = (status: RunStatus | string | null | undefined) => (
  Boolean(status) && TERMINAL_STATUSES.has(status as string)
);

const isActiveRunStatus = (status: RunStatus | string | null | undefined) => (
  Boolean(status) && ACTIVE_STATUSES.has(status as string)
);

const pruneTerminalRunStatusEntries = (
  byNodeId: Record<string, RunStatusEntry>,
  {
    nowMs = Date.now(),
    retentionMs = TERMINAL_RUN_STATUS_RETENTION_MS,
    maxTerminalEntries = MAX_TERMINAL_RUN_STATUS_ENTRIES,
  }: {
    nowMs?: number;
    retentionMs?: number;
    maxTerminalEntries?: number;
  } = {}
) => {
  const terminalEntries = Object.values(byNodeId)
    .filter((entry) => isTerminalRunStatus(entry.status))
    .map((entry) => {
      const updatedAtMs = Date.parse(entry.updatedAt || '');
      return {
        entry,
        updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
      };
    })
    .sort((left, right) => left.updatedAtMs - right.updatedAtMs);

  if (terminalEntries.length === 0) {
    return {
      byNodeId,
      prunedIds: [] as string[],
      nextDelayMs: null as number | null,
    };
  }

  const prunedIds = new Set<string>();
  for (const { entry, updatedAtMs } of terminalEntries) {
    if (updatedAtMs <= 0 || nowMs - updatedAtMs >= retentionMs) {
      prunedIds.add(entry.nodeId);
    }
  }

  const retainedTerminalEntries = terminalEntries.filter(({ entry }) => !prunedIds.has(entry.nodeId));
  const overflowCount = Math.max(0, retainedTerminalEntries.length - maxTerminalEntries);
  for (const { entry } of retainedTerminalEntries.slice(0, overflowCount)) {
    prunedIds.add(entry.nodeId);
  }

  if (prunedIds.size === 0) {
    const oldestRetained = retainedTerminalEntries[0];
    const nextDelayMs = oldestRetained
      ? Math.max(0, oldestRetained.updatedAtMs + retentionMs - nowMs)
      : null;
    return { byNodeId, prunedIds: [], nextDelayMs };
  }

  const next = { ...byNodeId };
  for (const id of prunedIds) {
    delete next[id];
  }

  const remainingTerminalEntries = Object.values(next)
    .filter((entry) => isTerminalRunStatus(entry.status))
    .map((entry) => {
      const updatedAtMs = Date.parse(entry.updatedAt || '');
      return Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
    })
    .filter((updatedAtMs) => updatedAtMs > 0)
    .sort((left, right) => left - right);
  const nextDelayMs = remainingTerminalEntries.length > 0
    ? Math.max(0, remainingTerminalEntries[0] + retentionMs - nowMs)
    : null;

  return {
    byNodeId: next,
    prunedIds: Array.from(prunedIds),
    nextDelayMs,
  };
};

const scheduleTerminalPrune = (delayMs = TERMINAL_RUN_STATUS_RETENTION_MS) => {
  if (typeof globalThis.setTimeout !== 'function' || typeof globalThis.clearTimeout !== 'function') return;
  if (terminalPruneTimer !== null) {
    globalThis.clearTimeout(terminalPruneTimer);
  }
  terminalPruneTimer = globalThis.setTimeout(() => {
    terminalPruneTimer = null;
    useRunStatusStore.getState().pruneTerminalRunStatuses();
  }, Math.max(0, delayMs));
};

export const useRunStatusStore = create<RunStatusState>((set, get) => ({
  byNodeId: {},
  revision: 0,

  setRunStatus: (nodeId, entry) =>
    set((state) => {
      const existing = state.byNodeId[nodeId];
      const requestedStatus = resolveAgentRunStatus(
        existing?.status as any,
        (entry.status ?? existing?.status ?? null) as any,
      ) as RunStatus | null;
      const ignoredNonTerminalRegression = Boolean(
        existing?.status &&
        isTerminalRunStatus(existing.status) &&
        entry.status &&
        isActiveRunStatus(entry.status) &&
        requestedStatus === existing.status
      );
      const nextEntry: RunStatusEntry = {
        nodeId,
        workspaceId: entry.workspaceId ?? existing?.workspaceId ?? null,
        role: entry.role ?? existing?.role ?? null,
        status: requestedStatus,
        progress: ignoredNonTerminalRegression ? existing?.progress ?? null : entry.progress ?? existing?.progress ?? null,
        updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      };
      const nextStoredEntry = {
        ...nextEntry,
        updatedAt: new Date().toISOString(),
      };

      if (
        existing &&
        existing.workspaceId === nextStoredEntry.workspaceId &&
        existing.role === nextStoredEntry.role &&
        existing.status === nextStoredEntry.status &&
        existing.progress === nextStoredEntry.progress
      ) {
        return state;
      }

      recordPerfEvent('run-status.changed', {
        nodeId,
        workspaceId: nextStoredEntry.workspaceId,
        role: nextStoredEntry.role,
        previousStatus: existing?.status ?? null,
        nextStatus: nextStoredEntry.status,
        previousProgress: existing?.progress ?? null,
        nextProgress: nextStoredEntry.progress,
        revision: state.revision + 1,
      }, { source: 'runStatusStore' });

      const nextByNodeId = {
        ...state.byNodeId,
        [nodeId]: nextStoredEntry,
      };
      const pruned = isTerminalRunStatus(nextStoredEntry.status)
        ? pruneTerminalRunStatusEntries(nextByNodeId, {
          maxTerminalEntries: MAX_TERMINAL_RUN_STATUS_ENTRIES,
          retentionMs: TERMINAL_RUN_STATUS_RETENTION_MS,
        })
        : { byNodeId: nextByNodeId, prunedIds: [] as string[], nextDelayMs: null as number | null };

      if (isTerminalRunStatus(nextStoredEntry.status)) {
        scheduleTerminalPrune(pruned.nextDelayMs ?? TERMINAL_RUN_STATUS_RETENTION_MS);
      }
      if (pruned.prunedIds.length > 0) {
        recordPerfEvent('run-status.pruned', {
          reason: 'terminal-retention',
          prunedCount: pruned.prunedIds.length,
          retainedCount: Object.keys(pruned.byNodeId).length,
          revision: state.revision + 1,
        }, { source: 'runStatusStore' });
      }

      return {
        revision: state.revision + 1,
        byNodeId: pruned.byNodeId,
      };
    }),

  clearRunStatus: (nodeId) =>
    set((state) => {
      if (!state.byNodeId[nodeId]) return state;
      const next = { ...state.byNodeId };
      const existing = next[nodeId];
      delete next[nodeId];
      recordPerfEvent('run-status.cleared', {
        nodeId,
        workspaceId: existing?.workspaceId ?? null,
        status: existing?.status ?? null,
        revision: state.revision + 1,
      }, { source: 'runStatusStore' });
      return { byNodeId: next, revision: state.revision + 1 };
    }),

  clearAllRunStatus: () => set((state) => (
    Object.keys(state.byNodeId).length === 0
      ? state
      : { byNodeId: {}, revision: state.revision + 1 }
  )),

  pruneTerminalRunStatuses: (
    retentionMs = TERMINAL_RUN_STATUS_RETENTION_MS,
    maxTerminalEntries = MAX_TERMINAL_RUN_STATUS_ENTRIES,
  ) => set((state) => {
    const pruned = pruneTerminalRunStatusEntries(state.byNodeId, {
      retentionMs,
      maxTerminalEntries,
    });
    if (pruned.nextDelayMs !== null) {
      scheduleTerminalPrune(pruned.nextDelayMs);
    }
    if (pruned.prunedIds.length === 0) return state;
    recordPerfEvent('run-status.pruned', {
      reason: 'terminal-retention',
      prunedCount: pruned.prunedIds.length,
      retainedCount: Object.keys(pruned.byNodeId).length,
      revision: state.revision + 1,
    }, { source: 'runStatusStore' });
    return { byNodeId: pruned.byNodeId, revision: state.revision + 1 };
  }),

  getRunningCount: (workspaceId) =>
    Object.values(get().byNodeId).filter((entry) => {
      if (workspaceId && entry.workspaceId !== workspaceId) return false;
      if (entry.role !== 'assistant') return false;
      return entry.status ? ACTIVE_STATUSES.has(entry.status) : false;
    }).length,

  hasHotSendActivity: (workspaceId, terminalGraceMs) => {
    if (!workspaceId) return false;
    const now = Date.now();
    return Object.values(get().byNodeId).some((entry) => {
      if (entry.workspaceId !== workspaceId) return false;
      if (entry.role !== 'assistant') return false;
      if (!entry.status) return true;
      if (!TERMINAL_STATUSES.has(entry.status)) return true;
      const updatedAtMs = Date.parse(entry.updatedAt || '');
      return Number.isFinite(updatedAtMs) && now - updatedAtMs <= terminalGraceMs;
    });
  },
}));
