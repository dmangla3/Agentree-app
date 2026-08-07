import { createActor, type ActorRefFrom } from 'xstate';
import { agentRunMachine, isTerminalAgentRunStatus, reduceAgentRunSnapshot } from './agentRun.machine';
import { normalizeAgentAdapterEventForRun } from './agentRunEventNormalizer';
import { clearAgentRunProjection, projectAgentRunSnapshot, projectAgentRunStatusSnapshot } from './agentRunEffects';
import { logAgentRunTransition } from './agentRunDebug';
import type { AgentRunEvent, AgentRunInput, AgentRunSnapshot } from './agentRun.types';
import type { Message } from '../stores/workspaceStore';

type AgentRunActor = ActorRefFrom<typeof agentRunMachine>;
type ProjectionWatchReason = 'chat-focus' | 'hover' | 'recent-send' | 'terminal-hold' | string;

interface ManagedRun {
  actor: AgentRunActor;
  previous: AgentRunSnapshot;
  unsubscribe: { unsubscribe: () => void };
}

const actors = new Map<string, ManagedRun>();
const projectionWatchers = new Map<string, Set<ProjectionWatchReason>>();
const CONTENT_PROJECTION_THROTTLE_MS = 140;
const RECENT_SEND_PROJECTION_MS = 10_000;
const dirtyProjectionNodeIds = new Set<string>();
let projectionFlushTimer: number | null = null;
const lastProjectionAt = new Map<string, number>();
const recentSendProjectionTimers = new Map<string, number>();
const terminalHoldProjectionTimers = new Map<string, number>();

const snapshotProjectionKey = (snapshot: AgentRunSnapshot) => JSON.stringify({
  nodeId: snapshot.nodeId,
  workspaceId: snapshot.workspaceId,
  parentId: snapshot.parentId,
  role: snapshot.role,
  agentId: snapshot.agentId,
  runId: snapshot.runId,
  phase: snapshot.phase,
  status: snapshot.status,
  progress: snapshot.progress,
  contentLength: snapshot.content.length,
  contentTail: snapshot.content.slice(-160),
  timelineLength: snapshot.timeline.length,
  usage: snapshot.usage,
  terminalStatus: snapshot.terminalStatus,
  terminalReason: snapshot.terminalReason,
  terminalHoldUntil: snapshot.terminalHoldUntil,
  cleanupAt: snapshot.cleanupAt,
});

const shouldProjectSnapshot = (
  previous: AgentRunSnapshot,
  next: AgentRunSnapshot,
  event: AgentRunEvent,
) => {
  if (event.type === 'cleanup' || event.type === 'remove') return true;
  return snapshotProjectionKey(previous) !== snapshotProjectionKey(next);
};

const snapshotStatusProjectionKey = (snapshot: AgentRunSnapshot) => JSON.stringify({
  nodeId: snapshot.nodeId,
  workspaceId: snapshot.workspaceId,
  role: snapshot.role,
  status: snapshot.status,
  progress: snapshot.progress,
});

const shouldProjectStatusSnapshot = (previous: AgentRunSnapshot, next: AgentRunSnapshot) => (
  snapshotStatusProjectionKey(previous) !== snapshotStatusProjectionKey(next)
);

const hasProjectionWatchers = (nodeId: string) => (
  (projectionWatchers.get(nodeId)?.size ?? 0) > 0
);

const clearProjectionTimer = (nodeId: string) => {
  dirtyProjectionNodeIds.delete(nodeId);
  if (dirtyProjectionNodeIds.size > 0 || projectionFlushTimer === null) return;
  window.clearTimeout(projectionFlushTimer);
  projectionFlushTimer = null;
};

const projectManagedSnapshot = (nodeId: string) => {
  clearProjectionTimer(nodeId);
  const snapshot = actors.get(nodeId)?.actor.getSnapshot().context.snapshot;
  if (!snapshot) return;
  projectAgentRunSnapshot(snapshot);
  lastProjectionAt.set(nodeId, performance.now());
};

const watchProjection = (nodeId: string, reason: ProjectionWatchReason) => {
  const watchers = projectionWatchers.get(nodeId) ?? new Set<ProjectionWatchReason>();
  watchers.add(reason);
  projectionWatchers.set(nodeId, watchers);
  projectManagedSnapshot(nodeId);
};

const unwatchProjection = (nodeId: string, reason: ProjectionWatchReason) => {
  const watchers = projectionWatchers.get(nodeId);
  if (!watchers) return;
  watchers.delete(reason);
  if (watchers.size === 0) {
    projectionWatchers.delete(nodeId);
  }
};

const clearRecentSendProjectionTimer = (nodeId: string) => {
  const timer = recentSendProjectionTimers.get(nodeId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    recentSendProjectionTimers.delete(nodeId);
  }
};

const clearTerminalHoldProjectionTimer = (nodeId: string) => {
  const timer = terminalHoldProjectionTimers.get(nodeId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    terminalHoldProjectionTimers.delete(nodeId);
  }
};

