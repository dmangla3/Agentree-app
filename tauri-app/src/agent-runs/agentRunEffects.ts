import type { QueryClient } from '@tanstack/react-query';
import { isTerminalAgentRunStatus } from './agentRun.machine';
import { patchFinalizedGraphSnapshot, patchFinalizedLocalNodes, patchFinalizedMessages } from './agentRunFinalizeCache';
import { projectAgentRunStatus, projectAgentRunToProjectedMessage } from './agentRunProjection';
import { requestAgentWorkspaceRefresh } from './agentRunWorkspaceRefresh';
import type { AgentRunSnapshot } from './agentRun.types';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { localNodeKeys, type LocalNodeMessage } from '../hooks/useLocalNodes';
import { threadSessionKeys } from '../hooks/useThreadSessions';
import type { GraphSnapshot } from '../hooks/useGraphSnapshot';
import type { ThreadSession } from '../lib/threadSessions';
import type { Message } from '../stores/workspaceStore';

const CLEANUP_DELAY_MS = 3000;

const cleanupTimers = new Map<string, number>();
const finalizeEffectKeys = new Map<string, string>();
const queryClientRefs = new Map<QueryClient, number>();
let activeQueryClient: QueryClient | null = null;

const lastRegisteredQueryClient = () => {
  let last: QueryClient | null = null;
  for (const queryClient of queryClientRefs.keys()) {
    last = queryClient;
  }
  return last;
};

export const registerAgentRunEffectsQueryClient = (queryClient: QueryClient) => {
  queryClientRefs.set(queryClient, (queryClientRefs.get(queryClient) ?? 0) + 1);
  activeQueryClient = queryClient;

  return () => {
    const nextCount = (queryClientRefs.get(queryClient) ?? 0) - 1;
    if (nextCount > 0) {
      queryClientRefs.set(queryClient, nextCount);
      return;
    }
    queryClientRefs.delete(queryClient);
    if (activeQueryClient === queryClient) {
      activeQueryClient = lastRegisteredQueryClient();
    }
  };
};

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const readTerminalPatch = (snapshot: AgentRunSnapshot) => {
  const ack = snapshot.finalizeAck;
  const executionData = (snapshot.executionData ?? {}) as Record<string, any>;
  const meta = ((executionData.meta ?? {}) as Record<string, any>);
  const status = ack?.status ?? snapshot.terminalStatus ?? snapshot.status;
  if (!isTerminalAgentRunStatus(status)) return null;
  const terminalStatus = status as string;
  const outputCommitSha = ack?.outputCommitSha
    ?? cleanString(executionData.output_commit_sha)
    ?? cleanString(meta.output_commit_sha)
    ?? null;
  const gitBranchName = ack?.gitBranchName
    ?? cleanString(executionData.git_branch_name)
    ?? cleanString(meta.git_branch_name)
    ?? null;
  return {
    nodeId: snapshot.nodeId,
    status: terminalStatus,
    outputCommitSha,
    gitBranchName,
    commitCreated: ack?.commitCreated ?? (typeof meta.commit_created === 'boolean' ? meta.commit_created : null),
    persisted: ack?.persisted ?? (typeof meta.persisted === 'boolean' ? meta.persisted : null),
    serverAckAt: ack?.serverAckAt ?? meta.server_ack_at ?? null,
    updatedAt: snapshot.updatedAt || new Date().toISOString(),
  };
};

const readGeneratedThreadTitle = (snapshot: AgentRunSnapshot): string | null => {
  const executionData = (snapshot.executionData ?? {}) as Record<string, any>;
  const meta = ((executionData.meta ?? {}) as Record<string, any>);
  return cleanString(meta.thread_title)
    ?? cleanString(meta.threadTitle)
    ?? cleanString(meta.agent_thread_title)
    ?? cleanString(meta.runtime_thread_title);
};

const readSnapshotThreadId = (snapshot: AgentRunSnapshot): string | null => (
  cleanString(snapshot.message?.threadId)
    ?? cleanString(snapshot.message?.thread_id)
);

const shouldPatchThreadTitle = (
  thread: Pick<ThreadSession, 'id' | 'title' | 'firstMessageId'>,
  snapshot: AgentRunSnapshot,
): boolean => {
  if (cleanString(thread.title)) return false;
  const snapshotThreadId = readSnapshotThreadId(snapshot);
  if (snapshotThreadId && thread.id === snapshotThreadId) return true;
  return Boolean(snapshot.parentId && thread.firstMessageId === snapshot.parentId);
};

