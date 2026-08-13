import type { QueryClient } from '@tanstack/react-query';
import { recordPerfEvent } from './perfRecorder';
import { runCacheRefreshOperation } from './cacheRefreshPerf';

const GRAPH_INTERACTION_IDLE_MS = 900;
const GRAPH_INTERACTION_STALE_MS = 12_000;

let activeInteractionCount = 0;
let lastInteractionAt = 0;
let idleTimer: number | null = null;
let nextInteractionToken = 1;

type ActiveInteraction = {
  reason: string;
  startedAt: number;
  staleTimer: number | null;
};

const activeInteractions = new Map<number, ActiveInteraction>();

type PendingMessageRefresh = {
  queryClient: QueryClient;
  workspaceId: string;
  refetchActive: boolean;
  reason?: string;
};

const pendingMessageRefreshes = new Map<string, PendingMessageRefresh>();

type PendingStructuralRefresh = {
  queryClient: QueryClient;
  workspaceId: string;
  refetchActiveMessages: boolean;
  reason?: string;
  includeBranches: boolean;
  includeWorkspaces: boolean;
};

const pendingStructuralRefreshes = new Map<string, PendingStructuralRefresh>();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const isGraphInteractionIdle = () => {
  if (activeInteractionCount > 0) return false;
  return now() - lastInteractionAt >= GRAPH_INTERACTION_IDLE_MS;
};

const flushPendingMessageRefreshes = async () => {
  if (!isGraphInteractionIdle()) return;

  const pendingMessages = Array.from(pendingMessageRefreshes.values());
  pendingMessageRefreshes.clear();
  await Promise.all(pendingMessages.map(async ({ queryClient, workspaceId, refetchActive, reason }) => {
    recordPerfEvent('query.messages.refresh.flushed', {
      workspaceId,
      reason: reason ?? null,
      refetchActive,
      refetchType: refetchActive ? 'active' : 'none',
    }, { source: 'graphInteractionGate' });
    await runCacheRefreshOperation({
      phase: 'messages.invalidate.flushed',
      workspaceId,
      reason: reason ?? null,
      queryKey: ['messages', workspaceId],
      refetchType: refetchActive ? 'active' : 'none',
      source: 'graphInteractionGate',
    }, () => queryClient.invalidateQueries({
      queryKey: ['messages', workspaceId],
      refetchType: refetchActive ? 'active' : 'none',
    }));
  }));

  const pendingStructural = Array.from(pendingStructuralRefreshes.values());
  pendingStructuralRefreshes.clear();
  await Promise.all(pendingStructural.map(async ({
    queryClient,
    workspaceId,
    refetchActiveMessages,
    reason,
    includeBranches,
    includeWorkspaces,
  }) => {
    recordPerfEvent('query.workspace-structural-refresh.flushed', {
      workspaceId,
      reason: reason ?? null,
      refetchActiveMessages,
      includeBranches,
      includeWorkspaces,
    }, { source: 'graphInteractionGate' });
    await runCacheRefreshOperation({
      phase: 'graph-snapshot.invalidate.structural',
      workspaceId,
      reason: reason ?? null,
      queryKey: ['graph-snapshot', workspaceId],
      refetchType: refetchActiveMessages ? 'active' : 'none',
      source: 'graphInteractionGate',
    }, () => queryClient.invalidateQueries({
      queryKey: ['graph-snapshot', workspaceId],
      refetchType: refetchActiveMessages ? 'active' : 'none',
    }));
    await runCacheRefreshOperation({
      phase: 'messages.invalidate.structural',
      workspaceId,
      reason: reason ?? null,
      queryKey: ['messages', workspaceId],
      refetchType: refetchActiveMessages ? 'active' : 'none',
      source: 'graphInteractionGate',
    }, () => queryClient.invalidateQueries({
      queryKey: ['messages', workspaceId],
      refetchType: refetchActiveMessages ? 'active' : 'none',
    }));
    if (includeBranches) {
      await runCacheRefreshOperation({
        phase: 'branches.invalidate.structural',
        workspaceId,
        reason: reason ?? null,
        queryKey: ['branches', workspaceId],
        source: 'graphInteractionGate',
      }, () => queryClient.invalidateQueries({ queryKey: ['branches', workspaceId] }));
      await runCacheRefreshOperation({
        phase: 'tracked-git-refs.invalidate.structural',
        workspaceId,
        reason: reason ?? null,
        queryKey: ['tracked-git-refs', workspaceId],
        source: 'graphInteractionGate',
      }, () => queryClient.invalidateQueries({ queryKey: ['tracked-git-refs', workspaceId] }));
    }
    if (includeWorkspaces) {
      await runCacheRefreshOperation({
        phase: 'workspaces.invalidate.structural',
        workspaceId,
        reason: reason ?? null,
        queryKey: ['workspaces'],
        source: 'graphInteractionGate',
      }, () => queryClient.invalidateQueries({ queryKey: ['workspaces'] }));
    }
  }));
};

const scheduleIdleFlush = () => {
  if (typeof window === 'undefined') return;
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
  }
  const delayMs = Math.max(0, GRAPH_INTERACTION_IDLE_MS - (now() - lastInteractionAt));
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    void flushPendingMessageRefreshes();
  }, delayMs);
};

const clearInteractionTimer = (interaction: ActiveInteraction) => {
  if (typeof window === 'undefined' || interaction.staleTimer === null) return;
  window.clearTimeout(interaction.staleTimer);
};

