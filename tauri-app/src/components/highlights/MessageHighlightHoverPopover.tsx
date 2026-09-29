import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Trash2 } from 'lucide-react';
import type { MessageHighlightAnnotation } from '../../stores/workspaceStore';
import { getMessageHighlights } from '../../lib/messageHighlights';
import { writeClipboardText } from '../../lib/clipboard';
import { useDeleteHighlight, useMessages } from '../../hooks/useMessages';
import {
  createRangeFromHighlightOffsets,
  getHighlightRootForNode,
} from './messageHighlightDom';

type HighlightRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type HighlightHitArea = {
  highlight: MessageHighlightAnnotation;
  rects: HighlightRect[];
  text: string;
};

type HitAreaCache = {
  root: HTMLElement;
  messageId: string;
  signature: string;
  areas: HighlightHitArea[];
};

type HoverState = {
  messageId: string;
  highlight: MessageHighlightAnnotation;
  text: string;
  left: number;
  top: number;
  anchorRect: HighlightRect;
};

const HIT_PADDING_PX = 2;
const POPOVER_WIDTH_ESTIMATE_PX = 72;
const POPOVER_HEIGHT_ESTIMATE_PX = 34;
const POPOVER_GAP_PX = 8;
const HOVER_BRIDGE_PADDING_PX = 8;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

const isPointInsideRect = (x: number, y: number, rect: HighlightRect) => (
  x >= rect.left - HIT_PADDING_PX
  && x <= rect.right + HIT_PADDING_PX
  && y >= rect.top - HIT_PADDING_PX
  && y <= rect.bottom + HIT_PADDING_PX
);

const getHighlightsSignature = (highlights: MessageHighlightAnnotation[]) => (
  highlights
    .map((highlight) => [
      highlight.id,
      highlight.color,
      highlight.range.start,
      highlight.range.end,
      highlight.updatedAt,
    ].join(':'))
    .join('|')
);

const rectToPlainObject = (rect: DOMRect): HighlightRect => ({
  left: rect.left,
  right: rect.right,
  top: rect.top,
  bottom: rect.bottom,
});

const getAnchorRect = (rects: HighlightRect[], x: number, y: number): HighlightRect | null => (
  rects.find((rect) => isPointInsideRect(x, y, rect)) ?? rects[0] ?? null
);

const isPointInsideDomRect = (x: number, y: number, rect: DOMRect, padding = 0) => (
  x >= rect.left - padding
  && x <= rect.right + padding
  && y >= rect.top - padding
  && y <= rect.bottom + padding
);

const getPointSide = (
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number }
) => ((point.x - end.x) * (start.y - end.y)) - ((start.x - end.x) * (point.y - end.y));

const isPointInsideTriangle = (
  point: { x: number; y: number },
  first: { x: number; y: number },
  second: { x: number; y: number },
  third: { x: number; y: number }
) => {
  const sideA = getPointSide(point, first, second);
  const sideB = getPointSide(point, second, third);
  const sideC = getPointSide(point, third, first);
  const hasNegative = sideA < 0 || sideB < 0 || sideC < 0;
  const hasPositive = sideA > 0 || sideB > 0 || sideC > 0;
  return !(hasNegative && hasPositive);
};

