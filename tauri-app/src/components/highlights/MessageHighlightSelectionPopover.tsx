import { useCallback, useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Highlighter } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  createHighlightRangeFromOffsets,
  MESSAGE_HIGHLIGHT_COLORS,
} from '../../lib/messageHighlights';
import type { MessageHighlightColor, MessageHighlightRange } from '../../stores/workspaceStore';
import { useAddHighlight } from '../../hooks/useMessages';
import {
  getHighlightRootForNode,
  getTextOffsetInHighlightRoot,
} from './messageHighlightDom';

const COLOR_BUTTON_CLASSES: Record<MessageHighlightColor, string> = {
  yellow: 'bg-yellow-300 hover:bg-yellow-300/85 ring-yellow-500/70',
  green: 'bg-green-300 hover:bg-green-300/85 ring-green-500/70',
  blue: 'bg-blue-300 hover:bg-blue-300/85 ring-blue-500/70',
  rose: 'bg-rose-300 hover:bg-rose-300/85 ring-rose-500/70',
};

type SelectionPopoverState = {
  messageId: string;
  range: MessageHighlightRange;
  left: number;
  top: number;
};

export function MessageHighlightSelectionPopover({
  workspaceId,
  surfaceRef,
}: {
  workspaceId: string | null;
  surfaceRef: RefObject<HTMLElement | null>;
}) {
  const addHighlightMutation = useAddHighlight();
  const [selectionState, setSelectionState] = useState<SelectionPopoverState | null>(null);

  const captureSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!workspaceId || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setSelectionState(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const startRoot = getHighlightRootForNode(range.startContainer);
    const endRoot = getHighlightRootForNode(range.endContainer);
    const surface = surfaceRef.current;
    if (!startRoot || startRoot !== endRoot || (surface && !surface.contains(startRoot))) {
      setSelectionState(null);
      return;
    }

    const messageId = startRoot.dataset.agentreeHighlightMessageId;
    if (!messageId) {
      setSelectionState(null);
      return;
    }

    const start = getTextOffsetInHighlightRoot(startRoot, range.startContainer, range.startOffset);
    const end = getTextOffsetInHighlightRoot(startRoot, range.endContainer, range.endOffset);
    if (start === null || end === null) {
      setSelectionState(null);
      return;
    }

    const rangeStart = Math.min(start, end);
    const rangeEnd = Math.max(start, end);
    const highlightRange = createHighlightRangeFromOffsets(startRoot.textContent ?? '', rangeStart, rangeEnd);
    if (!highlightRange) {
      setSelectionState(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      setSelectionState(null);
      return;
    }

    setSelectionState({
      messageId,
      range: highlightRange,
      left: Math.max(12, Math.min(rect.left + rect.width / 2, window.innerWidth - 160)),
      top: Math.max(12, rect.top - 44),
    });
  }, [surfaceRef, workspaceId]);

  useEffect(() => {
    const handlePointerUp = () => window.setTimeout(captureSelection, 0);
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectionState(null);
        return;
      }
      window.setTimeout(captureSelection, 0);
    };
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('selectionchange', captureSelection);
    return () => {
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('selectionchange', captureSelection);
    };
  }, [captureSelection]);

  const applyHighlight = (color: MessageHighlightColor) => {
    if (!workspaceId || !selectionState) return;
    addHighlightMutation.mutate({
      workspaceId,
      messageId: selectionState.messageId,
      color,
      range: selectionState.range,
    });
    window.getSelection()?.removeAllRanges();
    setSelectionState(null);
  };

  if (!selectionState || typeof document === 'undefined') return null;

  return createPortal((
    <div
      className="fixed z-[1000] flex items-center gap-1 rounded-md border border-border/80 bg-popover px-1.5 py-1 text-popover-foreground shadow-lg"
      style={{
        left: selectionState.left,
        top: selectionState.top,
        transform: 'translateX(-50%)',
      }}
      role="toolbar"
      aria-label="Highlight selection"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Highlighter size={14} className="mx-1 text-muted-foreground" aria-hidden="true" />
      {MESSAGE_HIGHLIGHT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={cn(
            'h-5 w-5 rounded-full ring-offset-2 transition focus-visible:outline-none focus-visible:ring-2',
            COLOR_BUTTON_CLASSES[color]
          )}
          aria-label={`Highlight ${color}`}
          title={`Highlight ${color}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => applyHighlight(color)}
        />
      ))}
    </div>
  ), document.body);
}
