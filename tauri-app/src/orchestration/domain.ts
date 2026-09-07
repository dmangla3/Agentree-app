import type { AgentRunJournalEvent } from '../lib/agentClient';
import type { Message } from '../stores/workspaceStore';
import { isActiveAgentStatus, isFailureAgentStatus, isTerminalAgentStatus, type AgentStatus } from '@shared/agentStatus';

export const orchestrationEventTypes = [
  'orchestration:flow_diagram_created',
  'orchestration:child_requested',
  'orchestration:child_started',
  'orchestration:wait_started',
  'orchestration:wait_completed',
  'orchestration:retry_requested',
  'orchestration:child_superseded',
  'orchestration:cancel_requested',
  'orchestration:cancelled',
  'orchestration:completed',
  'orchestration:needs_user_action',
] as const;

export type OrchestrationEventType = typeof orchestrationEventTypes[number];

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
  childUserNodeId?: string;
  childAssistantNodeId?: string;
  childRunId?: string;
  supersededAssistantNodeId?: string;
  replacementAssistantNodeId?: string;
  waitGroupId?: string;
  decisionIds?: string[];
  condition?: OrchestrationWaitGroup['condition'];
  mermaid?: string;
  diagram?: string;
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
  requestedChildLaunchByDecisionId?: Map<string, {
    childUserNodeId?: string;
    childAssistantNodeId?: string;
    childRunId?: string;
  }>;
  childAssistantNodeIdByDecisionId: Map<string, string>;
  supersededChildIds: Set<string>;
  activeWaitGroup: OrchestrationWaitGroup | null;
  needsUserActionReason: string | null;
  lastSeq: number;
}

export interface OrchestrationChildFact {
  assistantNodeId: string;
  decisionId: string | null;
  status: AgentStatus | null;
  active: boolean;
  terminal: boolean;
  outputCommitSha: string | null;
}

export interface ExistingOrchestrationChildLaunch {
  userNodeId: string | null;
  assistantNodeId: string;
  runId: string | null;
  status: AgentStatus | null;
}

export interface OrchestrationRecoveryProjection extends OrchestrationProjection {
  controlledChildren: OrchestrationChildFact[];
  activeControlledAssistantNodeIds: string[];
  terminalChildren: OrchestrationChildFact[];
  missingDecisionIds: string[];
}

export type OrchestrationRecoveryAction =
  | { type: 'complete_wait'; waitGroup: OrchestrationWaitGroup }
  | { type: 'mark_cancelled'; reason: string }
  | { type: 'stop_active_children'; assistantNodeIds: string[]; reason: string }
  | { type: 'needs_user_action'; reason: string }
  | { type: 'none' };

export const isOrchestrationEventType = (value: string): value is OrchestrationEventType =>
  orchestrationEventTypes.includes(value as OrchestrationEventType);

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
    ?? readRecordString(meta, ['child_run_id', 'run_id', 'runId']);
};

export const findExistingOrchestrationChildLaunch = (
  messages: Message[],
  orchestratorNodeId: string,
  decisionId: string,
): ExistingOrchestrationChildLaunch | null => {
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
  children: OrchestrationChildFact[],
): boolean => {
  const childByDecisionId = new Map(
    children
      .filter((child) => child.decisionId)
      .map((child) => [child.decisionId as string, child]),
  );
  const waitChildren = waitGroup.decisionIds.map((decisionId) => childByDecisionId.get(decisionId) ?? null);
  if (waitChildren.length === 0) return false;

  const condition = String(waitGroup.condition || 'all').toLowerCase();
  switch (condition) {
    case 'any':
      return waitChildren.some((child) => Boolean(child?.terminal));
    case 'failed':
      return waitChildren.some((child) => isFailureAgentStatus(child?.status));
    case 'completed':
      return waitChildren.every((child) => child?.status === 'completed');
    case 'commit_available':
      return waitChildren.every((child) => Boolean(child?.outputCommitSha));
    case 'terminal':
    case 'all':
    default:
      return waitChildren.every((child) => Boolean(child?.terminal));
  }
};

