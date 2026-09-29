import { memo, useCallback, useEffect } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { GraphUserNode } from './GraphUserNode';
import { GraphAssistantNode } from './GraphAssistantNode';
import { GraphThreadOriginNode } from './GraphThreadOriginNode';
import { GraphThreadLinkNode } from './GraphThreadLinkNode';
import { GraphCommitNode } from './GraphCommitNode';
import { GraphCanonicalCommitNode } from './GraphCanonicalCommitNode';
import { GraphDerivedCommitGroupNode } from './GraphDerivedCommitGroupNode';
import { GraphSummaryNode } from './GraphSummaryNode';
import { GraphOrchestrationNode } from './GraphOrchestrationNode';
import type { ProjectedCommitEntity, ProjectedCommitGroup, ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { preloadNodeHoverPreview } from '../../NodeHoverCardContent';
import { useGraphInteractionContext } from '../../graph/GraphInteractionContext';
import type { AttentionBadgeItem, FocusTriggerMetrics } from '../../../types/nodes';
import { createCommitHoverEntity } from './commitHoverEntity';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';
import { shouldEnableGraphNodeHover, type GraphNodeDetailLevel } from '../../../lib/graphNodeDetailLevel';
import { dispatchGraphComposerDockExpand } from '../../../lib/graphComposerDockEvents';
import { useAgentreeSurface } from '../../graph/surfaceCapabilities';
import { GraphNodeHoverCardContent } from './GraphNodeHoverCardContent';


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
  attentionBadgeCount?: number;
  attentionBadgeItems?: AttentionBadgeItem[];
  controlledHoverCardKey?: string | null;
  onControlledHoverCardDismiss?: () => void;
  detailLevel?: GraphNodeDetailLevel;
  graphNodeHeight?: number;
  heightKey?: string;
  onMeasureHeight?: (id: string, height: number) => void;
  onFocus: (id: string, metrics?: FocusTriggerMetrics) => void;
  onOpenThread?: (threadRootId: string) => void;
  onSelect: (id: string, multi: boolean) => void;
  onContextMenu: (id: string, e: React.MouseEvent) => void;
}

type GraphNode = Node<GraphNodeData>;
let hasScheduledAppHoverPreviewPreload = false;

