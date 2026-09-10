import { memo } from 'react';
import type { CSSProperties } from 'react';
import { ChevronDown, Workflow } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { GraphNodeHoverCardShell } from './GraphNodeWrapper';
import { GraphNodeHoverCardContent } from './GraphNodeHoverCardContent';
import { useRunStatusStore } from '../../../stores/runStatusStore';
import { shouldHydrateAgentRunHover } from '../../../lib/agentRunHoverHydrationPolicy';

interface GraphOrchestrationHullProps {
  data: {
    controllerMessageId: string;
    label?: string;
    totalOrchestrationRuns?: number;
    activeOrchestrationRuns?: number;
    failedOrchestrationRuns?: number;
    completedOrchestrationRuns?: number;
    cancelledOrchestrationRuns?: number;
    controllerEntity?: ProjectedNodeEntity;
    projection?: WorkspaceProjection;
    onToggleCollapse?: (controllerMessageId: string, collapsed: boolean) => void;
  };
  style?: CSSProperties;
}

export const GraphOrchestrationHull = memo(({ data, style }: GraphOrchestrationHullProps) => {
  const controllerNodeId = data.controllerEntity?.focusMessageId ?? data.controllerEntity?.messageId ?? null;
  const controllerRunStatus = useRunStatusStore(state => controllerNodeId ? state.byNodeId[controllerNodeId]?.status ?? null : null);
  const hoverHydrationEnabled = shouldHydrateAgentRunHover(data.controllerEntity, controllerRunStatus);

  const hull = (
    <div
      data-agentree-orchestration-hull="true"
      style={style}
      className={cn(
        'relative h-full w-full rounded-[18px] border border-dashed pointer-events-auto',
        'border-[hsl(var(--app-accent)/0.38)] bg-[hsl(var(--app-accent-soft)/0.16)]',
        'shadow-[inset_0_1px_0_hsl(var(--background)/0.28),0_18px_40px_-34px_hsl(var(--foreground)/0.38)]',
        'transition-[background-color,border-color,box-shadow] duration-200',
      )}
    >
      <div className="absolute left-3 top-2 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full border border-[hsl(var(--app-accent)/0.32)] bg-[hsl(var(--app-panel)/0.94)] px-2 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--app-accent))] shadow-sm backdrop-blur-sm">
        <Workflow className="h-3 w-3" strokeWidth={2.4} />
        <span className="truncate">{data.label || 'Orchestration'}</span>
        <span className="rounded-full bg-[hsl(var(--app-accent-soft)/0.62)] px-1.5 py-0.5 font-mono text-[8px] leading-none">
          {data.totalOrchestrationRuns ?? 0}
        </span>
        <button
          type="button"
          className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[hsl(var(--app-accent))] transition-colors hover:bg-[hsl(var(--app-accent-soft)/0.72)]"
          aria-label="Collapse orchestration container"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onToggleCollapse?.(data.controllerMessageId, true);
          }}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      <div className="absolute bottom-2 right-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-end gap-x-1 gap-y-0.5 rounded-full bg-[hsl(var(--app-panel)/0.82)] px-2 py-1 text-[9px] font-semibold leading-none text-muted-foreground shadow-sm">
        <span>{data.activeOrchestrationRuns ?? 0} active</span>
        <span>·</span>
        <span>{data.completedOrchestrationRuns ?? 0} done</span>
        <span>·</span>
        <span>{data.failedOrchestrationRuns ?? 0} failed</span>
        <span>·</span>
        <span>{data.cancelledOrchestrationRuns ?? 0} cancelled</span>
      </div>
    </div>
  );

  if (!data.controllerEntity || !data.projection) {
    return hull;
  }

  return (
    <GraphNodeHoverCardShell
      nodeId={controllerNodeId ?? undefined}
      hoverOpenDelay={220}
      hoverHydrationEnabled={hoverHydrationEnabled}
      hoverCardContent={(
        <GraphNodeHoverCardContent
          entity={data.controllerEntity}
          fallbackProjection={data.projection}
        />
      )}
    >
      {hull}
    </GraphNodeHoverCardShell>
  );
});

GraphOrchestrationHull.displayName = 'GraphOrchestrationHull';
