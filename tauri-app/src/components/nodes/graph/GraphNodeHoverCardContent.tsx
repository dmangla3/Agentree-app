import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { NodeHoverCardContent } from '../../NodeHoverCardContent';
import { useGraphHoverProjectionInput } from '../../graph/GraphHoverProjectionContext';
import { useWorkspaceProjection } from '../../../hooks/useWorkspaceProjection';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../../domain/workspaceProjection';
import type { HoverQuickReplyCreatedEvent } from '../../HoverQuickReplyActions';
import type { Message } from '../../../stores/workspaceStore';
import { cn } from '../../../lib/utils';
import {
  getAdjacentHoverNavigationIndex,
  HoverCardNavigationChrome,
} from '../../graph/HoverCardNavigationChrome';
import type {
  AgentreeSurfaceCapabilities,
  AgentreeSurfaceMode,
} from '../../graph/surfaceCapabilities';

interface GraphNodeHoverCardContentProps {
  entity?: ProjectedNodeEntity;
  fallbackProjection?: WorkspaceProjection;
  surfaceMode?: AgentreeSurfaceMode;
  capabilities?: AgentreeSurfaceCapabilities;
}

export function getChronologicalHoverAgentMessageIds(
  messages: Message[],
  entitiesByMessageId: ReadonlyMap<string, ProjectedNodeEntity>,
): string[] {
  const navigableAgentMessageIds = new Set(
    Array.from(entitiesByMessageId.entries())
      .filter(([, entity]) => entity.kind === 'assistant_message')
      .map(([messageId]) => messageId),
  );
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const depthById = new Map<string, number>();
  const getMessageDepth = (message: Message, visiting = new Set<string>()): number => {
    const cached = depthById.get(message.id);
    if (cached !== undefined) return cached;
    if (typeof message.depth === 'number' && Number.isFinite(message.depth)) {
      depthById.set(message.id, message.depth);
      return message.depth;
    }
    if (Array.isArray(message.path_ids) && message.path_ids.length > 0) {
      depthById.set(message.id, message.path_ids.length);
      return message.path_ids.length;
    }
    if (!message.parentId || visiting.has(message.id)) {
      depthById.set(message.id, 0);
      return 0;
    }
    const parent = messageById.get(message.parentId);
    if (!parent) {
      depthById.set(message.id, 0);
      return 0;
    }
    const nextVisiting = new Set(visiting).add(message.id);
    const depth = getMessageDepth(parent, nextVisiting) + 1;
    depthById.set(message.id, depth);
    return depth;
  };

  return messages
    .filter((message) => navigableAgentMessageIds.has(message.id))
    .slice()
    .sort((left, right) => {
      const leftTs = new Date(left.createdAt).getTime();
      const rightTs = new Date(right.createdAt).getTime();
      const timeOrder = (Number.isFinite(leftTs) ? leftTs : 0) - (Number.isFinite(rightTs) ? rightTs : 0);
      if (timeOrder !== 0) return timeOrder;
      const depthOrder = getMessageDepth(left) - getMessageDepth(right);
      if (depthOrder !== 0) return depthOrder;
      return left.id.localeCompare(right.id);
    })
    .map((message) => message.id);
}

const stopHoverNavigationControlEvent = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

const isTextEditingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, [contenteditable="true"], [role="textbox"]'));
};