const watchRecentSendProjection = (nodeId: string) => {
  clearRecentSendProjectionTimer(nodeId);
  watchProjection(nodeId, 'recent-send');
  const timer = window.setTimeout(() => {
    recentSendProjectionTimers.delete(nodeId);
    unwatchProjection(nodeId, 'recent-send');
  }, RECENT_SEND_PROJECTION_MS);
  recentSendProjectionTimers.set(nodeId, timer);
};

const watchTerminalHoldProjection = (nodeId: string, snapshot: AgentRunSnapshot) => {
  clearTerminalHoldProjectionTimer(nodeId);
  watchProjection(nodeId, 'terminal-hold');
  const delayMs = Math.max(0, (snapshot.terminalHoldUntil ?? Date.now() + 3000) - Date.now());
  const timer = window.setTimeout(() => {
    terminalHoldProjectionTimers.delete(nodeId);
    unwatchProjection(nodeId, 'terminal-hold');
  }, delayMs);
  terminalHoldProjectionTimers.set(nodeId, timer);
};

const flushProjectedSnapshots = () => {
  projectionFlushTimer = null;
  const nodeIds = Array.from(dirtyProjectionNodeIds);
  dirtyProjectionNodeIds.clear();
  for (const nodeId of nodeIds) {
    if (hasProjectionWatchers(nodeId)) {
      projectManagedSnapshot(nodeId);
    }
  }
};

const shouldThrottleProjection = (
  previous: AgentRunSnapshot,
  next: AgentRunSnapshot,
  event: AgentRunEvent,
) => (
  event.type === 'content' &&
  previous.status === next.status &&
  previous.phase === next.phase
);

const scheduleProjectedSnapshot = (nodeId: string) => {
  dirtyProjectionNodeIds.add(nodeId);
  const elapsed = performance.now() - (lastProjectionAt.get(nodeId) ?? 0);
  const delayMs = Math.max(0, CONTENT_PROJECTION_THROTTLE_MS - elapsed);
  if (projectionFlushTimer !== null) {
    if (delayMs === 0) {
      window.clearTimeout(projectionFlushTimer);
      flushProjectedSnapshots();
    }
    return;
  }
  if (delayMs === 0) {
    flushProjectedSnapshots();
    return;
  }

  projectionFlushTimer = window.setTimeout(flushProjectedSnapshots, delayMs);
};

const inputFromMessage = (message: Message, runId?: string | null): AgentRunInput => {
  const executionData = (message.execution_data ?? {}) as Record<string, any>;
  return {
    nodeId: message.id,
    workspaceId: message.workspaceId ?? null,
    parentId: message.parentId ?? null,
    role: message.role ?? null,
    agentId: message.agent_id ?? null,
    message,
    runId: runId ?? (typeof executionData.current_run_id === 'string' ? executionData.current_run_id : null),
    status: message.status as any,
    content: message.content ?? '',
    executionData,
  };
};

const createManagedRun = (input: AgentRunInput): ManagedRun => {
  const actor = createActor(agentRunMachine, { input });
  const initial = actor.getSnapshot().context.snapshot;
  const managed: ManagedRun = {
    actor,
    previous: initial,
    unsubscribe: { unsubscribe: () => undefined },
  };

  managed.unsubscribe = actor.subscribe((state) => {
    managed.previous = state.context.snapshot;
  });
  actor.start();
  return managed;
};

const getOrCreate = (nodeId: string, input?: Partial<AgentRunInput>) => {
  const existing = actors.get(nodeId);
  if (existing) return existing;
  const managed = createManagedRun({
    nodeId,
    workspaceId: input?.workspaceId ?? null,
    parentId: input?.parentId ?? null,
    role: input?.role ?? 'assistant',
    agentId: input?.agentId ?? null,
    message: input?.message ?? null,
    runId: input?.runId ?? null,
    status: input?.status ?? null,
    progress: input?.progress ?? null,
    content: input?.content ?? '',
    executionData: input?.executionData ?? {},
  });
  actors.set(nodeId, managed);
  return managed;
};

const dispatch = (nodeId: string, event: AgentRunEvent, input?: Partial<AgentRunInput>) => {
  const managed = getOrCreate(nodeId, input);
  const previous = managed.actor.getSnapshot().context.snapshot;
  const predicted = reduceAgentRunSnapshot(previous, event);
  const shouldProject = shouldProjectSnapshot(previous, predicted, event);
  const shouldProjectStatus = shouldProjectStatusSnapshot(previous, predicted);
  const becameTerminal = isTerminalAgentRunStatus(predicted.status) && !isTerminalAgentRunStatus(previous.status);
  const shouldProjectFull = shouldProject && (hasProjectionWatchers(nodeId) || becameTerminal);
  const effects = [
    ...(shouldProjectStatus ? ['project_status'] : []),
    ...(shouldProjectFull ? ['project_snapshot'] : []),
  ];
  managed.actor.send(event as any);
  if (becameTerminal) {
    clearRecentSendProjectionTimer(nodeId);
    watchTerminalHoldProjection(nodeId, predicted);
  }
  if (shouldProjectFull) {
    if (becameTerminal) {
      // watchTerminalHoldProjection already promoted the just-updated actor snapshot.
    } else if (shouldThrottleProjection(previous, predicted, event)) {
      scheduleProjectedSnapshot(nodeId);
    } else {
      projectManagedSnapshot(nodeId);
    }
  } else if (shouldProjectStatus) {
    projectAgentRunStatusSnapshot(managed.actor.getSnapshot().context.snapshot);
  }
  logAgentRunTransition(previous, predicted, event, effects);
};

