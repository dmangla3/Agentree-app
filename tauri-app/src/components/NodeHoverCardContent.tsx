import { lazy, Suspense, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import type { HoverQuickReplyCreatedEvent } from './HoverQuickReplyActions';
import { useRunStatusStore } from '../stores/runStatusStore';
import { isActiveAgentRunStatus } from '../lib/agentRunSteering';
import {
  AgentreeSurfaceProvider,
  useAgentreeSurface,
  type AgentreeSurfaceCapabilities,
  type AgentreeSurfaceMode,
} from './graph/surfaceCapabilities';
import { MessageHighlightSelectionPopover } from './highlights/MessageHighlightSelectionPopover';
import { MessageHighlightHoverPopover } from './highlights/MessageHighlightHoverPopover';
import { AgentResourceUsageBadge } from './AgentResourceUsageBadge';

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

interface NodeHoverCardContentProps {
  entity?: ProjectedNodeEntity;
  projection?: WorkspaceProjection;
  headerAccessory?: ReactNode;
  surfaceMode?: AgentreeSurfaceMode;
  capabilities?: AgentreeSurfaceCapabilities;
  onQuickReplyCreated?: (event: HoverQuickReplyCreatedEvent) => void;
}

export function NodeHoverCardContent({
  entity,
  projection,
  headerAccessory,
  surfaceMode,
  capabilities,
  onQuickReplyCreated,
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
    <AgentreeSurfaceProvider
      surfaceMode={resolvedSurfaceMode}
      capabilities={resolvedCapabilities}
      messageTimestampMode="contextual"
    >
    <div
      data-agentree-node-hover-card="true"
      className="relative flex w-[min(920px,var(--radix-hover-card-content-available-width),calc(100vw-2rem))] max-w-[min(920px,var(--radix-hover-card-content-available-width),calc(100vw-2rem))] flex-col overflow-visible rounded-[24px] border border-[hsl(var(--app-border)/0.76)] bg-[hsl(var(--app-panel)/0.96)] p-3 text-foreground shadow-[0_24px_64px_-40px_hsl(var(--foreground)/0.58),0_10px_24px_-20px_hsl(var(--foreground)/0.32),inset_0_1px_0_hsl(var(--background)/0.22)]"
    >
      {headerAccessory ? (
        <div
          data-agentree-hover-navigation-dock="attached"
          className="absolute right-4 top-px z-20 -translate-y-full"
        >
          {headerAccessory}
        </div>
      ) : null}
      {replyParentId && isAssistantAgentHover ? (
        <AgentResourceUsageBadge
          assistantNodeId={replyParentId}
          enabled={isActiveAgentRunStatus(resolvedRunStatus)}
        />
      ) : null}
      <div
        ref={previewScrollRef}
        data-agentree-highlight-scroll-container="true"
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
            onQuickReplyCreated={onQuickReplyCreated}
          />
        </Suspense>
      ) : null}
	    </div>
	    {resolvedCapabilities.canMutate ? (
	      <>
	        <MessageHighlightSelectionPopover
	          workspaceId={entity.message?.workspaceId ?? null}
	          surfaceRef={previewScrollRef}
	        />
	        <MessageHighlightHoverPopover
	          workspaceId={entity.message?.workspaceId ?? null}
	          surfaceRef={previewScrollRef}
	        />
	      </>
	    ) : null}
	    </AgentreeSurfaceProvider>
	  );
	}
