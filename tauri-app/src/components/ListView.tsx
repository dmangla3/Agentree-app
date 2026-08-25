import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScrollArea } from '../../@/components/ui/scroll-area';
import { ListNodeDispatcher } from './nodes/list/ListNodeDispatcher';
import type { WorkspaceProjection, ProjectedListItem } from '../domain/workspaceProjection';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { Clock } from 'lucide-react';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import { NodeContextMenu, type NodeContextMenuState } from './NodeContextMenu';

interface ListViewProps {
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

const getListItemSelectionId = (projection: WorkspaceProjection, item: ProjectedListItem): string | null => {
  if (item.type !== 'entity') return null;
  const entity = projection.entitiesById.get(item.entityId);
  if (!entity) return null;
  return entity.messageId || entity.summary?.id || null;
};

type ListGroupedBlock =
  | { key: string; turnGroupId: string; items: ProjectedListItem[] }
  | { key: string; turnGroupId: null; items: [ProjectedListItem] };

const getListItemTurnGroupId = (
  projection: WorkspaceProjection,
  item: ProjectedListItem
): string | null => {
  if (item.type === 'entity') {
    const entity = projection.entitiesById.get(item.entityId);
    if (!entity) return null;
    return entity.kind === 'summary_block' ? null : entity.turnGroupId || null;
  }
  return null;
};

const groupListItemsByTurn = (
  projection: WorkspaceProjection,
  items: ProjectedListItem[]
): ListGroupedBlock[] => {
  const grouped: ListGroupedBlock[] = [];

  items.forEach((item, index) => {
    const turnGroupId = getListItemTurnGroupId(projection, item);
    const lastGroup = grouped[grouped.length - 1];

    if (turnGroupId && lastGroup && lastGroup.turnGroupId === turnGroupId) {
      lastGroup.items.push(item);
      return;
    }

    grouped.push({
      key: turnGroupId ? `${turnGroupId}:${index}` : `standalone:${index}:${item.entityId}`,
      turnGroupId,
      items: [item] as [ProjectedListItem],
    });
  });

  return grouped;
};

const getListRowDomId = (item: ProjectedListItem): string =>
  `list-row-entity-${item.entityId}`;

const BOTTOM_PIN_THRESHOLD_PX = 96;
const USER_SCROLL_INTENT_WINDOW_MS = 1200;

const isViewportNearBottom = (viewport: HTMLDivElement): boolean => (
  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_PIN_THRESHOLD_PX
);

export const ListView = memo(({
  projection,
  focusedMessageId,
  filterActive,
  matchingMessageIds,
  selectedNodeIds = new Set<string>(),
  onSelectionChange,
  onRequestDeleteMessages,
  onAddCommitsToMergePanel,
}: ListViewProps) => {
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
      source: 'list',
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

  const listItems = useMemo(() => {
    if (!filterActive) return projection.listItems;

    return projection.listItems.filter((item) => {
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
    projection.listItems,
  ]);

  const groupedByDay = groupItemsByDay(listItems);
  const sortedDays = Object.keys(groupedByDay).sort((a, b) => a.localeCompare(b));
  const listScrollAnchorFingerprint = useMemo(() => (
    listItems.map((item) => `entity:${item.entityId}:${item.sortTs}`).join('|')
  ), [listItems]);

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
  }, [listScrollAnchorFingerprint, selectedWorkspaceId]);

  useEffect(() => {
    if (!focusedMessageId) return;

    const focusedEntity = projection.entitiesByMessageId.get(focusedMessageId);
    const targetDomId = (() => {
      if (focusedEntity) {
        return getListRowDomId({ type: 'entity', entityId: focusedEntity.entityId, sortTs: focusedEntity.sortTs });
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
  }, [focusedMessageId, projection.entitiesByMessageId, listItems.length]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[linear-gradient(180deg,hsl(var(--app-bg-elevated)/0.62),hsl(var(--app-bg))_22%,hsl(var(--app-bg-muted)/0.56)_100%)] dark:bg-[linear-gradient(180deg,hsl(var(--app-bg-elevated)/0.58),hsl(var(--app-bg))_34%,hsl(var(--background))_100%)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--app-border)/0.16)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--app-border)/0.12)_1px,transparent_1px)] bg-[size:56px_56px] opacity-35 dark:opacity-[0.08]"
      />
      <ScrollArea
        className="relative flex-1"
        viewportRef={viewportRef}
        onViewportScroll={handleViewportScroll}
      >
        <div className="mx-auto flex w-full max-w-[760px] min-w-0 flex-col px-4 pb-24 pt-3 md:px-6" onClick={handleBackgroundClick}>
          {sortedDays.length === 0 ? (
            <div className="flex min-h-[min(520px,calc(100dvh-12rem))] items-center justify-center">
              <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--app-panel)/0.72)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
                  <Clock size={16} strokeWidth={1.8} />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">No list items</p>
                  <p className="text-xs leading-5 text-muted-foreground">Messages, agent activity, summaries, and commits will appear here as the workspace changes.</p>
                </div>
              </div>
            </div>
          ) : sortedDays.map((dateKey) => (
            <div key={dateKey} className="flex flex-col min-w-0">
              <div className="sticky top-0 z-20 -mx-1 px-1 py-3">
                <div className="flex items-center gap-2 rounded-md border border-[hsl(var(--app-border)/0.46)] bg-[hsl(var(--app-bg)/0.86)] px-2.5 py-2 shadow-[0_10px_28px_-24px_hsl(var(--foreground)/0.42),inset_0_1px_0_hsl(var(--foreground)/0.035)] backdrop-blur-md dark:bg-[hsl(var(--app-bg-elevated)/0.82)]">
                  <Clock size={14} strokeWidth={1.8} className="text-muted-foreground" />
                  <span className="text-[11px] font-semibold uppercase leading-none tracking-[0.16em] text-muted-foreground">
                    {isToday(parseISO(dateKey)) ? 'Today' : isYesterday(parseISO(dateKey)) ? 'Yesterday' : format(parseISO(dateKey), 'EEEE, MMMM do')}
                  </span>
                </div>
              </div>

              <div className="ml-2 flex min-w-0 flex-col border-l border-[hsl(var(--app-border)/0.54)] pl-4 dark:border-white/[0.08]">
                {groupListItemsByTurn(projection, groupedByDay[dateKey]).map((group, groupIndex, groups) => (
                  <div
                    key={group.key}
                    className={group.turnGroupId ? "relative mb-4 flex min-w-0 flex-col gap-1.5" : "relative mb-4 flex min-w-0 flex-col"}
                    style={{ marginBottom: groupIndex === groups.length - 1 ? 0 : undefined }}
                  >
                    <span className="absolute -left-[21px] top-3 h-2.5 w-2.5 rounded-full border border-[hsl(var(--app-bg))] bg-[hsl(var(--app-border))] shadow-[0_0_0_3px_hsl(var(--app-bg)/0.88)] dark:border-[hsl(var(--app-bg))] dark:bg-white/20 dark:shadow-[0_0_0_3px_hsl(var(--app-bg)/0.92)]" />
                    {group.items.map((item) => {
                      const selectionId = getListItemSelectionId(projection, item);
                      const id = item.entityId;
                      return (
                        <ListNodeDispatcher
                          key={id}
                          rowId={getListRowDomId(item)}
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

ListView.displayName = 'ListView';
