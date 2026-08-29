import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { NodePreviewRenderer } from './NodePreviewRenderer';

export function AppNodeHoverPreview({
  entity,
  projection,
}: {
  entity: ProjectedNodeEntity;
  projection: WorkspaceProjection;
}) {
  return <NodePreviewRenderer entity={entity} projection={projection} />;
}
