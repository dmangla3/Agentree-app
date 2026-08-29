import type { ReactNode } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../@/components/ui/hover-card';
import type { ExecutionTimelineItem } from '../../lib/executionTimelineModel';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../domain/workspaceProjection';
import { NodeHoverCardContent } from '../NodeHoverCardContent';
import { createCommitHoverEntity } from '../nodes/graph/commitHoverEntity';
import type { AgentreeSurfaceCapabilities, AgentreeSurfaceMode } from '../graph/surfaceCapabilities';

interface ExecutionTimelineHoverCardProps {
  projection: WorkspaceProjection;
  item: ExecutionTimelineItem;
  children: ReactNode;
  onHoverChange?: (messageId: string | null) => void;
  surfaceMode?: AgentreeSurfaceMode;
  capabilities?: AgentreeSurfaceCapabilities;
}

export function resolveExecutionTimelineHoverEntity(
  projection: WorkspaceProjection,
  item: ExecutionTimelineItem,
): ProjectedNodeEntity | undefined {
  if (item.kind === 'commit' && item.commitSha) {
    const commit = projection.commitBySha.get(item.commitSha);
    if (commit) return createCommitHoverEntity(commit);
  }

  return projection.entitiesByMessageId.get(item.messageId) ??
    projection.entitiesById.get(item.entityId);
}

export function ExecutionTimelineHoverCard({
  projection,
  item,
  children,
  onHoverChange,
  surfaceMode,
  capabilities,
}: ExecutionTimelineHoverCardProps) {
  const entity = resolveExecutionTimelineHoverEntity(projection, item);

  return (
    <HoverCard
      openDelay={220}
      closeDelay={120}
      onOpenChange={(open) => {
        onHoverChange?.(open ? item.messageId : null);
      }}
    >
      <HoverCardTrigger asChild>
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        sideOffset={10}
        className="z-50 w-auto border-none bg-transparent p-0 shadow-none"
      >
        <NodeHoverCardContent
          entity={entity}
          projection={projection}
          surfaceMode={surfaceMode}
          capabilities={capabilities}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
