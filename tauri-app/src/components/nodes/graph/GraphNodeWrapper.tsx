import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import { cn } from '../../../lib/utils';
import { withHexAlpha, CARD_TOKENS } from '../../../lib/visualTokens';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';
import type { FocusTriggerMetrics } from '../../../types/nodes';
import { agentRunManager } from '../../../agent-runs/agentRunManager';

interface GraphNodeWrapperProps {
  nodeId?: string;
  children: ReactNode;
  isFocused: boolean;
  isSelected: boolean;
  isComposerBaseCommit?: boolean;
  disableHoverCard?: boolean;
  scopeColor?: string | null;
  className?: string;
  bodyClassName?: string;
  hoverOpenDelay?: number;
  style?: CSSProperties;
  heightKey?: string;
  onMeasureHeight?: (id: string, height: number) => void;
  hoverCardContent?: ReactNode;
  onFocus: (metrics?: FocusTriggerMetrics) => void;
  onSelect: (multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const GraphNodeWrapper = memo(({
  nodeId,
  children,
  isFocused,
  isSelected,
  isComposerBaseCommit = false,
  disableHoverCard,
  scopeColor,
  className,
  bodyClassName,
  hoverOpenDelay = 500,
  style,
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu
}: GraphNodeWrapperProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pointerDownAtRef = useRef<number | null>(null);
  const focusFeedbackTimeoutRef = useRef<number | null>(null);
  const [isFocusFeedbackActive, setIsFocusFeedbackActive] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [suppressFocusedHoverUntilLeave, setSuppressFocusedHoverUntilLeave] = useState(false);
  const restingBorderColor = scopeColor ? withHexAlpha(scopeColor, '88') : undefined;
  const isBaseCommitHighlighted = isComposerBaseCommit && !isFocused && !isFocusFeedbackActive;

  const clearFocusFeedback = () => {
    if (focusFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(focusFeedbackTimeoutRef.current);
      focusFeedbackTimeoutRef.current = null;
    }
    setIsFocusFeedbackActive(false);
  };

  useEffect(() => {
    if (isFocused) {
      clearFocusFeedback();
    }

    return () => {
      if (focusFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(focusFeedbackTimeoutRef.current);
        focusFeedbackTimeoutRef.current = null;
      }
    };
  }, [isFocused]);

  useLayoutEffect(() => {
    if (!nodeId || !onMeasureHeight) return;
    let frameId: number | null = null;
    let timeoutId: number | null = null;

    const measure = () => {
      const element = rootRef.current;
      if (!element) return;
      const height = Math.max(element.offsetHeight, element.scrollHeight);
      onMeasureHeight(nodeId, height);
    };

    frameId = window.requestAnimationFrame(measure);
    timeoutId = window.setTimeout(measure, 140);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [nodeId, heightKey, onMeasureHeight]);

  const nodeBody = (
    <div
      ref={rootRef}
      data-agentree-graph-node-id={nodeId}
      data-agentree-graph-height-key={heightKey}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        pointerDownAtRef.current = performance.now();
        setSuppressFocusedHoverUntilLeave(true);
        setIsFocusFeedbackActive(true);
        if (focusFeedbackTimeoutRef.current !== null) {
          window.clearTimeout(focusFeedbackTimeoutRef.current);
        }
        focusFeedbackTimeoutRef.current = window.setTimeout(() => {
          focusFeedbackTimeoutRef.current = null;
          setIsFocusFeedbackActive(false);
        }, 420);
      }}
      onPointerLeave={() => {
        setSuppressFocusedHoverUntilLeave(false);
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          pointerDownAtRef.current = null;
          clearFocusFeedback();
          onSelect(true);
          return;
        }
        onFocus({
          pointerDownAt: pointerDownAtRef.current,
          clickAt: performance.now(),
        });
        pointerDownAtRef.current = null;
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        pointerDownAtRef.current = null;
        onContextMenu(e);
      }}
      style={{
        ...style,
        borderColor: isFocused || isFocusFeedbackActive
          ? '#6366f1'
          : isBaseCommitHighlighted
            ? '#059669'
            : isSelected
              ? '#3b82f6'
              : restingBorderColor,
        boxShadow: isBaseCommitHighlighted
          ? '0 0 0 1.5px rgba(5,150,105,0.72), 0 14px 28px -22px rgba(4,120,87,0.86)'
          : !isFocused && !isSelected && scopeColor
            ? `0 4px 12px ${withHexAlpha(scopeColor, '16')}`
            : style?.boxShadow,
      }}
      className={cn(
        'agentree-graph-node-card relative flex flex-col overflow-hidden bg-background cursor-default pointer-events-auto',
        CARD_TOKENS.radius,
        'border',
        isFocused || isFocusFeedbackActive
          ? 'transition-all duration-200 ring-2 ring-indigo-500 shadow-md'
          : isBaseCommitHighlighted
            ? 'transition-all duration-200 ring-2 ring-emerald-600/80 shadow-sm'
            : 'transition-all duration-200 shadow-sm hover:shadow-md',
        isSelected && !isBaseCommitHighlighted ? 'ring-2 ring-blue-500' : '',
        className
      )}
    >
      <div className={cn(
        "pl-3 pr-3 py-2.5 flex-1 flex flex-col min-w-0",
        "backdrop-blur-0",
        bodyClassName
      )}>
        {children}
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

  const shouldDisableHoverCard = Boolean(disableHoverCard || (isFocused && suppressFocusedHoverUntilLeave));

  useEffect(() => {
    if (shouldDisableHoverCard) {
      setHoverOpen(false);
    }
  }, [shouldDisableHoverCard]);

  useEffect(() => {
    if (!nodeId || !hoverOpen || shouldDisableHoverCard) return;
    agentRunManager.watch(nodeId, 'hover');
    return () => {
      agentRunManager.unwatch(nodeId, 'hover');
    };
  }, [hoverOpen, nodeId, shouldDisableHoverCard]);

  if (!hoverCardContent) {
    return nodeBody;
  }

  return (
    <HoverCard
      open={shouldDisableHoverCard ? false : hoverOpen}
      onOpenChange={(open) => {
        setHoverOpen(shouldDisableHoverCard ? false : open);
      }}
      openDelay={hoverOpenDelay}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>
        {nodeBody}
      </HoverCardTrigger>
      <HoverCardContent side="right" align="center" sideOffset={8} className="w-auto border-none bg-transparent p-0 shadow-none z-50">
        {hoverCardContent}
      </HoverCardContent>
    </HoverCard>
  );
});

GraphNodeWrapper.displayName = 'GraphNodeWrapper';
