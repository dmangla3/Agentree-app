import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScrollArea } from '../../@/components/ui/scroll-area';
import { TimelineNodeDispatcher } from './nodes/timeline/TimelineNodeDispatcher';
import type { WorkspaceProjection, ProjectedTimelineItem } from '../domain/workspaceProjection';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { Clock } from 'lucide-react';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import { NodeContextMenu, type NodeContextMenuState } from './NodeContextMenu';

interface TimelineViewProps {
  projection: WorkspaceProjection;
  focusedMessageId: string | null;
  onNodeClick?: (messageId: string) => void;
  filterActive: boolean;
  matchingMessageIds: Set<string>;
  onStopAgent?: (nodeId: string) => void;
  selectedNodeIds?: Set<string>;
  onSelectionChange?: (params: { nodes: any[] }) => void;
  onRequestDeleteMessages?: (messageIds: string[]) => void;
  onAddCommitsToMergePanel?: (messageIds: string[]) => void;
}

const groupItemsByDay = (items: any[]) => {
  const grouped: Record<string, any[]> = {};
  items.forEach(item => {
    const date = new Date(item.sortTs);
    const dateKey = format(date, 'yyyy-MM-dd');
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(item);
  });
  return grouped;
};

const getTimelineItemSelectionId = (projection: WorkspaceProjection, item: ProjectedTimelineItem): string | null => {
  if (item.type !== 'entity') return null;
  const entity = projection.entitiesById.get(item.entityId);
  if (!entity) return null;
  return entity.messageId || entity.summary?.id || null;
};

type TimelineGroupedBlock =
  | { key: string; turnGroupId: string; items: ProjectedTimelineItem[] }
  | { key: string; turnGroupId: null; items: [ProjectedTimelineItem] };

const getTimelineItemTurnGroupId = (
  projection: WorkspaceProjection,
  item: ProjectedTimelineItem
): string | null => {
  if (item.type === 'entity') {
    const entity = projection.entitiesById.get(item.entityId);
    if (!entity) return null;
    return entity.kind === 'summary_block' ? null : entity.turnGroupId || null;
  }
  return null;
};

const groupTimelineItemsByTurn = (
  projection: WorkspaceProjection,
  items: ProjectedTimelineItem[]
): TimelineGroupedBlock[] => {
  const grouped: TimelineGroupedBlock[] = [];

  items.forEach((item, index) => {
    const turnGroupId = getTimelineItemTurnGroupId(projection, item);
    const lastGroup = grouped[grouped.length - 1];

    if (turnGroupId && lastGroup && lastGroup.turnGroupId === turnGroupId) {
      lastGroup.items.push(item);
      return;
    }

    grouped.push({
      key: turnGroupId ? `${turnGroupId}:${index}` : `standalone:${index}:${item.entityId}`,
      turnGroupId,
      items: [item] as [ProjectedTimelineItem],
    });
  });

  return grouped;
};

const getTimelineRowDomId = (item: ProjectedTimelineItem): string =>
  `timeline-row-entity-${item.entityId}`;

const BOTTOM_PIN_THRESHOLD_PX = 96;
const USER_SCROLL_INTENT_WINDOW_MS = 1200;

const isViewportNearBottom = (viewport: HTMLDivElement): boolean => (
  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_PIN_THRESHOLD_PX
);

