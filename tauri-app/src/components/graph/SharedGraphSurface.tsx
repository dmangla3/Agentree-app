import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Bot, ChevronUp } from 'lucide-react';
import type { WorkspaceProjection } from '../../domain/workspaceProjection';
import { useGraphLayout, type LaneStrategy, type LayoutMode } from '../../hooks/graph/useGraphLayout';
import { graphNodeTypes } from './graphNodeTypes';
import {
  AgentreeSurfaceProvider,
  appSurfaceCapabilities,
  type AgentreeSurfaceCapabilities,
  type AgentreeSurfaceMode,
} from './surfaceCapabilities';
import { buildExecutionTimelineItems, packExecutionTimelineItems } from '../../lib/executionTimelineModel';
import { ExecutionTimelineDock } from '../timeline/ExecutionTimelineDock';
import { GraphInteractionContext } from './GraphInteractionContext';
import { GraphHoverProjectionContext } from './GraphHoverProjectionContext';
import { MiniMapPanel } from './MiniMapPanel';
import SummaryEdge from '../SummaryEdge';
import { HorizontalThenVerticalEdge } from '../HorizontalThenVerticalEdge';
import { ContextSmoothStepEdge } from '../ContextSmoothStepEdge';
import { cn } from '../../lib/utils';
import { getGraphEdgeEndpointDotVariant, isInterTurnEndpointEdge, type EdgeEndpointDotVariant } from '../graphEdgeEndpointDots';
import type { GraphEdgeLegendId } from './GraphCanvasIndexPanel';

export type SharedGraphSurfaceProps = {
  projection: WorkspaceProjection;
  focusedMessageId: string | null;
  layoutMode?: LayoutMode;
  laneStrategy?: LaneStrategy;
  surfaceMode?: AgentreeSurfaceMode;
  capabilities?: AgentreeSurfaceCapabilities;
  className?: string;
  showTimeline?: boolean;
  onFocusMessage?: (messageId: string) => void;
};

const EMPTY_SET = new Set<string>();
const VISIBLE_NODE_SECTIONS = new Set<'conversation' | 'commits'>(['conversation', 'commits']);
const graphEdgeTypes = {
  summaryEdge: SummaryEdge,
  horizontalThenVertical: HorizontalThenVerticalEdge,
  smoothstep: ContextSmoothStepEdge,
  compactLineage: HorizontalThenVerticalEdge,
};

const getAssistantOutputCommitNodeId = (assistantId: string): string => `commit:${assistantId}`;

const getRenderedNodeWidth = (node: Node<any>): number => {
  const styleWidth = node.style?.width;
  if (typeof styleWidth === 'number') return styleWidth;
  if (typeof (node as any).width === 'number') return (node as any).width;
  return node.type === 'commit_message' || node.type === 'canonical_commit' || node.type === 'layout_derived_commit_group'
    ? 120
    : 200;
};

const getRenderedNodeHeight = (node: Node<any>): number => {
  const styleHeight = node.style?.height;
  if (typeof styleHeight === 'number') return styleHeight;
  if (typeof (node as any).height === 'number') return (node as any).height;
  if (node.type === 'user_message') return 82;
  if (node.type === 'assistant_message') return 112;
  if (node.type === 'commit_message' || node.type === 'canonical_commit' || node.type === 'layout_derived_commit_group') return 112;
  return 100;
};

