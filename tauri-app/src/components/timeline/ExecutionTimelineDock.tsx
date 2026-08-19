import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Bot, ChevronDown, GitCommitHorizontal, User, X } from 'lucide-react';
import type { WorkspaceProjection } from '../../domain/workspaceProjection';
import {
  getExecutionTimelineRelations,
  getLatestTimelineWindow,
  packExecutionTimelineItems,
  type ExecutionTimelineItem,
  type ExecutionTimelineModel,
} from '../../lib/executionTimelineModel';
import {
  buildExecutionTimelineDisplayScale,
  buildTimelineRulerTicks,
  formatIdleGapLabel,
  getTimelineDisplayFraction,
  scaleTimelineMs,
  type ExecutionTimelineDisplayScale,
  type ExecutionTimelinePreferredRulerTick,
  unscaleTimelineDisplayMs,
} from '../../lib/executionTimelineDisplayScale';
import { cn } from '../../lib/utils';
import { ExecutionTimelineHoverCard } from './ExecutionTimelineHoverCard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../@/components/ui/dropdown-menu';

type TimelineWindow = { startMs: number; endMs: number };
type PackedExecutionTimelineItem = ExecutionTimelineItem & { lane: number };
type TimelineRangePresetId = 'all' | '3h' | '6h' | '1d' | '3d';
type TimelineThreadScope = 'all' | 'current';

export type ExecutionTimelineDockProps = {
  projection: WorkspaceProjection;
  model: ExecutionTimelineModel;
  focusedMessageId: string | null;
  selectedNodeIds: Set<string>;
  currentThreadRootId?: string | null;
  threadRootIdByMessageId?: Map<string, string>;
  onFocusMessage: (messageId: string) => void;
  onSelectMessage: (messageId: string, multi: boolean) => void;
  onContextMenuMessage: (messageId: string, event: React.MouseEvent) => void;
  onClose?: () => void;
};

const LANE_HEIGHT = 34;
const LANE_TOP = 52;
const BAR_HEIGHT = 28;
const MARKER_SIZE = 24;
const DETAIL_PADDING_X = 14;
const MIN_BAR_WIDTH_PX = 28;
const VIEWPORT_OVERSCAN_RATIO = 0.25;
const MAX_VIEWPORT_DISPLAY_FRACTION = 0.3;
const DEFAULT_VIEWPORT_DISPLAY_FRACTION = 0.2;
const VIEWPORT_FRACTION_STORAGE_PREFIX = 'agentree.executionTimeline.viewportDisplayFraction';
const RANGE_PRESETS: Array<{ id: TimelineRangePresetId; label: string; durationMs: number | null }> = [
  { id: 'all', label: 'All time', durationMs: null },
  { id: '3h', label: 'Last 3 hours', durationMs: 3 * 60 * 60 * 1000 },
  { id: '6h', label: 'Last 6 hours', durationMs: 6 * 60 * 60 * 1000 },
  { id: '1d', label: 'Last 1 day', durationMs: 24 * 60 * 60 * 1000 },
  { id: '3d', label: 'Last 3 days', durationMs: 3 * 24 * 60 * 60 * 1000 },
];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const readStoredViewportDisplayFraction = (key: string): number | null => {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 0.01, MAX_VIEWPORT_DISPLAY_FRACTION) : null;
  } catch {
    return null;
  }
};

const writeStoredViewportDisplayFraction = (key: string, value: number) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(clamp(value, 0.01, MAX_VIEWPORT_DISPLAY_FRACTION)));
  } catch {
    // Storage can be unavailable in private contexts or tests.
  }
};

const itemTimeMs = (item: ExecutionTimelineItem): number => (
  item.kind === 'agent_run' ? item.startMs : item.timeMs
);

const itemEndMs = (item: ExecutionTimelineItem): number => (
  item.kind === 'agent_run' ? item.endMs : item.timeMs
);

const getItemMessageId = (item: ExecutionTimelineItem): string => item.messageId;

const isItemInRange = (item: ExecutionTimelineItem, startMs: number, endMs: number): boolean => (
  itemEndMs(item) >= startMs && itemTimeMs(item) <= endMs
);

const formatClock = (timeMs: number): string => (
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timeMs))
);