export const agentRunManager = {
  seed(message: Message, runId?: string | null) {
    const existing = actors.get(message.id);
    if (existing) {
      dispatch(message.id, { type: 'seed', message, runId });
      return;
    }
    const managed = createManagedRun(inputFromMessage(message, runId));
    actors.set(message.id, managed);
    watchRecentSendProjection(message.id);
  },

  replaceNode(optimisticNodeId: string, realNode: Message) {
    const managed = actors.get(optimisticNodeId);
    if (!managed) {
      this.seed(realNode);
      return;
    }
    actors.delete(optimisticNodeId);
    actors.set(realNode.id, managed);
    const watchers = projectionWatchers.get(optimisticNodeId);
    const hadRecentSendWatcher = watchers?.has('recent-send') ?? false;
    const hadTerminalHoldWatcher = watchers?.has('terminal-hold') ?? false;
    if (watchers) {
      projectionWatchers.delete(optimisticNodeId);
      projectionWatchers.set(realNode.id, watchers);
    }
    clearRecentSendProjectionTimer(optimisticNodeId);
    clearTerminalHoldProjectionTimer(optimisticNodeId);
    dispatch(realNode.id, { type: 'replace_node', optimisticNodeId, realNode });
    if (hadRecentSendWatcher) {
      watchRecentSendProjection(realNode.id);
    }
    if (hadTerminalHoldWatcher) {
      const snapshot = managed.actor.getSnapshot().context.snapshot;
      watchTerminalHoldProjection(realNode.id, snapshot);
    }
    clearAgentRunProjection(optimisticNodeId);
  },

  dispatch,

  ingest(nodeId: string, rawEvent: Record<string, any>, input?: Partial<AgentRunInput>) {
    dispatch(nodeId, normalizeAgentAdapterEventForRun(rawEvent), input);
  },

  watch(nodeId: string, reason: ProjectionWatchReason) {
    watchProjection(nodeId, reason);
  },

  unwatch(nodeId: string, reason: ProjectionWatchReason) {
    unwatchProjection(nodeId, reason);
  },

  promoteProjection(nodeId: string) {
    projectManagedSnapshot(nodeId);
  },

  snapshot(nodeId: string): AgentRunSnapshot | null {
    return actors.get(nodeId)?.actor.getSnapshot().context.snapshot ?? null;
  },

  cleanup(nodeId: string) {
    const managed = actors.get(nodeId);
    if (!managed) {
      clearProjectionTimer(nodeId);
      lastProjectionAt.delete(nodeId);
      projectionWatchers.delete(nodeId);
      clearRecentSendProjectionTimer(nodeId);
      clearTerminalHoldProjectionTimer(nodeId);
      clearAgentRunProjection(nodeId);
      return;
    }
    clearProjectionTimer(nodeId);
    lastProjectionAt.delete(nodeId);
    projectionWatchers.delete(nodeId);
    clearRecentSendProjectionTimer(nodeId);
    clearTerminalHoldProjectionTimer(nodeId);
    const previousStatus = managed.actor.getSnapshot().context.snapshot.status;
    managed.actor.send({ type: 'cleanup' } as any);
    managed.unsubscribe.unsubscribe();
    managed.actor.stop();
    actors.delete(nodeId);
    clearAgentRunProjection(nodeId, {
      clearRunStatus: !isTerminalAgentRunStatus(previousStatus),
    });
  },

  clearAll() {
    if (projectionFlushTimer !== null) {
      window.clearTimeout(projectionFlushTimer);
      projectionFlushTimer = null;
    }
    dirtyProjectionNodeIds.clear();
    projectionWatchers.clear();
    for (const timer of recentSendProjectionTimers.values()) {
      window.clearTimeout(timer);
    }
    recentSendProjectionTimers.clear();
    for (const timer of terminalHoldProjectionTimers.values()) {
      window.clearTimeout(timer);
    }
    terminalHoldProjectionTimers.clear();
    for (const [nodeId, managed] of actors) {
      clearProjectionTimer(nodeId);
      lastProjectionAt.delete(nodeId);
      managed.unsubscribe.unsubscribe();
      managed.actor.stop();
      clearAgentRunProjection(nodeId);
    }
    actors.clear();
  },
};
