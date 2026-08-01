import { isTerminalAgentRunStatus } from './agentRun.machine';
import { projectAgentRunStatus, projectAgentRunToProjectedMessage } from './agentRunProjection';
import type { AgentRunSnapshot } from './agentRun.types';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';

const CLEANUP_DELAY_MS = 3000;

const cleanupTimers = new Map<string, number>();

/**
 * The single bridge from AgentRunActor snapshots into Zustand projection caches.
 *
 * Keep lifecycle decisions in agentRun.machine.ts / agentRunManager.ts. This
 * file is allowed to mutate agentRunProjectionStore and runStatusStore because
 * it is applying actor-owned state to render-facing caches.
 */
export const projectAgentRunSnapshot = (snapshot: AgentRunSnapshot) => {
  if (snapshot.phase === 'cleanup') {
    clearAgentRunProjection(snapshot.nodeId, {
      clearRunStatus: !isTerminalAgentRunStatus(snapshot.status),
    });
    return;
  }

  const existing = useAgentRunProjectionStore.getState().projectionsById[snapshot.nodeId] ?? null;
  useAgentRunProjectionStore.getState().setProjectionForNode(
    snapshot.nodeId,
    projectAgentRunToProjectedMessage(snapshot, existing),
  );
  useRunStatusStore.getState().setRunStatus(snapshot.nodeId, projectAgentRunStatus(snapshot));

  if (isTerminalAgentRunStatus(snapshot.status)) {
    const existingTimer = cleanupTimers.get(snapshot.nodeId);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }
    const delayMs = Math.max(0, (snapshot.terminalHoldUntil ?? Date.now() + CLEANUP_DELAY_MS) - Date.now());
    const timer = window.setTimeout(() => {
      cleanupTimers.delete(snapshot.nodeId);
      clearAgentRunProjection(snapshot.nodeId, { clearRunStatus: false });
    }, delayMs);
    cleanupTimers.set(snapshot.nodeId, timer);
  }
};

export const clearAgentRunProjection = (
  nodeId: string,
  options: { clearRunStatus?: boolean } = {},
) => {
  const timer = cleanupTimers.get(nodeId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    cleanupTimers.delete(nodeId);
  }
  useAgentRunProjectionStore.getState().clearProjectionForNode(nodeId);
  if (options.clearRunStatus ?? true) {
    useRunStatusStore.getState().clearRunStatus(nodeId);
  }
};
