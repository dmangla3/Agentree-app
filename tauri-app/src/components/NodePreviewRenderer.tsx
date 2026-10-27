import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { ChatNodeDispatcher } from './nodes/chat/ChatNodeDispatcher';

interface NodePreviewRendererProps {
  entity: ProjectedNodeEntity;
  projection: WorkspaceProjection;
}

export function NodePreviewRenderer({ entity, projection }: NodePreviewRendererProps) {
  return (
    <ChatNodeDispatcher
      entityId={entity.entityId}
      entityOverride={entity}
      projection={projection}
      focusedMessageId={null}
      isSelected={false}
      layout="hovercard"
      onFocus={() => {}}
      onSelect={() => {}}
      onContextMenu={() => {}}
    />
  );
}