const patchGeneratedThreadTitle = <T extends Pick<ThreadSession, 'id' | 'title' | 'firstMessageId' | 'updatedAt'>>(
  current: T[] | undefined,
  snapshot: AgentRunSnapshot,
  generatedThreadTitle: string,
): T[] | undefined => {
  if (!current) return current;
  let changed = false;
  const next = current.map((thread) => {
    if (!shouldPatchThreadTitle(thread, snapshot)) return thread;
    changed = true;
    return {
      ...thread,
      title: generatedThreadTitle,
      updatedAt: snapshot.updatedAt || thread.updatedAt,
    };
  });
  return changed ? next : current;
};

const patchGeneratedGraphSnapshotThreadTitle = (
  current: GraphSnapshot | undefined,
  snapshot: AgentRunSnapshot,
  generatedThreadTitle: string,
): GraphSnapshot | undefined => {
  if (!current || !Array.isArray(current.threadSessions)) return current;
  const threadSessions = patchGeneratedThreadTitle(current.threadSessions, snapshot, generatedThreadTitle);
  if (threadSessions === current.threadSessions) return current;
  return {
    ...current,
    threadSessions,
  };
};

const finalizeEffectKey = (snapshot: AgentRunSnapshot) => {
  const patch = readTerminalPatch(snapshot);
  if (!patch) return null;
  const generatedThreadTitle = readGeneratedThreadTitle(snapshot);
  return JSON.stringify({
    nodeId: patch.nodeId,
    workspaceId: snapshot.workspaceId,
    status: patch.status,
    outputCommitSha: patch.outputCommitSha,
    commitCreated: patch.commitCreated,
    gitBranchName: patch.gitBranchName,
    persisted: patch.persisted,
    serverAckAt: patch.serverAckAt,
    generatedThreadTitle,
  });
};

export const applyAgentRunFinalizeSnapshotEffects = (
  snapshot: AgentRunSnapshot,
  options: { force?: boolean } = {},
) => {
  const queryClient = activeQueryClient;
  const cachePatch = readTerminalPatch(snapshot);
  if (!queryClient || !snapshot.workspaceId || !cachePatch) return;

  const key = finalizeEffectKey(snapshot);
  if (!key || (!options.force && finalizeEffectKeys.get(snapshot.nodeId) === key)) return;
  finalizeEffectKeys.set(snapshot.nodeId, key);

  queryClient.setQueryData<Message[]>(
    ['messages', snapshot.workspaceId],
    (current) => patchFinalizedMessages(current, cachePatch),
  );
  queryClient.setQueryData<LocalNodeMessage[]>(
    localNodeKeys.workspace(snapshot.workspaceId),
    (current) => patchFinalizedLocalNodes(current, cachePatch),
  );
  queryClient.setQueryData<GraphSnapshot>(
    ['graph-snapshot', snapshot.workspaceId],
    (current) => patchFinalizedGraphSnapshot(current, cachePatch),
  );
  requestAgentWorkspaceRefresh(queryClient, snapshot.workspaceId, {
    reason: 'agent-finalize-ack',
    includeCommitGraph: Boolean(cachePatch.outputCommitSha),
    catchUpHotDeltas: Boolean(cachePatch.outputCommitSha),
  });
  const generatedThreadTitle = readGeneratedThreadTitle(snapshot);
  if (generatedThreadTitle) {
    queryClient.setQueryData<ThreadSession[]>(
      threadSessionKeys.workspace(snapshot.workspaceId),
      (current) => patchGeneratedThreadTitle(current, snapshot, generatedThreadTitle),
    );
    queryClient.setQueryData<GraphSnapshot>(
      ['graph-snapshot', snapshot.workspaceId],
      (current) => patchGeneratedGraphSnapshotThreadTitle(current, snapshot, generatedThreadTitle),
    );
    void queryClient.invalidateQueries({
      queryKey: threadSessionKeys.workspace(snapshot.workspaceId),
      refetchType: 'active',
    });
  }
};

export const clearAgentRunEffectsForNode = (nodeId: string) => {
  finalizeEffectKeys.delete(nodeId);
};

export const resetAgentRunEffectsForTest = () => {
  finalizeEffectKeys.clear();
  queryClientRefs.clear();
  activeQueryClient = null;
};

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

export const projectAgentRunStatusSnapshot = (snapshot: AgentRunSnapshot) => {
  if (snapshot.phase === 'cleanup') {
    if (!isTerminalAgentRunStatus(snapshot.status)) {
      useRunStatusStore.getState().clearRunStatus(snapshot.nodeId);
    }
    return;
  }

  useRunStatusStore.getState().setRunStatus(snapshot.nodeId, projectAgentRunStatus(snapshot));
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
