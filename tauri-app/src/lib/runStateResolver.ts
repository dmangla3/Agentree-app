import type { AgentStatus } from '@shared/agentStatus';
import type { Message } from '../stores/workspaceStore';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { resolveAgentRunStatus } from '../agent-runs/agentRun.machine';

export type NodeLifecycleStatus =
  | AgentStatus
  | 'pending'
  | 'creating'
  | 'initializing'
  | 'streaming'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'error'
  | string;

const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled', 'error']);

const normalizeStatus = (status: unknown): string | null => {
  if (typeof status !== 'string') return null;
  const trimmed = status.trim();
  return trimmed ? trimmed : null;
};

export const isTerminalNodeStatus = (status: unknown) => {
  const normalized = normalizeStatus(status);
  return Boolean(normalized && TERMINAL_STATUSES.has(normalized));
};

const resolveProjectedNodeStatus = (
  previous: unknown,
  next: unknown,
): NodeLifecycleStatus | null => {
  const previousStatus = normalizeStatus(previous);
  const nextStatus = normalizeStatus(next);
  return resolveAgentRunStatus(previousStatus as any, nextStatus as any) as NodeLifecycleStatus | null;
};

const terminalStatusFromExecutionData = (executionData: unknown): NodeLifecycleStatus | null => {
  if (!executionData || typeof executionData !== 'object') return null;
  const status = normalizeStatus((executionData as Record<string, unknown>).last_terminal_status);
  return status && TERMINAL_STATUSES.has(status) ? status as NodeLifecycleStatus : null;
};

export interface ResolvedNodeState {
  status: NodeLifecycleStatus | null;
  content: string;
  progress: string | null;
  lastSeq: number | null;
  source: 'server' | 'live' | 'merged';
}

export function resolveNodeState(
  serverMessage: Message | null | undefined,
  liveMessage: AgentRunProjectedMessage | null | undefined,
): ResolvedNodeState {
  const actorSnapshot = agentRunManager.snapshot(liveMessage?.id ?? serverMessage?.id ?? '');
  const serverTerminalStatus = terminalStatusFromExecutionData(serverMessage?.execution_data);
  const liveTerminalStatus = terminalStatusFromExecutionData(liveMessage?.execution_data);
  const serverStatus = serverTerminalStatus ?? normalizeStatus(serverMessage?.status);
  const liveStatus = normalizeStatus(actorSnapshot?.status ?? liveTerminalStatus ?? liveMessage?._optimisticStatus ?? liveMessage?.status);
  const status = resolveProjectedNodeStatus(serverStatus, liveStatus);
  const serverContent = typeof serverMessage?.content === 'string' ? serverMessage.content : '';
  const liveContent = typeof actorSnapshot?.content === 'string'
    ? actorSnapshot.content
    : typeof liveMessage?.content === 'string'
      ? liveMessage.content
      : '';
  const content = liveContent.length >= serverContent.length ? liveContent : serverContent;
  const liveExecution = liveMessage?.execution_data as Record<string, any> | null | undefined;
  const serverExecution = serverMessage?.execution_data as Record<string, any> | null | undefined;
  const lastSeq = typeof actorSnapshot?.lastSeq === 'number'
    ? actorSnapshot.lastSeq
    : typeof liveExecution?.last_agent_event_seq === 'number'
    ? liveExecution.last_agent_event_seq
    : typeof serverExecution?.last_agent_event_seq === 'number'
      ? serverExecution.last_agent_event_seq
      : null;

  return {
    status,
    content,
    progress: actorSnapshot?.progress ?? liveMessage?._setupProgress ?? null,
    lastSeq,
    source: serverMessage && (liveMessage || actorSnapshot) ? 'merged' : (liveMessage || actorSnapshot) ? 'live' : 'server',
  };
}
