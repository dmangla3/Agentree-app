import type { AgentRunJournalEvent } from '../lib/agentClient';
import type { Message } from '../stores/workspaceStore';
import { isActiveAgentStatus, isFailureAgentStatus, isTerminalAgentStatus, type AgentStatus } from '@shared/agentStatus';

export const orchestrationEventTypes = [
  'orchestration:run_requested',
  'orchestration:run_started',
  'orchestration:wait_started',
  'orchestration:wait_completed',
  'orchestration:retry_requested',
  'orchestration:run_superseded',
  'orchestration:cancel_requested',
  'orchestration:cancelled',
  'orchestration:completed',
  'orchestration:needs_user_action',
] as const;

export type OrchestrationEventType = typeof orchestrationEventTypes[number];

const legacyOrchestrationEventTypeAliases: Record<string, OrchestrationEventType> = {
  'orchestration:child_requested': 'orchestration:run_requested',
  'orchestration:child_started': 'orchestration:run_started',
  'orchestration:child_superseded': 'orchestration:run_superseded',
};

export type OrchestrationStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs_user_action';

export type OrchestrationNodeKind = 'orchestrator' | 'normal' | string;

export interface OrchestrationWaitGroup {
  waitGroupId: string;
  decisionIds: string[];
  condition: 'terminal' | 'completed' | 'failed' | 'commit_available' | 'any' | 'all' | string;
}

export interface OrchestrationEventPayload {
  orchestratorRunId?: string;
  orchestratorNodeId?: string;
  decisionId?: string;
  runUserNodeId?: string;
  runAssistantNodeId?: string;
  agentRunId?: string;
  supersededAssistantNodeId?: string;
  replacementAssistantNodeId?: string;
  waitGroupId?: string;
  decisionIds?: string[];
  condition?: OrchestrationWaitGroup['condition'];
  plan?: unknown;
  reason?: string;
  [key: string]: unknown;
}

export interface ParsedOrchestrationEvent {
  type: OrchestrationEventType;
  seq: number;
  timestamp: number;
  payload: OrchestrationEventPayload;
}

export interface OrchestrationProjection {
  status: OrchestrationStatus;
  requestedDecisionIds: Set<string>;
  requestedRunLaunchByDecisionId?: Map<string, {
    runUserNodeId?: string;
    runAssistantNodeId?: string;
    agentRunId?: string;
  }>;
  runAssistantNodeIdByDecisionId: Map<string, string>;
  supersededRunIds: Set<string>;
  activeWaitGroup: OrchestrationWaitGroup | null;
  needsUserActionReason: string | null;
  lastSeq: number;
}

export interface OrchestrationRunFact {
  assistantNodeId: string;
  decisionId: string | null;
  status: AgentStatus | null;
  active: boolean;
  terminal: boolean;
  outputCommitSha: string | null;
}

export interface ExistingOrchestrationRunLaunch {
  userNodeId: string | null;
  assistantNodeId: string;
  runId: string | null;
  status: AgentStatus | null;
}

export interface OrchestrationRecoveryProjection extends OrchestrationProjection {
  orchestrationRuns: OrchestrationRunFact[];
  activeOrchestrationRunAssistantNodeIds: string[];
  terminalOrchestrationRuns: OrchestrationRunFact[];
  missingDecisionIds: string[];
}

export type OrchestrationRecoveryAction =
  | { type: 'complete_wait'; waitGroup: OrchestrationWaitGroup }
  | { type: 'mark_cancelled'; reason: string }
  | { type: 'stop_active_runs'; assistantNodeIds: string[]; reason: string }
  | { type: 'needs_user_action'; reason: string }
  | { type: 'none' };

const normalizeOrchestrationEventType = (value: string): OrchestrationEventType | null => {
  if (orchestrationEventTypes.includes(value as OrchestrationEventType)) return value as OrchestrationEventType;
  return legacyOrchestrationEventTypeAliases[value] ?? null;
};

export const isOrchestrationEventType = (value: string): value is OrchestrationEventType =>
  normalizeOrchestrationEventType(value) !== null;

const readRecordString = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

