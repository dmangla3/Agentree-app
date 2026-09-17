import { lazy, Suspense, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Workflow } from 'lucide-react';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { useRunStatusStore } from '../stores/runStatusStore';
import { isActiveAgentRunStatus } from '../lib/agentRunSteering';
import {
  AgentreeSurfaceProvider,
  useAgentreeSurface,
  type AgentreeSurfaceCapabilities,
  type AgentreeSurfaceMode,
} from './graph/surfaceCapabilities';
import { MessageHighlightSelectionPopover } from './highlights/MessageHighlightSelectionPopover';

let appNodeHoverPreviewPreload: Promise<{ default: typeof import('./AppNodeHoverPreview').AppNodeHoverPreview }> | null = null;

const loadAppNodeHoverPreview = () => {
  appNodeHoverPreviewPreload ??= import('./AppNodeHoverPreview').then((module) => ({
    default: module.AppNodeHoverPreview,
  }));
  return appNodeHoverPreviewPreload;
};

export const preloadNodeHoverPreview = () => {
  void loadAppNodeHoverPreview();
};

const AppNodeHoverPreview = lazy(loadAppNodeHoverPreview);

const AppHoverQuickReplyActions = lazy(() => import('./HoverQuickReplyActions').then((module) => ({
  default: module.HoverQuickReplyActions,
})));

const HOVER_PREVIEW_BOTTOM_PIN_THRESHOLD_PX = 32;

const isNearHoverPreviewBottom = (element: HTMLElement) => (
  element.scrollHeight - element.scrollTop - element.clientHeight <= HOVER_PREVIEW_BOTTOM_PIN_THRESHOLD_PX
);

const ORCHESTRATION_RUN_PREVIEW_LIMIT = 4;

const getOrchestrationRunStatusLabel = (entity: ProjectedNodeEntity): string => {
  if (entity.status === 'completed') return 'Completed';
  if (entity.status === 'failed') return 'Failed';
  if (entity.status === 'cancelled') return 'Cancelled';
  if (entity.status === 'running' || entity.status === 'streaming') return 'Running';
  if (entity.status === 'pending') return 'Pending';
  return 'Unknown';
};

