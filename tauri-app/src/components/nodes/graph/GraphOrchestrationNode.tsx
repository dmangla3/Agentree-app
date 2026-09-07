import { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { ChevronRight, Workflow } from 'lucide-react';
import type { AgentStatus } from '@shared/agentStatus';
import { cn } from '../../../lib/utils';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';
import { NodeHoverCardContent } from '../../NodeHoverCardContent';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { useAgentRunHoverHydration } from '../../../hooks/useAgentRunHoverHydration';

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

interface GraphOrchestrationNodeProps {
  data: {
    controllerMessageId: string;
    label?: string;
    totalChildRuns?: number;
    activeChildRuns?: number;
    failedChildRuns?: number;
    completedChildRuns?: number;
    cancelledChildRuns?: number;
    miniChildren?: OrchestrationMiniChild[];
    miniEdges?: OrchestrationMiniEdge[];
    controllerEntity?: ProjectedNodeEntity;
    projection?: WorkspaceProjection;
    onToggleCollapse?: (controllerMessageId: string, collapsed: boolean) => void;
  };
}

const getChildToneClassName = (status: AgentStatus | null | undefined): string => {
  if (status === 'completed') return 'border-emerald-500/60 bg-emerald-500 text-white';
  if (status === 'failed' || status === 'failed_runtime' || status === 'failed_setup' || status === 'failed_spawn' || status === 'failed_finalization') {
    return 'border-red-500/62 bg-red-500 text-white';
  }
  if (status === 'cancelled') return 'border-amber-500/62 bg-amber-500 text-white';
  if (status === 'running' || status === 'streaming' || status === 'pending' || status === 'initializing') {
    return 'border-sky-500/62 bg-sky-500 text-white';
  }
  return 'border-zinc-400/55 bg-zinc-300 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-50';
};

const getDotPosition = (index: number, count: number): { x: number; y: number } => {
  if (count <= 1) return { x: 50, y: 50 };
  const columns = Math.min(4, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const col = index % columns;
  const row = Math.floor(index / columns);
  const x = columns === 1 ? 50 : 18 + (col * 64) / Math.max(1, columns - 1);
  const y = rows === 1 ? 50 : 24 + (row * 52) / Math.max(1, rows - 1);
  return { x, y };
};

export const GraphOrchestrationNode = memo(({ data }: GraphOrchestrationNodeProps) => {
  const [controllerHoverOpen, setControllerHoverOpen] = useState(false);
  const miniChildren = data.miniChildren ?? [];
  const controllerNodeId = data.controllerEntity?.focusMessageId ?? data.controllerEntity?.messageId ?? null;
  useAgentRunHoverHydration(controllerNodeId, controllerHoverOpen && Boolean(data.controllerEntity && data.projection));
  const positions = new Map(miniChildren.map((child, index) => [child.id, getDotPosition(index, miniChildren.length)]));
  const renderMiniChildDot = (child: OrchestrationMiniChild, index: number) => {
    const position = positions.get(child.id) ?? getDotPosition(index, miniChildren.length);
    const label = `${child.label}${child.status ? ` (${child.status})` : ''}`;
    const dot = (
      <div
        className={cn(
          'absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[8px] font-bold shadow-sm',
          getChildToneClassName(child.status),
        )}
        style={{ left: `${position.x}%`, top: `${position.y}%` }}
        title={child.entity && data.projection ? undefined : label}
        aria-label={label}
      >
        {index + 1}
      </div>
    );

    if (!child.entity || !data.projection) {
      return <div key={child.id}>{dot}</div>;
    }

    return (
      <HoverCard key={child.id} openDelay={180} closeDelay={120}>
        <HoverCardTrigger asChild>
          {dot}
        </HoverCardTrigger>
        <HoverCardContent
          side="right"
          align="center"
          sideOffset={8}
          className="z-50 w-auto border-none bg-transparent p-0 shadow-none"
        >
          <NodeHoverCardContent
            entity={child.entity}
            projection={data.projection}
            showOrchestrationSummary={false}
          />
        </HoverCardContent>
      </HoverCard>
    );
  };

  const node = (
    <div
      data-agentree-orchestration-node="true"
      className={cn(
        'relative h-full w-full overflow-hidden rounded-lg border border-[hsl(var(--app-accent)/0.42)]',
        'bg-[hsl(var(--app-panel-strong)/0.92)] shadow-[0_12px_28px_-22px_hsl(var(--foreground)/0.44)]',
      )}
    >
      <div className="flex min-h-11 items-start gap-2 border-b border-[hsl(var(--app-border)/0.55)] px-2.5 py-1.5">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft)/0.7)] text-[hsl(var(--app-accent))]">
          <Workflow className="h-3.5 w-3.5" strokeWidth={2.4} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--app-accent))]">
            {data.label || 'Orchestration'}
          </div>
          <div className="mt-1 grid grid-cols-4 gap-0.5 text-center tabular-nums">
            {[
              ['Active', data.activeChildRuns ?? 0],
              ['Done', data.completedChildRuns ?? 0],
              ['Failed', data.failedChildRuns ?? 0],
              ['Cancel', data.cancelledChildRuns ?? 0],
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

      <div className="absolute inset-x-3 bottom-3 top-14 rounded-md border border-[hsl(var(--app-border)/0.45)] bg-[hsl(var(--app-bg-muted)/0.42)]">
        <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          {data.miniEdges?.map((edge) => {
            const source = positions.get(edge.sourceId);
            const target = positions.get(edge.targetId);
            if (!source || !target) return null;
            return (
              <line
                key={`${edge.sourceId}->${edge.targetId}`}
                x1={`${source.x}%`}
                y1={`${source.y}%`}
                x2={`${target.x}%`}
                y2={`${target.y}%`}
                stroke="hsl(var(--app-accent) / 0.34)"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            );
          })}
        </svg>
        {miniChildren.map(renderMiniChildDot)}
      </div>
      <Handle
        id="top-target"
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-slate-400 !border-2 !border-background"
      />
      <Handle
        id="left-target"
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-0 !bg-transparent"
      />
      <Handle
        id="right-target"
        type="target"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-0 !bg-transparent"
      />
      <Handle
        id="bottom-source"
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-slate-400 !border-2 !border-background"
      />
    </div>
  );

  if (!data.controllerEntity || !data.projection) {
    return node;
  }

  return (
    <HoverCard open={controllerHoverOpen} onOpenChange={setControllerHoverOpen} openDelay={220} closeDelay={120}>
      <HoverCardTrigger asChild>
        {node}
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="center"
        sideOffset={8}
        className="z-50 w-auto border-none bg-transparent p-0 shadow-none"
      >
        <NodeHoverCardContent
          entity={data.controllerEntity}
          projection={data.projection}
        />
      </HoverCardContent>
    </HoverCard>
  );
});

GraphOrchestrationNode.displayName = 'GraphOrchestrationNode';
