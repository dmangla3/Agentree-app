import { memo, useCallback } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { GraphUserNode } from './GraphUserNode';
import { GraphAssistantNode } from './GraphAssistantNode';
import { GraphThreadOriginNode } from './GraphThreadOriginNode';
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
import { createCommitHoverEntity } from './commitHoverEntity';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';
import { shouldEnableGraphNodeHover, type GraphNodeDetailLevel } from '../../../lib/graphNodeDetailLevel';


export interface GraphNodeData {
  [key: string]: unknown;
  entity?: ProjectedNodeEntity;
  commit?: ProjectedCommitEntity;
  group?: ProjectedCommitGroup;
  projection?: WorkspaceProjection;
  isFocused?: boolean;
  focusedMessageId?: string | null;
  isSelected: boolean;
  isComposerBaseCommit?: boolean;
  detailLevel?: GraphNodeDetailLevel;
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
  const selectedWorkspaceId = useWorkspaceStore(state => state.selectedWorkspaceId);
  const setComposerBaseCommitOverride = useWorkspaceStore(state => state.setComposerBaseCommitOverride);
  const isSelected = data.isSelected || isSelectedInFlow;
  const isFocused = !!data.isFocused;
  const isComposerBaseCommit = !!data.isComposerBaseCommit;
  const detailLevel = data.detailLevel ?? 'full';
  const enableHoverCard = shouldEnableGraphNodeHover({
    detailLevel,
    isFocused,
    isSelected,
    isComposerBaseCommit,
  });

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
    const commitSha = data.entity?.kind === 'commit_message'
      ? getMessageOutputCommitSha(data.entity.message)
      : null;
    const id = commitSha
      ? `commit:${commitSha}`
      : data.entity?.focusMessageId || data.entity?.messageId || data.entity?.summary?.id;
    if (id) {
      data.onContextMenu(id, e);
    }
  }, [data]);
  const handleCommitFocus = useCallback((commitSha: string, metrics?: FocusTriggerMetrics) => {
    data.onFocus(commitSha, {
      pointerDownAt: metrics?.pointerDownAt ?? null,
      clickAt: metrics?.clickAt ?? performance.now(),
      metadata: {
        ...(metrics?.metadata ?? {}),
        commitSha,
      },
    });
  }, [data]);
  const handleCanonicalCommitFocus = useCallback((metrics?: FocusTriggerMetrics) => {
    if (!data.commit?.sha) return;
    handleCommitFocus(data.commit.sha, metrics);
  }, [data.commit?.sha, handleCommitFocus]);
  const handleCanonicalCommitContextMenu = useCallback((e: React.MouseEvent) => {
    if (!data.commit?.sha) return;
    data.onContextMenu(`commit:${data.commit.sha}`, e);
  }, [data]);
  const handleCommitSelectBase = useCallback((commit: ProjectedCommitEntity) => {
    const workspaceId = commit.commit.workspace_id || selectedWorkspaceId;
    if (!workspaceId) return;
    setComposerBaseCommitOverride({
      workspaceId,
      commitSha: commit.sha,
      label: commit.subject || commit.shortSha || commit.sha,
      source: 'graph-header',
    });
  }, [selectedWorkspaceId, setComposerBaseCommitOverride]);

  const sharedProps = {
    nodeId: props.id,
    isFocused,
    isSelected,
    isComposerBaseCommit,
    detailLevel,
    layout: 'graph' as const,
    heightKey: data.heightKey,
    onMeasureHeight: data.onMeasureHeight,
    hoverCardContent: enableHoverCard ? (
      <GraphNodeHoverCardContent
        entity={data.entity}
        fallbackProjection={data.projection}
      />
    ) : undefined,
    disableHoverCard: !enableHoverCard || isSelectionGestureActive || isViewportInteracting,
    onFocus: handleFocus,
    onSelect: handleSelect,
    onContextMenu: handleContextMenu,
  };

  if (data.group) {
    return (
      <GraphDerivedCommitGroupNode
        group={data.group}
        projection={data.projection}
        isFocused={isFocused}
        isSelected={isSelected}
        isComposerBaseCommit={isComposerBaseCommit}
        detailLevel={detailLevel}
        onCommitSelectBase={handleCommitSelectBase}
      />
    );
  }

  if (data.commit) {
    const hoverEntity = createCommitHoverEntity(data.commit);
    return (
      <GraphCanonicalCommitNode
        commit={data.commit}
        isFocused={isFocused}
        isSelected={isSelected}
        isComposerBaseCommit={isComposerBaseCommit}
        detailLevel={detailLevel}
        disableHoverCard={!enableHoverCard || isSelectionGestureActive || isViewportInteracting}
        onFocus={handleCanonicalCommitFocus}
        onContextMenu={handleCanonicalCommitContextMenu}
        hoverCardContent={enableHoverCard ? (
          <GraphNodeHoverCardContent
            entity={hoverEntity}
            fallbackProjection={data.projection}
          />
        ) : undefined}
      />
    );
  }

  if (!data.entity) return null;

  switch (data.entity.kind) {
    case 'thread_origin':
      return <GraphThreadOriginNode {...sharedProps} entity={data.entity} />;
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