const getOrchestrationRunStatusClassName = (entity: ProjectedNodeEntity): string => {
  if (entity.status === 'completed') {
    return 'border-emerald-500/24 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (entity.status === 'failed') {
    return 'border-red-500/24 bg-red-500/10 text-red-700 dark:text-red-300';
  }
  if (entity.status === 'cancelled') {
    return 'border-amber-500/24 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  }
  if (entity.status === 'running' || entity.status === 'streaming' || entity.status === 'pending') {
    return 'border-sky-500/24 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  }
  return 'border-[hsl(var(--app-border)/0.64)] bg-[hsl(var(--app-bg-muted)/0.52)] text-muted-foreground';
};

function OrchestrationSummaryPanel({
  entity,
  projection,
}: {
  entity: ProjectedNodeEntity;
  projection: WorkspaceProjection;
}) {
  const summary = entity.nodeKind === 'orchestrator' ? entity.orchestrationSummary ?? null : null;
  if (!summary) return null;
  const runEntities = summary.orchestrationRunAssistantEntityIds
    .map((entityId) => projection.entitiesById.get(entityId))
    .filter((run): run is ProjectedNodeEntity => Boolean(run))
    .slice(0, ORCHESTRATION_RUN_PREVIEW_LIMIT);
  const hiddenRunCount = Math.max(0, summary.totalOrchestrationRuns - runEntities.length);

  return (
    <section
      data-testid="orchestration-hover-summary"
      className="mt-2 rounded-[16px] border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel-strong)/0.62)] px-3 py-2.5"
      aria-label="Orchestration summary"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.64)] bg-[hsl(var(--app-bg-muted)/0.56)] text-[hsl(var(--app-accent))]">
            <Workflow size={15} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-semibold text-foreground">Orchestration</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {summary.totalOrchestrationRuns} orchestration {summary.totalOrchestrationRuns === 1 ? 'run' : 'runs'}
            </div>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-5 gap-1 text-center tabular-nums">
          {[
            ['Active', summary.activeOrchestrationRuns],
            ['Done', summary.completedOrchestrationRuns],
            ['Failed', summary.failedOrchestrationRuns],
            ['Cancelled', summary.cancelledOrchestrationRuns],
            ['Total', summary.totalOrchestrationRuns],
          ].map(([label, count]) => (
            <div key={label} className="min-w-10 rounded-lg bg-[hsl(var(--app-bg-muted)/0.46)] px-1.5 py-1">
              <div className="text-[11px] font-semibold leading-none text-foreground">{count}</div>
              <div className="mt-0.5 text-[9px] leading-none text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {runEntities.length > 0 ? (
        <div className="mt-2 space-y-1">
          {runEntities.map((run) => (
            <div key={run.entityId} className="flex min-w-0 items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-muted-foreground">{run.preview || run.shortLabel}</span>
              <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none ${getOrchestrationRunStatusClassName(run)}`}>
                {getOrchestrationRunStatusLabel(run)}
              </span>
            </div>
          ))}
          {hiddenRunCount > 0 ? (
            <div className="text-[10px] text-muted-foreground">
              +{hiddenRunCount} more orchestration {hiddenRunCount === 1 ? 'run' : 'runs'}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface NodeHoverCardContentProps {
  entity?: ProjectedNodeEntity;
  projection?: WorkspaceProjection;
  headerAccessory?: ReactNode;
  surfaceMode?: AgentreeSurfaceMode;
  capabilities?: AgentreeSurfaceCapabilities;
  showOrchestrationSummary?: boolean;
}

export function NodeHoverCardContent({
  entity,
  projection,
  headerAccessory,
  surfaceMode,
  capabilities,
  showOrchestrationSummary = true,
}: NodeHoverCardContentProps) {
  const surface = useAgentreeSurface();
  const resolvedSurfaceMode = surfaceMode ?? surface.surfaceMode;
  const resolvedCapabilities = capabilities ?? surface.capabilities;
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const previewPinnedToBottomRef = useRef(true);
  const replyParentId = entity?.focusMessageId || entity?.messageId || null;
  const replyRunStatus = useRunStatusStore((state) => (
    replyParentId ? state.byNodeId[replyParentId]?.status ?? null : null
  ));
  const resolvedRunStatus = replyRunStatus ?? entity?.status ?? entity?.message?.status ?? null;
  const isAssistantAgentHover = entity?.message?.role === 'assistant' || entity?.kind === 'assistant_message';
  const shouldDefaultScrollPreviewToBottom = isAssistantAgentHover && isActiveAgentRunStatus(resolvedRunStatus);
  useLayoutEffect(() => {
    if (!shouldDefaultScrollPreviewToBottom) return;
    const scrollArea = previewScrollRef.current;
    if (!scrollArea) return;

    let settledFrameId: number | null = null;
    const scrollToBottom = () => {
      scrollArea.scrollTop = scrollArea.scrollHeight;
      previewPinnedToBottomRef.current = true;
    };

    scrollToBottom();
    const frameId = window.requestAnimationFrame(() => {
      scrollToBottom();
      settledFrameId = window.requestAnimationFrame(scrollToBottom);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      if (settledFrameId !== null) {
        window.cancelAnimationFrame(settledFrameId);
      }
    };
  }, [replyParentId, shouldDefaultScrollPreviewToBottom]);

  useLayoutEffect(() => {
    if (!shouldDefaultScrollPreviewToBottom) return;
    const scrollArea = previewScrollRef.current;
    if (!scrollArea) return;

    let frameId: number | null = null;
    const scrollToBottomIfPinned = () => {
      if (!previewPinnedToBottomRef.current) return;
      scrollArea.scrollTop = scrollArea.scrollHeight;
    };
    const scheduleScrollToBottomIfPinned = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        scrollToBottomIfPinned();
      });
    };

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleScrollToBottomIfPinned);
    resizeObserver?.observe(scrollArea);
    Array.from(scrollArea.children).forEach((child) => {
      resizeObserver?.observe(child);
    });

    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(scheduleScrollToBottomIfPinned);
    mutationObserver?.observe(scrollArea, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    scheduleScrollToBottomIfPinned();

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [replyParentId, shouldDefaultScrollPreviewToBottom]);

  if (!entity || !projection) return null;

  return (
    <AgentreeSurfaceProvider surfaceMode={resolvedSurfaceMode} capabilities={resolvedCapabilities}>
    <div
      data-agentree-node-hover-card="true"
      className="flex w-[min(920px,var(--radix-hover-card-content-available-width),calc(100vw-2rem))] max-w-[min(920px,var(--radix-hover-card-content-available-width),calc(100vw-2rem))] flex-col overflow-hidden rounded-[24px] border border-[hsl(var(--app-border)/0.76)] bg-[hsl(var(--app-panel)/0.96)] p-3 text-foreground shadow-[0_24px_64px_-40px_hsl(var(--foreground)/0.58),0_10px_24px_-20px_hsl(var(--foreground)/0.32),inset_0_1px_0_hsl(var(--background)/0.22)]"
    >
      {headerAccessory}
      <div
        ref={previewScrollRef}
        className="max-h-[calc(min(70vh,720px)-1.5rem)] w-full overflow-y-auto overscroll-contain"
        onWheelCapture={(event) => {
          event.stopPropagation();
        }}
        onScroll={() => {
          const scrollArea = previewScrollRef.current;
          if (!scrollArea || !shouldDefaultScrollPreviewToBottom) return;
          previewPinnedToBottomRef.current = isNearHoverPreviewBottom(scrollArea);
        }}
      >
        <div className="min-w-0">
          <div className="min-w-0 rounded-[20px] border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.42)] p-1 shadow-[inset_0_1px_0_hsl(var(--background)/0.16)]">
            <Suspense fallback={null}>
              <AppNodeHoverPreview entity={entity} projection={projection} />
            </Suspense>
          </div>
          {showOrchestrationSummary ? (
            <OrchestrationSummaryPanel entity={entity} projection={projection} />
          ) : null}
        </div>
      </div>
      {(resolvedCapabilities.canReply || resolvedCapabilities.canSteer) && replyParentId ? (
        <Suspense fallback={null}>
          <AppHoverQuickReplyActions
            entity={entity}
            projection={projection}
            replyParentId={replyParentId}
            replyRunStatus={replyRunStatus}
            canReply={resolvedCapabilities.canReply}
            canSteer={resolvedCapabilities.canSteer}
          />
        </Suspense>
      ) : null}
	    </div>
	    <MessageHighlightSelectionPopover
	      workspaceId={entity.message?.workspaceId ?? null}
	      surfaceRef={previewScrollRef}
	    />
	    </AgentreeSurfaceProvider>
	  );
	}
