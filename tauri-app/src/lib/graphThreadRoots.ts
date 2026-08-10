import type { Message } from '../stores/workspaceStore';
import { isFirstClassCommitMessage } from './graph/turnUtils';

export interface ThreadRootIndex {
  threadRootIds: string[];
  threadRootIdByMessageId: Map<string, string>;
  messageIdsByThreadRootId: Map<string, Set<string>>;
}

export const getThreadRootId = (
  messageId: string | null | undefined,
  messageMap: Map<string, Message>,
): string | null => {
  let cursor = messageId ? messageMap.get(messageId) ?? null : null;
  const visited = new Set<string>();

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (!cursor.parentId) {
      return cursor.role === 'user' ? cursor.id : null;
    }
    cursor = messageMap.get(cursor.parentId) ?? null;
  }

  return null;
};

export const buildThreadRootIndex = (messages: Message[]): ThreadRootIndex => {
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  const threadRootIds = messages
    .filter((message) => message.role === 'user' && message.parentId === null)
    .sort((left, right) => {
      const leftTs = new Date(left.createdAt).getTime();
      const rightTs = new Date(right.createdAt).getTime();
      if (leftTs !== rightTs) return leftTs - rightTs;
      return left.id.localeCompare(right.id);
    })
    .map((message) => message.id);

  const threadRootIdByMessageId = new Map<string, string>();
  const messageIdsByThreadRootId = new Map<string, Set<string>>();

  for (const message of messages) {
    if (isFirstClassCommitMessage(message, { messageMap })) continue;
    const threadRootId = getThreadRootId(message.id, messageMap);
    if (!threadRootId) continue;

    threadRootIdByMessageId.set(message.id, threadRootId);
    const threadMessageIds = messageIdsByThreadRootId.get(threadRootId) ?? new Set<string>();
    threadMessageIds.add(message.id);
    messageIdsByThreadRootId.set(threadRootId, threadMessageIds);
  }

  return {
    threadRootIds,
    threadRootIdByMessageId,
    messageIdsByThreadRootId,
  };
};

export const getThreadDescendantIds = (
  threadRootId: string | null | undefined,
  messages: Message[],
): Set<string> => {
  if (!threadRootId) return new Set();
  return buildThreadRootIndex(messages).messageIdsByThreadRootId.get(threadRootId) ?? new Set();
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
