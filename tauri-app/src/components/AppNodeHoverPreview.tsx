import { useMemo } from 'react';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { mergeLiveMessage } from '../hooks/useLiveMessages';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { NodePreviewRenderer } from './NodePreviewRenderer';

export function AppNodeHoverPreview({
  entity,
  projection,
}: {
  entity: ProjectedNodeEntity;
  projection: WorkspaceProjection;
}) {
  const messageId = entity.messageId ?? entity.message?.id ?? null;
  const liveMessage = useAgentRunProjectionStore((state) => (
    messageId ? state.projectionsById[messageId] ?? null : null
  ));
  const resolvedEntity = useMemo(() => {
    if (!liveMessage) return entity;
    const message = mergeLiveMessage(entity.message ?? null, liveMessage);
    return {
      ...entity,
      message,
      status: message.status as ProjectedNodeEntity['status'],
      preview: message.content || entity.preview,
      totalTokens: message.totalTokens ?? entity.totalTokens,
    };
  }, [entity, liveMessage]);

  return <NodePreviewRenderer entity={resolvedEntity} projection={projection} />;
}
