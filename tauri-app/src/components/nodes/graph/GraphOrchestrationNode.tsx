import { memo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { ChevronRight, Workflow } from 'lucide-react';
import { isActiveAgentStatus, isFailureAgentStatus, type AgentStatus } from '@shared/agentStatus';
import { cn } from '../../../lib/utils';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { GraphNodeHoverCardShell, GraphNodeWrapper } from './GraphNodeWrapper';
import { GraphNodeHoverCardContent } from './GraphNodeHoverCardContent';
import { useRunStatusStore } from '../../../stores/runStatusStore';
import { shouldHydrateAgentRunHover } from '../../../lib/agentRunHoverHydrationPolicy';
import {
  getOrchestrationMiniGridPosition,
  getOrchestrationMiniLayoutPositions,
} from '../../../lib/orchestrationMiniLayout';
import type { FocusTriggerMetrics } from '../../../types/nodes';

interface OrchestrationMiniChild {
  id: string;
  label: string;
  status?: AgentStatus | null;
  entity?: ProjectedNodeEntity;
}

interface OrchestrationMiniEdge {
  sourceId: string;
  targetId: string;
}

interface OrchestrationMiniAnchor {
  id: string;
}

interface GraphOrchestrationNodeProps {
  nodeId?: string;
  isFocused?: boolean;
  isSelected?: boolean;
  focusFeedbackEnabled?: boolean;
  detailLevel?: string;
  disableHoverCard?: boolean;
  heightKey?: string;
  hoverCardContent?: ReactNode;
  controlledHoverCardKey?: string | null;
  onControlledHoverCardDismiss?: () => void;
  onFocus?: (metrics?: FocusTriggerMetrics) => void;
  onSelect?: (multi: boolean) => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  data: {
    controllerMessageId: string;
    label?: string;
    totalOrchestrationRuns?: number;
    activeOrchestrationRuns?: number;
    failedOrchestrationRuns?: number;
    completedOrchestrationRuns?: number;
    cancelledOrchestrationRuns?: number;
    miniChildren?: OrchestrationMiniChild[];
    miniAnchors?: OrchestrationMiniAnchor[];
    miniEdges?: OrchestrationMiniEdge[];
    controllerEntity?: ProjectedNodeEntity;
    projection?: WorkspaceProjection;
    onToggleCollapse?: (controllerMessageId: string, collapsed: boolean) => void;
  };
}

const ORCHESTRATION_NODE_WIDTH = 200;
const ORCHESTRATION_NODE_HEIGHT = 190;

const getChildToneClassName = (status: AgentStatus | null | undefined): string => {
  if (status === 'completed') return 'border-emerald-500/60 bg-emerald-500 text-white';
  if (isFailureAgentStatus(status)) {
    return 'border-red-500/62 bg-red-500 text-white';
  }
  if (status === 'cancelled') return 'border-amber-500/62 bg-amber-500 text-white';
  if (isActiveAgentStatus(status)) {
    return 'border-sky-500/62 bg-sky-500 text-white';
  }
  return 'border-zinc-400/55 bg-zinc-300 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-50';
};

const getEdgeToneClassName = (
  sourceStatus: AgentStatus | null | undefined,
  targetStatus: AgentStatus | null | undefined,
): string => {
  if (isActiveAgentStatus(sourceStatus) || isActiveAgentStatus(targetStatus)) {
    return 'agentree-orchestration-edge-active';
  }
  if (isFailureAgentStatus(targetStatus) || isFailureAgentStatus(sourceStatus)) {
    return 'agentree-orchestration-edge-failed';
  }
  if (targetStatus === 'cancelled' || sourceStatus === 'cancelled') {
    return 'agentree-orchestration-edge-cancelled';
  }
  if (targetStatus === 'completed' || sourceStatus === 'completed') {
    return 'agentree-orchestration-edge-completed';
  }
  return 'agentree-orchestration-edge-muted';
};

function OrchestrationMiniChildDot({
  child,
  index,
  position,
  projection,
  onHoverOpenChange,
}: {
  child: OrchestrationMiniChild;
  index: number;
  position: { x: number; y: number };
  projection?: WorkspaceProjection;
  onHoverOpenChange: (childId: string, open: boolean) => void;
}) {
  const label = `${child.label}${child.status ? ` (${child.status})` : ''}`;
  const isActive = isActiveAgentStatus(child.status);
  const nodeId = child.entity?.focusMessageId ?? child.entity?.messageId ?? null;
  const runStatus = useRunStatusStore(state => nodeId ? state.byNodeId[nodeId]?.status ?? null : null);
  const hoverHydrationEnabled = shouldHydrateAgentRunHover(child.entity, runStatus);
  const dot = (
    <div
      className={cn(
        'absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[8px] font-bold shadow-sm',
        'transition-[box-shadow,filter,transform] duration-150 hover:scale-[1.08]',
        isActive ? 'shadow-[0_6px_14px_-8px_rgba(2,132,199,0.72)]' : '',
        getChildToneClassName(child.status),
      )}
      style={{ left: `${position.x}%`, top: `${position.y}%` }}
      title={child.entity && projection ? undefined : label}
      aria-label={label}
      onPointerEnter={(event) => {
        event.stopPropagation();
        onHoverOpenChange(child.id, true);
      }}
      onPointerLeave={(event) => {
        event.stopPropagation();
        onHoverOpenChange(child.id, false);
      }}
      onMouseEnter={(event) => {
        event.stopPropagation();
        onHoverOpenChange(child.id, true);
      }}
      onMouseLeave={(event) => {
        event.stopPropagation();
        onHoverOpenChange(child.id, false);
      }}
    >
      {isActive ? (
        <span
          className="agentree-orchestration-dot-pulse absolute -inset-1 rounded-full border border-sky-400/48"
          aria-hidden="true"
        />
      ) : null}
      <span className="relative font-mono tabular-nums">{index + 1}</span>
    </div>
  );

  if (!child.entity || !projection) {
    return <div key={child.id}>{dot}</div>;
  }

  return (
    <GraphNodeHoverCardShell
      key={child.id}
      nodeId={nodeId ?? undefined}
      hoverOpenDelay={180}
      hoverHydrationEnabled={hoverHydrationEnabled}
      onHoverOpenChange={(open) => onHoverOpenChange(child.id, open)}
      hoverCardContent={(
        <GraphNodeHoverCardContent
          entity={child.entity}
          fallbackProjection={projection}
          showOrchestrationSummary={false}
        />
      )}
    >
      {dot}
    </GraphNodeHoverCardShell>
  );
}

export const GraphOrchestrationNode = memo(({
  data,
  nodeId,
  isFocused = false,
  isSelected = false,
  focusFeedbackEnabled = true,
  disableHoverCard = false,
  heightKey,
  hoverCardContent,
  controlledHoverCardKey,
  onControlledHoverCardDismiss,
  onFocus = () => {},
  onSelect = () => {},
  onContextMenu = () => {},
}: GraphOrchestrationNodeProps) => {
  const [hoveredMiniChildId, setHoveredMiniChildId] = useState<string | null>(null);
  const miniChildren = data.miniChildren ?? [];
  const controllerNodeId = data.controllerEntity?.focusMessageId ?? data.controllerEntity?.messageId ?? null;
  const controllerRunStatus = useRunStatusStore(state => controllerNodeId ? state.byNodeId[controllerNodeId]?.status ?? null : null);
  const controllerHoverHydrationEnabled = shouldHydrateAgentRunHover(data.controllerEntity, controllerRunStatus);
  const miniLayoutNodes = [...(data.miniAnchors ?? []), ...miniChildren];
  const positions = getOrchestrationMiniLayoutPositions(miniLayoutNodes, data.miniEdges ?? []);
  const miniChildById = new Map(miniChildren.map((child) => [child.id, child]));
  const renderMiniChildDot = (child: OrchestrationMiniChild, index: number) => {
    const position = positions.get(child.id) ?? getOrchestrationMiniGridPosition(index, miniChildren.length);
    return (
      <OrchestrationMiniChildDot
        key={child.id}
        child={child}
        index={index}
        position={position}
        projection={data.projection}
        onHoverOpenChange={(childId, open) => {
          setHoveredMiniChildId((current) => {
            if (open) return childId;
            return current === childId ? null : current;
          });
        }}
      />
    );
  };

  const node = (
    <div
      data-agentree-orchestration-node="true"
      className="relative h-full w-full overflow-hidden"
    >
      <div className="flex min-h-11 items-start gap-2 border-b border-[hsl(var(--app-border)/0.55)] px-2.5 py-1.5">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft)/0.7)] text-[hsl(var(--app-accent))]">
          <Workflow className="h-3.5 w-3.5" strokeWidth={2.4} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--app-accent))]">
            {data.label || 'Orchestration'}
          </div>
          <div className="mt-1 grid grid-cols-5 gap-0.5 text-center tabular-nums">
            {[
              ['Active', data.activeOrchestrationRuns ?? 0],
              ['Done', data.completedOrchestrationRuns ?? 0],
              ['Failed', data.failedOrchestrationRuns ?? 0],
              ['Cancel', data.cancelledOrchestrationRuns ?? 0],
              ['Total', data.totalOrchestrationRuns ?? 0],
            ].map(([label, count]) => (
              <div key={label} className="min-w-0 rounded bg-[hsl(var(--app-bg-muted)/0.62)] px-0.5 py-0.5">
                <div className="text-[9px] font-bold leading-none text-foreground">{count}</div>
                <div className="mt-0.5 truncate text-[6.5px] font-semibold uppercase leading-none text-muted-foreground">
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[hsl(var(--app-accent))] transition-colors hover:bg-[hsl(var(--app-accent-soft)/0.72)]"
          aria-label="Expand orchestration container"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onToggleCollapse?.(data.controllerMessageId, false);
          }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="agentree-orchestration-mini-surface absolute inset-x-3 bottom-3 top-14 overflow-hidden rounded-md border border-[hsl(var(--app-border)/0.42)]">
        <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          {data.miniEdges?.map((edge) => {
            const source = positions.get(edge.sourceId);
            const target = positions.get(edge.targetId);
            if (!source || !target) return null;
            const sourceChild = miniChildById.get(edge.sourceId);
            const targetChild = miniChildById.get(edge.targetId);
            return (
              <line
                key={`${edge.sourceId}->${edge.targetId}`}
                className={cn(
                  'agentree-orchestration-edge',
                  getEdgeToneClassName(sourceChild?.status, targetChild?.status),
                )}
                x1={`${source.x}%`}
                y1={`${source.y}%`}
                x2={`${target.x}%`}
                y2={`${target.y}%`}
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            );
          })}
        </svg>
        {miniChildren.map(renderMiniChildDot)}
      </div>
    </div>
  );

  const resolvedHoverCardContent = hoverCardContent ?? (
    data.controllerEntity && data.projection ? (
        <GraphNodeHoverCardContent
          entity={data.controllerEntity}
          fallbackProjection={data.projection}
        />
    ) : undefined
  );

  return (
    <GraphNodeWrapper
      nodeId={nodeId ?? controllerNodeId ?? data.controllerMessageId}
      isFocused={isFocused}
      isSelected={isSelected}
      focusFeedbackEnabled={focusFeedbackEnabled}
      disableHoverCard={disableHoverCard || Boolean(hoveredMiniChildId)}
      heightKey={heightKey}
      className={cn(
        'overflow-hidden border-[hsl(var(--app-accent)/0.42)] bg-[hsl(var(--app-panel-strong)/0.92)]',
        'shadow-[0_12px_28px_-22px_hsl(var(--foreground)/0.44)]',
      )}
      bodyClassName="!p-0"
      style={{
        width: ORCHESTRATION_NODE_WIDTH,
        height: ORCHESTRATION_NODE_HEIGHT,
      }}
      hoverOpenDelay={220}
      hoverHydrationEnabled={controllerHoverHydrationEnabled}
      hoverCardContent={resolvedHoverCardContent}
      controlledHoverCardKey={controlledHoverCardKey}
      onControlledHoverCardDismiss={onControlledHoverCardDismiss}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {node}
    </GraphNodeWrapper>
  );
});

GraphOrchestrationNode.displayName = 'GraphOrchestrationNode';
