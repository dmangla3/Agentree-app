import type { Message } from '../stores/workspaceStore';
import type { AgentStatus } from '@shared/agentStatus';
import { resolveNodeState } from './runStateResolver';
import { getMessageThreadSessionId } from './threadSessions';

export const SUBGRAPH_THREAD_LINK_NODE_KIND = 'subgraph_thread_link';

const normalizeString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

const getExecutionMeta = (message: Message | null | undefined): Record<string, unknown> => (
  ((message?.execution_data as any)?.meta && typeof (message?.execution_data as any).meta === 'object')
    ? (message?.execution_data as any).meta
    : {}
);

export const isSubgraphThreadLinkMessage = (message: Message | null | undefined): boolean => (
  getExecutionMeta(message).node_kind === SUBGRAPH_THREAD_LINK_NODE_KIND
);

export const getSubgraphThreadDelegationRequestId = (
  message: Message | null | undefined,
): string | null => (
  normalizeString(getExecutionMeta(message).delegation_request_id)
);

export const isDelegatedSubgraphThreadLinkMessage = (
  message: Message | null | undefined,
): boolean => (
  isSubgraphThreadLinkMessage(message) && getSubgraphThreadDelegationRequestId(message) !== null
);

export const getSubgraphThreadLinkTargetId = (message: Message | null | undefined): string | null => (
  normalizeString(getExecutionMeta(message).target_thread_root_id)
);

export interface AttachedThreadLink {
  linkMessageId: string;
  threadRootId: string;
  title: string;
  status: AgentStatus | null;
  statusNodeId: string | null;
}

export interface AttachedThreadLinkIndex {
  byAssistantId: Map<string, AttachedThreadLink[]>;
  dockedLinkMessageIds: Set<string>;
}

const messageTime = (message: Message): number => {
  const parsed = Date.parse(message.updatedAt || message.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export const buildAttachedThreadLinkIndex = (
  messages: Message[],
): AttachedThreadLinkIndex => {
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const latestAssistantByThreadRootId = new Map<string, Message>();

  for (const message of messages) {
    const threadRootId = getMessageThreadSessionId(message)
      ?? normalizeString(getExecutionMeta(message).thread_origin_id);
    if (!threadRootId || message.role !== 'assistant') continue;
    const current = latestAssistantByThreadRootId.get(threadRootId);
    if (
      !current
      || messageTime(message) > messageTime(current)
      || (messageTime(message) === messageTime(current) && message.id.localeCompare(current.id) > 0)
    ) {
      latestAssistantByThreadRootId.set(threadRootId, message);
    }
  }

  const byAssistantId = new Map<string, AttachedThreadLink[]>();
  const dockedLinkMessageIds = new Set<string>();

  for (const link of messages) {
    if (!isDelegatedSubgraphThreadLinkMessage(link) || !link.parentId) continue;
    const owner = messageById.get(link.parentId);
    if (owner?.role !== 'assistant') continue;
    const threadRootId = getSubgraphThreadLinkTargetId(link);
    if (!threadRootId) continue;

    const latestAssistant = latestAssistantByThreadRootId.get(threadRootId) ?? null;
    const status = latestAssistant
      ? resolveNodeState(latestAssistant, null).status as AgentStatus | null
      : null;
    const attachedThreads = byAssistantId.get(owner.id) ?? [];
    attachedThreads.push({
      linkMessageId: link.id,
      threadRootId,
      title: normalizeString(link.content) ?? normalizeString(link.aiLabel) ?? 'Delegated work',
      status,
      statusNodeId: latestAssistant?.id ?? null,
    });
    byAssistantId.set(owner.id, attachedThreads);
    dockedLinkMessageIds.add(link.id);
  }

  byAssistantId.forEach((attachedThreads) => {
    attachedThreads.sort((left, right) => {
      const leftMessage = messageById.get(left.linkMessageId);
      const rightMessage = messageById.get(right.linkMessageId);
      if (leftMessage && rightMessage) {
        const timeDelta = messageTime(leftMessage) - messageTime(rightMessage);
        if (timeDelta !== 0) return timeDelta;
      }
      return left.linkMessageId.localeCompare(right.linkMessageId);
    });
  });

  return { byAssistantId, dockedLinkMessageIds };
};
