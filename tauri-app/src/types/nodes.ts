import type { ReactNode } from 'react';
import type { ProjectedNodeEntity } from '../domain/workspaceProjection';
import type { GraphNodeDetailLevel } from '../lib/graphNodeDetailLevel';

export type ViewLayout = 'chat' | 'graph' | 'list' | 'hovercard';

export interface FocusTriggerMetrics {
  pointerDownAt: number | null;
  clickAt: number;
  metadata?: Record<string, unknown>;
}

export interface AttentionBadgeItem {
  id: string;
  kind: string;
  label: string;
  status?: string | null;
  priority?: number | null;
  source: 'insight' | 'candidate';
}

export interface SharedNodeProps {
  nodeId?: string;
  entity: ProjectedNodeEntity;
  isFocused: boolean;
  isSelected: boolean;
  isComposerBaseCommit?: boolean;
  focusFeedbackEnabled?: boolean;
  detailLevel?: GraphNodeDetailLevel;
  disableHoverCard?: boolean;
  attentionBadgeCount?: number;
  attentionBadgeItems?: AttentionBadgeItem[];
  showSelectionControl?: boolean;
  layout: ViewLayout;
  graphNodeHeight?: number;
  heightKey?: string;
  onMeasureHeight?: (id: string, height: number) => void;
  hoverCardContent?: ReactNode;
  onFocus: (metrics?: FocusTriggerMetrics) => void;
  onSelect: (multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}
