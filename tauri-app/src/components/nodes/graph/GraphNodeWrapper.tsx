import { cloneElement, isValidElement, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react';
import { Handle, Position } from '@xyflow/react';
import { cn } from '../../../lib/utils';
import { CARD_TOKENS } from '../../../lib/visualTokens';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';
import type { FocusTriggerMetrics } from '../../../types/nodes';
import { useAgentRunHoverHydration } from '../../../hooks/useAgentRunHoverHydration';

interface GraphNodeWrapperProps {
  nodeId?: string;
  children: ReactNode;
  isFocused: boolean;
  isSelected: boolean;
  isComposerBaseCommit?: boolean;
  focusFeedbackEnabled?: boolean;
  disableHoverCard?: boolean;
  className?: string;
  bodyClassName?: string;
  hoverOpenDelay?: number;
  hoverHydrationEnabled?: boolean;
  style?: CSSProperties;
  heightKey?: string;
  onMeasureHeight?: (id: string, height: number) => void;
  hoverCardContent?: ReactNode;
  onFocus: (metrics?: FocusTriggerMetrics) => void;
  onSelect: (multi: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

interface GraphNodeHoverCardShellProps {
  nodeId?: string;
  disabled?: boolean;
  hoverOpenDelay?: number;
  hoverHydrationEnabled?: boolean;
  hoverCardContent?: ReactNode;
  children: ReactNode;
}

export const GraphNodeHoverCardShell = ({
  nodeId,
  disabled,
  hoverOpenDelay = 200,
  hoverHydrationEnabled = false,
  hoverCardContent,
  children,
}: GraphNodeHoverCardShellProps) => {
  const hoverContentRef = useRef<HTMLDivElement | null>(null);
  const pointerInsideHoverContentRef = useRef(false);
  const pointerInsideTriggerRef = useRef(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const shouldDisableHoverCard = Boolean(disabled);

  const closeHoverCard = () => {
    pointerInsideHoverContentRef.current = false;
    pointerInsideTriggerRef.current = false;
    setHoverOpen(false);
  };

  const closeHoverCardUnlessFocusRemainsInside = () => {
    if (pointerInsideTriggerRef.current) return;
    const hoverContent = hoverContentRef.current;
    if (hoverContent && hoverContent.contains(document.activeElement)) return;
    closeHoverCard();
  };

  useEffect(() => {
    if (shouldDisableHoverCard) {
      closeHoverCard();
    }
  }, [shouldDisableHoverCard]);

  useEffect(() => {
    if (!hoverCardContent || !hoverOpen) return;
    window.addEventListener('agentree:graph-viewport-interaction-start', closeHoverCard);
    return () => {
      window.removeEventListener('agentree:graph-viewport-interaction-start', closeHoverCard);
    };
  }, [hoverCardContent, hoverOpen]);

  useEffect(() => {
    if (!hoverCardContent || !hoverOpen) return;
    const closeHoverCardForHiddenDocument = () => {
      if (document.visibilityState === 'hidden') {
        closeHoverCard();
      }
    };
    document.addEventListener('visibilitychange', closeHoverCardForHiddenDocument);
    window.addEventListener('blur', closeHoverCard);
    return () => {
      document.removeEventListener('visibilitychange', closeHoverCardForHiddenDocument);
      window.removeEventListener('blur', closeHoverCard);
    };
  }, [hoverCardContent, hoverOpen]);

  useAgentRunHoverHydration(nodeId, hoverOpen && !shouldDisableHoverCard && hoverHydrationEnabled);

  if (!hoverCardContent) {
    return <>{children}</>;
  }

  return (
    <HoverCard
      open={shouldDisableHoverCard ? false : hoverOpen}
      onOpenChange={(open) => {
        if (shouldDisableHoverCard) {
          closeHoverCard();
          return;
        }
        if (open) {
          setHoverOpen(true);
          return;
        }
        if (pointerInsideHoverContentRef.current || pointerInsideTriggerRef.current) {
          setHoverOpen(true);
          return;
        }
        setHoverOpen(false);
      }}
      openDelay={hoverOpenDelay}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>
        {isValidElement(children)
          ? cloneElement(children as ReactElement<any>, {
            onPointerEnter: (event: ReactPointerEvent) => {
              pointerInsideTriggerRef.current = true;
              setHoverOpen(true);
              (children as ReactElement<any>).props.onPointerEnter?.(event);
            },
            onPointerLeave: (event: ReactPointerEvent) => {
              pointerInsideTriggerRef.current = false;
              (children as ReactElement<any>).props.onPointerLeave?.(event);
            },
            onMouseEnter: (event: ReactMouseEvent) => {
              pointerInsideTriggerRef.current = true;
              setHoverOpen(true);
              (children as ReactElement<any>).props.onMouseEnter?.(event);
            },
            onMouseLeave: (event: ReactMouseEvent) => {
              pointerInsideTriggerRef.current = false;
              (children as ReactElement<any>).props.onMouseLeave?.(event);
            },
          })
          : children}
      </HoverCardTrigger>
      <HoverCardContent
        ref={hoverContentRef}
        side="right"
        align="center"
        sideOffset={8}
        className="z-50 w-auto border-none bg-transparent p-0 shadow-none"
        onPointerEnter={() => {
          pointerInsideHoverContentRef.current = true;
        }}
        onPointerLeave={() => {
          closeHoverCardUnlessFocusRemainsInside();
        }}
        onBlurCapture={(event) => {
          const nextFocus = event.relatedTarget as Node | null;
          if (nextFocus && event.currentTarget.contains(nextFocus)) return;
          if (pointerInsideHoverContentRef.current) return;
          closeHoverCard();
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Escape') return;
          closeHoverCard();
        }}
      >
        {hoverOpen ? hoverCardContent : null}
      </HoverCardContent>
    </HoverCard>
  );
};

export const GraphNodeWrapper = memo(({
  nodeId,
  children,
  isFocused,
  isSelected,
  isComposerBaseCommit = false,
  focusFeedbackEnabled = true,
  disableHoverCard,
  className,
  bodyClassName,
  hoverOpenDelay = 200,
  style,
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  hoverHydrationEnabled = false,
  onFocus,
  onSelect,
  onContextMenu
}: GraphNodeWrapperProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pointerDownAtRef = useRef<number | null>(null);
  const focusFeedbackTimeoutRef = useRef<number | null>(null);
  const [isFocusFeedbackActive, setIsFocusFeedbackActive] = useState(false);
  const [suppressFocusedHoverUntilLeave, setSuppressFocusedHoverUntilLeave] = useState(false);
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
      return;
    }

    if (!isFocusFeedbackActive) {
      return;
    }

    if (focusFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(focusFeedbackTimeoutRef.current);
    }
    focusFeedbackTimeoutRef.current = window.setTimeout(() => {
      focusFeedbackTimeoutRef.current = null;
      setIsFocusFeedbackActive(false);
    }, 420);

    return () => {
      if (focusFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(focusFeedbackTimeoutRef.current);
        focusFeedbackTimeoutRef.current = null;
      }
    };
  }, [isFocused, isFocusFeedbackActive]);

  useEffect(() => {
    return () => {
      if (focusFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(focusFeedbackTimeoutRef.current);
        focusFeedbackTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isFocusFeedbackActive) return;
    clearFocusFeedback();
  }, [nodeId]);

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
        if (focusFeedbackEnabled) {
          setIsFocusFeedbackActive(true);
        }
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
        contain: 'layout paint style',
        borderColor: isFocused || isFocusFeedbackActive
          ? '#6366f1'
          : isBaseCommitHighlighted
            ? '#059669'
            : isSelected
              ? '#3b82f6'
              : undefined,
        boxShadow: isBaseCommitHighlighted
          ? '0 0 0 1.5px rgba(5,150,105,0.72), 0 14px 28px -22px rgba(4,120,87,0.86)'
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

  return (
    <GraphNodeHoverCardShell
      nodeId={nodeId}
      disabled={shouldDisableHoverCard}
      hoverOpenDelay={hoverOpenDelay}
      hoverHydrationEnabled={hoverHydrationEnabled}
      hoverCardContent={hoverCardContent}
    >
      {nodeBody}
    </GraphNodeHoverCardShell>
  );
});

GraphNodeWrapper.displayName = 'GraphNodeWrapper';