const isPointInsideHoverBridge = (
  x: number,
  y: number,
  hoverState: HoverState | null,
  popover: HTMLElement | null
) => {
  if (!hoverState || !popover) return false;
  const popoverRect = popover.getBoundingClientRect();
  if (isPointInsideDomRect(x, y, popoverRect, HOVER_BRIDGE_PADDING_PX)) return true;

  const anchorRect = hoverState.anchorRect;
  const popoverIsAbove = popoverRect.bottom <= anchorRect.top;
  const anchorPoint = popoverIsAbove
    ? { x: (anchorRect.left + anchorRect.right) / 2, y: anchorRect.top - HOVER_BRIDGE_PADDING_PX }
    : { x: (anchorRect.left + anchorRect.right) / 2, y: anchorRect.bottom + HOVER_BRIDGE_PADDING_PX };
  const popoverEdgeY = popoverIsAbove
    ? popoverRect.bottom + HOVER_BRIDGE_PADDING_PX
    : popoverRect.top - HOVER_BRIDGE_PADDING_PX;

  return isPointInsideTriangle(
    { x, y },
    anchorPoint,
    { x: popoverRect.left - HOVER_BRIDGE_PADDING_PX, y: popoverEdgeY },
    { x: popoverRect.right + HOVER_BRIDGE_PADDING_PX, y: popoverEdgeY }
  );
};

const getPopoverPosition = (anchorRect: HighlightRect) => {
  const anchorCenterX = (anchorRect.left + anchorRect.right) / 2;
  const placeAbove = anchorRect.top > POPOVER_HEIGHT_ESTIMATE_PX + POPOVER_GAP_PX + 8;
  const left = clamp(
    anchorCenterX,
    POPOVER_WIDTH_ESTIMATE_PX / 2 + 8,
    window.innerWidth - (POPOVER_WIDTH_ESTIMATE_PX / 2) - 8
  );
  const top = placeAbove
    ? anchorRect.top - POPOVER_HEIGHT_ESTIMATE_PX - POPOVER_GAP_PX
    : anchorRect.bottom + POPOVER_GAP_PX;

  return {
    left,
    top: clamp(top, 8, window.innerHeight - POPOVER_HEIGHT_ESTIMATE_PX - 8),
  };
};

const buildHitAreas = (
  root: HTMLElement,
  highlights: MessageHighlightAnnotation[]
): HighlightHitArea[] => {
  const areas: HighlightHitArea[] = [];

  highlights.forEach((highlight) => {
    const range = createRangeFromHighlightOffsets(root, highlight.range.start, highlight.range.end);
    if (!range) return;

    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 || rect.height > 0)
      .map(rectToPlainObject);
    if (rects.length === 0) return;

    areas.push({
      highlight,
      rects,
      text: range.toString() || highlight.range.exact,
    });
  });

  return areas;
};

