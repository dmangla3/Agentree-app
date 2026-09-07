import { QueryClient } from '@tanstack/react-query';
import { AGENT_STATUS, isActiveAgentStatus, type AgentStatus } from '@shared/agentStatus';
import { agentClient } from './agentClient';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, type LocalNodeMessage } from '../hooks/useLocalNodes';
import type { Message } from '../stores/workspaceStore';

export const isNoAgentSessionFoundError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('No agent session found');
};

type StaleLocalAgentNodeCandidate = Pick<Message, 'status' | 'execution_data'> & Partial<Pick<Message, 'role'>>;

export const isStalePrelaunchLocalAgentNode = (node: StaleLocalAgentNodeCandidate | null | undefined): boolean => {
  if (!isActiveAgentStatus(node?.status)) return false;
  if (node?.role && node.role !== 'assistant') return false;
  return Boolean(readQuickReplyFlag(node) || !readCurrentRunId(node));
};

export async function markLocalAgentNodeTerminal(input: {
  queryClient: QueryClient;
  workspaceId: string;
  nodeId: string;
  node?: Partial<Message> | null;
  status: AgentStatus;
  reason: string;
}): Promise<Message> {
  const now = new Date().toISOString();
  const executionData = buildTerminalExecutionData(input.node?.execution_data, input.status, input.reason);
  const nextMessage = {
    ...(input.node ?? {}),
    id: input.nodeId,
    role: input.node?.role ?? 'assistant',
    workspaceId: input.node?.workspaceId ?? input.workspaceId,
    content: input.node?.content ?? '',
    parentId: input.node?.parentId ?? null,
    attachments: input.node?.attachments ?? [],
    createdAt: input.node?.createdAt ?? now,
    updatedAt: now,
    status: input.status,
    execution_data: executionData,
  } as Message;

  await agentClient.upsertLocalNode(input.workspaceId, input.nodeId, nextMessage);

  input.queryClient.setQueryData<Message[]>(['messages', input.workspaceId], (current) => {
    const existing = current ?? [];
    return [...existing.filter((message) => message.id !== input.nodeId), nextMessage]
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  });
  input.queryClient.setQueryData<LocalNodeMessage[]>(
    localNodeKeys.workspace(input.workspaceId),
    (current) => upsertMessagesIntoLocalNodeCache(current, input.workspaceId, [nextMessage], {
      syncStatus: 'local_only',
      finalizedAt: Math.floor(Date.now() / 1000),
    }),
  );
  void input.queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(input.workspaceId) });
  return nextMessage;
}

export async function markStaleLocalAgentNodeCancelled(input: {
  queryClient: QueryClient;
  workspaceId: string;
  nodeId: string;
  node?: Partial<Message> | null;
  reason?: string;
}): Promise<boolean> {
  if (!isStalePrelaunchLocalAgentNode(input.node as Message | null | undefined)) {
    return false;
  }
  await markLocalAgentNodeTerminal({
    queryClient: input.queryClient,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    node: input.node,
    status: AGENT_STATUS.cancelled,
    reason: input.reason ?? 'Run cancelled before the native agent session was created.',
  });
  return true;
}

function buildTerminalExecutionData(
  existing: Message['execution_data'] | undefined,
  status: AgentStatus,
  reason: string,
): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? existing as Record<string, unknown> : {};
  const meta = base.meta && typeof base.meta === 'object' && !Array.isArray(base.meta)
    ? base.meta as Record<string, unknown>
    : {};
  return {
    ...base,
    last_terminal_status: status,
    stop_reason: reason,
    meta: {
      ...meta,
      provider_error_message: reason,
      ...(status === AGENT_STATUS.cancelled
        ? { cancellation_reason: reason }
        : { failure_reason: reason }),
    },
  };
}

function readCurrentRunId(node: Pick<Message, 'execution_data'> | null | undefined): string | null {
  const executionData = node?.execution_data;
  if (!executionData || typeof executionData !== 'object') return null;
  const currentRunId = (executionData as Record<string, unknown>).current_run_id;
  return typeof currentRunId === 'string' && currentRunId.trim() ? currentRunId.trim() : null;
}

function readQuickReplyFlag(node: Pick<Message, 'execution_data'> | null | undefined): boolean {
  const executionData = node?.execution_data;
  if (!executionData || typeof executionData !== 'object') return false;
  const meta = (executionData as Record<string, unknown>).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return (meta as Record<string, unknown>).quick_reply === true;
}
