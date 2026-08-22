import type { ProjectedNodeEntity } from '../domain/workspaceProjection';

const ACTIVE_AGENT_STATUSES = new Set(['pending', 'creating', 'initializing', 'running', 'streaming']);

export const resolveAgentRunHoverStatus = (
  entity: ProjectedNodeEntity | null | undefined,
  liveStatus?: string | null,
): string | null => (
  liveStatus ?? entity?.status ?? entity?.message?.status ?? null
);

export const shouldHydrateAgentRunHover = (
  entity: ProjectedNodeEntity | null | undefined,
  liveStatus?: string | null,
): boolean => {
  if (!entity) return false;
  if (entity.kind !== 'assistant_message') return false;
  if (!entity.message) return Boolean(entity.messageId);
  if (entity.message.role !== 'assistant') return false;

  const status = resolveAgentRunHoverStatus(entity, liveStatus);
  return ACTIVE_AGENT_STATUSES.has(status || '');
};