const addMissingTurnGroupHulls = (
  nodes: Node<any>[],
  projection: WorkspaceProjection,
): Node<any>[] => {
  if (nodes.some((node) => node.type === 'turn_group_hull')) return nodes;
  if (!projection.turnGroups.length) return nodes;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const hullNodes: Node<any>[] = [];
  const padding = 10;

  for (const turnGroup of projection.turnGroups) {
    const memberNodeIds = new Set<string>();
    for (const entityId of turnGroup.memberEntityIds) {
      const entity = projection.entitiesById.get(entityId);
      const messageId = entity?.messageId;
      if (messageId) {
        if (nodeById.has(messageId)) memberNodeIds.add(messageId);
        const commitNodeId = getAssistantOutputCommitNodeId(messageId);
        if (nodeById.has(commitNodeId)) memberNodeIds.add(commitNodeId);
      }
      if (entity?.summary?.id && nodeById.has(entity.summary.id)) {
        memberNodeIds.add(entity.summary.id);
      }
    }

    if (memberNodeIds.size === 0) continue;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const memberNodeId of memberNodeIds) {
      const memberNode = nodeById.get(memberNodeId);
      if (!memberNode) continue;
      minX = Math.min(minX, memberNode.position.x);
      minY = Math.min(minY, memberNode.position.y);
      maxX = Math.max(maxX, memberNode.position.x + getRenderedNodeWidth(memberNode));
      maxY = Math.max(maxY, memberNode.position.y + getRenderedNodeHeight(memberNode));
    }

    if (minX === Infinity || minY === Infinity) continue;

    const threadRootId = projection.threadRootIdByMessageId.get(turnGroup.userMessageId) ?? null;
    hullNodes.push({
      id: `hull:${turnGroup.turnGroupId}`,
      type: 'turn_group_hull',
      position: {
        x: minX - padding,
        y: minY - padding,
      },
      data: {
        label: turnGroup.userMessageId === projection.originMessageId ? 'Origin' : undefined,
        slotKind: 'turn',
        threadRootId,
        isThreadRoot: threadRootId === turnGroup.userMessageId,
      },
      selectable: false,
      draggable: false,
      focusable: false,
      style: {
        width: (maxX - minX) + padding * 2,
        height: (maxY - minY) + padding * 2,
        zIndex: -1,
      },
    });
  }

  return hullNodes.length > 0 ? [...hullNodes, ...nodes] : nodes;
};

