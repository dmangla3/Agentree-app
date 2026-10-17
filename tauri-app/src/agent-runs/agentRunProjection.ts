import { AGENT_STATUS } from '@shared/agentStatus';
import type { AgentRunSnapshot } from './agentRun.types';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';

const progressText: Record<string, string> = {
  pending: 'Sending...',
  creating: 'Creating node...',
  initializing: 'Initializing agent...',
  running: 'Running...',
  streaming: 'Running...',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  error: 'Failed',
};

const cleanNodeId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

/**
 * Convert an actor snapshot into the projected message shape consumed by
 * existing selectors/components.
 */
export const projectAgentRunToProjectedMessage = (
  snapshot: AgentRunSnapshot,
  existing?: AgentRunProjectedMessage | Message | null,
): AgentRunProjectedMessage => {
  const base = {
    ...((snapshot.message ?? {}) as Partial<AgentRunProjectedMessage>),
    ...((existing ?? {}) as Partial<AgentRunProjectedMessage>),
  };
  const executionData = {
    ...((base.execution_data ?? {}) as Record<string, any>),
    ...snapshot.executionData,
    timeline: snapshot.timeline,
    ...(snapshot.lastSeq !== null ? { last_agent_event_seq: snapshot.lastSeq } : {}),
    ...(snapshot.lastStreamSeq !== null ? { last_stream_seq: snapshot.lastStreamSeq } : {}),
  };
  const outputCommitSha = typeof (executionData as any).output_commit_sha === 'string'
    ? (executionData as any).output_commit_sha
    : typeof (executionData as any).meta?.output_commit_sha === 'string'
      ? (executionData as any).meta.output_commit_sha
      : base.output_commit_sha ?? null;

  return {
    ...base,
    id: snapshot.nodeId,
    workspaceId: snapshot.workspaceId ?? base.workspaceId ?? '',
    // Hydration adapters historically used an empty string when parent data
    // was not present. Never let that transient placeholder detach a running
    // assistant from the durable/seeded user node.
    parentId: cleanNodeId(snapshot.parentId) ?? cleanNodeId(base.parentId) ?? null,
    role: snapshot.role ?? base.role ?? 'assistant',
    agent_id: snapshot.agentId ?? base.agent_id ?? null,
    content: snapshot.content,
    status: (snapshot.status ?? base.status ?? AGENT_STATUS.running) as any,
    _optimistic: base._optimistic ?? false,
    _optimisticStatus: (snapshot.status ?? base._optimisticStatus ?? null) as any,
    _optimisticError: base._optimisticError ?? null,
    _rollbackOnFail: base._rollbackOnFail,
    _setupProgress: snapshot.progress ?? (snapshot.status ? progressText[snapshot.status] ?? null : null) ?? undefined,
    _terminalHoldUntil: snapshot.terminalHoldUntil ?? base._terminalHoldUntil,
    _terminalContentLength: snapshot.terminalStatus ? snapshot.content.length : base._terminalContentLength,
    execution_data: executionData,
    output_commit_sha: outputCommitSha,
    createdAt: base.createdAt ?? new Date().toISOString(),
    updatedAt: snapshot.updatedAt,
  } as AgentRunProjectedMessage;
};

export const projectAgentRunStatus = (snapshot: AgentRunSnapshot) => ({
  workspaceId: snapshot.workspaceId,
  role: snapshot.role,
  status: snapshot.status,
  progress: snapshot.progress ?? (snapshot.status ? progressText[snapshot.status] ?? null : null),
});