export const getControlledByNodeId = (message: Pick<Message, 'controlled_by_node_id' | 'controlledByNodeId' | 'execution_data'>): string | null => {
  const direct = readRecordString(message as Record<string, unknown>, ['controlled_by_node_id', 'controlledByNodeId']);
  if (direct) return direct;
  const executionData = message.execution_data && typeof message.execution_data === 'object'
    ? message.execution_data as Record<string, unknown>
    : {};
  const meta = executionData.meta && typeof executionData.meta === 'object'
    ? executionData.meta as Record<string, unknown>
    : {};
  return readRecordString(meta, ['controlled_by_node_id', 'controlledByNodeId', 'controlled_by', 'controlledBy']);
};

export const getNodeKind = (message: Pick<Message, 'execution_data'>): OrchestrationNodeKind => {
  const executionData = message.execution_data && typeof message.execution_data === 'object'
    ? message.execution_data as Record<string, unknown>
    : {};
  const meta = executionData.meta && typeof executionData.meta === 'object'
    ? executionData.meta as Record<string, unknown>
    : {};
  return readRecordString(meta, ['node_kind', 'nodeKind']) ?? 'normal';
};

export const getOrchestrationDecisionId = (message: Pick<Message, 'execution_data'>): string | null => {
  const executionData = message.execution_data && typeof message.execution_data === 'object'
    ? message.execution_data as Record<string, unknown>
    : {};
  const meta = executionData.meta && typeof executionData.meta === 'object'
    ? executionData.meta as Record<string, unknown>
    : {};
  return readRecordString(meta, ['orchestration_decision_id', 'orchestrationDecisionId']);
};

export const getOrchestrationDecisionKey = (
  orchestratorRunId: string,
  decisionId: string,
): string => `${orchestratorRunId}:${decisionId}`;

const getRunId = (message: Pick<Message, 'execution_data'>): string | null => {
  const executionData = message.execution_data && typeof message.execution_data === 'object'
    ? message.execution_data as Record<string, unknown>
    : {};
  const meta = executionData.meta && typeof executionData.meta === 'object'
    ? executionData.meta as Record<string, unknown>
    : {};
  return readRecordString(executionData, ['current_run_id'])
    ?? readRecordString(meta, ['agent_run_id', 'child_run_id', 'run_id', 'runId']);
};

export const findExistingOrchestrationRunLaunch = (
  messages: Message[],
  orchestratorNodeId: string,
  decisionId: string,
): ExistingOrchestrationRunLaunch | null => {
  const assistant = messages.find((message) => (
    message.role === 'assistant'
    && getControlledByNodeId(message) === orchestratorNodeId
    && getOrchestrationDecisionId(message) === decisionId
  ));
  if (!assistant) return null;

  return {
    userNodeId: assistant.parentId ?? null,
    assistantNodeId: assistant.id,
    runId: getRunId(assistant),
    status: (typeof assistant.status === 'string' ? assistant.status : null) as AgentStatus | null,
  };
};

export const isOrchestrationWaitGroupSatisfied = (
  waitGroup: OrchestrationWaitGroup,
  runs: OrchestrationRunFact[],
): boolean => {
  const runByDecisionId = new Map(
    runs
      .filter((run) => run.decisionId)
      .map((run) => [run.decisionId as string, run]),
  );
  const waitRuns = waitGroup.decisionIds.map((decisionId) => runByDecisionId.get(decisionId) ?? null);
  if (waitRuns.length === 0) return false;

  const condition = String(waitGroup.condition || 'all').toLowerCase();
  switch (condition) {
    case 'any':
      return waitRuns.some((run) => Boolean(run?.terminal));
    case 'failed':
      return waitRuns.some((run) => isFailureAgentStatus(run?.status));
    case 'completed':
      return waitRuns.every((run) => run?.status === 'completed');
    case 'commit_available':
      return waitRuns.every((run) => Boolean(run?.outputCommitSha));
    case 'terminal':
    case 'all':
    default:
      return waitRuns.every((run) => Boolean(run?.terminal));
  }
};

export const getSatisfiedActiveWaitGroup = (
  projection: OrchestrationRecoveryProjection,
): OrchestrationWaitGroup | null => {
  return projection.activeWaitGroup && isOrchestrationWaitGroupSatisfied(projection.activeWaitGroup, projection.orchestrationRuns)
    ? projection.activeWaitGroup
    : null;
};