export function GraphNodeHoverCardContent({
  entity,
  fallbackProjection,
  surfaceMode,
  capabilities,
}: GraphNodeHoverCardContentProps) {
  const hoverInput = useGraphHoverProjectionInput();
  const hoverProjection = useWorkspaceProjection(
    hoverInput.messages.length > 0 ? hoverInput.messages : fallbackProjection?.messages ?? [],
    hoverInput.summaries.length > 0 ? hoverInput.summaries : fallbackProjection?.summaries ?? [],
    null,
    hoverInput.disabledSummaryIds,
    'graph-hover',
  );
  const initialMessageId = entity?.messageId ?? null;
  const projectionMessages = hoverProjection.messages ?? [];
  const chronologicalAgentMessageIds = useMemo(
    () => getChronologicalHoverAgentMessageIds(projectionMessages, hoverProjection.entitiesByMessageId),
    [hoverProjection.entitiesByMessageId, projectionMessages],
  );
  const navigableAgentMessageIds = useMemo(
    () => new Set(chronologicalAgentMessageIds),
    [chronologicalAgentMessageIds],
  );
  const [activeMessageId, setActiveMessageId] = useState<string | null>(initialMessageId);
  const [pendingReplyAgentMessageId, setPendingReplyAgentMessageId] = useState<string | null>(null);
  const [replyAttentionActive, setReplyAttentionActive] = useState(false);

  useEffect(() => {
    setActiveMessageId(initialMessageId);
    setPendingReplyAgentMessageId(null);
  }, [initialMessageId]);

  useEffect(() => {
    if (!pendingReplyAgentMessageId) {
      setReplyAttentionActive(false);
      return;
    }
    setReplyAttentionActive(true);
    const timeoutId = window.setTimeout(() => setReplyAttentionActive(false), 2400);
    return () => window.clearTimeout(timeoutId);
  }, [pendingReplyAgentMessageId]);

  const currentMessageId = activeMessageId && hoverProjection.entitiesByMessageId.has(activeMessageId)
    ? activeMessageId
    : initialMessageId;
  const currentIndex = currentMessageId ? chronologicalAgentMessageIds.indexOf(currentMessageId) : -1;
  const previousMessageId = currentIndex > 0 ? chronologicalAgentMessageIds[currentIndex - 1] : null;
  const nextMessageId = currentIndex >= 0 && currentIndex < chronologicalAgentMessageIds.length - 1
    ? chronologicalAgentMessageIds[currentIndex + 1]
    : null;
  const pendingReplyIndex = pendingReplyAgentMessageId
    ? chronologicalAgentMessageIds.indexOf(pendingReplyAgentMessageId)
    : -1;
  const pendingReplyIsNext = Boolean(
    pendingReplyAgentMessageId && pendingReplyAgentMessageId === nextMessageId,
  );
  const canJumpToPendingReply = pendingReplyIndex >= 0
    && pendingReplyAgentMessageId !== currentMessageId
    && !pendingReplyIsNext;

  useEffect(() => {
    if (pendingReplyAgentMessageId && pendingReplyAgentMessageId === currentMessageId) {
      setPendingReplyAgentMessageId(null);
    }
  }, [currentMessageId, pendingReplyAgentMessageId]);

  const navigateToMessage = (messageId: string | null) => {
    if (!messageId || !navigableAgentMessageIds.has(messageId)) return;
    setActiveMessageId(messageId);
  };

  const navigateByStep = (step: -1 | 1) => {
    if (currentIndex < 0) return;
    const nextIndex = getAdjacentHoverNavigationIndex(
      currentIndex,
      chronologicalAgentMessageIds.length,
      step,
    );
    if (nextIndex === currentIndex) return;
    navigateToMessage(chronologicalAgentMessageIds[nextIndex] ?? null);
  };

  const handleQuickReplyCreated = (event: HoverQuickReplyCreatedEvent) => {
    if (event.assistantMessageId) {
      setPendingReplyAgentMessageId(event.assistantMessageId);
    }
  };

  const handleNavigationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTextEditingTarget(event.target)) return;
    if (event.key === 'ArrowLeft' && previousMessageId) {
      stopHoverNavigationControlEvent(event);
      navigateByStep(-1);
    } else if (event.key === 'ArrowRight' && nextMessageId) {
      stopHoverNavigationControlEvent(event);
      navigateByStep(1);
    }
  };

  const replyAccessory = canJumpToPendingReply ? (
    <button
      type="button"
      aria-label="View new reply"
      onClick={(event) => {
        stopHoverNavigationControlEvent(event);
        navigateToMessage(pendingReplyAgentMessageId);
      }}
      className={cn(
        "flex h-10 items-center gap-1.5 rounded-full border border-[hsl(var(--app-accent)/0.34)] bg-[hsl(var(--app-accent-soft)/0.48)] px-3 text-[11px] font-semibold text-[hsl(var(--app-accent))] shadow-[0_8px_20px_-16px_hsl(var(--app-accent)/0.8)] transition-[background-color,border-color,box-shadow,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.72)] active:scale-[0.96]",
        replyAttentionActive && "motion-safe:animate-pulse",
      )}
    >
      <span className="hidden sm:inline">View new reply</span>
      <span className="sm:hidden">New reply</span>
      <ArrowRight size={14} strokeWidth={2.2} aria-hidden="true" />
    </button>
  ) : null;

  const navigationChrome = initialMessageId && (currentIndex >= 0 || replyAccessory) ? (
    <HoverCardNavigationChrome
      position={currentIndex + 1}
      itemCount={chronologicalAgentMessageIds.length}
      canGoPrevious={Boolean(previousMessageId)}
      canGoNext={Boolean(nextMessageId)}
      previousLabel="Show older agent message"
      nextLabel="Show newer agent message"
      onPrevious={() => navigateByStep(-1)}
      onNext={() => navigateByStep(1)}
      accessory={replyAccessory}
      announcement={pendingReplyIndex >= 0 ? 'New reply ready' : null}
      nextAttention={pendingReplyIsNext && replyAttentionActive}
      showControls={currentIndex >= 0}
    />
  ) : null;

  const resolvedEntity = currentMessageId
    ? hoverProjection.entitiesByMessageId.get(currentMessageId) ?? entity
    : entity?.summary?.id
      ? hoverProjection.entitiesBySummaryId.get(entity.summary.id) ?? entity
      : entity;

  return (
    <div
      data-agentree-graph-hover-navigation="chronological"
      onKeyDownCapture={handleNavigationKeyDown}
    >
      <NodeHoverCardContent
        key={currentMessageId ?? resolvedEntity?.entityId ?? 'graph-hover'}
        entity={resolvedEntity}
        projection={resolvedEntity ? hoverProjection : fallbackProjection}
        headerAccessory={navigationChrome}
        surfaceMode={surfaceMode}
        capabilities={capabilities}
        onQuickReplyCreated={handleQuickReplyCreated}
      />
    </div>
  );
}
