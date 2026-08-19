import type { Message } from '../stores/workspaceStore';
import { isFirstClassCommitMessage } from './graph/turnUtils';
import {
  getLegacyThreadIdForMessage,
  getMessageThreadSessionId,
  type ThreadSession,
} from './threadSessions';

export interface ThreadRootIndex {
  threadRootIds: string[];
  threadRootIdByMessageId: Map<string, string>;
  messageIdsByThreadRootId: Map<string, Set<string>>;
  rootMessageIdByThreadRootId: Map<string, string>;
}

export const getThreadOriginNodeId = (threadRootId: string): string => `thread-origin:${threadRootId}`;

export const getEmptyWorkspaceThreadRootId = (workspaceId: string): string => `workspace-empty-thread:${workspaceId}`;

export const getThreadRootId = (
  messageId: string | null | undefined,
  messageMap: Map<string, Message>,
): string | null => {
  const directThreadId = messageId ? getMessageThreadSessionId(messageMap.get(messageId)) : null;
  return directThreadId ?? getLegacyThreadIdForMessage(messageId, messageMap);
};

export const buildThreadRootIndex = (
  messages: Message[],
  options: {
    emptyThreadRootId?: string | null;
    syntheticThreadRootIds?: string[];
    threadSessions?: ThreadSession[];
  } = {},
): ThreadRootIndex => {
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  const threadRootIdByMessageId = new Map<string, string>();
  const messageIdsByThreadRootId = new Map<string, Set<string>>();
  const rootMessageIdByThreadRootId = new Map<string, string>();
  const threadSessionById = new Map<string, ThreadSession>();

  for (const thread of options.threadSessions ?? []) {
    const threadRootId = thread.id.trim();
    if (!threadRootId) continue;
    threadSessionById.set(threadRootId, thread);
    if (!messageIdsByThreadRootId.has(threadRootId)) {
      messageIdsByThreadRootId.set(threadRootId, new Set());
    }
    if (thread.firstMessageId && messageMap.has(thread.firstMessageId)) {
      rootMessageIdByThreadRootId.set(threadRootId, thread.firstMessageId);
    }
  }

  const emptyThreadRootId = options.emptyThreadRootId?.trim();
  if (messages.length === 0 && emptyThreadRootId) {
    messageIdsByThreadRootId.set(emptyThreadRootId, new Set());
  }

  for (const syntheticThreadRootId of options.syntheticThreadRootIds ?? []) {
    const threadRootId = syntheticThreadRootId.trim();
    if (!threadRootId || messageIdsByThreadRootId.has(threadRootId)) continue;
    messageIdsByThreadRootId.set(threadRootId, new Set());
  }

  for (const message of messages) {
    if (isFirstClassCommitMessage(message, { messageMap })) continue;
    const threadRootId = getThreadRootId(message.id, messageMap);
    if (!threadRootId) continue;

    threadRootIdByMessageId.set(message.id, threadRootId);
    const threadMessageIds = messageIdsByThreadRootId.get(threadRootId) ?? new Set<string>();
    threadMessageIds.add(message.id);
    messageIdsByThreadRootId.set(threadRootId, threadMessageIds);

    if (message.role === 'user') {
      const currentRootMessageId = rootMessageIdByThreadRootId.get(threadRootId);
      const currentRootMessage = currentRootMessageId ? messageMap.get(currentRootMessageId) ?? null : null;
      const currentTs = currentRootMessage ? new Date(currentRootMessage.createdAt).getTime() : Number.POSITIVE_INFINITY;
      const messageTs = new Date(message.createdAt).getTime();
      if (
        !currentRootMessage ||
        message.parentId === null && currentRootMessage.parentId !== null ||
        (message.parentId === currentRootMessage.parentId && (
          messageTs < currentTs ||
          (messageTs === currentTs && message.id.localeCompare(currentRootMessage.id) < 0)
        ))
      ) {
        rootMessageIdByThreadRootId.set(threadRootId, message.id);
      }
    }
  }

  const threadRootIds = Array.from(messageIdsByThreadRootId.keys()).sort((left, right) => {
    const leftMessage = rootMessageIdByThreadRootId.get(left)
      ? messageMap.get(rootMessageIdByThreadRootId.get(left)!) ?? null
      : null;
    const rightMessage = rootMessageIdByThreadRootId.get(right)
      ? messageMap.get(rootMessageIdByThreadRootId.get(right)!) ?? null
      : null;
    const isTopLevelThreadRoot = (message: Message | null): boolean => {
      if (!message) return false;
      if (message.parentId === null) return true;
      const parent = messageMap.get(message.parentId) ?? null;
      return parent?.role === 'assistant' && parent.parentId === null;
    };
    const leftIsTopLevel = isTopLevelThreadRoot(leftMessage);
    const rightIsTopLevel = isTopLevelThreadRoot(rightMessage);
    if (leftIsTopLevel !== rightIsTopLevel) return leftIsTopLevel ? -1 : 1;
    const leftThread = threadSessionById.get(left);
    const rightThread = threadSessionById.get(right);
    const leftTs = leftMessage
      ? new Date(leftMessage.createdAt).getTime()
      : leftThread
        ? new Date(leftThread.createdAt).getTime()
        : Number.POSITIVE_INFINITY;
    const rightTs = rightMessage
      ? new Date(rightMessage.createdAt).getTime()
      : rightThread
        ? new Date(rightThread.createdAt).getTime()
        : Number.POSITIVE_INFINITY;
    if (leftTs !== rightTs) return leftTs - rightTs;
    return left.localeCompare(right);
  });

  return {
    threadRootIds,
    threadRootIdByMessageId,
    messageIdsByThreadRootId,
    rootMessageIdByThreadRootId,
  };
};

