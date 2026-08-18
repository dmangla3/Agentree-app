import type { QueryClient } from '@tanstack/react-query';
import {
  isGraphInteractionGateIdle,
  scheduleLocalCommitGraphRefreshWhenGraphIdle,
  scheduleMessagesRefreshWhenGraphIdle,
} from '../lib/graphInteractionGate';
import { recordPerfEvent } from '../lib/perfRecorder';
import { runCacheRefreshOperation } from '../lib/cacheRefreshPerf';
import { catchUpHotSendMessageDeltas } from '../hooks/useHotSendMessageDeltas';
import { localNodeKeys } from '../hooks/useLocalNodes';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useWorkspaceStore } from '../stores/workspaceStore';

type PendingWorkspaceRefresh = {
  queryClient: QueryClient;
  workspaceId: string;
  reasons: Set<string>;
  includeCommitGraph: boolean;
  catchUpHotDeltas: boolean;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type PendingCommitGraphRefetch = {
  queryClient: QueryClient;
  workspaceId: string;
  reason: string;
  timer: ReturnType<typeof setTimeout>;
};

export type AgentWorkspaceRefreshOptions = {
  reason: string;
  includeCommitGraph?: boolean;
  catchUpHotDeltas?: boolean;
  debounceMs?: number;
};

const COMMIT_GRAPH_REFETCH_RECHECK_MS = 900;
const WORKSPACE_REFRESH_BUSY_RECHECK_MS = 250;
const WORKSPACE_REFRESH_BUSY_MAX_WAIT_MS = 3_000;
const pendingByWorkspace = new Map<string, PendingWorkspaceRefresh>();
const pendingCommitGraphRefetchByWorkspace = new Map<string, PendingCommitGraphRefetch>();

const hasActiveWorkspaceRunState = (workspaceId: string) => {
  const runStatusStore = useRunStatusStore.getState();
  if (runStatusStore.getRunningCount(workspaceId) > 0) return true;
  if (runStatusStore.hasHotSendActivity(workspaceId, 5_000)) return true;
  return useWorkspaceStore.getState().activeSendFlowFocus?.workspaceId === workspaceId;
};

const flushCommitGraphRefetch = (
  workspaceId: string,
  options: { force?: boolean } = {},
) => {
  const pending = pendingCommitGraphRefetchByWorkspace.get(workspaceId);
  if (!pending) return;

  if (!options.force && hasActiveWorkspaceRunState(workspaceId)) {
    recordPerfEvent('query.local-commit-graph.refetch.wait-active', {
      workspaceId,
      reason: pending.reason,
      refetchActive: false,
    }, { source: 'agentRunWorkspaceRefresh' });
    pending.timer = setTimeout(() => flushCommitGraphRefetch(workspaceId), COMMIT_GRAPH_REFETCH_RECHECK_MS);
    return;
  }

  pendingCommitGraphRefetchByWorkspace.delete(workspaceId);

  recordPerfEvent('query.local-commit-graph.refetch.deferred', {
    workspaceId,
    reason: pending.reason,
    refetchActive: true,
  }, { source: 'agentRunWorkspaceRefresh' });

  void scheduleLocalCommitGraphRefreshWhenGraphIdle(pending.queryClient, workspaceId, {
    reason: pending.reason,
  });
};

const scheduleCommitGraphRefetch = (
  queryClient: QueryClient,
  workspaceId: string,
  reason: string,
) => {
  const existing = pendingCommitGraphRefetchByWorkspace.get(workspaceId);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => flushCommitGraphRefetch(workspaceId), COMMIT_GRAPH_REFETCH_RECHECK_MS);
  pendingCommitGraphRefetchByWorkspace.set(workspaceId, {
    queryClient,
    workspaceId,
    reason: existing?.reason && existing.reason !== reason ? `${existing.reason}+${reason}` : reason,
    timer,
  });
};

const flushWorkspaceRefresh = (
  workspaceId: string,
  options: { force?: boolean } = {},
) => {
  const pending = pendingByWorkspace.get(workspaceId);
  if (!pending) return;

  const pendingAgeMs = Date.now() - pending.createdAt;
  const activeRunCount = useRunStatusStore.getState().getRunningCount(workspaceId);
  const waitForActiveRun = activeRunCount > 0 || useWorkspaceStore.getState().activeSendFlowFocus?.workspaceId === workspaceId;
  const waitForGraphIdle = !isGraphInteractionGateIdle();
  if (
    !options.force &&
    (waitForActiveRun || waitForGraphIdle) &&
    pendingAgeMs < WORKSPACE_REFRESH_BUSY_MAX_WAIT_MS
  ) {
    const reason = Array.from(pending.reasons).join('+') || 'agent-run';
    recordPerfEvent('query.agent-workspace-refresh.wait-responsive-idle', {
      workspaceId,
      reason,
      includeCommitGraph: pending.includeCommitGraph,
      catchUpHotDeltas: pending.catchUpHotDeltas,
      pendingAgeMs,
      activeRunCount,
      waitForActiveRun,
      waitForGraphIdle,
    }, { source: 'agentRunWorkspaceRefresh' });
    pending.timer = setTimeout(
      () => flushWorkspaceRefresh(workspaceId),
      WORKSPACE_REFRESH_BUSY_RECHECK_MS,
    );
    return;
  }

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
      refetchActive: false,
      refetchMode: 'deferred',
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
    scheduleCommitGraphRefetch(pending.queryClient, workspaceId, reason);
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
    createdAt: Date.now(),
    timer: setTimeout(() => flushWorkspaceRefresh(workspaceId), debounceMs),
  };
  pendingByWorkspace.set(workspaceId, pending);
};

export const flushAgentWorkspaceRefreshesForTest = () => {
  for (const workspaceId of Array.from(pendingByWorkspace.keys())) {
    const pending = pendingByWorkspace.get(workspaceId);
    if (pending) clearTimeout(pending.timer);
    flushWorkspaceRefresh(workspaceId, { force: true });
  }
  for (const workspaceId of Array.from(pendingCommitGraphRefetchByWorkspace.keys())) {
    const pending = pendingCommitGraphRefetchByWorkspace.get(workspaceId);
    if (pending) clearTimeout(pending.timer);
    flushCommitGraphRefetch(workspaceId, { force: true });
  }
};
