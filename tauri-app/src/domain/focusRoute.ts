import type { Message } from '../stores/workspaceStore';
import { getGraphParentId } from '../lib/graph/lineage';

export interface FocusRoute {
  baseNodeId: string | null;
  messageIds: string[];
  edges: string[];
}

export interface RenderedFocusRoute {
  nodeIds: string[];
  edges: string[];
}

const EMPTY_ROUTE: FocusRoute = {
  baseNodeId: null,
  messageIds: [],
  edges: [],
};

export const isImportedGitMessage = (message: Message | null | undefined): boolean => {
  if (!message || message.role !== 'assistant') return false;
  const meta = ((message.execution_data as any)?.meta || {}) as Record<string, unknown>;
  return meta.sync_source === 'external_git' || meta.node_kind === 'commit';
};

const edgeIdsForRoute = (messageIds: string[]): string[] => {
  const edges: string[] = [];
  for (let index = 1; index < messageIds.length; index += 1) {
    edges.push(`${messageIds[index - 1]}->${messageIds[index]}`);
  }
  return edges;
};

export const buildFocusRoute = (
  messages: Message[] | Map<string, Message>,
  focusedMessageId: string | null
): FocusRoute => {
  if (!focusedMessageId) return EMPTY_ROUTE;

  const messageMap = messages instanceof Map
    ? messages
    : new Map(messages.map((message) => [message.id, message]));

  const focusedMessage = messageMap.get(focusedMessageId);
  if (!focusedMessage || isImportedGitMessage(focusedMessage)) return EMPTY_ROUTE;

  const reversedRoute: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = focusedMessage.id;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = messageMap.get(currentId);
    if (!message) break;
    reversedRoute.push(message.id);
    currentId = getGraphParentId(message, messageMap);
  }

  const messageIds = reversedRoute.reverse();
  return {
    baseNodeId: messageIds[0] ?? null,
    messageIds,
    edges: edgeIdsForRoute(messageIds),
  };
};

export const collapseRenderedFocusRoute = (
  routeMessageIds: string[],
  resolveRenderedNodeId: (messageId: string) => string | null | undefined
): RenderedFocusRoute => {
  const nodeIds: string[] = [];
  for (const messageId of routeMessageIds) {
    const renderedNodeId = resolveRenderedNodeId(messageId);
    if (!renderedNodeId) continue;
    if (nodeIds[nodeIds.length - 1] === renderedNodeId) continue;
    nodeIds.push(renderedNodeId);
  }

  return {
    nodeIds,
    edges: edgeIdsForRoute(nodeIds),
  };
};
