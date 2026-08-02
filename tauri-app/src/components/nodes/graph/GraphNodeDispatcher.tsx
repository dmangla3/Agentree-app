import { memo, useCallback } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { GraphUserNode } from './GraphUserNode';
import { GraphAssistantNode } from './GraphAssistantNode';
import { GraphCommitNode } from './GraphCommitNode';
import { GraphCanonicalCommitNode } from './GraphCanonicalCommitNode';
import { GraphDerivedCommitGroupNode } from './GraphDerivedCommitGroupNode';
import { GraphSummaryNode } from './GraphSummaryNode';
import type { ProjectedCommitEntity, ProjectedCommitGroup, ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { NodeHoverCardContent } from '../../NodeHoverCardContent';
import { useGraphInteractionContext } from '../../graph/GraphInteractionContext';
import { useGraphHoverProjectionInput } from '../../graph/GraphHoverProjectionContext';
import { useWorkspaceProjection } from '../../../hooks/useWorkspaceProjection';
import type { FocusTriggerMetrics } from '../../../types/nodes';


export interface GraphNodeData {
  [key: string]: unknown;
  entity?: ProjectedNodeEntity;
  commit?: ProjectedCommitEntity;
  group?: ProjectedCommitGroup;
  projection?: WorkspaceProjection;
  isFocused?: boolean;
  focusedMessageId?: string | null;
  isSelected: boolean;
  heightKey?: string;
  onMeasureHeight?: (id: string, height: number) => void;
  onFocus: (id: string, metrics?: FocusTriggerMetrics) => void;
  onSelect: (id: string, multi: boolean) => void;
  onContextMenu: (id: string, e: React.MouseEvent) => void;
}

type GraphNode = Node<GraphNodeData>;

function GraphNodeHoverCardContent({
  entity,
  fallbackProjection,
}: {
  entity?: ProjectedNodeEntity;
  fallbackProjection?: WorkspaceProjection;
}) {
  const hoverInput = useGraphHoverProjectionInput();
  const hoverProjection = useWorkspaceProjection(
    hoverInput.messages.length > 0 ? hoverInput.messages : fallbackProjection?.messages ?? [],
    hoverInput.scopes.length > 0 ? hoverInput.scopes : fallbackProjection?.scopes ?? [],
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
    />
  );
}

export const GraphNodeDispatcher = memo((props: NodeProps<GraphNode>) => {
  const { data, selected: isSelectedInFlow } = props;
  const { isSelectionGestureActive, isViewportInteracting } = useGraphInteractionContext();

  const handleFocus = useCallback((metrics?: FocusTriggerMetrics) => {
    if (data.entity?.focusMessageId) {
      data.onFocus(data.entity.focusMessageId, metrics);
    }
  }, [data]);

  const handleSelect = useCallback((multi: boolean) => {
    const id = data.entity?.focusMessageId || data.entity?.messageId || data.entity?.summary?.id;
    if (id) {
      data.onSelect(id, multi);
    }
  }, [data]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const id = data.entity?.focusMessageId || data.entity?.messageId || data.entity?.summary?.id;
    if (id) {
      data.onContextMenu(id, e);
    }
  }, [data]);

  // Use scopeColor from node data (set by graphUtils using DB scope color)
  const scopeColor = data.entity?.scopeId ? (data as any).scopeColor || null : null;
  
  const sharedProps = {
    nodeId: props.id,
    isFocused: !!data.isFocused,
    isSelected: data.isSelected || isSelectedInFlow,
    scopeColor,
    layout: 'graph' as const,
    heightKey: data.heightKey,
    onMeasureHeight: data.onMeasureHeight,
    hoverCardContent: (
      <GraphNodeHoverCardContent
        entity={data.entity}
        fallbackProjection={data.projection}
      />
    ),
    disableHoverCard: isSelectionGestureActive || isViewportInteracting,
    onFocus: handleFocus,
    onSelect: handleSelect,
    onContextMenu: handleContextMenu,
  };

  if (data.group) {
    return (
      <GraphDerivedCommitGroupNode
        group={data.group}
        projection={data.projection}
        isFocused={!!data.isFocused}
        isSelected={data.isSelected || isSelectedInFlow}
      />
    );
  }

  if (data.commit) {
    return (
      <GraphCanonicalCommitNode
        commit={data.commit}
        isFocused={!!data.isFocused}
        isSelected={data.isSelected || isSelectedInFlow}
      />
    );
  }

  if (!data.entity) return null;

  switch (data.entity.kind) {
    case 'user_message':
      return <GraphUserNode {...sharedProps} entity={data.entity} />;
    case 'assistant_message':
      return <GraphAssistantNode {...sharedProps} entity={data.entity} />;
    case 'commit_message':
      return <GraphCommitNode {...sharedProps} entity={data.entity} />;
    case 'summary_block':
      return <GraphSummaryNode {...sharedProps} entity={data.entity} />;
    default:
      return null;
  }
});

GraphNodeDispatcher.displayName = 'GraphNodeDispatcher';