function SharedGraphSurfaceInner({
  projection,
  focusedMessageId,
  layoutMode = 'tidy',
  laneStrategy = 'balanced',
  surfaceMode = 'app',
  capabilities = appSurfaceCapabilities,
  className,
  showTimeline = false,
  onFocusMessage,
}: SharedGraphSurfaceProps) {
  const [activeFocusedMessageId, setActiveFocusedMessageId] = useState(focusedMessageId);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const effectiveFocusedMessageId = activeFocusedMessageId ?? focusedMessageId;
  const measuredNodeHeights = useMemo(() => new Map<string, number>(), []);
  const selectedNodeIds = useMemo(() => new Set<string>(), []);
  const handleFocus = useCallback((messageId: string) => {
    setActiveFocusedMessageId(messageId);
    onFocusMessage?.(messageId);
  }, [onFocusMessage]);
  const layout = useGraphLayout({
    projection,
    messages: projection.messages,
    summaries: projection.summaries,
    measuredNodeHeights,
    layoutMode,
    laneStrategy,
    disabledSummaryIds: EMPTY_SET,
    focusedMessageId: effectiveFocusedMessageId,
    contextPathMessageIds: projection.branchPathMessageIds,
    matchingMessageIds: EMPTY_SET,
    filterActive: false,
    hasNodeTypeFilter: false,
    keepAncestors: true,
    keepDescendants: true,
    visibleNodeSections: VISIBLE_NODE_SECTIONS,
    insights: [],
    showInsightsInGraph: false,
    workspaceRepoMap: new Map(),
    branchPointersByNodeId: new Map(),
    onToggleSummary: () => {},
    onToggleCollapse: () => {},
    onFocus: handleFocus,
    onSelect: () => {},
    onContextMenu: () => {},
  });
  const nodes = useMemo(() => addMissingTurnGroupHulls(
    layout.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        projection,
      },
    })),
    projection,
  ), [layout.nodes, projection]);
  const edges = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return layout.edges.map((edge) => {
      const endpointDotVariant: EdgeEndpointDotVariant | null = getGraphEdgeEndpointDotVariant({
        edgeLegendType: (edge.data as any)?.edgeLegendType as GraphEdgeLegendId | undefined,
        matchedContextPathPreview: false,
        isInterTurnEdge: isInterTurnEndpointEdge(nodeById.get(edge.source), nodeById.get(edge.target)),
      });
      if (!endpointDotVariant) return edge;
      return {
        ...edge,
        data: {
          ...(edge.data ?? {}),
          endpointDotVariant,
        },
      };
    });
  }, [layout.edges, nodes]);
  const timelineModel = useMemo(
    () => packExecutionTimelineItems(buildExecutionTimelineItems(projection)),
    [projection],
  );
  const handleInit = useCallback((instance: ReactFlowInstance) => {
    const targetNode = nodes.find((node) => {
      const data = node.data as Record<string, any>;
      return data?.entity?.focusMessageId === effectiveFocusedMessageId ||
        data?.entity?.messageId === effectiveFocusedMessageId ||
        node.id === effectiveFocusedMessageId;
    }) ?? nodes[0];
    if (!targetNode) return;

    window.requestAnimationFrame(() => {
      instance.setCenter(
        targetNode.position.x + ((targetNode.width as number | undefined) ?? 220) / 2,
        targetNode.position.y + ((targetNode.height as number | undefined) ?? 104) / 2,
        { zoom: 0.95, duration: 0 },
      );
    });
  }, [effectiveFocusedMessageId, nodes]);

  return (
    <AgentreeSurfaceProvider surfaceMode={surfaceMode} capabilities={capabilities}>
      <GraphInteractionContext.Provider
        value={{
          selectedNodeIds,
          isSelectionGestureActive: false,
          isViewportInteracting: false,
        }}
      >
        <GraphHoverProjectionContext.Provider
          value={{
            messages: projection.messages,
            summaries: projection.summaries,
            disabledSummaryIds: EMPTY_SET,
          }}
        >
          <div className={className}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={graphNodeTypes}
              edgeTypes={graphEdgeTypes}
              onInit={handleInit}
              minZoom={0.18}
              maxZoom={1.55}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={capabilities.canSelect}
            >
              <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} color="hsl(var(--app-border-strong) / 0.42)" />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
            <MiniMapPanel
              graphNodes={nodes}
              graphEdges={edges}
              threadRootIdByMessageId={projection.threadRootIdByMessageId}
            />
            {showTimeline ? (
              <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-center">
                {timelineExpanded ? (
                  <div className="pointer-events-auto w-full">
                    <ExecutionTimelineDock
                      projection={projection}
                      model={timelineModel}
                      focusedMessageId={effectiveFocusedMessageId}
                      selectedNodeIds={selectedNodeIds}
                      onFocusMessage={handleFocus}
                      onSelectMessage={() => {}}
                      onContextMenuMessage={() => {}}
                      onClose={() => setTimelineExpanded(false)}
                      surfaceMode={surfaceMode}
                      capabilities={capabilities}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setTimelineExpanded(true)}
                    className={cn(
                      'pointer-events-auto',
                      'flex h-11 min-w-0 items-center gap-2 rounded-lg border border-[hsl(var(--app-border)/0.76)]',
                      'bg-[hsl(var(--app-panel)/0.94)] px-3 text-xs font-semibold text-foreground shadow-[var(--app-shadow-floating)] backdrop-blur-xl',
                      'transition-[background-color,border-color,box-shadow,transform] hover:border-[hsl(var(--app-border-strong)/0.82)] hover:bg-[hsl(var(--app-panel-strong)/0.96)] active:scale-[0.98]',
                    )}
                    aria-label="Open execution timeline"
                    title="Open execution timeline"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.64)] bg-[hsl(var(--app-bg-muted)/0.65)] text-[hsl(var(--app-accent))]">
                      <Bot className="h-3.5 w-3.5" strokeWidth={2} />
                    </span>
                    <span className="min-w-0 truncate">
                      Execution timeline
                    </span>
                    <span className="hidden text-muted-foreground sm:inline">
                      {timelineModel.bars.length} {timelineModel.bars.length === 1 ? 'run' : 'runs'}
                    </span>
                    <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </GraphHoverProjectionContext.Provider>
      </GraphInteractionContext.Provider>
    </AgentreeSurfaceProvider>
  );
}

export function SharedGraphSurface(props: SharedGraphSurfaceProps) {
  return (
    <ReactFlowProvider>
      <SharedGraphSurfaceInner {...props} />
    </ReactFlowProvider>
  );
}
