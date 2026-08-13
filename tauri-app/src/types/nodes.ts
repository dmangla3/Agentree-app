import type { ReactNode } from 'react';
import type { ProjectedNodeEntity } from '../domain/workspaceProjection';
import type { GraphNodeDetailLevel } from '../lib/graphNodeDetailLevel';

export type ViewLayout = 'chat' | 'graph' | 'timeline' | 'hovercard';

export interface FocusTriggerMetrics {
  pointerDownAt: number | null;
  clickAt: number;
  metadata?: Record<string, unknown>;
}

export interface SharedNodeProps {
  nodeId?: string;
  entity: ProjectedNodeEntity;
  isFocused: boolean;
  isSelected: boolean;
  isComposerBaseCommit?: boolean;
  detailLevel?: GraphNodeDetailLevel;
  disableHoverCard?: boolean;
  showSelectionControl?: boolean;
  scopeColor?: string | null;
  scopeName?: string | null;
  layout: ViewLayout;
  heightKey?: string;
  onMeasureHeight?: (id: string, height: number) => void;
  hoverCardContent?: ReactNode;
  onFocus: (metrics?: FocusTriggerMetrics) => void;
  onSelect: (multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}
