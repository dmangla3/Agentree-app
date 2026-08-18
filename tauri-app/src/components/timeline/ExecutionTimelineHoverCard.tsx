import type { ReactNode } from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../@/components/ui/hover-card';
import type { ExecutionTimelineItem } from '../../lib/executionTimelineModel';
import type { WorkspaceProjection } from '../../domain/workspaceProjection';
import { NodeHoverCardContent } from '../NodeHoverCardContent';

interface ExecutionTimelineHoverCardProps {
  projection: WorkspaceProjection;
  item: ExecutionTimelineItem;
  children: ReactNode;
  onHoverChange?: (messageId: string | null) => void;
}

export function ExecutionTimelineHoverCard({
  projection,
  item,
  children,
  onHoverChange,
}: ExecutionTimelineHoverCardProps) {
  const entity = projection.entitiesByMessageId.get(item.messageId) ??
    projection.entitiesById.get(item.entityId);

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
        <NodeHoverCardContent entity={entity} projection={projection} />
      </HoverCardContent>
    </HoverCard>
  );
}
