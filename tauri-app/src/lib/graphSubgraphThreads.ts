import type { Message } from '../stores/workspaceStore';
import type { AgentStatus } from '@shared/agentStatus';
import { resolveNodeState } from './runStateResolver';
import { getMessageThreadSessionId } from './threadSessions';

export const SUBGRAPH_THREAD_LINK_NODE_KIND = 'subgraph_thread_link';

const SUBGRAPH_THREAD_STORAGE_PREFIX = 'agentree.converted-subgraph-threads.v1';

const normalizeString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

const getExecutionMeta = (message: Message | null | undefined): Record<string, unknown> => (
  ((message?.execution_data as any)?.meta && typeof (message?.execution_data as any).meta === 'object')
    ? (message?.execution_data as any).meta
    : {}
);

export const getSubgraphThreadLinkNodeId = (threadRootId: string): string => `thread-link:${threadRootId}`;

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

export const getSubgraphThreadOriginalParentId = (message: Message | null | undefined): string | null => (
  normalizeString(getExecutionMeta(message).original_parent_id)
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

export const getConvertedSubgraphThreadsStorageKey = (workspaceId: string): string => (
  `${SUBGRAPH_THREAD_STORAGE_PREFIX}.workspace.${workspaceId}`
);

const normalizeRootIdSet = (
  value: unknown,
  availableMessageIds?: Iterable<string>,
): Set<string> => {
  const available = availableMessageIds ? new Set(availableMessageIds) : null;
  if (!Array.isArray(value)) return new Set();

  return new Set(value.filter((item): item is string => (
    typeof item === 'string' &&
    item.trim().length > 0 &&
    (!available || available.has(item))
  )));
};

export const readConvertedSubgraphThreadRootIds = (
  workspaceId: string | null | undefined,
  availableMessageIds?: Iterable<string>,
): Set<string> => {
  if (!workspaceId || typeof window === 'undefined') return new Set();

  try {
    const raw = window.localStorage.getItem(getConvertedSubgraphThreadsStorageKey(workspaceId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { rootMessageIds?: unknown };
    return normalizeRootIdSet(parsed.rootMessageIds, availableMessageIds);
  } catch {
    return new Set();
  }
};

export const rememberConvertedSubgraphThreadRootIds = (
  workspaceId: string | null | undefined,
  rootMessageIds: Iterable<string>,
): void => {
  if (!workspaceId || typeof window === 'undefined') return;

  try {
    const ids = Array.from(new Set(rootMessageIds)).filter(Boolean).sort();
    const key = getConvertedSubgraphThreadsStorageKey(workspaceId);
    if (ids.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ rootMessageIds: ids }));
  } catch {
    // Converted subgraph threads are a best-effort local graph preference.
  }
};

const createThreadLinkMessage = (root: Message, originalParentId: string): Message => ({
  ...root,
  id: getSubgraphThreadLinkNodeId(root.id),
  role: 'user',
  parentId: originalParentId,
  content: root.content,
  aiLabel: 'Thread',
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  processedContent: null,
  reasoning: null,
  followupQuestions: null,
  citations: null,
  comments: null,
  agent_id: null,
  status: 'completed',
  node_delta: null,
  path_ids: null,
  depth: null,
  last_event_at: null,
  lease_expires_at: null,
  heartbeat_at: null,
  collapsed: false,
  context_active: true,
  output_commit_sha: null,
  commit: null,
  git_branch_name: null,
  branchPointers: [],
  execution_data: {
    meta: {
      node_kind: SUBGRAPH_THREAD_LINK_NODE_KIND,
      target_thread_root_id: root.id,
      original_parent_id: originalParentId,
    },
  },
});

const createConvertedThreadRootMessage = (root: Message): Message => ({
  ...root,
  parentId: null,
  execution_data: {
    ...((root.execution_data && typeof root.execution_data === 'object') ? root.execution_data : {}),
    meta: {
      ...getExecutionMeta(root),
      thread_origin_id: root.id,
      converted_subgraph_parent_id: root.parentId,
    },
  },
});

export const applySubgraphThreadConversions = ({
  messages,
  convertedRootIds,
}: {
  messages: Message[];
  convertedRootIds: Set<string>;
}): Message[] => {
  if (convertedRootIds.size === 0 || messages.length === 0) return messages;

  const messageById = new Map(messages.map((message) => [message.id, message]));
  const validRootIds = new Set<string>();
  for (const rootId of convertedRootIds) {
    const root = messageById.get(rootId);
    if (!root || root.role !== 'user' || !root.parentId || isSubgraphThreadLinkMessage(root)) continue;
    validRootIds.add(rootId);
  }

  if (validRootIds.size === 0) return messages;

  const convertedMessages: Message[] = [];
  for (const message of messages) {
    if (!validRootIds.has(message.id)) {
      convertedMessages.push(message);
      continue;
    }

    const originalParentId = message.parentId;
    if (!originalParentId) {
      convertedMessages.push(message);
      continue;
    }

    convertedMessages.push(createThreadLinkMessage(message, originalParentId));
    convertedMessages.push(createConvertedThreadRootMessage(message));
  }

  return convertedMessages;
};