const findLatestInteractionToken = (reason: string) => {
  let latestToken: number | null = null;
  for (const [token, interaction] of activeInteractions) {
    if (interaction.reason === reason) {
      latestToken = token;
    }
  }
  return latestToken;
};

export const markGraphInteractionStart = (reason: string) => {
  activeInteractionCount += 1;
  lastInteractionAt = now();
  const token = nextInteractionToken++;
  const startedAt = lastInteractionAt;
  const interaction: ActiveInteraction = {
    reason,
    startedAt,
    staleTimer: null,
  };
  activeInteractions.set(token, interaction);

  if (typeof window !== 'undefined') {
    interaction.staleTimer = window.setTimeout(() => {
      if (!activeInteractions.delete(token)) return;
      activeInteractionCount = Math.max(0, activeInteractionCount - 1);
      lastInteractionAt = now();
      recordPerfEvent('graph.interaction-gate.stale-ended', {
        reason,
        activeInteractionCount,
        staleMs: Number((lastInteractionAt - startedAt).toFixed(2)),
      }, { source: 'graphInteractionGate' });
      scheduleIdleFlush();
    }, GRAPH_INTERACTION_STALE_MS);
  }

  recordPerfEvent('graph.interaction-gate.start', {
    reason,
    activeInteractionCount,
    token,
  }, { source: 'graphInteractionGate' });
};

export const markGraphInteractionEnd = (reason: string) => {
  const token = findLatestInteractionToken(reason);
  if (token === null) {
    recordPerfEvent('graph.interaction-gate.end.ignored', {
      reason,
      activeInteractionCount,
    }, { source: 'graphInteractionGate' });
    scheduleIdleFlush();
    return;
  }

  const interaction = activeInteractions.get(token);
  if (interaction) {
    clearInteractionTimer(interaction);
    activeInteractions.delete(token);
  }
  activeInteractionCount = Math.max(0, activeInteractionCount - 1);
  lastInteractionAt = now();
  recordPerfEvent('graph.interaction-gate.end', {
    reason,
    activeInteractionCount,
    token,
  }, { source: 'graphInteractionGate' });
  scheduleIdleFlush();
};

export const scheduleMessagesRefreshWhenGraphIdle = async (
  queryClient: QueryClient,
  workspaceId: string | null | undefined,
  options: { refetchActive?: boolean; reason?: string } = {}
) => {
  if (!workspaceId) return;

  if (isGraphInteractionIdle()) {
    recordPerfEvent('query.messages.refresh.immediate', {
      workspaceId,
      reason: options.reason ?? null,
      refetchActive: Boolean(options.refetchActive),
      refetchType: options.refetchActive ? 'active' : 'none',
    }, { source: 'graphInteractionGate' });
    await runCacheRefreshOperation({
      phase: 'messages.invalidate.immediate',
      workspaceId,
      reason: options.reason ?? null,
      queryKey: ['messages', workspaceId],
      refetchType: options.refetchActive ? 'active' : 'none',
      source: 'graphInteractionGate',
    }, () => queryClient.invalidateQueries({
      queryKey: ['messages', workspaceId],
      refetchType: options.refetchActive ? 'active' : 'none',
    }));
    return;
  }

  pendingMessageRefreshes.set(workspaceId, {
    queryClient,
    workspaceId,
    refetchActive: Boolean(options.refetchActive),
    reason: options.reason,
  });
  recordPerfEvent('query.messages.refresh.deferred', {
    workspaceId,
    reason: options.reason ?? null,
    refetchActive: Boolean(options.refetchActive),
    activeInteractionCount,
    msSinceLastInteraction: Number((now() - lastInteractionAt).toFixed(2)),
  }, { source: 'graphInteractionGate' });
  scheduleIdleFlush();
};

export const scheduleWorkspaceStructuralRefreshWhenGraphIdle = async (
  queryClient: QueryClient,
  workspaceId: string | null | undefined,
  options: {
    refetchActiveMessages?: boolean;
    reason?: string;
    includeBranches?: boolean;
    includeWorkspaces?: boolean;
  } = {}
) => {
  if (!workspaceId) return;

  const merged = pendingStructuralRefreshes.get(workspaceId);
  const next: PendingStructuralRefresh = {
    queryClient,
    workspaceId,
    refetchActiveMessages: Boolean(options.refetchActiveMessages) || merged?.refetchActiveMessages || false,
    reason: options.reason ?? merged?.reason,
    includeBranches: Boolean(options.includeBranches) || merged?.includeBranches || false,
    includeWorkspaces: Boolean(options.includeWorkspaces) || merged?.includeWorkspaces || false,
  };

  if (isGraphInteractionIdle()) {
    pendingStructuralRefreshes.set(workspaceId, next);
    await flushPendingMessageRefreshes();
    return;
  }

  pendingStructuralRefreshes.set(workspaceId, next);
  recordPerfEvent('query.workspace-structural-refresh.deferred', {
    workspaceId,
    reason: options.reason ?? null,
    refetchActiveMessages: Boolean(options.refetchActiveMessages),
    includeBranches: Boolean(options.includeBranches),
    includeWorkspaces: Boolean(options.includeWorkspaces),
    activeInteractionCount,
    msSinceLastInteraction: Number((now() - lastInteractionAt).toFixed(2)),
  }, { source: 'graphInteractionGate' });
  scheduleIdleFlush();
};
