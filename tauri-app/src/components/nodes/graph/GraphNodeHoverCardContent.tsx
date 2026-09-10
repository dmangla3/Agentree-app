import { NodeHoverCardContent } from '../../NodeHoverCardContent';
import { useGraphHoverProjectionInput } from '../../graph/GraphHoverProjectionContext';
import { useWorkspaceProjection } from '../../../hooks/useWorkspaceProjection';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import type {
  AgentreeSurfaceCapabilities,
  AgentreeSurfaceMode,
} from '../../graph/surfaceCapabilities';

interface GraphNodeHoverCardContentProps {
  entity?: ProjectedNodeEntity;
  fallbackProjection?: WorkspaceProjection;
  surfaceMode?: AgentreeSurfaceMode;
  capabilities?: AgentreeSurfaceCapabilities;
  showOrchestrationSummary?: boolean;
}

export function GraphNodeHoverCardContent({
  entity,
  fallbackProjection,
  surfaceMode,
  capabilities,
  showOrchestrationSummary,
}: GraphNodeHoverCardContentProps) {
  const hoverInput = useGraphHoverProjectionInput();
  const hoverProjection = useWorkspaceProjection(
    hoverInput.messages.length > 0 ? hoverInput.messages : fallbackProjection?.messages ?? [],
    hoverInput.summaries.length > 0 ? hoverInput.summaries : fallbackProjection?.summaries ?? [],
    null,
    hoverInput.disabledSummaryIds,
    'graph-hover',
  );
  const resolvedEntity = entity?.messageId
    ? hoverProjection.entitiesByMessageId.get(entity.messageId) ?? entity
    : entity?.summary?.id
      ? hoverProjection.entitiesBySummaryId.get(entity.summary.id) ?? entity
      : entity;

  return (
    <NodeHoverCardContent
      entity={resolvedEntity}
      projection={resolvedEntity ? hoverProjection : fallbackProjection}
      surfaceMode={surfaceMode}
      capabilities={capabilities}
      showOrchestrationSummary={showOrchestrationSummary}
    />
  );
}
