import { cloneElement, Component, isValidElement, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  ErrorInfo,
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
  controlledHoverCardKey?: string | null;
  onControlledHoverCardDismiss?: () => void;
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
  controlledOpenKey?: string | null;
  onControlledOpenDismiss?: () => void;
  hoverCardContent?: ReactNode;
  onHoverOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

class GraphNodeHoverCardErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[GraphNodeHoverCard] Failed to render hover preview:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          data-agentree-node-hover-error="true"
          className="w-72 rounded-2xl border border-[hsl(var(--app-border)/0.76)] bg-[hsl(var(--app-panel)/0.96)] px-4 py-3 text-foreground shadow-lg"
        >
          <div className="text-sm font-semibold">Preview unavailable</div>
          <div className="mt-1 text-xs text-muted-foreground">This node preview could not be displayed.</div>
        </div>
      );
    }

    return this.props.children;
  }
}

export const GraphNodeHoverCardShell = ({
  nodeId,
  disabled,
  hoverOpenDelay = 250,
  hoverHydrationEnabled = false,
  controlledOpenKey = null,
  onControlledOpenDismiss,
  hoverCardContent,
  onHoverOpenChange,
  children,
}: GraphNodeHoverCardShellProps) => {
  const hoverContentRef = useRef<HTMLDivElement | null>(null);
  const pointerInsideHoverContentRef = useRef(false);
  const pointerInsideTriggerRef = useRef(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const isControlledOpen = Boolean(controlledOpenKey);
  const shouldDisableHoverCard = Boolean(disabled) && !isControlledOpen;
  const effectiveHoverOpen = !shouldDisableHoverCard && (hoverOpen || isControlledOpen);

  const closeHoverCard = (options: { dismissControlled?: boolean } = {}) => {
    if (isControlledOpen && !options.dismissControlled) {
      setHoverOpen(true);
      return;
    }
    pointerInsideHoverContentRef.current = false;
    pointerInsideTriggerRef.current = false;
    setHoverOpen(false);
    if (isControlledOpen && options.dismissControlled) {
      onControlledOpenDismiss?.();
    }
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
    if (isControlledOpen) {
      setHoverOpen(true);
    }
  }, [controlledOpenKey, isControlledOpen]);

  useEffect(() => {
    if (!hoverCardContent || !effectiveHoverOpen) return;
    const handleViewportInteractionStart = () => closeHoverCard({ dismissControlled: true });
    window.addEventListener('agentree:graph-viewport-interaction-start', handleViewportInteractionStart);
    return () => {
      window.removeEventListener('agentree:graph-viewport-interaction-start', handleViewportInteractionStart);
    };
  }, [effectiveHoverOpen, hoverCardContent, isControlledOpen]);

  useEffect(() => {
    if (!hoverCardContent || !effectiveHoverOpen) return;
    const closeHoverCardForHiddenDocument = () => {
      if (document.visibilityState === 'hidden') {
        closeHoverCard({ dismissControlled: true });
      }
    };
    const closeForWindowBlur = () => closeHoverCard({ dismissControlled: true });
    document.addEventListener('visibilitychange', closeHoverCardForHiddenDocument);
    window.addEventListener('blur', closeForWindowBlur);
    return () => {
      document.removeEventListener('visibilitychange', closeHoverCardForHiddenDocument);
      window.removeEventListener('blur', closeForWindowBlur);
    };
  }, [effectiveHoverOpen, hoverCardContent, isControlledOpen]);

  useAgentRunHoverHydration(nodeId, effectiveHoverOpen && hoverHydrationEnabled);

  useEffect(() => {
    onHoverOpenChange?.(effectiveHoverOpen);
  }, [effectiveHoverOpen, onHoverOpenChange]);

  if (!hoverCardContent) {
    return <>{children}</>;
  }

  return (
    <HoverCard
      open={effectiveHoverOpen}
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
        closeHoverCard();
      }}
      openDelay={hoverOpenDelay}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>
        {isValidElement(children)
          ? cloneElement(children as ReactElement<any>, {
            onPointerEnter: (event: ReactPointerEvent) => {
              pointerInsideTriggerRef.current = true;
              (children as ReactElement<any>).props.onPointerEnter?.(event);
            },
            onPointerLeave: (event: ReactPointerEvent) => {
              pointerInsideTriggerRef.current = false;
              (children as ReactElement<any>).props.onPointerLeave?.(event);
            },
            onMouseEnter: (event: ReactMouseEvent) => {
              pointerInsideTriggerRef.current = true;
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
          if (isControlledOpen) return;
          closeHoverCardUnlessFocusRemainsInside();
        }}
        onBlurCapture={(event) => {
          const nextFocus = event.relatedTarget as Node | null;
          if (nextFocus && event.currentTarget.contains(nextFocus)) return;
          if (pointerInsideHoverContentRef.current) return;
          closeHoverCard({ dismissControlled: true });
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Escape') return;
          closeHoverCard({ dismissControlled: true });
        }}
      >
        <GraphNodeHoverCardErrorBoundary key={nodeId ?? 'graph-node-hover'}>
          {effectiveHoverOpen ? hoverCardContent : null}
        </GraphNodeHoverCardErrorBoundary>
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
  hoverOpenDelay = 250,
  style,
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  hoverHydrationEnabled = false,
  controlledHoverCardKey = null,
  onControlledHoverCardDismiss,
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
      data-design-scope="nodes"
      data-design-part="graph-node"
      data-design-base-highlighted={isBaseCommitHighlighted ? 'true' : 'false'}
      data-design-focused={isFocused || isFocusFeedbackActive ? 'true' : 'false'}
      data-design-selected={isSelected ? 'true' : 'false'}
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
          ? 'hsl(var(--app-selection) / 0.92)'
          : isBaseCommitHighlighted
            ? '#059669'
            : isSelected
              ? 'hsl(var(--app-selection) / 0.68)'
              : undefined,
        boxShadow: isBaseCommitHighlighted
          ? '0 0 0 1.5px rgba(5,150,105,0.72), 0 14px 28px -22px rgba(4,120,87,0.86)'
          : style?.boxShadow,
      }}
      className={cn(
        'agentree-graph-node-card relative flex flex-col overflow-hidden bg-background cursor-default pointer-events-auto',
        CARD_TOKENS.radius,
        'rounded-xl',
        'border',
        isFocused || isFocusFeedbackActive
          ? 'transition-[border-color,box-shadow,transform] duration-normal ease-out-cubic motion-reduce:transition-none ring-2 ring-[hsl(var(--app-selection)/0.9)] shadow-[0_12px_30px_-25px_hsl(var(--foreground)/0.44)]'
          : isBaseCommitHighlighted
            ? 'transition-[border-color,box-shadow,transform] duration-normal ease-out-cubic motion-reduce:transition-none ring-2 ring-emerald-600/80 shadow-sm'
            : 'transition-[border-color,box-shadow,transform] duration-normal ease-out-cubic motion-reduce:transition-none shadow-sm hover:shadow-[0_12px_30px_-25px_hsl(var(--foreground)/0.4)]',
        isSelected && !isFocused && !isFocusFeedbackActive && !isBaseCommitHighlighted
          ? 'ring-2 ring-[hsl(var(--app-selection)/0.58)]'
          : '',
        className
      )}
    >
      <div data-design-part="graph-node-body" className={cn(
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
      controlledOpenKey={controlledHoverCardKey}
      onControlledOpenDismiss={onControlledHoverCardDismiss}
      hoverCardContent={hoverCardContent}
    >
      {nodeBody}
    </GraphNodeHoverCardShell>
  );
});

GraphNodeWrapper.displayName = 'GraphNodeWrapper';