export const GraphNodeDispatcher = memo((props: NodeProps<GraphNode>) => {
  const { data, selected: isSelectedInFlow } = props;
  const { isSelectionGestureActive, isViewportInteracting } = useGraphInteractionContext();
  const { surfaceMode, capabilities } = useAgentreeSurface();
  const selectedWorkspaceId = useWorkspaceStore(state => state.selectedWorkspaceId);
  const setComposerBaseCommitOverride = useWorkspaceStore(state => state.setComposerBaseCommitOverride);
  const setThreadComposerTarget = useWorkspaceStore(state => state.setThreadComposerTarget);
  const isSelected = capabilities.canSelect && (data.isSelected || isSelectedInFlow);
  const isFocused = !!data.isFocused;
  const isComposerBaseCommit = !!data.isComposerBaseCommit;
  const detailLevel = data.detailLevel ?? 'full';
  const controlledHoverCardKey = typeof data.controlledHoverCardKey === 'string' ? data.controlledHoverCardKey : null;
  const isControlledHoverCardOpen = Boolean(controlledHoverCardKey);
  const isRedirectedUserNode = data.entity?.kind === 'user_message'
    && !!data.entity.focusMessageId
    && data.entity.focusMessageId !== data.entity.messageId;
  const isThreadNode = data.entity?.kind === 'thread_origin' || data.entity?.kind === 'thread_link';
  const enableHoverCard = !isThreadNode && (isControlledHoverCardOpen || shouldEnableGraphNodeHover({
    detailLevel,
    isFocused,
    isSelected,
    isComposerBaseCommit,
  }));
  const disableHoverCard = !enableHoverCard || (!isControlledHoverCardOpen && (isSelectionGestureActive || isViewportInteracting));

  useEffect(() => {
    if (surfaceMode !== 'app') return;
    if (hasScheduledAppHoverPreviewPreload) return;
    hasScheduledAppHoverPreviewPreload = true;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleWindow.requestIdleCallback(preloadNodeHoverPreview, { timeout: 1200 });
    } else {
      window.setTimeout(preloadNodeHoverPreview, 250);
    }
  }, [surfaceMode]);

  const handleFocus = useCallback((metrics?: FocusTriggerMetrics) => {
    if (data.entity?.kind === 'thread_origin') {
      const threadRootId = data.entity.threadRootId ?? null;
      if (capabilities.canMutate && threadRootId && selectedWorkspaceId) {
        dispatchGraphComposerDockExpand();
        setThreadComposerTarget({
          workspaceId: selectedWorkspaceId,
          threadId: threadRootId,
          reason: 'thread-origin',
          nonce: Date.now(),
        });
      }
      return;
    }
    if (data.entity?.focusMessageId) {
      if (data.entity.kind === 'thread_link') {
        const threadRootId = data.entity.threadLinkRootId ?? data.entity.threadRootId ?? null;
        if (threadRootId) {
          data.onOpenThread?.(threadRootId);
        }
        return;
      }
      if (capabilities.canReply && (data.entity.kind === 'user_message' || data.entity.kind === 'assistant_message')) {
        dispatchGraphComposerDockExpand();
      }
      data.onFocus(data.entity.focusMessageId, {
        pointerDownAt: metrics?.pointerDownAt ?? null,
        clickAt: metrics?.clickAt ?? performance.now(),
        metadata: {
          ...(metrics?.metadata ?? {}),
          via: 'react-flow-node-click',
        },
      });
    }
  }, [capabilities.canMutate, capabilities.canReply, data, selectedWorkspaceId, setThreadComposerTarget]);

  const handleSelect = useCallback((multi: boolean) => {
    if (!capabilities.canSelect) return;
    const id = data.entity?.focusMessageId || data.entity?.messageId || data.entity?.summary?.id;
    if (id) {
      data.onSelect(id, multi);
    }
  }, [capabilities.canSelect, data]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!capabilities.canOpenContextMenu) return;
    const commitSha = data.entity?.kind === 'commit_message'
      ? getMessageOutputCommitSha(data.entity.message)
      : null;
    const id = commitSha
      ? `commit:${commitSha}`
      : data.entity?.messageId || data.entity?.focusMessageId || data.entity?.summary?.id;
    if (id) {
      data.onContextMenu(id, e);
    }
  }, [capabilities.canOpenContextMenu, data]);
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
    if (!capabilities.canOpenContextMenu) return;
    if (!data.commit?.sha) return;
    data.onContextMenu(`commit:${data.commit.sha}`, e);
  }, [capabilities.canOpenContextMenu, data]);
  const handleCommitSelectBase = useCallback((commit: ProjectedCommitEntity) => {
    if (!capabilities.canMutate) return;
    const workspaceId = commit.commit.workspace_id || selectedWorkspaceId;
    if (!workspaceId) return;
    setComposerBaseCommitOverride({
      workspaceId,
      commitSha: commit.sha,
      label: commit.subject || commit.shortSha || commit.sha,
      source: 'graph-header',
    });
  }, [capabilities.canMutate, selectedWorkspaceId, setComposerBaseCommitOverride]);

  const sharedProps = {
    nodeId: props.id,
    isFocused,
    isSelected,
    isComposerBaseCommit,
    attentionBadgeCount: typeof data.attentionBadgeCount === 'number' ? data.attentionBadgeCount : undefined,
    attentionBadgeItems: Array.isArray(data.attentionBadgeItems) ? data.attentionBadgeItems : undefined,
    focusFeedbackEnabled: !isRedirectedUserNode,
    detailLevel,
    layout: 'graph' as const,
    graphNodeHeight: typeof data.graphNodeHeight === 'number' ? data.graphNodeHeight : undefined,
    heightKey: data.heightKey,
    onMeasureHeight: data.onMeasureHeight,
    hoverCardContent: enableHoverCard ? (
      <GraphNodeHoverCardContent
        entity={data.entity}
        fallbackProjection={data.projection}
        surfaceMode={surfaceMode}
        capabilities={capabilities}
      />
    ) : undefined,
    controlledHoverCardKey,
    onControlledHoverCardDismiss: data.onControlledHoverCardDismiss,
    disableHoverCard,
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
        onCommitSelectBase={capabilities.canMutate ? handleCommitSelectBase : undefined}
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
        disableHoverCard={disableHoverCard}
        onFocus={handleCanonicalCommitFocus}
        onContextMenu={handleCanonicalCommitContextMenu}
        hoverCardContent={enableHoverCard ? (
          <GraphNodeHoverCardContent
            entity={hoverEntity}
            fallbackProjection={data.projection}
            surfaceMode={surfaceMode}
            capabilities={capabilities}
          />
        ) : undefined}
        controlledHoverCardKey={controlledHoverCardKey}
        onControlledHoverCardDismiss={data.onControlledHoverCardDismiss}
      />
    );
  }

  if (!data.entity) return null;

  if (props.type === 'orchestration_node') {
    return (
      <GraphOrchestrationNode
        data={data as any}
        nodeId={data.entity.focusMessageId ?? data.entity.messageId ?? props.id}
        isFocused={isFocused}
        isSelected={isSelected}
        focusFeedbackEnabled
        detailLevel={detailLevel}
        heightKey={data.heightKey}
        disableHoverCard={disableHoverCard}
        hoverCardContent={enableHoverCard ? (
          <GraphNodeHoverCardContent
            entity={data.entity}
            fallbackProjection={data.projection}
            surfaceMode={surfaceMode}
            capabilities={capabilities}
          />
        ) : undefined}
        controlledHoverCardKey={controlledHoverCardKey}
        onControlledHoverCardDismiss={data.onControlledHoverCardDismiss}
        onFocus={handleFocus}
        onSelect={handleSelect}
        onContextMenu={handleContextMenu}
      />
    );
  }

  switch (data.entity.kind) {
    case 'thread_origin':
      return <GraphThreadOriginNode {...sharedProps} entity={data.entity} />;
    case 'thread_link':
      return <GraphThreadLinkNode {...sharedProps} entity={data.entity} />;
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
