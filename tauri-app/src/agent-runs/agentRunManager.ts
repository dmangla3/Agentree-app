import { createActor, type ActorRefFrom } from 'xstate';
import { agentRunMachine, isTerminalAgentRunStatus, reduceAgentRunSnapshot } from './agentRun.machine';
import { clearAgentRunProjection, projectAgentRunSnapshot } from './agentRunEffects';
import { logAgentRunTransition } from './agentRunDebug';
import type { AgentRunEvent, AgentRunInput, AgentRunSnapshot } from './agentRun.types';
import type { Message } from '../stores/workspaceStore';

type AgentRunActor = ActorRefFrom<typeof agentRunMachine>;

interface ManagedRun {
  actor: AgentRunActor;
  previous: AgentRunSnapshot;
  unsubscribe: { unsubscribe: () => void };
}

const actors = new Map<string, ManagedRun>();
const CONTENT_PROJECTION_THROTTLE_MS = 140;
const projectionTimers = new Map<string, number>();
const lastProjectionAt = new Map<string, number>();

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

const clearProjectionTimer = (nodeId: string) => {
  const timer = projectionTimers.get(nodeId);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  projectionTimers.delete(nodeId);
};

const projectManagedSnapshot = (nodeId: string) => {
  clearProjectionTimer(nodeId);
  const snapshot = actors.get(nodeId)?.actor.getSnapshot().context.snapshot;
  if (!snapshot) return;
  projectAgentRunSnapshot(snapshot);
  lastProjectionAt.set(nodeId, performance.now());
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
  if (projectionTimers.has(nodeId)) return;

  const elapsed = performance.now() - (lastProjectionAt.get(nodeId) ?? 0);
  const delayMs = Math.max(0, CONTENT_PROJECTION_THROTTLE_MS - elapsed);
  if (delayMs === 0) {
    projectManagedSnapshot(nodeId);
    return;
  }

  const timer = window.setTimeout(() => {
    projectionTimers.delete(nodeId);
    projectManagedSnapshot(nodeId);
  }, delayMs);
  projectionTimers.set(nodeId, timer);
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
  const effects = shouldProject ? ['project_snapshot'] : [];
  managed.actor.send(event as any);
  if (shouldProject) {
    if (shouldThrottleProjection(previous, predicted, event)) {
      scheduleProjectedSnapshot(nodeId);
    } else {
      projectManagedSnapshot(nodeId);
    }
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
    projectAgentRunSnapshot(managed.actor.getSnapshot().context.snapshot);
  },

  replaceNode(optimisticNodeId: string, realNode: Message) {
    const managed = actors.get(optimisticNodeId);
    if (!managed) {
      this.seed(realNode);
      return;
    }
    actors.delete(optimisticNodeId);
    actors.set(realNode.id, managed);
    dispatch(realNode.id, { type: 'replace_node', optimisticNodeId, realNode });
    clearAgentRunProjection(optimisticNodeId);
  },

  dispatch,

  snapshot(nodeId: string): AgentRunSnapshot | null {
    return actors.get(nodeId)?.actor.getSnapshot().context.snapshot ?? null;
  },

  cleanup(nodeId: string) {
    const managed = actors.get(nodeId);
    if (!managed) {
      clearProjectionTimer(nodeId);
      lastProjectionAt.delete(nodeId);
      clearAgentRunProjection(nodeId);
      return;
    }
    clearProjectionTimer(nodeId);
    lastProjectionAt.delete(nodeId);
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
