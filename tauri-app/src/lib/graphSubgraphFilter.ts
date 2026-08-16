import type { Message } from '../stores/workspaceStore';

interface GraphFilterLike {
  matchingMessageIds: Set<string>;
  filterActive: boolean;
  hasNodeTypeFilter: boolean;
  keepAncestors: boolean;
  keepDescendants: boolean;
}

export const getSubgraphMessageIds = (
  messages: Message[],
  rootMessageId: string | null,
): Set<string> => {
  if (!rootMessageId) return new Set();
  const messageIds = new Set(messages.map((message) => message.id));
  if (!messageIds.has(rootMessageId)) return new Set();

  const childrenByParentId = new Map<string, string[]>();
  for (const message of messages) {
    if (!message.parentId) continue;
    const children = childrenByParentId.get(message.parentId) ?? [];
    children.push(message.id);
    childrenByParentId.set(message.parentId, children);
  }

  const filteredIds = new Set<string>();
  const stack = [rootMessageId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (filteredIds.has(id)) continue;
    filteredIds.add(id);
    stack.push(...(childrenByParentId.get(id) ?? []));
  }

  return filteredIds;
};

export const createSubgraphFilterState = (
  rootMessageId: string | null,
  subgraphMessageIds: Set<string>,
  fallback: GraphFilterLike,
): GraphFilterLike => {
  if (!rootMessageId) return fallback;

  return {
    matchingMessageIds: subgraphMessageIds,
    filterActive: true,
    hasNodeTypeFilter: true,
    keepAncestors: false,
    keepDescendants: false,
  };
};

export const shouldClearSubgraphForFocus = (
  rootMessageId: string | null,
  subgraphMessageIds: Set<string>,
  focusedMessageId: string | null,
): boolean => {
  if (!rootMessageId || !focusedMessageId) return false;
  if (focusedMessageId === rootMessageId) return false;
  return !subgraphMessageIds.has(focusedMessageId);
};
