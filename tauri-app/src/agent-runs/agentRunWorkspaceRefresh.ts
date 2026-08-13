import type { QueryClient } from '@tanstack/react-query';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { recordPerfEvent } from '../lib/perfRecorder';
import { runCacheRefreshOperation } from '../lib/cacheRefreshPerf';
import { catchUpHotSendMessageDeltas } from '../hooks/useHotSendMessageDeltas';
import { localNodeKeys } from '../hooks/useLocalNodes';

type PendingWorkspaceRefresh = {
  queryClient: QueryClient;
  workspaceId: string;
  reasons: Set<string>;
  includeCommitGraph: boolean;
  catchUpHotDeltas: boolean;
  timer: ReturnType<typeof setTimeout>;
};

export type AgentWorkspaceRefreshOptions = {
  reason: string;
  includeCommitGraph?: boolean;
  catchUpHotDeltas?: boolean;
  debounceMs?: number;
};

const pendingByWorkspace = new Map<string, PendingWorkspaceRefresh>();

const flushWorkspaceRefresh = (workspaceId: string) => {
  const pending = pendingByWorkspace.get(workspaceId);
  if (!pending) return;
  pendingByWorkspace.delete(workspaceId);

  const reason = Array.from(pending.reasons).join('+') || 'agent-run';
  void runCacheRefreshOperation({
    phase: 'local-nodes.invalidate',
    workspaceId,
    reason,
    queryKey: localNodeKeys.workspace(workspaceId),
    refetchType: 'none',
    source: 'agentRunWorkspaceRefresh',
  }, () => pending.queryClient.invalidateQueries({
    queryKey: localNodeKeys.workspace(workspaceId),
    refetchType: 'none',
  }));
  void scheduleMessagesRefreshWhenGraphIdle(pending.queryClient, workspaceId, { reason });

  if (pending.includeCommitGraph) {
    recordPerfEvent('query.local-commit-graph.refresh', {
      workspaceId,
      reason,
      refetchActive: true,
    }, { source: 'agentRunWorkspaceRefresh' });

    void runCacheRefreshOperation({
      phase: 'local-commit-graph.invalidate',
      workspaceId,
      reason,
      queryKey: ['local-commit-graph', workspaceId],
      refetchType: 'none',
      source: 'agentRunWorkspaceRefresh',
    }, () => pending.queryClient.invalidateQueries({
      queryKey: ['local-commit-graph', workspaceId],
      refetchType: 'none',
    }));
    void runCacheRefreshOperation({
      phase: 'local-commits.invalidate',
      workspaceId,
      reason,
      queryKey: ['local-commits', workspaceId],
      refetchType: 'none',
      source: 'agentRunWorkspaceRefresh',
    }, () => pending.queryClient.invalidateQueries({
      queryKey: ['local-commits', workspaceId],
      refetchType: 'none',
    }));
    void runCacheRefreshOperation({
      phase: 'local-commit-graph.refetch',
      workspaceId,
      reason,
      queryKey: ['local-commit-graph', workspaceId],
      refetchType: 'active',
      source: 'agentRunWorkspaceRefresh',
    }, () => pending.queryClient.refetchQueries({
      queryKey: ['local-commit-graph', workspaceId],
      type: 'active',
    }));
    void runCacheRefreshOperation({
      phase: 'local-commits.refetch',
      workspaceId,
      reason,
      queryKey: ['local-commits', workspaceId],
      refetchType: 'active',
      source: 'agentRunWorkspaceRefresh',
    }, () => pending.queryClient.refetchQueries({
      queryKey: ['local-commits', workspaceId],
      type: 'active',
    }));
  }

  if (pending.catchUpHotDeltas) {
    void runCacheRefreshOperation({
      phase: 'hot-send-deltas.catch-up',
      workspaceId,
      reason,
      source: 'agentRunWorkspaceRefresh',
    }, () => catchUpHotSendMessageDeltas(pending.queryClient, workspaceId));
  }
};

export const requestAgentWorkspaceRefresh = (
  queryClient: QueryClient,
  workspaceId: string | null | undefined,
  options: AgentWorkspaceRefreshOptions,
) => {
  if (!workspaceId) return;

  const existing = pendingByWorkspace.get(workspaceId);
  if (existing) {
    existing.queryClient = queryClient;
    existing.reasons.add(options.reason);
    existing.includeCommitGraph = existing.includeCommitGraph || Boolean(options.includeCommitGraph);
    existing.catchUpHotDeltas = existing.catchUpHotDeltas || Boolean(options.catchUpHotDeltas);
    return;
  }

  const debounceMs = options.debounceMs ?? 50;
  const pending: PendingWorkspaceRefresh = {
    queryClient,
    workspaceId,
    reasons: new Set([options.reason]),
    includeCommitGraph: Boolean(options.includeCommitGraph),
    catchUpHotDeltas: Boolean(options.catchUpHotDeltas),
    timer: setTimeout(() => flushWorkspaceRefresh(workspaceId), debounceMs),
  };
  pendingByWorkspace.set(workspaceId, pending);
};

export const flushAgentWorkspaceRefreshesForTest = () => {
  for (const workspaceId of Array.from(pendingByWorkspace.keys())) {
    const pending = pendingByWorkspace.get(workspaceId);
    if (pending) clearTimeout(pending.timer);
    flushWorkspaceRefresh(workspaceId);
  }
};