export const planOrchestrationRecoveryAction = (
  projection: OrchestrationRecoveryProjection,
): OrchestrationRecoveryAction => {
  if (projection.status === 'needs_user_action') {
    return {
      type: 'needs_user_action',
      reason: projection.needsUserActionReason ?? 'Orchestration requires user action.',
    };
  }

  if (projection.status === 'cancelling') {
    if (projection.activeOrchestrationRunAssistantNodeIds.length > 0) {
      return {
        type: 'stop_active_runs',
        assistantNodeIds: projection.activeOrchestrationRunAssistantNodeIds,
        reason: 'cancel_recovery',
      };
    }
    return {
      type: 'mark_cancelled',
      reason: projection.needsUserActionReason ?? 'cancelled',
    };
  }

  const satisfiedWaitGroup = getSatisfiedActiveWaitGroup(projection);
  if (satisfiedWaitGroup) {
    return {
      type: 'complete_wait',
      waitGroup: satisfiedWaitGroup,
    };
  }

  return { type: 'none' };
};

export const parseOrchestrationJournalEvent = (
  row: AgentRunJournalEvent,
): ParsedOrchestrationEvent | null => {
  const eventType = normalizeOrchestrationEventType(row.eventType);
  if (!eventType) return null;
  let payload: OrchestrationEventPayload = {};
  try {
    const parsed = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as OrchestrationEventPayload;
    }
  } catch {
    payload = { reason: 'Invalid orchestration event payload.' };
  }
  payload.runUserNodeId = typeof payload.runUserNodeId === 'string'
    ? payload.runUserNodeId
    : typeof payload.childUserNodeId === 'string'
      ? payload.childUserNodeId
      : undefined;
  payload.runAssistantNodeId = typeof payload.runAssistantNodeId === 'string'
    ? payload.runAssistantNodeId
    : typeof payload.childAssistantNodeId === 'string'
      ? payload.childAssistantNodeId
      : undefined;
  payload.agentRunId = typeof payload.agentRunId === 'string'
    ? payload.agentRunId
    : typeof payload.childRunId === 'string'
      ? payload.childRunId
      : undefined;

  return {
    type: eventType,
    seq: row.seq,
    timestamp: row.timestamp,
    payload,
  };
};

export const replayOrchestrationEvents = (
  events: ParsedOrchestrationEvent[],
): OrchestrationProjection => {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const requestedDecisionIds = new Set<string>();
  const requestedRunLaunchByDecisionId = new Map<string, {
    runUserNodeId?: string;
    runAssistantNodeId?: string;
    agentRunId?: string;
  }>();
  const runAssistantNodeIdByDecisionId = new Map<string, string>();
  const supersededRunIds = new Set<string>();
  let status: OrchestrationStatus = 'running';
  let activeWaitGroup: OrchestrationWaitGroup | null = null;
  let needsUserActionReason: string | null = null;
  let lastSeq = 0;

  for (const event of ordered) {
    lastSeq = event.seq;
    const { payload } = event;
    switch (event.type) {
      case 'orchestration:run_requested':
        if (!payload.decisionId) {
          status = 'needs_user_action';
          needsUserActionReason = 'Orchestration run request event is missing its decision id.';
          break;
        }
        requestedDecisionIds.add(payload.decisionId);
        requestedRunLaunchByDecisionId.set(payload.decisionId, {
          runUserNodeId: typeof payload.runUserNodeId === 'string' ? payload.runUserNodeId : undefined,
          runAssistantNodeId: typeof payload.runAssistantNodeId === 'string' ? payload.runAssistantNodeId : undefined,
          agentRunId: typeof payload.agentRunId === 'string' ? payload.agentRunId : undefined,
        });
        break;
      case 'orchestration:run_started':
        if (!payload.decisionId || !payload.runAssistantNodeId) {
          status = 'needs_user_action';
          needsUserActionReason = 'Orchestration run start event is missing its decision or assistant node id.';
          break;
        }
        if (!runAssistantNodeIdByDecisionId.has(payload.decisionId)) {
          runAssistantNodeIdByDecisionId.set(payload.decisionId, payload.runAssistantNodeId);
        }
        break;
      case 'orchestration:wait_started':
        activeWaitGroup = typeof payload.waitGroupId === 'string'
          ? {
            waitGroupId: payload.waitGroupId,
            decisionIds: Array.isArray(payload.decisionIds)
              ? payload.decisionIds.filter((decisionId): decisionId is string => typeof decisionId === 'string')
              : [],
            condition: typeof payload.condition === 'string' ? payload.condition : 'all',
          }
          : null;
        break;
      case 'orchestration:wait_completed':
        if (!payload.waitGroupId || payload.waitGroupId === activeWaitGroup?.waitGroupId) {
          activeWaitGroup = null;
        }
        break;
      case 'orchestration:run_superseded':
        if (typeof payload.supersededAssistantNodeId === 'string') {
          supersededRunIds.add(payload.supersededAssistantNodeId);
        }
        if (typeof payload.decisionId === 'string' && typeof payload.replacementAssistantNodeId === 'string') {
          runAssistantNodeIdByDecisionId.set(payload.decisionId, payload.replacementAssistantNodeId);
        }
        break;
      case 'orchestration:cancel_requested':
        status = 'cancelling';
        break;
      case 'orchestration:cancelled':
        status = 'cancelled';
        activeWaitGroup = null;
        break;
      case 'orchestration:completed':
        status = 'completed';
        activeWaitGroup = null;
        break;
      case 'orchestration:needs_user_action':
        status = 'needs_user_action';
        needsUserActionReason = typeof payload.reason === 'string' ? payload.reason : null;
        break;
      default:
        break;
    }
  }

  return {
    status,
    requestedDecisionIds,
    requestedRunLaunchByDecisionId,
    runAssistantNodeIdByDecisionId,
    supersededRunIds,
    activeWaitGroup,
    needsUserActionReason,
    lastSeq,
  };
};

