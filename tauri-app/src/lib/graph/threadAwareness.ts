import { isActiveAgentStatus, isTerminalAgentStatus } from '@shared/agentStatus';

export interface ThreadAwarenessMessageLike {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  last_event_at?: string | null;
}

export interface ThreadAwarenessSummary {
  unreadCompletedLeafCount: number;
  initialPreviewNodeId: string | null;
  previewNodeIds: string[];
}

export const getThreadAwarenessTimestamp = (message: ThreadAwarenessMessageLike): number => {
  const candidates = [message.last_event_at, message.updatedAt, message.createdAt];
  let latest = 0;

  for (const candidate of candidates) {
    const parsed = Date.parse(candidate || '');
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }

  return latest;
};

const byRecency = (
  left: ThreadAwarenessMessageLike,
  right: ThreadAwarenessMessageLike,
): number => (
  getThreadAwarenessTimestamp(right) - getThreadAwarenessTimestamp(left) ||
  right.id.localeCompare(left.id)
);

const getLatestMessageId = (messages: ThreadAwarenessMessageLike[]): string | null => (
  [...messages].sort(byRecency)[0]?.id ?? null
);

export const getThreadAwarenessSummary = ({
  messages,
  lastVisitedAt,
}: {
  messages: readonly ThreadAwarenessMessageLike[];
  lastVisitedAt: number;
}): ThreadAwarenessSummary => {
  const parentIds = new Set<string>();
  for (const message of messages) {
    if (message.parentId) parentIds.add(message.parentId);
  }

  const sortedMessages = [...messages].sort(byRecency);
  const assistantPreviewMessages = sortedMessages.filter((message) => message.role === 'assistant');
  const leaves = sortedMessages.filter((message) => !parentIds.has(message.id));
  const assistantLeaves = leaves.filter((message) => message.role === 'assistant');
  const unreadCompletedLeaves = leaves.filter((message) => (
    message.role === 'assistant' &&
    message.status === 'completed' &&
    getThreadAwarenessTimestamp(message) > lastVisitedAt
  ));
  const activeMessages = assistantPreviewMessages.filter((message) => isActiveAgentStatus(message.status));
  const failedLeaves = assistantLeaves.filter((message) => (
    isTerminalAgentStatus(message.status) && message.status !== 'completed'
  ));

  const initialPreviewNodeId = getLatestMessageId(unreadCompletedLeaves) ??
    getLatestMessageId(activeMessages) ??
    getLatestMessageId(failedLeaves) ??
    getLatestMessageId(assistantLeaves) ??
    getLatestMessageId(assistantPreviewMessages);

  return {
    unreadCompletedLeafCount: unreadCompletedLeaves.length,
    initialPreviewNodeId,
    previewNodeIds: assistantPreviewMessages.map((message) => message.id),
  };
};