export const getSatisfiedActiveWaitGroup = (
  projection: OrchestrationRecoveryProjection,
): OrchestrationWaitGroup | null => {
  return projection.activeWaitGroup && isOrchestrationWaitGroupSatisfied(projection.activeWaitGroup, projection.controlledChildren)
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
    if (projection.activeControlledAssistantNodeIds.length > 0) {
      return {
        type: 'stop_active_children',
        assistantNodeIds: projection.activeControlledAssistantNodeIds,
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
  if (!isOrchestrationEventType(row.eventType)) return null;
  let payload: OrchestrationEventPayload = {};
  try {
    const parsed = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as OrchestrationEventPayload;
    }
  } catch {
    payload = { reason: 'Invalid orchestration event payload.' };
  }
  return {
    type: row.eventType,
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
  const requestedChildLaunchByDecisionId = new Map<string, {
    childUserNodeId?: string;
    childAssistantNodeId?: string;
    childRunId?: string;
  }>();
  const childAssistantNodeIdByDecisionId = new Map<string, string>();
  const supersededChildIds = new Set<string>();
  let status: OrchestrationStatus = 'running';
  let activeWaitGroup: OrchestrationWaitGroup | null = null;
  let needsUserActionReason: string | null = null;
  let lastSeq = 0;

  for (const event of ordered) {
    lastSeq = event.seq;
    const { payload } = event;
    switch (event.type) {
      case 'orchestration:child_requested':
        if (!payload.decisionId) {
          status = 'needs_user_action';
          needsUserActionReason = 'Child request event is missing its decision id.';
          break;
        }
        requestedDecisionIds.add(payload.decisionId);
        requestedChildLaunchByDecisionId.set(payload.decisionId, {
          childUserNodeId: typeof payload.childUserNodeId === 'string' ? payload.childUserNodeId : undefined,
          childAssistantNodeId: typeof payload.childAssistantNodeId === 'string' ? payload.childAssistantNodeId : undefined,
          childRunId: typeof payload.childRunId === 'string' ? payload.childRunId : undefined,
        });
        break;
      case 'orchestration:child_started':
        if (!payload.decisionId || !payload.childAssistantNodeId) {
          status = 'needs_user_action';
          needsUserActionReason = 'Child start event is missing its decision or assistant node id.';
          break;
        }
        if (!childAssistantNodeIdByDecisionId.has(payload.decisionId)) {
          childAssistantNodeIdByDecisionId.set(payload.decisionId, payload.childAssistantNodeId);
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
      case 'orchestration:child_superseded':
        if (typeof payload.supersededAssistantNodeId === 'string') {
          supersededChildIds.add(payload.supersededAssistantNodeId);
        }
        if (typeof payload.decisionId === 'string' && typeof payload.replacementAssistantNodeId === 'string') {
          childAssistantNodeIdByDecisionId.set(payload.decisionId, payload.replacementAssistantNodeId);
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
    requestedChildLaunchByDecisionId,
    childAssistantNodeIdByDecisionId,
    supersededChildIds,
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
  const controlledChildren = input.messages
    .filter((message) => message.role === 'assistant')
    .filter((message) => getControlledByNodeId(message) === input.orchestratorNodeId)
    .map((message): OrchestrationChildFact => {
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

  for (const child of controlledChildren) {
    if (!child.decisionId) continue;
    if (!projection.childAssistantNodeIdByDecisionId.has(child.decisionId)) {
      projection.childAssistantNodeIdByDecisionId.set(child.decisionId, child.assistantNodeId);
    }
  }

  const childDecisionIds = new Set(controlledChildren.map((child) => child.decisionId).filter(Boolean));
  const missingDecisionIds = [...projection.requestedDecisionIds]
    .filter((decisionId) => (
      !projection.childAssistantNodeIdByDecisionId.has(decisionId)
      && !childDecisionIds.has(decisionId)
      && !projection.requestedChildLaunchByDecisionId?.get(decisionId)?.childAssistantNodeId
    ));

  let status = projection.status;
  let needsUserActionReason = projection.needsUserActionReason;
  if (missingDecisionIds.length > 0 && status !== 'completed' && status !== 'cancelled') {
    status = 'needs_user_action';
    needsUserActionReason = `Requested child run is missing for decision ${missingDecisionIds[0]}.`;
  }

  return {
    ...projection,
    status,
    needsUserActionReason,
    controlledChildren,
    activeControlledAssistantNodeIds: controlledChildren
      .filter((child) => child.active && !projection.supersededChildIds.has(child.assistantNodeId))
      .map((child) => child.assistantNodeId),
    terminalChildren: controlledChildren.filter((child) => child.terminal),
    missingDecisionIds,
  };
};