export const getThreadDescendantIds = (
  threadRootId: string | null | undefined,
  messages: Message[],
): Set<string> => {
  if (!threadRootId) return new Set();
  return buildThreadRootIndex(messages).messageIdsByThreadRootId.get(threadRootId) ?? new Set();
};

export const getLatestThreadMessageId = (
  threadRootId: string | null | undefined,
  messages: Message[],
): string | null => {
  if (!threadRootId) return null;

  const messageById = new Map(messages.map((message) => [message.id, message]));
  const threadMessageIds = buildThreadRootIndex(messages).messageIdsByThreadRootId.get(threadRootId);
  if (!threadMessageIds || threadMessageIds.size === 0) return null;

  let latestMessage: Message | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const messageId of threadMessageIds) {
    const message = messageById.get(messageId);
    if (!message) continue;

    const updatedAt = new Date(message.updatedAt).getTime();
    const createdAt = new Date(message.createdAt).getTime();
    const timestamp = Math.max(
      Number.isFinite(updatedAt) ? updatedAt : Number.NEGATIVE_INFINITY,
      Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY,
    );

    if (
      !latestMessage ||
      timestamp > latestTimestamp ||
      (timestamp === latestTimestamp && message.id.localeCompare(latestMessage.id) > 0)
    ) {
      latestMessage = message;
      latestTimestamp = timestamp;
    }
  }

  return latestMessage?.id ?? null;
};

export const getHiddenConversationMessageIds = ({
  messages,
  hiddenThreadRootIds,
  hiddenSubgraphRootIds,
}: {
  messages: Message[];
  hiddenThreadRootIds: Set<string>;
  hiddenSubgraphRootIds: Set<string>;
}): Set<string> => {
  const hiddenIds = new Set<string>();
  for (const threadRootId of hiddenThreadRootIds) {
    getThreadDescendantIds(threadRootId, messages).forEach((messageId) => hiddenIds.add(messageId));
  }

  for (const subgraphRootId of hiddenSubgraphRootIds) {
    const subgraphIds = new Set<string>();
    const childrenByParentId = new Map<string, string[]>();
    for (const message of messages) {
      if (!message.parentId) continue;
      const children = childrenByParentId.get(message.parentId) ?? [];
      children.push(message.id);
      childrenByParentId.set(message.parentId, children);
    }

    const stack = [subgraphRootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (subgraphIds.has(id)) continue;
      subgraphIds.add(id);
      stack.push(...(childrenByParentId.get(id) ?? []));
    }
    subgraphIds.forEach((messageId) => hiddenIds.add(messageId));
  }

  return hiddenIds;
};
