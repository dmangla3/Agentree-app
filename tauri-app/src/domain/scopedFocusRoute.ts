import type { Message, Scope } from '../stores/workspaceStore';
import { getGraphParentId } from '../lib/graph/lineage';

export interface ScopedFocusRoute {
  scopeId: string | null;
  baseNodeId: string | null;
  messageIds: string[];
  edges: string[];
}

export interface RenderedFocusRoute {
  nodeIds: string[];
  edges: string[];
}

const EMPTY_ROUTE: ScopedFocusRoute = {
  scopeId: null,
  baseNodeId: null,
  messageIds: [],
  edges: [],
};

export const isImportedGitMessage = (message: Message | null | undefined): boolean => {
  if (!message || message.role !== 'assistant') return false;
  const meta = ((message.execution_data as any)?.meta || {}) as Record<string, unknown>;
  return meta.sync_source === 'external_git' || meta.node_kind === 'commit' || meta.node_kind === 'commit_batch';
};

const edgeIdsForRoute = (messageIds: string[]): string[] => {
  const edges: string[] = [];
  for (let index = 1; index < messageIds.length; index += 1) {
    edges.push(`${messageIds[index - 1]}->${messageIds[index]}`);
  }
  return edges;
};

const buildLegacyUnscopedFocusRoute = (
  focusedMessage: Message,
  messageMap: Map<string, Message>
): ScopedFocusRoute => {
  const reversedRoute: string[] = [];
  const visited = new Set<string>();

  let currentId: string | null = focusedMessage.id;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = messageMap.get(currentId);
    if (!message) break;

    const messageScopeId = message.scope_id ?? null;
    if (messageScopeId) {
      break;
    }

    reversedRoute.push(message.id);
    currentId = getGraphParentId(message, messageMap);
  }

  const messageIds = reversedRoute.reverse();
  return {
    scopeId: null,
    baseNodeId: messageIds[0] ?? null,
    messageIds,
    edges: edgeIdsForRoute(messageIds),
  };
};

export const buildScopedFocusRoute = (
  messages: Message[] | Map<string, Message>,
  scopes: Scope[] | Map<string, Scope>,
  focusedMessageId: string | null
): ScopedFocusRoute => {
  if (!focusedMessageId) return EMPTY_ROUTE;

  const messageMap = messages instanceof Map
    ? messages
    : new Map(messages.map((message) => [message.id, message]));
  const scopeMap = scopes instanceof Map
    ? scopes
    : new Map(scopes.map((scope) => [scope.id, scope]));

  const focusedMessage = messageMap.get(focusedMessageId);
  if (!focusedMessage) return EMPTY_ROUTE;
  if (isImportedGitMessage(focusedMessage)) return EMPTY_ROUTE;

  const focusedScopeId = focusedMessage.scope_id ?? null;
  if (!focusedScopeId) {
    return buildLegacyUnscopedFocusRoute(focusedMessage, messageMap);
  }

  const focusedScope = scopeMap.get(focusedScopeId) ?? null;
  const baseNodeId = focusedScope?.base_node_id ?? null;
  const reversedRoute: string[] = [];
  const visited = new Set<string>();

  let currentId: string | null = focusedMessage.id;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = messageMap.get(currentId);
    if (!message) break;

    const isBaseBoundary = !!baseNodeId && message.id === baseNodeId;
    const isSameScope = (message.scope_id ?? null) === focusedScopeId;
    const isImportedConnector = isImportedGitMessage(message);

    if (isBaseBoundary || isSameScope || isImportedConnector) {
      reversedRoute.push(message.id);
    }

    if (isBaseBoundary) break;

    currentId = getGraphParentId(message, messageMap);
  }

  const messageIds = reversedRoute.reverse();
  return {
    scopeId: focusedScopeId,
    baseNodeId,
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