export const TimelineView = memo(({
  projection,
  focusedMessageId,
  filterActive,
  matchingMessageIds,
  selectedNodeIds = new Set<string>(),
  onSelectionChange,
  onRequestDeleteMessages,
  onAddCommitsToMergePanel,
}: TimelineViewProps) => {
  const [contextMenu, setContextMenu] = useState<NodeContextMenuState | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const lastFocusedScrollTargetRef = useRef<string | null>(null);
  const clearSelectedMessageIds = useWorkspaceStore(state => state.clearSelectedMessageIds);
  const dispatchFocus = useWorkspaceStore(state => state.dispatchFocus);
  const selectedWorkspaceId = useWorkspaceStore(state => state.selectedWorkspaceId);

  const showSelectionControl = selectedNodeIds.size > 1;

  const handleFocus = useCallback((id: string, metadata?: Record<string, unknown>) => {
    clearSelectedMessageIds();
    dispatchFocus({
      messageId: id,
      source: 'timeline',
      metadata,
    });
  }, [clearSelectedMessageIds, dispatchFocus]);

  const handleSelect = useCallback((id: string, multi: boolean) => {
    if (onSelectionChange) {
      const nextSelected = new Set(selectedNodeIds);
      if (multi) {
        if (nextSelected.has(id)) nextSelected.delete(id);
        else nextSelected.add(id);
      } else {
        nextSelected.clear();
        nextSelected.add(id);
      }
      onSelectionChange({
        nodes: Array.from(nextSelected).map(sid => ({
          id: sid,
          type: projection.summaryMap.has(sid)
            ? 'summary_block'
            : projection.entitiesByMessageId.get(sid)?.kind ?? 'assistant_message',
          data: {},
          position: { x: 0, y: 0 }
        }))
      });
    }
  }, [selectedNodeIds, onSelectionChange, projection.entitiesByMessageId, projection.summaryMap]);

  const handleBackgroundClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    clearSelectedMessageIds();
    setContextMenu(null);
  }, [clearSelectedMessageIds]);

  const handleContextMenu = useCallback((id: string, e: React.MouseEvent) => {
    const targetIds = selectedNodeIds.has(id) ? Array.from(selectedNodeIds) : [id];
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetIds,
    });
  }, [selectedNodeIds]);

  const timelineItems = useMemo(() => {
    if (!filterActive) return projection.timelineItems;

    return projection.timelineItems.filter((item) => {
      const entity = projection.entitiesById.get(item.entityId);
      if (!entity) return false;
      if (entity.messageId && matchingMessageIds.has(entity.messageId)) return true;
      if (entity.summary) {
        return matchingMessageIds.has(entity.summary.startMessageId) ||
          matchingMessageIds.has(entity.summary.endMessageId);
      }
      return false;
    });
  }, [
    filterActive,
    matchingMessageIds,
    projection.entitiesById,
    projection.timelineItems,
  ]);

  const groupedByDay = groupItemsByDay(timelineItems);
  const sortedDays = Object.keys(groupedByDay).sort((a, b) => a.localeCompare(b));
  const timelineScrollAnchorFingerprint = useMemo(() => (
    timelineItems.map((item) => `entity:${item.entityId}:${item.sortTs}`).join('|')
  ), [timelineItems]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const handleViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    if (isViewportNearBottom(viewport)) {
      shouldStickToBottomRef.current = true;
      return;
    }

    if (performance.now() <= userScrollIntentUntilRef.current) {
      shouldStickToBottomRef.current = false;
    }
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.addEventListener('wheel', markUserScrollIntent, { passive: true });
    viewport.addEventListener('touchstart', markUserScrollIntent, { passive: true });
    viewport.addEventListener('pointerdown', markUserScrollIntent);
    viewport.addEventListener('keydown', markUserScrollIntent);

    return () => {
      viewport.removeEventListener('wheel', markUserScrollIntent);
      viewport.removeEventListener('touchstart', markUserScrollIntent);
      viewport.removeEventListener('pointerdown', markUserScrollIntent);
      viewport.removeEventListener('keydown', markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    userScrollIntentUntilRef.current = 0;
    lastFocusedScrollTargetRef.current = null;
  }, [selectedWorkspaceId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) return;

    const scrollToBottom = () => {
      if (!shouldStickToBottomRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    };

    scrollToBottom();
    const rafId = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(rafId);
  }, [timelineScrollAnchorFingerprint, selectedWorkspaceId]);

  useEffect(() => {
    if (!focusedMessageId) return;

    const focusedEntity = projection.entitiesByMessageId.get(focusedMessageId);
    const targetDomId = (() => {
      if (focusedEntity) {
        return getTimelineRowDomId({ type: 'entity', entityId: focusedEntity.entityId, sortTs: focusedEntity.sortTs });
      }
      return null;
    })();

    if (!targetDomId) return;
    if (lastFocusedScrollTargetRef.current === targetDomId) return;
    lastFocusedScrollTargetRef.current = targetDomId;
    shouldStickToBottomRef.current = false;

    const rafId = window.requestAnimationFrame(() => {
      const element = document.getElementById(targetDomId);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [focusedMessageId, projection.entitiesByMessageId, timelineItems.length]);

  return (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-950 overflow-hidden relative">
      <ScrollArea
        className="flex-1"
        viewportRef={viewportRef}
        onViewportScroll={handleViewportScroll}
      >
        <div className="flex flex-col pb-24 max-w-xl w-full mx-auto px-4 md:px-6 min-w-0" onClick={handleBackgroundClick}>
          {sortedDays.map((dateKey) => (
            <div key={dateKey} className="flex flex-col min-w-0">
              <div className="sticky top-0 z-20 py-3 bg-slate-50/90 dark:bg-slate-950/90 backdrop-blur-sm">
                <div className="flex items-center gap-2">
                  <Clock size={14} className="text-slate-400" />
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                    {isToday(parseISO(dateKey)) ? 'Today' : isYesterday(parseISO(dateKey)) ? 'Yesterday' : format(parseISO(dateKey), 'EEEE, MMMM do')}
                  </span>
                </div>
              </div>

              <div className="flex flex-col border-l border-slate-200 dark:border-slate-800 ml-1.5 pl-3 min-w-0">
                {groupTimelineItemsByTurn(projection, groupedByDay[dateKey]).map((group, groupIndex, groups) => (
                  <div
                    key={group.key}
                    className={group.turnGroupId ? "flex flex-col gap-0 mb-4 min-w-0" : "flex flex-col mb-4 min-w-0"}
                    style={{ marginBottom: groupIndex === groups.length - 1 ? 0 : undefined }}
                  >
                    {group.items.map((item) => {
                      const selectionId = getTimelineItemSelectionId(projection, item);
                      const id = item.entityId;
                      return (
                        <TimelineNodeDispatcher
                          key={id}
                          rowId={getTimelineRowDomId(item)}
                          entityId={item.entityId}
                          projection={projection}
                          isSelected={selectionId ? selectedNodeIds.has(selectionId) : false}
                          showSelectionControl={showSelectionControl}
                          onFocus={handleFocus}
                          onSelect={handleSelect}
                          onContextMenu={handleContextMenu}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      <NodeContextMenu
        contextMenu={contextMenu}
        projection={projection}
        onClose={() => setContextMenu(null)}
        onDeleteMessages={onRequestDeleteMessages}
        onAddCommitsToMergePanel={onAddCommitsToMergePanel}
      />
    </div>
  );
});

TimelineView.displayName = 'TimelineView';