export const recoverOrchestrationProjection = (input: {
  orchestratorNodeId: string;
  events: ParsedOrchestrationEvent[];
  messages: Message[];
}): OrchestrationRecoveryProjection => {
  const projection = replayOrchestrationEvents(input.events);
  const orchestrationRuns = input.messages
    .filter((message) => message.role === 'assistant')
    .filter((message) => getControlledByNodeId(message) === input.orchestratorNodeId)
    .map((message): OrchestrationRunFact => {
      const status = (typeof message.status === 'string' ? message.status : null) as AgentStatus | null;
      return {
        assistantNodeId: message.id,
        decisionId: getOrchestrationDecisionId(message),
        status,
        active: isActiveAgentStatus(status),
        terminal: isTerminalAgentStatus(status),
        outputCommitSha: typeof message.output_commit_sha === 'string' && message.output_commit_sha.trim()
          ? message.output_commit_sha.trim()
          : null,
      };
    });

  for (const run of orchestrationRuns) {
    if (!run.decisionId) continue;
    if (!projection.runAssistantNodeIdByDecisionId.has(run.decisionId)) {
      projection.runAssistantNodeIdByDecisionId.set(run.decisionId, run.assistantNodeId);
    }
  }

  const runDecisionIds = new Set(orchestrationRuns.map((run) => run.decisionId).filter(Boolean));
  const missingDecisionIds = [...projection.requestedDecisionIds]
    .filter((decisionId) => (
      !projection.runAssistantNodeIdByDecisionId.has(decisionId)
      && !runDecisionIds.has(decisionId)
      && !projection.requestedRunLaunchByDecisionId?.get(decisionId)?.runAssistantNodeId
    ));

  let status = projection.status;
  let needsUserActionReason = projection.needsUserActionReason;
  if (missingDecisionIds.length > 0 && status !== 'completed' && status !== 'cancelled') {
    status = 'needs_user_action';
    needsUserActionReason = `Requested orchestration run is missing for decision ${missingDecisionIds[0]}.`;
  }

  return {
    ...projection,
    status,
    needsUserActionReason,
    orchestrationRuns,
    activeOrchestrationRunAssistantNodeIds: orchestrationRuns
      .filter((run) => run.active && !projection.supersededRunIds.has(run.assistantNodeId))
      .map((run) => run.assistantNodeId),
    terminalOrchestrationRuns: orchestrationRuns.filter((run) => run.terminal),
    missingDecisionIds,
  };
};
