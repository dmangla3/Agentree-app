import { createActor, type ActorRefFrom } from 'xstate';
import { flowRunMachine, isActiveFlowRunStatus } from './flowRun.machine';
import type { FlowExecutionEvent, FlowExecutionResult } from './flowExecutor';
import type { FlowRunEvent, FlowRunSnapshot } from './flowRun.types';

type FlowRunActorRef = ActorRefFrom<typeof flowRunMachine>;

export interface StartFlowRunInput {
  flowRunId: string;
  flowId: string;
  abortController?: AbortController;
  stopNode?: (assistantNodeId: string) => Promise<void>;
}

interface ManagedFlowRun {
  actor: FlowRunActorRef;
  abortController: AbortController;
  stopNode: (assistantNodeId: string) => Promise<void>;
}

const noopStopNode = async () => undefined;

class FlowRunManager {
  private runs = new Map<string, ManagedFlowRun>();

  start(input: StartFlowRunInput): FlowRunSnapshot {
    const existing = this.runs.get(input.flowRunId);
    if (existing) {
      existing.actor.send({ type: 'start' });
      return existing.actor.getSnapshot().context.snapshot;
    }

    const actor = createActor(flowRunMachine, {
      input: {
        flowRunId: input.flowRunId,
        flowId: input.flowId,
      },
    });
    actor.start();

    const managed: ManagedFlowRun = {
      actor,
      abortController: input.abortController ?? new AbortController(),
      stopNode: input.stopNode ?? noopStopNode,
    };
    this.runs.set(input.flowRunId, managed);
    actor.send({ type: 'start' });
    return actor.getSnapshot().context.snapshot;
  }

  dispatch(flowRunId: string, event: FlowRunEvent): FlowRunSnapshot | null {
    const managed = this.runs.get(flowRunId);
    if (!managed) return null;
    managed.actor.send(event);
    return managed.actor.getSnapshot().context.snapshot;
  }

  recordExecutionEvent(flowRunId: string, event: FlowExecutionEvent): FlowRunSnapshot | null {
    return this.dispatch(flowRunId, { type: 'execution_event', event });
  }

  finish(flowRunId: string, result: FlowExecutionResult): FlowRunSnapshot | null {
    return this.dispatch(flowRunId, { type: 'result', result });
  }

  fail(flowRunId: string, reason: string): FlowRunSnapshot | null {
    return this.dispatch(flowRunId, { type: 'fail', reason });
  }

  snapshot(flowRunId: string): FlowRunSnapshot | null {
    return this.runs.get(flowRunId)?.actor.getSnapshot().context.snapshot ?? null;
  }

  snapshotForNode(nodeId: string): FlowRunSnapshot | null {
    for (const managed of this.runs.values()) {
      const snapshot = managed.actor.getSnapshot().context.snapshot;
      if (snapshot.launchedNodeIds.includes(nodeId) || snapshot.activeNodeIds.includes(nodeId)) {
        return snapshot;
      }
    }
    return null;
  }

  isNodeOwnedByActiveFlow(nodeId: string): boolean {
    const snapshot = this.snapshotForNode(nodeId);
    return Boolean(snapshot && isActiveFlowRunStatus(snapshot.status));
  }

  async cancel(flowRunId: string, reason = 'Flow cancelled.'): Promise<FlowRunSnapshot | null> {
    const managed = this.runs.get(flowRunId);
    if (!managed) return null;

    managed.actor.send({ type: 'cancel', reason });
    const snapshot = managed.actor.getSnapshot().context.snapshot;
    if (!managed.abortController.signal.aborted) {
      managed.abortController.abort(reason);
    }

    await Promise.all(snapshot.activeNodeIds.map((nodeId) => managed.stopNode(nodeId)));
    return managed.actor.getSnapshot().context.snapshot;
  }

  remove(flowRunId: string): void {
    const managed = this.runs.get(flowRunId);
    if (!managed) return;
    managed.actor.stop();
    this.runs.delete(flowRunId);
  }

  resetForTests(): void {
    for (const managed of this.runs.values()) {
      managed.actor.stop();
    }
    this.runs.clear();
  }
}

export const flowRunManager = new FlowRunManager();
