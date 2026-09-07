import type { AgentRunJournalEvent } from '../lib/agentClient';
import type { Message } from '../stores/workspaceStore';
import {
  completeSatisfiedWaitGroup,
  type StartOrchestrationRunDeps,
} from './controlPlane';
import {
  getNodeKind,
  parseOrchestrationJournalEvent,
  planOrchestrationRecoveryAction,
  recoverOrchestrationProjection,
  type OrchestrationRecoveryAction,
  type OrchestrationRecoveryProjection,
} from './domain';

export interface RecoverableOrchestratorRun {
  runId: string;
  orchestratorNodeId: string;
}

export interface ApplyOrchestrationRecoveryDeps {
  recordOrchestrationEvent: StartOrchestrationRunDeps['recordOrchestrationEvent'];
  stopAgent: (assistantNodeId: string) => Promise<void>;
}

export interface ApplyOrchestrationRecoveryInput {
  orchestratorRunId: string;
  orchestratorNodeId: string;
  projection: OrchestrationRecoveryProjection;
  action?: OrchestrationRecoveryAction;
}

export interface ApplyOrchestrationRecoveryResult {
  action: OrchestrationRecoveryAction['type'];
  stoppedAssistantNodeIds: string[];
  completedWaitGroupId: string | null;
  completedOrchestration: boolean;
  cancelledOrchestration: boolean;
  skippedReason: string | null;
}

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const readExecutionData = (message: Message): Record<string, unknown> => (
  message.execution_data && typeof message.execution_data === 'object'
    ? message.execution_data as Record<string, unknown>
    : {}
);

const readMeta = (message: Message): Record<string, unknown> => {
  const executionData = readExecutionData(message);
  return executionData.meta && typeof executionData.meta === 'object'
    ? executionData.meta as Record<string, unknown>
    : {};
};

export const getOrchestratorRunId = (message: Message): string | null => {
  const executionData = readExecutionData(message);
  const meta = readMeta(message);
  return readString(executionData.current_run_id)
    ?? readString(meta.orchestrator_run_id)
    ?? readString(meta.orchestratorRunId);
};

export const findRecoverableOrchestratorRuns = (messages: Message[]): RecoverableOrchestratorRun[] => {
  const seen = new Set<string>();
  const runs: RecoverableOrchestratorRun[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (getNodeKind(message) !== 'orchestrator') continue;
    const runId = getOrchestratorRunId(message);
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    runs.push({
      runId,
      orchestratorNodeId: message.id,
    });
  }
  return runs;
};

export const applyOrchestrationRecoveryAction = async (
  input: ApplyOrchestrationRecoveryInput,
  deps: ApplyOrchestrationRecoveryDeps,
): Promise<ApplyOrchestrationRecoveryResult> => {
  const action = input.action ?? planOrchestrationRecoveryAction(input.projection);

  if (action.type === 'stop_active_children') {
    const stoppedAssistantNodeIds: string[] = [];
    for (const assistantNodeId of Array.from(new Set(action.assistantNodeIds))) {
      await deps.stopAgent(assistantNodeId);
      stoppedAssistantNodeIds.push(assistantNodeId);
    }
    return {
      action: action.type,
      stoppedAssistantNodeIds,
      completedWaitGroupId: null,
      completedOrchestration: false,
      cancelledOrchestration: false,
      skippedReason: null,
    };
  }

  if (action.type === 'mark_cancelled') {
    await deps.recordOrchestrationEvent(
      input.orchestratorRunId,
      input.orchestratorNodeId,
      'orchestration:cancelled',
      {
        reason: action.reason,
        stoppedAssistantNodeIds: [],
      },
    );
    return {
      action: action.type,
      stoppedAssistantNodeIds: [],
      completedWaitGroupId: null,
      completedOrchestration: false,
      cancelledOrchestration: true,
      skippedReason: null,
    };
  }

  if (action.type === 'complete_wait') {
    const result = await completeSatisfiedWaitGroup({
      orchestratorRunId: input.orchestratorRunId,
      orchestratorNodeId: input.orchestratorNodeId,
      projection: input.projection,
    }, {
      recordOrchestrationEvent: deps.recordOrchestrationEvent,
    });
    return {
      action: action.type,
      stoppedAssistantNodeIds: [],
      completedWaitGroupId: result.completedWaitGroupId,
      completedOrchestration: false,
      cancelledOrchestration: false,
      skippedReason: result.completedWaitGroupId ? null : 'wait_not_satisfied',
    };
  }

  return {
    action: action.type,
    stoppedAssistantNodeIds: [],
    completedWaitGroupId: null,
    completedOrchestration: false,
    cancelledOrchestration: false,
    skippedReason: null,
  };
};

export interface RecoverOrchestrationsFromMessagesDeps extends ApplyOrchestrationRecoveryDeps {
  replayAgentRunEvents: (runId: string, afterSeq?: number) => Promise<AgentRunJournalEvent[]>;
}

export interface OrchestrationRecoveryRunResult extends ApplyOrchestrationRecoveryResult {
  runId: string;
  orchestratorNodeId: string;
  lastSeq: number;
}

export const recoverOrchestrationsFromMessages = async (
  messages: Message[],
  deps: RecoverOrchestrationsFromMessagesDeps,
): Promise<OrchestrationRecoveryRunResult[]> => {
  const results: OrchestrationRecoveryRunResult[] = [];
  for (const orchestrator of findRecoverableOrchestratorRuns(messages)) {
    const journalRows = await deps.replayAgentRunEvents(orchestrator.runId, 0);
    const events = journalRows
      .map(parseOrchestrationJournalEvent)
      .filter((event): event is NonNullable<typeof event> => Boolean(event));
    const projection = recoverOrchestrationProjection({
      orchestratorNodeId: orchestrator.orchestratorNodeId,
      events,
      messages,
    });
    const result = await applyOrchestrationRecoveryAction({
      orchestratorRunId: orchestrator.runId,
      orchestratorNodeId: orchestrator.orchestratorNodeId,
      projection,
    }, deps);
    results.push({
      runId: orchestrator.runId,
      orchestratorNodeId: orchestrator.orchestratorNodeId,
      lastSeq: projection.lastSeq,
      ...result,
    });
  }
  return results;
};
