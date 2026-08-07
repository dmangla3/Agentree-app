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

  const scopedIds = new Set<string>();
  const stack = [rootMessageId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (scopedIds.has(id)) continue;
    scopedIds.add(id);
    stack.push(...(childrenByParentId.get(id) ?? []));
  }

  return scopedIds;
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