export function MessageHighlightHoverPopover({
  workspaceId,
  surfaceRef,
}: {
  workspaceId: string | null;
  surfaceRef: RefObject<HTMLElement | null>;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const hitAreaCacheRef = useRef<HitAreaCache | null>(null);
  const latestPointerRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null);
  const frameRef = useRef<number | null>(null);
  const [hoverState, setHoverState] = useState<HoverState | null>(null);
  const [copiedHighlightId, setCopiedHighlightId] = useState<string | null>(null);
  const messagesQuery = useMessages(workspaceId, { enabled: Boolean(workspaceId) });
  const deleteHighlightMutation = useDeleteHighlight();

  const messagesById = useMemo(() => {
    const messages = messagesQuery.data ?? [];
    return new Map(messages.map((message) => [message.id, message]));
  }, [messagesQuery.data]);

  const clearHoverState = useCallback(() => {
    setHoverState(null);
    setCopiedHighlightId(null);
  }, []);

  const clearHitAreaCache = useCallback(() => {
    hitAreaCacheRef.current = null;
  }, []);

  const getHitAreas = useCallback((
    root: HTMLElement,
    messageId: string,
    highlights: MessageHighlightAnnotation[]
  ): HighlightHitArea[] => {
    const signature = getHighlightsSignature(highlights);
    const cached = hitAreaCacheRef.current;
    if (
      cached
      && cached.root === root
      && cached.messageId === messageId
      && cached.signature === signature
    ) {
      return cached.areas;
    }

    const areas = buildHitAreas(root, highlights);
    hitAreaCacheRef.current = { root, messageId, signature, areas };
    return areas;
  }, []);

  const runHitTest = useCallback(() => {
    frameRef.current = null;
    const pointer = latestPointerRef.current;
    const surface = surfaceRef.current;
    if (!workspaceId || !pointer || !surface) {
      clearHoverState();
      return;
    }

    const popover = popoverRef.current;
    if (popover && pointer.target instanceof Node && popover.contains(pointer.target)) {
      return;
    }

    if (isPointInsideHoverBridge(pointer.x, pointer.y, hoverState, popover)) {
      return;
    }

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      clearHoverState();
      return;
    }

    const root = pointer.target instanceof Node
      ? getHighlightRootForNode(pointer.target)
      : null;
    if (!root || !surface.contains(root)) {
      clearHoverState();
      return;
    }

    const messageId = root.dataset.agentreeHighlightMessageId;
    if (!messageId) {
      clearHoverState();
      return;
    }

    const highlights = getMessageHighlights(messagesById.get(messageId));
    if (highlights.length === 0) {
      clearHoverState();
      return;
    }

    const areas = getHitAreas(root, messageId, highlights);
    const hit = areas.find((area) =>
      area.rects.some((rect) => isPointInsideRect(pointer.x, pointer.y, rect))
    );
    if (!hit) {
      clearHoverState();
      return;
    }

    const anchorRect = getAnchorRect(hit.rects, pointer.x, pointer.y);
    if (!anchorRect) {
      clearHoverState();
      return;
    }

    if (hoverState?.messageId === messageId && hoverState.highlight.id === hit.highlight.id) {
      return;
    }

    const position = getPopoverPosition(anchorRect);
    setHoverState({
      messageId,
      highlight: hit.highlight,
      text: hit.text,
      left: position.left,
      top: position.top,
      anchorRect,
    });
  }, [clearHoverState, getHitAreas, hoverState, messagesById, surfaceRef, workspaceId]);

  const scheduleHitTest = useCallback((event: PointerEvent) => {
    latestPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      target: event.target,
    };
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(runHitTest);
  }, [runHitTest]);

  useEffect(() => {
    clearHitAreaCache();
  }, [clearHitAreaCache, messagesById]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    const handlePointerMove = (event: PointerEvent) => scheduleHitTest(event);
    const handleScrollOrResize = () => {
      clearHitAreaCache();
      clearHoverState();
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [clearHitAreaCache, clearHoverState, scheduleHitTest, workspaceId]);

  const handleCopy = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!hoverState?.text.trim()) return;
    try {
      await writeClipboardText(hoverState.text);
      setCopiedHighlightId(hoverState.highlight.id);
      window.setTimeout(() => setCopiedHighlightId(null), 1000);
    } catch (_error) {
      setCopiedHighlightId(null);
    }
  };

  const handleDelete = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!workspaceId || !hoverState) return;
    deleteHighlightMutation.mutate({
      workspaceId,
      messageId: hoverState.messageId,
      highlightId: hoverState.highlight.id,
    });
    clearHoverState();
    clearHitAreaCache();
  };

  if (!hoverState || typeof document === 'undefined') return null;

  const copied = copiedHighlightId === hoverState.highlight.id;

  return createPortal((
    <div
      ref={popoverRef}
      className="fixed z-[1001] flex items-center gap-1 rounded-md border border-border/80 bg-popover px-1.5 py-1 text-popover-foreground shadow-lg"
      style={{
        left: hoverState.left,
        top: hoverState.top,
        transform: 'translateX(-50%)',
      }}
      role="toolbar"
      aria-label="Highlight actions"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Copy highlight"
        title={copied ? 'Copied' : 'Copy highlight'}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => void handleCopy(event)}
      >
        {copied ? <Check size={13} strokeWidth={2.4} /> : <Copy size={13} strokeWidth={2.2} />}
      </button>
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Delete highlight"
        title="Delete highlight"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => handleDelete(event)}
      >
        <Trash2 size={13} strokeWidth={2.2} />
      </button>
    </div>
  ), document.body);
}