const formatDuration = (durationMs: number): string => {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const getVisualLane = (lane: number, laneCount: number): number => Math.max(0, laneCount - 1 - lane);

const viewportFromDisplayWindow = (
  displayScale: ExecutionTimelineDisplayScale,
  model: ExecutionTimelineModel,
  startDisplayMs: number,
  endDisplayMs: number,
): TimelineWindow => {
  const requestedSpan = Math.max(1, endDisplayMs - startDisplayMs);
  const maxDisplaySpanMs = Math.max(1, displayScale.displaySpanMs * MAX_VIEWPORT_DISPLAY_FRACTION);
  const span = clamp(requestedSpan, 1, Math.min(displayScale.displaySpanMs, maxDisplaySpanMs));
  const start = clamp(startDisplayMs, 0, displayScale.displaySpanMs - span);
  const end = start + span;
  const startMs = clamp(unscaleTimelineDisplayMs(displayScale, start), model.minMs, model.maxMs);
  const endMs = clamp(unscaleTimelineDisplayMs(displayScale, end), startMs + 1, model.maxMs);
  return { startMs, endMs };
};

export const ExecutionTimelineDock = memo(({
  projection,
  model,
  focusedMessageId,
  selectedNodeIds,
  currentThreadRootId = null,
  threadRootIdByMessageId = projection.threadRootIdByMessageId,
  onFocusMessage,
  onSelectMessage,
  onContextMenuMessage,
  onClose,
}: ExecutionTimelineDockProps) => {
  const detailRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const dragModeRef = useRef<'detail-pan' | 'brush-pan' | 'brush-left' | 'brush-right' | null>(null);
  const dragStartRef = useRef<{ clientX: number; viewport: TimelineWindow } | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [threadScope, setThreadScope] = useState<TimelineThreadScope>('all');
  const [selectedRangePresetId, setSelectedRangePresetId] = useState<TimelineRangePresetId>('all');
  const [viewport, setViewport] = useState<TimelineWindow>(() => getLatestTimelineWindow(model));
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time', []);
  const workspaceId = useMemo(() => (
    projection.originMessage?.workspaceId ?? projection.messages[0]?.workspaceId ?? 'global'
  ), [projection.messages, projection.originMessage?.workspaceId]);
  const viewportDisplayFractionStorageKey = useMemo(
    () => `${VIEWPORT_FRACTION_STORAGE_PREFIX}:${workspaceId}`,
    [workspaceId],
  );
  const rememberedViewportDisplayFractionRef = useRef<number | null>(
    readStoredViewportDisplayFraction(viewportDisplayFractionStorageKey),
  );

  const baseItems = useMemo<ExecutionTimelineItem[]>(
    () => [...model.bars, ...model.markers],
    [model.bars, model.markers],
  );
  const threadFilteredItems = useMemo(() => {
    if (threadScope === 'all' || !currentThreadRootId) return baseItems;
    return baseItems.filter((item) => {
      const threadRootId = threadRootIdByMessageId.get(item.messageId);
      return threadRootId === currentThreadRootId;
    });
  }, [baseItems, currentThreadRootId, threadRootIdByMessageId, threadScope]);
  const threadFilteredModel = useMemo(() => packExecutionTimelineItems(threadFilteredItems), [threadFilteredItems]);
  const selectedRangePreset = RANGE_PRESETS.find((preset) => preset.id === selectedRangePresetId) ?? RANGE_PRESETS[0];
  const rangeDomain = useMemo(() => {
    const endMs = threadFilteredModel.maxMs;
    if (!selectedRangePreset.durationMs) {
      return { startMs: threadFilteredModel.minMs, endMs };
    }
    return {
      startMs: Math.max(threadFilteredModel.minMs, endMs - selectedRangePreset.durationMs),
      endMs,
    };
  }, [selectedRangePreset.durationMs, threadFilteredModel.maxMs, threadFilteredModel.minMs]);
  const rangeFilteredItems = useMemo(() => (
    threadFilteredItems.filter((item) => isItemInRange(item, rangeDomain.startMs, rangeDomain.endMs))
  ), [rangeDomain.endMs, rangeDomain.startMs, threadFilteredItems]);
  const visibleModel = useMemo(() => {
    const packed = packExecutionTimelineItems(rangeFilteredItems);
    if (selectedRangePreset.id === 'all') return packed;
    return {
      ...packed,
      minMs: rangeDomain.startMs,
      maxMs: Math.max(rangeDomain.endMs, rangeDomain.startMs + 1),
    };
  }, [rangeDomain.endMs, rangeDomain.startMs, rangeFilteredItems, selectedRangePreset.id]);
  const displayScale = useMemo(
    () => buildExecutionTimelineDisplayScale(visibleModel),
    [visibleModel],
  );
  const selectedRangeLabel = selectedRangePreset.label;

  useEffect(() => {
    rememberedViewportDisplayFractionRef.current = readStoredViewportDisplayFraction(viewportDisplayFractionStorageKey);
  }, [viewportDisplayFractionStorageKey]);

  useEffect(() => {
    setViewport((current) => {
      const rememberedFraction = rememberedViewportDisplayFractionRef.current ?? DEFAULT_VIEWPORT_DISPLAY_FRACTION;
      const nextSpanFraction = clamp(rememberedFraction, 0.01, MAX_VIEWPORT_DISPLAY_FRACTION);
      const nextDisplaySpanMs = Math.max(1, displayScale.displaySpanMs * nextSpanFraction);
      const currentStartDisplayMs = scaleTimelineMs(displayScale, current.startMs);
      const currentEndDisplayMs = scaleTimelineMs(displayScale, current.endMs);
      const currentCenterDisplayMs = (currentStartDisplayMs + currentEndDisplayMs) / 2;
      const shouldAnchorToEnd = (
        current.endMs >= visibleModel.maxMs ||
        current.startMs < visibleModel.minMs ||
        currentCenterDisplayMs < 0 ||
        currentCenterDisplayMs > displayScale.displaySpanMs
      );
      const centerDisplayMs = shouldAnchorToEnd
        ? displayScale.displaySpanMs - nextDisplaySpanMs / 2
        : currentCenterDisplayMs;
      return viewportFromDisplayWindow(
        displayScale,
        visibleModel,
        centerDisplayMs - nextDisplaySpanMs / 2,
        centerDisplayMs + nextDisplaySpanMs / 2,
      );
    });
  }, [displayScale, visibleModel]);

  useEffect(() => {
    if (!currentThreadRootId && threadScope === 'current') setThreadScope('all');
  }, [currentThreadRootId, threadScope]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const mode = dragModeRef.current;
      if (!mode) return;

      const dragStart = dragStartRef.current;
      if (!dragStart) return;
      const original = dragStart.viewport;
      const originalStartDisplayMs = scaleTimelineMs(displayScale, original.startMs);
      const originalEndDisplayMs = scaleTimelineMs(displayScale, original.endMs);

      if (mode === 'detail-pan') {
        const rect = detailRef.current?.getBoundingClientRect();
        if (!rect) return;
        const originalDisplaySpanMs = Math.max(1, originalEndDisplayMs - originalStartDisplayMs);
        const deltaDisplayMs = ((event.clientX - dragStart.clientX) / Math.max(1, rect.width)) * originalDisplaySpanMs;
        setViewport(viewportFromDisplayWindow(
          displayScale,
          visibleModel,
          originalStartDisplayMs - deltaDisplayMs,
          originalEndDisplayMs - deltaDisplayMs,
        ));
        return;
      }

      const rect = minimapRef.current?.getBoundingClientRect();
      if (!rect) return;

      const domainSpan = Math.max(1, displayScale.displaySpanMs);
      const deltaDisplayMs = ((event.clientX - dragStart.clientX) / Math.max(1, rect.width)) * domainSpan;

      if (mode === 'brush-pan') {
        setViewport(viewportFromDisplayWindow(
          displayScale,
          visibleModel,
          originalStartDisplayMs + deltaDisplayMs,
          originalEndDisplayMs + deltaDisplayMs,
        ));
        return;
      }

      if (mode === 'brush-left') {
        setViewport(viewportFromDisplayWindow(
          displayScale,
          visibleModel,
          Math.min(originalEndDisplayMs - 1, originalStartDisplayMs + deltaDisplayMs),
          originalEndDisplayMs,
        ));
        return;
      }

      setViewport(viewportFromDisplayWindow(
        displayScale,
        visibleModel,
        originalStartDisplayMs,
        Math.max(originalStartDisplayMs + 1, originalEndDisplayMs + deltaDisplayMs),
      ));
    };

    const handlePointerUp = () => {
      dragModeRef.current = null;
      dragStartRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [displayScale, visibleModel, viewport]);

  const allItems = useMemo<PackedExecutionTimelineItem[]>(
    () => [...visibleModel.bars, ...visibleModel.markers].sort((left, right) => itemTimeMs(left) - itemTimeMs(right)),
    [visibleModel.bars, visibleModel.markers],
  );
  const relationItems = useMemo(() => (
    hoveredMessageId ? getExecutionTimelineRelations(allItems, hoveredMessageId) : { incoming: [], outgoing: [] }
  ), [allItems, hoveredMessageId]);
  const relatedMessageIds = useMemo(() => new Set([
    ...relationItems.incoming.map(getItemMessageId),
    ...relationItems.outgoing.map(getItemMessageId),
  ]), [relationItems]);
  const detailHeight = Math.max(132, visibleModel.laneCount * LANE_HEIGHT + 64);
  const viewportDisplayStartMs = scaleTimelineMs(displayScale, viewport.startMs);
  const viewportDisplayEndMs = scaleTimelineMs(displayScale, viewport.endMs);
  const viewportDisplaySpanMs = Math.max(1, viewportDisplayEndMs - viewportDisplayStartMs);
  const getViewportDisplayPct = useCallback((timeMs: number) => (
    ((scaleTimelineMs(displayScale, timeMs) - viewportDisplayStartMs) / viewportDisplaySpanMs) * 100
  ), [displayScale, viewportDisplaySpanMs, viewportDisplayStartMs]);
  const relationConnectors = useMemo(() => {
    if (!hoveredMessageId) return [];
    const hoveredItem = allItems.find((item) => item.messageId === hoveredMessageId);
    if (!hoveredItem) return [];

    const pointForItem = (item: ExecutionTimelineItem) => {
      const timeMs = item.kind === 'agent_run' ? (item.startMs + item.endMs) / 2 : item.timeMs;
      const lane = (item as { lane?: number }).lane ?? 0;
      return {
        x: clamp(getViewportDisplayPct(timeMs), 0, 100),
        y: LANE_TOP + getVisualLane(lane, visibleModel.laneCount) * LANE_HEIGHT + LANE_HEIGHT / 2,
      };
    };
    const hoveredPoint = pointForItem(hoveredItem);
    return [
      ...relationItems.incoming.map((item) => ({
        id: `${item.id}->${hoveredItem.id}`,
        from: pointForItem(item),
        to: hoveredPoint,
      })),
      ...relationItems.outgoing.map((item) => ({
        id: `${hoveredItem.id}->${item.id}`,
        from: hoveredPoint,
        to: pointForItem(item),
      })),
    ];
  }, [allItems, getViewportDisplayPct, hoveredMessageId, relationItems, visibleModel.laneCount]);
  const visibleStartMs = viewport.startMs - (viewport.endMs - viewport.startMs) * VIEWPORT_OVERSCAN_RATIO;
  const visibleEndMs = viewport.endMs + (viewport.endMs - viewport.startMs) * VIEWPORT_OVERSCAN_RATIO;
  const visibleBars = visibleModel.bars.filter((bar) => bar.endMs >= visibleStartMs && bar.startMs <= visibleEndMs);
  const visibleMarkers = visibleModel.markers.filter((marker) => marker.timeMs >= visibleStartMs && marker.timeMs <= visibleEndMs);
  const brushLeftPct = clamp(getTimelineDisplayFraction(viewport.startMs, displayScale) * 100, 0, 100);
  const brushRightPct = clamp(getTimelineDisplayFraction(viewport.endMs, displayScale) * 100, brushLeftPct, 100);
  const brushSpanPct = Math.max(0, brushRightPct - brushLeftPct);
  const preferredRulerTicks = useMemo<ExecutionTimelinePreferredRulerTick[]>(() => [
    ...visibleModel.bars.map((bar) => ({
      timeMs: bar.startMs,
      priority: 4,
      label: formatClock(bar.startMs),
      major: true,
    })),
    ...visibleModel.markers.map((marker) => ({
      timeMs: marker.timeMs,
      priority: marker.kind === 'user_message' ? 3 : 2,
      label: formatClock(marker.timeMs),
      major: true,
    })),
    ...displayScale.segments
      .filter((segment) => segment.kind === 'break')
      .flatMap((segment) => [
        {
          timeMs: segment.startMs,
          priority: 1,
          label: formatClock(segment.startMs),
          major: false,
        },
        {
          timeMs: segment.endMs,
          priority: 1,
          label: formatClock(segment.endMs),
          major: false,
        },
      ]),
  ], [displayScale.segments, visibleModel.bars, visibleModel.markers]);
  const rulerTargetTickCount = useMemo(() => {
    const viewportRealSpanMs = Math.max(1, viewport.endMs - viewport.startMs);
    if (viewportRealSpanMs <= 15 * 60 * 1000) return 10;
    if (viewportRealSpanMs <= 60 * 60 * 1000) return 9;
    if (viewportRealSpanMs <= 6 * 60 * 60 * 1000) return 8;
    if (viewportRealSpanMs <= 24 * 60 * 60 * 1000) return 6;
    return 5;
  }, [viewport.endMs, viewport.startMs]);
  const rulerTicks = useMemo(() => buildTimelineRulerTicks(displayScale, rulerTargetTickCount, {
    minDisplayGapFraction: 0.075,
    preferredTicks: preferredRulerTicks,
    viewportStartMs: viewport.startMs,
    viewportEndMs: viewport.endMs,
  }), [
    displayScale,
    preferredRulerTicks,
    rulerTargetTickCount,
    viewport.endMs,
    viewport.startMs,
  ]);

  useEffect(() => {
    if (!Number.isFinite(brushSpanPct) || brushSpanPct <= 0) return;
    const nextFraction = clamp(brushSpanPct / 100, 0.01, MAX_VIEWPORT_DISPLAY_FRACTION);
    rememberedViewportDisplayFractionRef.current = nextFraction;
    writeStoredViewportDisplayFraction(viewportDisplayFractionStorageKey, nextFraction);
  }, [brushSpanPct, viewportDisplayFractionStorageKey]);

  const startBrushDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    mode: 'brush-pan' | 'brush-left' | 'brush-right',
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragModeRef.current = mode;
    dragStartRef.current = {
      clientX: event.clientX,
      viewport,
    };
  }, [viewport]);

  const startDetailDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    event.preventDefault();
    dragModeRef.current = 'detail-pan';
    dragStartRef.current = {
      clientX: event.clientX,
      viewport,
    };
  }, [viewport]);

  const handleMinimapPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const rect = minimapRef.current?.getBoundingClientRect();
    if (!rect) return;

    const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const centerDisplayMs = ratio * displayScale.displaySpanMs;
    const displaySpanMs = Math.max(1, viewportDisplayEndMs - viewportDisplayStartMs);
    setViewport(viewportFromDisplayWindow(
      displayScale,
      visibleModel,
      centerDisplayMs - displaySpanMs / 2,
      centerDisplayMs + displaySpanMs / 2,
    ));
  }, [displayScale, visibleModel, viewportDisplayEndMs, viewportDisplayStartMs]);

  const handleItemClick = useCallback((item: ExecutionTimelineItem, event: React.MouseEvent) => {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      onSelectMessage(item.messageId, true);
      return;
    }
    onFocusMessage(item.messageId);
  }, [onFocusMessage, onSelectMessage]);

  const handleItemContextMenu = useCallback((item: ExecutionTimelineItem, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenuMessage(item.messageId, event);
  }, [onContextMenuMessage]);

  return (
    <section
      className="w-full overflow-hidden rounded-lg border border-[hsl(var(--app-border)/0.76)] bg-[hsl(var(--app-panel)/0.96)] shadow-[0_24px_70px_-34px_hsl(var(--foreground)/0.52),inset_0_1px_0_hsl(var(--background)/0.16)] backdrop-blur-xl"
      aria-label="Execution timeline"
    >
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[hsl(var(--app-border)/0.62)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.64)] bg-[hsl(var(--app-bg-muted)/0.65)] text-[hsl(var(--app-accent))]">
            <Bot className="h-3.5 w-3.5" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-none text-foreground">Execution timeline</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-medium text-muted-foreground">
              <span>{visibleModel.bars.length} {visibleModel.bars.length === 1 ? 'run' : 'runs'}</span>
              <span>{visibleModel.markers.filter((marker) => marker.kind === 'user_message').length} prompts</span>
              <span>{visibleModel.markers.filter((marker) => marker.kind === 'commit').length} {visibleModel.markers.filter((marker) => marker.kind === 'commit').length === 1 ? 'commit' : 'commits'}</span>
              <span className="hidden sm:inline">{timezone}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 max-w-44 items-center gap-1.5 rounded-md border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.72)] px-2.5 text-xs font-medium text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] transition-[background-color,border-color,transform] hover:border-[hsl(var(--app-border-strong)/0.75)] hover:bg-[hsl(var(--app-accent-soft)/0.52)] active:scale-[0.98]"
                aria-label={`Timeline range: ${selectedRangeLabel}`}
              >
                <span className="min-w-0 truncate">{selectedRangeLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {RANGE_PRESETS.map((preset) => (
                <DropdownMenuItem
                  key={preset.id}
                  onSelect={() => setSelectedRangePresetId(preset.id)}
                  className={cn(
                    "text-xs",
                    selectedRangePresetId === preset.id && "bg-[hsl(var(--app-accent-soft)/0.55)] text-foreground",
                  )}
                >
                  {preset.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div
            className="flex h-8 items-center rounded-md border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.72)] p-0.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]"
            role="group"
            aria-label="Timeline thread scope"
          >
            {(['all', 'current'] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => setThreadScope(scope)}
                disabled={scope === 'current' && !currentThreadRootId}
                className={cn(
                  "h-7 rounded-[5px] px-2.5 text-xs font-medium transition-[background-color,color,box-shadow]",
                  threadScope === scope
                    ? "bg-[hsl(var(--app-bg))] text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                  scope === 'current' && !currentThreadRootId && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
                )}
                aria-pressed={threadScope === scope}
              >
                {scope === 'all' ? 'All threads' : 'This thread'}
              </button>
            ))}
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--app-bg-muted)/0.7)] hover:text-foreground"
              aria-label="Close execution timeline"
              title="Close execution timeline"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {allItems.length === 0 ? (
        <div className="flex h-40 items-center justify-center px-4 text-sm text-muted-foreground">
          No execution timing available
        </div>
      ) : (
        <div className="px-3 pb-3 pt-2">
          <div
            ref={detailRef}
            data-testid="execution-timeline-detail"
            className="relative cursor-grab overflow-hidden rounded-md border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg)/0.88)] active:cursor-grabbing"
            style={{ height: detailHeight }}
            onPointerDown={startDetailDrag}
          >
            <div
              data-testid="execution-timeline-ruler"
              className="pointer-events-none absolute inset-x-0 top-0 z-20 h-7 border-b border-[hsl(var(--app-border)/0.46)] bg-[hsl(var(--app-panel)/0.78)]"
            >
              {rulerTicks.map((tick) => {
                const leftPct = getViewportDisplayPct(tick.timeMs);
                if (leftPct < -2 || leftPct > 102) return null;
                return (
                  <div
                    key={`${tick.timeMs}:${tick.label}`}
                    data-testid="execution-timeline-ruler-tick"
                    className="absolute top-0 h-full border-l border-[hsl(var(--app-border-strong)/0.5)]"
                    style={{ left: `${clamp(leftPct, 0, 100)}%` }}
                  >
                    <span className="absolute left-1 top-1 text-[10px] font-medium tabular-nums text-muted-foreground">
                      {tick.label}
                    </span>
                  </div>
                );
              })}
            </div>
            {displayScale.segments.filter((segment) => segment.kind === 'break').map((segment) => {
              const leftPct = getViewportDisplayPct(segment.startMs);
              const rightPct = getViewportDisplayPct(segment.endMs);
              if (rightPct < 0 || leftPct > 100) return null;
              const widthPct = Math.max(1.4, Math.min(100, rightPct) - Math.max(0, leftPct));
              return (
                <div
                  key={`detail-break:${segment.startMs}:${segment.endMs}`}
                  data-testid="execution-timeline-break"
                  className="pointer-events-none absolute bottom-0 top-7 z-[1] border-x border-[hsl(var(--app-warning)/0.3)] bg-[repeating-linear-gradient(135deg,hsl(var(--app-warning)/0.13)_0,hsl(var(--app-warning)/0.13)_4px,transparent_4px,transparent_8px)]"
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={formatIdleGapLabel(segment.endMs - segment.startMs)}
                >
                  <span className="absolute left-1/2 top-8 -translate-x-1/2 whitespace-nowrap rounded-full border border-[hsl(var(--app-warning)/0.28)] bg-[hsl(var(--app-panel)/0.9)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm">
                    {formatIdleGapLabel(segment.endMs - segment.startMs)}
                  </span>
                </div>
              );
            })}
            <div
              data-testid="execution-timeline-viewport"
              data-start-ms={Math.round(viewport.startMs)}
              data-end-ms={Math.round(viewport.endMs)}
              className="pointer-events-none absolute left-2 top-8 z-10 rounded bg-[hsl(var(--app-panel)/0.86)] px-2 py-1 text-[10px] font-medium tabular-nums text-muted-foreground"
            >
              {formatClock(viewport.startMs)} - {formatClock(viewport.endMs)}
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-7 bg-[linear-gradient(to_right,hsl(var(--app-border)/0.18)_1px,transparent_1px)] bg-[length:80px_100%]" />
            {Array.from({ length: visibleModel.laneCount }).map((_, lane) => (
              <div
                key={lane}
                className="pointer-events-none absolute inset-x-0 border-t border-[hsl(var(--app-border)/0.28)]"
                style={{ top: LANE_TOP + lane * LANE_HEIGHT }}
              />
            ))}

            {relationConnectors.length > 0 ? (
              <svg
                data-testid="execution-timeline-connectors"
                className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
                viewBox={`0 0 100 ${detailHeight}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {relationConnectors.map((connector) => {
                  const midX = (connector.from.x + connector.to.x) / 2;
                  return (
                    <path
                      key={connector.id}
                      d={`M ${connector.from.x} ${connector.from.y} C ${midX} ${connector.from.y}, ${midX} ${connector.to.y}, ${connector.to.x} ${connector.to.y}`}
                      className="fill-none stroke-[hsl(var(--app-accent)/0.46)]"
                      strokeWidth={1.4}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </svg>
            ) : null}

            {visibleBars.map((bar) => {
              const leftPct = getViewportDisplayPct(bar.startMs);
              const rightPct = getViewportDisplayPct(bar.endMs);
              const widthPct = Math.max(0.4, rightPct - leftPct);
              const visualLane = getVisualLane(bar.lane, visibleModel.laneCount);
              const isFocused = focusedMessageId === bar.messageId;
              const isSelected = selectedNodeIds.has(bar.messageId);
              const isHovered = hoveredMessageId === bar.messageId;
              const isRelated = relatedMessageIds.has(bar.messageId);
              return (
                <ExecutionTimelineHoverCard
                  key={bar.id}
                  projection={projection}
                  item={bar}
                  onHoverChange={setHoveredMessageId}
                >
                  <button
                    type="button"
                    aria-label={`Agent run ${bar.label}`}
                    className={cn(
                      "absolute z-20 flex min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-[11px] font-semibold leading-none shadow-sm transition-[opacity,box-shadow,border-color,background-color]",
                      bar.isActive
                        ? "border-indigo-400/80 bg-indigo-500 text-white shadow-[0_12px_28px_-22px_rgba(79,70,229,0.82)]"
                        : "border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.88)] text-foreground",
                      isFocused && "ring-2 ring-indigo-500",
                      isSelected && "ring-2 ring-blue-500",
                      isHovered && "border-[hsl(var(--app-accent))] shadow-[0_14px_30px_-22px_hsl(var(--app-accent)/0.75)]",
                      hoveredMessageId && !isHovered && !isRelated && "opacity-45",
                    )}
                    style={{
                      left: `calc(${leftPct}% + ${DETAIL_PADDING_X}px)`,
                      top: LANE_TOP + visualLane * LANE_HEIGHT + (LANE_HEIGHT - BAR_HEIGHT) / 2,
                      width: `max(${MIN_BAR_WIDTH_PX}px, calc(${widthPct}% - ${DETAIL_PADDING_X * 2}px))`,
                      height: BAR_HEIGHT,
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerEnter={() => setHoveredMessageId(bar.messageId)}
                    onPointerLeave={() => setHoveredMessageId(null)}
                    onClick={(event) => handleItemClick(bar, event)}
                    onContextMenu={(event) => handleItemContextMenu(bar, event)}
                    title={`${bar.label} - ${formatDuration(bar.endMs - bar.startMs)}`}
                  >
                    <Bot className="h-3 w-3 shrink-0" strokeWidth={2} />
                    <span className="min-w-0 truncate">{bar.label}</span>
                  </button>
                </ExecutionTimelineHoverCard>
              );
            })}

            {visibleMarkers.map((marker) => {
              const leftPct = getViewportDisplayPct(marker.timeMs);
              const visualLane = getVisualLane(marker.lane, visibleModel.laneCount);
              const isFocused = focusedMessageId === marker.messageId;
              const isSelected = selectedNodeIds.has(marker.messageId);
              const isHovered = hoveredMessageId === marker.messageId;
              const isRelated = relatedMessageIds.has(marker.messageId);
              const Icon = marker.kind === 'commit' ? GitCommitHorizontal : User;
              return (
                <ExecutionTimelineHoverCard
                  key={marker.id}
                  projection={projection}
                  item={marker}
                  onHoverChange={setHoveredMessageId}
                >
                  <button
                    type="button"
                    aria-label={`${marker.kind === 'commit' ? 'Commit' : 'User message'} ${marker.label}`}
                    className={cn(
                      "absolute z-30 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border bg-[hsl(var(--app-panel))] text-muted-foreground shadow-sm transition-[opacity,box-shadow,border-color,color]",
                      marker.kind === 'commit' && "border-emerald-400/75 text-emerald-700 dark:text-emerald-300",
                      marker.kind === 'user_message' && "border-slate-300/80 text-slate-700 dark:border-slate-700 dark:text-slate-200",
                      isFocused && "ring-2 ring-indigo-500",
                      isSelected && "ring-2 ring-blue-500",
                      isHovered && "border-[hsl(var(--app-accent))] text-[hsl(var(--app-accent))]",
                      hoveredMessageId && !isHovered && !isRelated && "opacity-45",
                    )}
                    style={{
                      left: `calc(${leftPct}% + ${DETAIL_PADDING_X}px)`,
                      top: LANE_TOP + visualLane * LANE_HEIGHT + (LANE_HEIGHT - MARKER_SIZE) / 2,
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerEnter={() => setHoveredMessageId(marker.messageId)}
                    onPointerLeave={() => setHoveredMessageId(null)}
                    onClick={(event) => handleItemClick(marker, event)}
                    onContextMenu={(event) => handleItemContextMenu(marker, event)}
                    title={`${marker.label} - ${formatClock(marker.timeMs)}`}
                  >
                    <Icon className="h-3 w-3" strokeWidth={2.1} />
                  </button>
                </ExecutionTimelineHoverCard>
              );
            })}

            {hoveredMessageId ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center">
                <div className="rounded-full border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.92)] px-2.5 py-1 text-[10px] font-medium text-muted-foreground shadow-sm">
                  {relationItems.incoming.length} parent / {relationItems.outgoing.length} children
                </div>
              </div>
            ) : null}

          </div>

          <div
            ref={minimapRef}
            data-testid="execution-timeline-minimap"
            className="relative mt-2 h-14 overflow-hidden rounded-md border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.48)]"
            onPointerDown={handleMinimapPointerDown}
          >
            <div className="absolute inset-x-2 top-1/2 h-px bg-[hsl(var(--app-border)/0.55)]" />
            {displayScale.segments.filter((segment) => segment.kind === 'break').map((segment) => (
              <div
                key={`minimap-break:${segment.startMs}:${segment.endMs}`}
                className="pointer-events-none absolute inset-y-1 border-x border-[hsl(var(--app-warning)/0.24)] bg-[repeating-linear-gradient(135deg,hsl(var(--app-warning)/0.16)_0,hsl(var(--app-warning)/0.16)_3px,transparent_3px,transparent_6px)]"
                style={{
                  left: `${(segment.displayStartMs / displayScale.displaySpanMs) * 100}%`,
                  width: `${Math.max(1, ((segment.displayEndMs - segment.displayStartMs) / displayScale.displaySpanMs) * 100)}%`,
                }}
              />
            ))}
            {visibleModel.bars.map((bar) => {
              const leftPct = getTimelineDisplayFraction(bar.startMs, displayScale) * 100;
              const rightPct = getTimelineDisplayFraction(bar.endMs, displayScale) * 100;
              const visualLane = getVisualLane(bar.lane, visibleModel.laneCount);
              return (
                <div
                  key={bar.id}
                  className={cn(
                    "absolute h-1.5 rounded-full",
                    bar.isActive ? "bg-indigo-500" : "bg-slate-500/65 dark:bg-slate-300/55",
                  )}
                  style={{
                    left: `${leftPct}%`,
                    top: 13 + (visualLane % 3) * 8,
                    width: `${Math.max(0.4, rightPct - leftPct)}%`,
                  }}
                />
              );
            })}
            {visibleModel.markers.map((marker) => (
              <div
                key={marker.id}
                className={cn(
                  "absolute top-[32px] h-2.5 w-px",
                  marker.kind === 'commit' ? "bg-emerald-500" : "bg-zinc-500",
                )}
                style={{ left: `${getTimelineDisplayFraction(marker.timeMs, displayScale) * 100}%` }}
              />
            ))}
            <div
              data-testid="execution-timeline-brush"
              data-display-start-pct={brushLeftPct.toFixed(4)}
              data-display-end-pct={brushRightPct.toFixed(4)}
              data-display-span-pct={brushSpanPct.toFixed(4)}
              className="absolute top-1 h-12 cursor-grab rounded-md border border-indigo-400/80 bg-indigo-500/10 shadow-[0_0_0_1px_rgba(99,102,241,0.14)_inset] transition-[border-color,background-color,box-shadow] hover:border-indigo-300 hover:bg-indigo-500/15 hover:shadow-[0_0_0_1px_rgba(99,102,241,0.22)_inset,0_10px_22px_-18px_rgba(79,70,229,0.72)] active:cursor-grabbing"
              style={{ left: `${brushLeftPct}%`, right: `${100 - brushRightPct}%` }}
              onPointerDown={(event) => startBrushDrag(event, 'brush-pan')}
            >
              <span
                data-testid="execution-timeline-brush-left-handle"
                className="absolute inset-y-0 left-0 z-10 w-3 cursor-ew-resize rounded-l-md border-l-2 border-indigo-300/95 bg-indigo-500/25 shadow-[6px_0_12px_-10px_rgba(79,70,229,0.95)] transition-[background-color,border-color] hover:border-indigo-200 hover:bg-indigo-500/35"
                onPointerDown={(event) => startBrushDrag(event, 'brush-left')}
              />
              <span
                data-testid="execution-timeline-brush-right-handle"
                className="absolute inset-y-0 right-0 z-10 w-3 cursor-ew-resize rounded-r-md border-r-2 border-indigo-300/95 bg-indigo-500/25 shadow-[-6px_0_12px_-10px_rgba(79,70,229,0.95)] transition-[background-color,border-color] hover:border-indigo-200 hover:bg-indigo-500/35"
                onPointerDown={(event) => startBrushDrag(event, 'brush-right')}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
});

ExecutionTimelineDock.displayName = 'ExecutionTimelineDock';
