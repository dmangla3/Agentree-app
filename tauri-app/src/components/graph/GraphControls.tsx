import { memo, ReactNode, RefObject, SyntheticEvent, TouchEvent, WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../@/components/ui/button';
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from '../../../@/components/ui/hover-card';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '../../../@/components/ui/popover';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '../../../@/components/ui/tooltip';
import { Input } from '../../../@/components/ui/input';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    DropdownMenuCheckboxItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '../../../@/components/ui/dropdown-menu';
import { ScrollArea } from '../../../@/components/ui/scroll-area';

import {
    RefreshCw,
    X,
    Filter,
    GitBranch,
    GitCommitHorizontal,
    CalendarDays,
    Search,
    Settings2,
    Clock3,
    Bot,
    Tags,
    Check,
    LayoutGrid,
    SlidersHorizontal,
    Zap,
    RotateCcw,
    User,
    Leaf,
    Eye,
    Plus,
    ChevronLeft,
    ChevronRight,
    Loader2,
    CheckCircle2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { Insight, Message, Summary } from '../../stores/workspaceStore';
import type { MergeTabRunIndicator } from '../../stores/integrationStore';
import { LayoutMode, LaneStrategy } from '../../hooks/graph/useGraphLayout';
import { AgentOperator, GroupOperator, MessageNodeType, TagOperator, TimePreset } from '../../hooks/graph/useTagFilter';
import { NodeHoverCardContent } from '../NodeHoverCardContent';
import { useWorkspaceProjection } from '../../hooks/useWorkspaceProjection';
import { QUICK_REPLY_KEEP_HOVER_OPEN_EVENT } from '../../lib/quickReply';

interface ThreadHoverProjectionInput {
    messages: Message[];
    summaries: Summary[];
    disabledSummaryIds: Set<string>;
}

function ParallelThreadsIcon({ size = 15, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <path d="M7 4c-2 3-2 5 0 8s2 5 0 8" />
            <path d="M12 4c-2 3-2 5 0 8s2 5 0 8" />
            <path d="M17 4c-2 3-2 5 0 8s2 5 0 8" />
            <circle cx="7" cy="4" r="1" fill="currentColor" stroke="none" />
            <circle cx="12" cy="4" r="1" fill="currentColor" stroke="none" />
            <circle cx="17" cy="4" r="1" fill="currentColor" stroke="none" />
            <circle cx="7" cy="20" r="1" fill="currentColor" stroke="none" />
            <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
            <circle cx="17" cy="20" r="1" fill="currentColor" stroke="none" />
        </svg>
    );
}

function SimpleMergeIcon({ size = 15, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <path d="M7 4v16" />
            <path d="M17 8c-4.2 0-6.3 4-8.4 4" />
            <circle cx="7" cy="4" r="1.75" fill="currentColor" stroke="none" />
            <circle cx="17" cy="8" r="1.75" fill="currentColor" stroke="none" />
            <circle cx="7" cy="12" r="2.15" fill="currentColor" stroke="none" />
            <circle cx="7" cy="20" r="1.75" fill="currentColor" stroke="none" />
        </svg>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ViewMode = 'branch' | 'timeline';
export interface GraphSyncStatusItem {
    key: string;
    label: string;
    source: string;
    cadenceLabel: string;
    dueAt: number | null;
    detail: string;
    enabled: boolean;
    isRefreshing?: boolean;
}

export interface LeafNodeNavigationItem {
    id: string;
    label: string;
    modelLabel: string;
    statusLabel: string;
    statusTone: 'active' | 'success' | 'danger' | 'muted';
    timestampLabel: string;
}

export interface ThreadNavigationItem {
    threadRootId: string;
    label: string;
    turnCount: number;
    commitCount: number;
    baseCommitSha?: string | null;
    updatedLabel: string;
    runningCount: number;
    hidden: boolean;
    done: boolean;
    current: boolean;
    lastUpdatedAt?: number;
    unreadCompletedLeafCount?: number;
    initialPreviewNodeId?: string | null;
    previewNodeIds?: string[];
}

type ThreadListFilter = 'all' | 'active' | 'done';

export interface GraphControlsProps {
    // Refs
    controlsRef?: RefObject<HTMLDivElement>;

    // View mode
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    executionTimelineOpen?: boolean;
    onExecutionTimelineOpenChange?: (open: boolean) => void;
    renderExecutionTimelinePanel?: (onClose: () => void) => ReactNode;

    // Layout settings
    layoutMode: LayoutMode;
    onLayoutModeChange: (mode: LayoutMode) => void;
    laneStrategy: LaneStrategy;
    onLaneStrategyChange: (strategy: LaneStrategy) => void;

    // Filters
    timePreset: TimePreset;
    customTimeFrom: string;
    customTimeTo: string;
    onTimePresetChange: (preset: TimePreset) => void;
    onCustomTimeFromChange: (value: string) => void;
    onCustomTimeToChange: (value: string) => void;
    uniqueAgentIds: string[];
    agentLabelsById: Map<string, string>;
    selectedAgentIds: Set<string>;
    selectedNodeTypes: Set<MessageNodeType>;
    agentOperator: AgentOperator;
    onAgentOperatorChange: (op: AgentOperator) => void;
    onAgentFilterChange: (agentId: string, checked: boolean) => void;
    onNodeTypeFilterChange: (nodeType: MessageNodeType, checked: boolean) => void;
    uniqueTags: string[];
    selectedFilterTags: Set<string>;
    tagOperator: TagOperator;
    onTagOperatorChange: (op: TagOperator) => void;
    groupOperator: GroupOperator;
    onGroupOperatorChange: (op: GroupOperator) => void;
    keepAncestors: boolean;
    keepDescendants: boolean;
    onKeepAncestorsChange: (value: boolean) => void;
    onKeepDescendantsChange: (value: boolean) => void;
    activeFilterCount: number;
    matchingCount: number;
    messageNodeCount: number;
    nodeTypeCounts: Record<MessageNodeType, number>;
    filterButtonText: string;
    onTagFilterChange: (tag: string, checked: boolean) => void;
    onClearTagFilters: () => void;
    onClearAllFilters: () => void;

    // Insights
    insights: Insight[];
    insightsVisible: boolean;
    showInsightsInGraph: boolean;
    onToggleInsightsVisible: () => void;
    onToggleShowInsightsInGraph: () => void;

    // Actions
    threadItems: ThreadNavigationItem[];
    onThreadFocus: (threadRootId: string) => void;
    onThreadDoneChange: (threadRootId: string, done: boolean) => void;
    doneThreadsCollapsed: boolean;
    onDoneThreadsCollapsedChange: (collapsed: boolean) => void;
    leafNodes: LeafNodeNavigationItem[];
    onLeafNodeFocus: (id: string) => void;
    mergeSourceCount: number;
    mergeRunIndicator: MergeTabRunIndicator;
    mergeAttentionNonce: number;
    renderMergePanel?: (onClose: () => void) => ReactNode;
    onResetLayout: () => void;
    isRefreshingGraph: boolean;
    autoRefreshEligible: boolean;
    syncStatusItems: GraphSyncStatusItem[];
    onRefreshSyncItem: (key: string) => void;
}

const formatCountdownLabel = (msRemaining: number | null) => {
    if (msRemaining === null) return 'Idle';
    if (msRemaining <= 0) return 'Due now';

    const totalSeconds = Math.ceil(msRemaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    return `${seconds}s`;
};

const stopNestedScrollPropagation = (event: WheelEvent | TouchEvent) => {
    event.stopPropagation();
};

const formatThreadMetadata = (thread: ThreadNavigationItem) => (
    `${thread.turnCount} ${thread.turnCount === 1 ? 'turn' : 'turns'} · ${thread.commitCount} ${thread.commitCount === 1 ? 'commit' : 'commits'} · ${thread.updatedLabel}`
);

const sortThreadsByRunningThenRecent = (left: ThreadNavigationItem, right: ThreadNavigationItem) => (
    Number(right.runningCount > 0) - Number(left.runningCount > 0) ||
    right.runningCount - left.runningCount ||
    (right.lastUpdatedAt ?? 0) - (left.lastUpdatedAt ?? 0) ||
    left.threadRootId.localeCompare(right.threadRootId)
);

const sortThreadsByRecent = (left: ThreadNavigationItem, right: ThreadNavigationItem) => (
    (right.lastUpdatedAt ?? 0) - (left.lastUpdatedAt ?? 0) ||
    left.threadRootId.localeCompare(right.threadRootId)
);

const stopThreadHoverCardControlEvent = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
};

const stopThreadHoverCardPropagation = (event: SyntheticEvent) => {
    event.stopPropagation();
};

function ThreadUnreadBadge({
    count,
    className,
}: {
    count: number;
    className?: string;
}) {
    if (count <= 0) return null;
    const label = `${count} completed leaf ${count === 1 ? 'node' : 'nodes'} since last visit`;
    const displayCount = count > 99 ? '99+' : String(count);

    return (
        <span
            aria-label={label}
            className={cn(
                "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[hsl(var(--background)/0.88)] bg-[hsl(var(--app-accent)/0.94)] px-1.5 font-mono text-[9px] font-bold leading-none text-white shadow-[0_7px_16px_-12px_hsl(var(--app-accent)/0.95),inset_0_1px_0_rgba(255,255,255,0.22)] ring-1 ring-white/25 tabular-nums dark:border-[hsl(var(--app-panel-strong)/0.92)] dark:ring-white/10",
                className,
            )}
        >
            {displayCount}
        </span>
    );
}

interface ThreadNodeHoverCardProps {
    thread: ThreadNavigationItem;
    projectionInput?: ThreadHoverProjectionInput;
    side: 'right' | 'bottom';
    children: ReactNode;
}

interface ThreadNodeHoverCardContentProps {
    thread: ThreadNavigationItem;
    projectionInput: ThreadHoverProjectionInput;
    previewNodeIds: string[];
    previewIndex: number;
    onPreviewIndexChange: (index: number | ((current: number) => number)) => void;
}

export function getThreadPreviewDisplayIndex(previewIndex: number, previewNodeCount: number): number {
    if (previewNodeCount <= 0) return 0;
    const clampedPreviewIndex = Math.min(Math.max(previewIndex, 0), previewNodeCount - 1);
    return previewNodeCount - clampedPreviewIndex;
}

export function getThreadPreviewIndexForDisplayStep(
    previewIndex: number,
    previewNodeCount: number,
    step: -1 | 1,
): number {
    if (previewNodeCount <= 0) return 0;
    const clampedPreviewIndex = Math.min(Math.max(previewIndex, 0), previewNodeCount - 1);
    const nextIndex = clampedPreviewIndex - step;
    return Math.min(Math.max(nextIndex, 0), previewNodeCount - 1);
}

function ThreadNodeHoverCardContent({
    thread,
    projectionInput,
    previewNodeIds,
    previewIndex,
    onPreviewIndexChange,
}: ThreadNodeHoverCardContentProps) {
    const projection = useWorkspaceProjection(
        projectionInput.messages,
        projectionInput.summaries,
        null,
        projectionInput.disabledSummaryIds,
        'thread-hover',
    );
    const clampedPreviewIndex = Math.min(Math.max(previewIndex, 0), previewNodeIds.length - 1);
    const previewNodeId = previewNodeIds[clampedPreviewIndex] ?? null;
    const previewEntity = previewNodeId ? projection.entitiesByMessageId.get(previewNodeId) : null;
    const canShowPrevious = clampedPreviewIndex > 0;
    const canShowNext = clampedPreviewIndex < previewNodeIds.length - 1;
    const canNavigate = previewNodeIds.length > 1;

    if (!previewEntity) return null;

    const navigationChrome = canNavigate ? (
        <div
            className="mb-2 flex items-center justify-end border-b border-[hsl(var(--app-border)/0.46)] pb-2"
            onPointerDown={stopThreadHoverCardPropagation}
            onMouseDown={stopThreadHoverCardPropagation}
            onClick={stopThreadHoverCardPropagation}
        >
            <div className="flex h-9 items-center rounded-full border border-[hsl(var(--app-border)/0.56)] bg-[hsl(var(--background)/0.78)] p-0.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04),0_8px_20px_-18px_hsl(var(--foreground)/0.5)] backdrop-blur-md">
                <button
                    type="button"
                    aria-label="Show older thread node"
                    disabled={!canShowNext}
                    onPointerDown={stopThreadHoverCardPropagation}
                    onMouseDown={stopThreadHoverCardPropagation}
                    onClick={(event) => {
                        stopThreadHoverCardControlEvent(event);
                        onPreviewIndexChange((current) => getThreadPreviewIndexForDisplayStep(current, previewNodeIds.length, -1));
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.62)] hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35"
                >
                    <ChevronLeft size={14} strokeWidth={2.2} />
                </button>
                <div className="min-w-12 px-1 text-center font-mono text-[10px] font-semibold leading-none text-muted-foreground tabular-nums">
                    {getThreadPreviewDisplayIndex(clampedPreviewIndex, previewNodeIds.length)} / {previewNodeIds.length}
                </div>
                <button
                    type="button"
                    aria-label="Show newer thread node"
                    disabled={!canShowPrevious}
                    onPointerDown={stopThreadHoverCardPropagation}
                    onMouseDown={stopThreadHoverCardPropagation}
                    onClick={(event) => {
                        stopThreadHoverCardControlEvent(event);
                        onPreviewIndexChange((current) => getThreadPreviewIndexForDisplayStep(current, previewNodeIds.length, 1));
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.62)] hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35"
                >
                    <ChevronRight size={14} strokeWidth={2.2} />
                </button>
            </div>
        </div>
    ) : null;

    return (
        <div data-agentree-thread-hover-card="true">
            <NodeHoverCardContent
                key={`${thread.threadRootId}:${previewEntity.messageId ?? previewEntity.entityId}`}
                entity={previewEntity}
                projection={projection}
                headerAccessory={navigationChrome}
            />
        </div>
    );
}

function ThreadNodeHoverCard({
    thread,
    projectionInput,
    side,
    children,
}: ThreadNodeHoverCardProps) {
    const hoverContentRef = useRef<HTMLDivElement | null>(null);
    const keepHoverOpenRef = useRef(false);
    const [hoverOpen, setHoverOpen] = useState(false);
    const previewNodeIds = thread.previewNodeIds ?? [];
    const initialPreviewIndex = useMemo(() => {
        if (previewNodeIds.length === 0) return 0;
        const preferredIndex = thread.initialPreviewNodeId
            ? previewNodeIds.indexOf(thread.initialPreviewNodeId)
            : -1;
        return preferredIndex >= 0 ? preferredIndex : 0;
    }, [previewNodeIds, thread.initialPreviewNodeId]);
    const [previewIndex, setPreviewIndex] = useState(initialPreviewIndex);

    useEffect(() => {
        if (!hoverOpen) return;
        setPreviewIndex(initialPreviewIndex);
    }, [hoverOpen, initialPreviewIndex, thread.threadRootId]);

    useEffect(() => {
        if (previewNodeIds.length === 0) return;
        setPreviewIndex((current) => Math.min(Math.max(current, 0), previewNodeIds.length - 1));
    }, [previewNodeIds.length]);

    useEffect(() => {
        if (!projectionInput || previewNodeIds.length === 0) return;
        const previewNodeIdSet = new Set(previewNodeIds);
        const keepHoverCardOpen = (event: Event) => {
            const messageId = (event as CustomEvent<{ messageId?: string | null }>).detail?.messageId ?? null;
            if (messageId && !previewNodeIdSet.has(messageId)) return;
            keepHoverOpenRef.current = true;
            setHoverOpen(true);
        };
        window.addEventListener(QUICK_REPLY_KEEP_HOVER_OPEN_EVENT, keepHoverCardOpen);
        return () => {
            window.removeEventListener(QUICK_REPLY_KEEP_HOVER_OPEN_EVENT, keepHoverCardOpen);
        };
    }, [previewNodeIds, projectionInput]);

    if (!projectionInput || previewNodeIds.length === 0) {
        return <>{children}</>;
    }

    return (
        <HoverCard
            open={hoverOpen}
            onOpenChange={(open) => {
                if (open) {
                    setHoverOpen(true);
                    return;
                }
                const activeElement = document.activeElement;
                if (
                    keepHoverOpenRef.current &&
                    activeElement &&
                    hoverContentRef.current?.contains(activeElement)
                ) {
                    setHoverOpen(true);
                    return;
                }
                keepHoverOpenRef.current = false;
                setHoverOpen(false);
            }}
            openDelay={520}
            closeDelay={140}
        >
            <HoverCardTrigger asChild>
                {children}
            </HoverCardTrigger>
            <HoverCardContent
                ref={hoverContentRef}
                side={side}
                align="center"
                sideOffset={10}
                collisionPadding={16}
                className="z-50 w-auto border-none bg-transparent p-0 shadow-none"
                onPointerDownCapture={(event) => event.stopPropagation()}
                onMouseDownCapture={(event) => event.stopPropagation()}
                onBlurCapture={(event) => {
                    const nextFocus = event.relatedTarget as Node | null;
                    if (nextFocus && event.currentTarget.contains(nextFocus)) return;
                    keepHoverOpenRef.current = false;
                    setHoverOpen(false);
                }}
                onKeyDownCapture={(event) => {
                    if (event.key !== 'Escape') return;
                    keepHoverOpenRef.current = false;
                    setHoverOpen(false);
                }}
            >
                {hoverOpen ? (
                    <ThreadNodeHoverCardContent
                        thread={thread}
                        projectionInput={projectionInput}
                        previewNodeIds={previewNodeIds}
                        previewIndex={previewIndex}
                        onPreviewIndexChange={setPreviewIndex}
                    />
                ) : null}
            </HoverCardContent>
        </HoverCard>
    );
}

interface GraphThreadTabsProps {
    threadItems: ThreadNavigationItem[];
    threadHoverProjectionInput?: ThreadHoverProjectionInput;
    onThreadFocus: (threadRootId: string) => void;
    onThreadDoneChange: (threadRootId: string, done: boolean) => void;
    doneThreadsCollapsed: boolean;
    onDoneThreadsCollapsedChange: (collapsed: boolean) => void;
    threadBarCollapsed?: boolean;
    onThreadBarCollapsedChange?: (collapsed: boolean) => void;
    onCreateThread: () => void;
    orientation?: 'horizontal' | 'vertical';
}

export const GraphThreadTabs = memo(function GraphThreadTabs({
    threadItems,
    threadHoverProjectionInput,
    onThreadFocus,
    onThreadDoneChange,
    doneThreadsCollapsed,
    onDoneThreadsCollapsedChange,
    threadBarCollapsed = false,
    onThreadBarCollapsedChange,
    onCreateThread,
    orientation = 'horizontal',
}: GraphThreadTabsProps) {
    const tabListRef = useRef<HTMLDivElement | null>(null);
    const isVertical = orientation === 'vertical';
    const activeThreadItems = useMemo(() => (
        threadItems
            .filter((thread) => !thread.done || thread.runningCount > 0)
            .sort(sortThreadsByRunningThenRecent)
    ), [threadItems]);
    const doneThreadItems = useMemo(() => (
        threadItems
            .filter((thread) => thread.done && thread.runningCount === 0)
            .sort(sortThreadsByRecent)
    ), [threadItems]);
    const threadTabItems = activeThreadItems;
    const threadOrderKey = useMemo(
        () => [
            ...threadTabItems.map((thread) => `${thread.threadRootId}:${thread.done ? 'd' : 'a'}`),
            `done:${doneThreadItems.length}:${doneThreadsCollapsed ? 'collapsed' : 'open'}`,
        ].join('|'),
        [doneThreadItems.length, doneThreadsCollapsed, threadTabItems]
    );
    const totalRunningAgents = useMemo(
        () => threadItems.reduce((total, thread) => total + thread.runningCount, 0),
        [threadItems]
    );
    const doneThreadCount = doneThreadItems.length;

    useEffect(() => {
        const tabList = tabListRef.current;
        if (!tabList) return;
        if (isVertical) {
            tabList.scrollTop = tabList.scrollHeight;
        } else {
            tabList.scrollLeft = tabList.scrollWidth;
        }
    }, [isVertical, threadOrderKey]);

    if (threadTabItems.length === 0 && doneThreadItems.length === 0) return null;

    if (isVertical && threadBarCollapsed) {
        return (
            <div className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-[hsl(var(--app-border)/0.48)] bg-[hsl(var(--app-panel-strong)/0.36)] px-1.5 py-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.022)]">
                <button
                    type="button"
                    aria-label="Expand threads bar"
                    onClick={() => onThreadBarCollapsedChange?.(false)}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.56)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.58)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                    <ChevronRight size={15} strokeWidth={2.3} />
                </button>
                <div
                    aria-label={`Graph threads (${threadItems.length})`}
                    className="flex w-10 flex-col items-center gap-1 rounded-lg border border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.48)] px-1 py-2 text-muted-foreground"
                >
                    <ParallelThreadsIcon size={15} strokeWidth={2} />
                    <span className="font-mono text-[11px] font-semibold leading-none tabular-nums text-foreground">
                        {threadItems.length}
                    </span>
                </div>
                <div
                    aria-label={`Running threads (${totalRunningAgents})`}
                    className="flex w-10 flex-col items-center gap-1 rounded-lg border border-[hsl(var(--app-border)/0.42)] bg-[hsl(var(--app-bg-muted)/0.54)] px-1 py-2 text-[9px] font-semibold uppercase text-muted-foreground"
                >
                    <span className="font-mono text-[11px] leading-none tabular-nums text-[hsl(var(--app-warning))]">
                        {totalRunningAgents}
                    </span>
                    <span className="[writing-mode:vertical-rl]">Run</span>
                </div>
                {doneThreadCount > 0 ? (
                    <div
                        aria-label={`Done threads (${doneThreadCount})`}
                        className="flex w-10 flex-col items-center gap-1 rounded-lg border border-[hsl(var(--app-border)/0.42)] bg-[hsl(var(--app-bg-muted)/0.54)] px-1 py-2 text-[9px] font-semibold uppercase text-muted-foreground"
                    >
                        <span className="font-mono text-[11px] leading-none tabular-nums text-foreground/72">
                            {doneThreadCount}
                        </span>
                        <span className="[writing-mode:vertical-rl]">Done</span>
                    </div>
                ) : null}
                <button
                    type="button"
                    aria-label="Start new thread"
                    onClick={onCreateThread}
                    className="mt-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.56)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.58)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                    <Plus size={14} strokeWidth={2.3} />
                </button>
            </div>
        );
    }

    const renderThreadTab = (thread: ThreadNavigationItem) => {
        const metadata = formatThreadMetadata(thread);
        const activityLabel = `${thread.runningCount} running`;
        const baseCommitLabel = thread.baseCommitSha ? thread.baseCommitSha.slice(0, 8) : 'unknown base';
        const doneActionLabel = thread.done ? `Reopen thread ${thread.label}` : `Mark done ${thread.label}`;
        const unreadCompletedLeafCount = thread.unreadCompletedLeafCount ?? 0;

        const tab = (
            <div
                key={thread.threadRootId}
                className={cn(
                    "group/thread-tab relative flex shrink-0 items-stretch overflow-hidden rounded-lg border shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[border-color,background-color,box-shadow,opacity,transform] duration-150",
                    isVertical ? "w-full min-w-0" : "min-w-[9.5rem] max-w-[14.5rem]",
                    thread.current
                        ? "border-[hsl(var(--app-accent)/0.34)] bg-[hsl(var(--app-accent-soft)/0.46)] text-[hsl(var(--app-accent))] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.045),0_6px_16px_-16px_hsl(var(--app-accent)/0.7)]"
                        : "border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.54)] text-foreground hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-panel)/0.76)]",
                    thread.done && thread.runningCount === 0 && "opacity-65"
                )}
            >
                <button
                    type="button"
                    role="tab"
                    aria-selected={thread.current}
                    aria-label={`Open thread ${thread.label}`}
                    onClick={() => onThreadFocus(thread.threadRootId)}
                    className={cn(
                        "min-w-0 flex-1 px-2 py-1.5 text-left outline-none transition-[opacity,transform] duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                        unreadCompletedLeafCount > 0 && "pr-8",
                    )}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span
                            className={cn(
                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                thread.current
                                    ? "bg-[hsl(var(--app-accent))]"
                                    : thread.runningCount > 0
                                        ? "bg-[hsl(var(--app-warning))]"
                                        : thread.done
                                            ? "bg-muted-foreground/30"
                                            : "bg-muted-foreground/45"
                            )}
                        />
                        <span className="min-w-0 truncate text-[11px] font-semibold leading-none">
                            {thread.label}
                        </span>
                        {thread.current ? (
                            <span className="shrink-0 rounded bg-[hsl(var(--app-accent)/0.13)] px-1 py-0.5 text-[8px] font-bold leading-none">
                                Current
                            </span>
                        ) : null}
                        {thread.runningCount > 0 ? (
                            <span className="shrink-0 rounded bg-[hsl(var(--app-warning)/0.12)] px-1 py-0.5 text-[8px] font-bold leading-none text-[hsl(var(--app-warning))]">
                                {activityLabel}
                            </span>
                        ) : thread.done ? (
                            <span className="shrink-0 rounded bg-[hsl(var(--app-bg-muted))] px-1 py-0.5 text-[8px] font-bold leading-none text-muted-foreground">
                                Done
                            </span>
                        ) : null}
                    </span>
                    <span className="mt-1 block truncate text-[9px] leading-none text-muted-foreground">
                        <span className="font-mono text-foreground/70">{baseCommitLabel}</span>
                        <span className="px-1 text-muted-foreground/45">·</span>
                        {metadata}
                    </span>
                </button>
                <button
                    type="button"
                    onClick={() => onThreadDoneChange(thread.threadRootId, !thread.done)}
                    aria-label={doneActionLabel}
                    className={cn(
                        "flex w-6 shrink-0 items-center justify-center border-l border-[hsl(var(--app-border)/0.4)] text-muted-foreground opacity-55 transition-[background-color,color,opacity] duration-150 hover:bg-[hsl(var(--app-accent-soft)/0.38)] hover:text-foreground group-hover/thread-tab:opacity-100",
                        thread.done && "text-[hsl(var(--app-accent))] opacity-100"
                    )}
                >
                    {thread.done ? <Eye size={11} strokeWidth={2} /> : <Check size={11} strokeWidth={2} />}
                </button>
                <ThreadUnreadBadge
                    count={unreadCompletedLeafCount}
                    className="pointer-events-none absolute right-[1.65rem] top-1.5"
                />
            </div>
        );

        if (thread.current) return tab;

        return (
            <ThreadNodeHoverCard
                key={thread.threadRootId}
                thread={thread}
                projectionInput={threadHoverProjectionInput}
                side={isVertical ? 'right' : 'bottom'}
            >
                {tab}
            </ThreadNodeHoverCard>
        );
    };

    return (
        <div
            className={cn(
                "bg-[hsl(var(--app-panel-strong)/0.36)] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.022)]",
                isVertical
                    ? "flex h-full w-[16rem] shrink-0 flex-col border-r border-[hsl(var(--app-border)/0.48)] px-2 py-2"
                    : "border-b border-[hsl(var(--app-border)/0.38)] px-3 py-1.5"
            )}
        >
            <div className={cn("flex min-w-0 gap-1.5", isVertical ? "min-h-0 flex-1 flex-col" : "items-center")}>
                <div
                    className={cn(
                        "shrink-0 items-center gap-1.5 rounded-md border border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.48)] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground",
                        isVertical ? "flex justify-between" : "hidden md:flex"
                    )}
                >
                    <ParallelThreadsIcon size={11} strokeWidth={2} />
                    <span>Threads</span>
                    <span className="rounded bg-[hsl(var(--app-bg-muted)/0.72)] px-1.5 py-0.5 font-mono text-[8px] tracking-normal text-foreground/70">
                        {totalRunningAgents} running
                    </span>
                    {isVertical ? (
                        <button
                            type="button"
                            aria-label="Collapse threads bar"
                            onClick={() => onThreadBarCollapsedChange?.(true)}
                            className="relative -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 after:absolute after:-inset-2 after:content-[''] hover:bg-[hsl(var(--app-accent-soft)/0.46)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                        >
                            <ChevronLeft size={13} strokeWidth={2.3} />
                        </button>
                    ) : null}
                </div>
                {isVertical ? (
                    <button
                        type="button"
                        aria-label="Start new thread"
                        onClick={onCreateThread}
                        className="flex h-8 w-full shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.56)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.58)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    >
                        <Plus size={14} strokeWidth={2.3} />
                    </button>
                ) : (
                    <button
                        type="button"
                        aria-label="Start new thread"
                        onClick={onCreateThread}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.56)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] transition-[background-color,border-color,color,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.58)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    >
                        <Plus size={14} strokeWidth={2.3} />
                    </button>
                )}
                <div
                    ref={tabListRef}
                    className={cn(
                        "flex min-w-0 flex-1 gap-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent",
                        isVertical
                            ? "min-h-0 flex-col items-stretch overflow-y-auto overscroll-y-contain"
                            : "items-center overflow-x-auto overscroll-x-contain"
                    )}
                    onWheelCapture={stopNestedScrollPropagation}
                    onTouchMoveCapture={stopNestedScrollPropagation}
                    role="tablist"
                    aria-label="Graph threads"
                    aria-orientation={orientation}
                >
                    {threadTabItems.map((thread) => renderThreadTab(thread))}
                    {isVertical && doneThreadItems.length > 0 ? (
                        <div className="mt-2 border-t border-[hsl(var(--app-border)/0.48)] pt-2">
                            <button
                                type="button"
                                aria-expanded={!doneThreadsCollapsed}
                                onClick={() => onDoneThreadsCollapsedChange(!doneThreadsCollapsed)}
                                className="flex w-full items-center justify-between rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:bg-[hsl(var(--app-panel)/0.7)] hover:text-foreground"
                            >
                                <span>Done threads</span>
                                <span className="font-mono tracking-normal">{doneThreadItems.length}</span>
                            </button>
                            {!doneThreadsCollapsed ? (
                                <div className="mt-1 flex flex-col gap-1">
                                    {doneThreadItems.map((thread) => renderThreadTab(thread))}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
});

GraphThreadTabs.displayName = 'GraphThreadTabs';

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function GraphControls({
    controlsRef,
    viewMode,
    onViewModeChange,
    executionTimelineOpen = false,
    onExecutionTimelineOpenChange,
    renderExecutionTimelinePanel,
    layoutMode,
    onLayoutModeChange,
    laneStrategy,
    onLaneStrategyChange,
    timePreset,
    customTimeFrom,
    customTimeTo,
    onTimePresetChange,
    onCustomTimeFromChange,
    onCustomTimeToChange,
    uniqueAgentIds,
    agentLabelsById,
    selectedAgentIds,
    selectedNodeTypes,
    agentOperator,
    onAgentOperatorChange,
    onAgentFilterChange,
    onNodeTypeFilterChange,
    uniqueTags,
    selectedFilterTags,
    tagOperator,
    onTagOperatorChange,
    groupOperator,
    onGroupOperatorChange,
    keepAncestors,
    keepDescendants,
    onKeepAncestorsChange,
    onKeepDescendantsChange,
    activeFilterCount,
    matchingCount,
    messageNodeCount,
    nodeTypeCounts,
    filterButtonText,
    onTagFilterChange,
    onClearTagFilters,
    onClearAllFilters,
    insights,
    insightsVisible,
    showInsightsInGraph,
    onToggleInsightsVisible,
    onToggleShowInsightsInGraph,
    threadItems,
    onThreadFocus,
    onThreadDoneChange,
    doneThreadsCollapsed,
    onDoneThreadsCollapsedChange,
    leafNodes,
    onLeafNodeFocus,
    mergeSourceCount,
    mergeRunIndicator,
    mergeAttentionNonce,
    renderMergePanel,
    onResetLayout,
    isRefreshingGraph,
    autoRefreshEligible,
    syncStatusItems,
    onRefreshSyncItem,
}: GraphControlsProps) {
    const insightsCount = insights.length;
    const [agentSearch, setAgentSearch] = useState('');
    const [tagSearch, setTagSearch] = useState('');
    const [threadListFilter, setThreadListFilter] = useState<ThreadListFilter>('all');
    const [threadDropdownOpen, setThreadDropdownOpen] = useState(false);
    const [mergeDropdownOpen, setMergeDropdownOpen] = useState(false);
    const [mergeAttentionActive, setMergeAttentionActive] = useState(false);
    const lastMergeAttentionNonceRef = useRef(mergeAttentionNonce);
    const [localDoneThreadsCollapsed, setLocalDoneThreadsCollapsed] = useState(doneThreadsCollapsed);
    useEffect(() => {
        setLocalDoneThreadsCollapsed(doneThreadsCollapsed);
    }, [doneThreadsCollapsed]);
    useEffect(() => {
        if (mergeAttentionNonce <= 0 || mergeAttentionNonce === lastMergeAttentionNonceRef.current) return;
        lastMergeAttentionNonceRef.current = mergeAttentionNonce;
        setMergeDropdownOpen(true);
        setMergeAttentionActive(true);
        const timeoutId = window.setTimeout(() => setMergeAttentionActive(false), 1600);
        return () => window.clearTimeout(timeoutId);
    }, [mergeAttentionNonce]);
    const handleDoneThreadsCollapsedChange = useCallback((collapsed: boolean) => {
        setLocalDoneThreadsCollapsed(collapsed);
        onDoneThreadsCollapsedChange(collapsed);
    }, [onDoneThreadsCollapsedChange]);
    const filteredAgentIds = useMemo(() => {
        const q = agentSearch.trim().toLowerCase();
        if (!q) return uniqueAgentIds;
        return uniqueAgentIds.filter((agentId) => {
            const label = agentLabelsById.get(agentId) ?? agentId;
            return label.toLowerCase().includes(q);
        });
    }, [agentLabelsById, agentSearch, uniqueAgentIds]);
    const filteredTags = useMemo(() => {
        const q = tagSearch.trim().toLowerCase();
        if (!q) return uniqueTags;
        return uniqueTags.filter((tag) => tag.toLowerCase().includes(q));
    }, [tagSearch, uniqueTags]);
    const [clockNow, setClockNow] = useState(() => Date.now());
    useEffect(() => {
        const intervalId = window.setInterval(() => {
            setClockNow(Date.now());
        }, 1000);
        return () => window.clearInterval(intervalId);
    }, []);
    const computedSyncStatusItems = useMemo(() => {
        return syncStatusItems.map((item) => {
            const remainingMs = item.dueAt === null ? null : item.dueAt - clockNow;
            return {
                ...item,
                countdownLabel: formatCountdownLabel(remainingMs),
                tone: item.enabled && remainingMs !== null ? 'active' as const : 'muted' as const,
            };
        });
    }, [clockNow, syncStatusItems]);
    const nextRefreshLabel = useMemo(() => {
        if (!autoRefreshEligible) return null;
        const nextDueAt = syncStatusItems
            .map((item) => item.dueAt)
            .filter((value): value is number => value !== null)
            .sort((a, b) => a - b)[0];

        if (!nextDueAt) return null;
        return formatCountdownLabel(nextDueAt - clockNow);
    }, [autoRefreshEligible, clockNow, syncStatusItems]);
    const openThreadItems = useMemo(() => (
        threadItems
            .filter((thread) => !thread.done || thread.runningCount > 0)
            .sort(sortThreadsByRunningThenRecent)
    ), [threadItems]);
    const doneThreadItems = useMemo(() => (
        threadItems
            .filter((thread) => thread.done && thread.runningCount === 0)
            .sort(sortThreadsByRecent)
    ), [threadItems]);
    const activeThreadCount = openThreadItems.length;
    const doneThreadCount = doneThreadItems.length;
    const filteredOpenThreadItems = useMemo(() => {
        if (threadListFilter === 'done') return [];
        return openThreadItems;
    }, [openThreadItems, threadListFilter]);
    const filteredDoneThreadItems = useMemo(() => {
        if (threadListFilter === 'active') return [];
        if (threadListFilter === 'done') return doneThreadItems;
        return localDoneThreadsCollapsed ? [] : doneThreadItems;
    }, [doneThreadItems, localDoneThreadsCollapsed, threadListFilter]);
    const hasFilteredThreads = filteredOpenThreadItems.length > 0 || filteredDoneThreadItems.length > 0;
    const showDoneThreadGroup = doneThreadItems.length > 0 && threadListFilter !== 'active';
    const hasVisibleDoneThreadRows = filteredDoneThreadItems.length > 0;
    const hasCollapsedDoneThreadRows = showDoneThreadGroup && !hasVisibleDoneThreadRows && threadListFilter === 'all';
    const hasCurrentThread = threadItems.some((thread) => thread.current);
    const hasActiveThread = threadItems.some((thread) => thread.runningCount > 0);
    const timeLabel = timePreset === 'all'
        ? null
        : timePreset === '1h'
            ? 'Last 1h'
            : timePreset === '5h'
                ? 'Last 5h'
                : timePreset === '24h'
                    ? 'Last 24h'
                    : timePreset === '7d'
                        ? 'Last 7d'
                        : timePreset === '30d'
                            ? 'Last 30d'
                            : 'Custom range';
    const selectedAgentsLabel = selectedAgentIds.size > 0
        ? `${agentOperator === 'none_of' ? 'Exclude' : 'Models'}: ${selectedAgentIds.size}`
        : null;
    const selectedNodeTypesLabel = selectedNodeTypes.size > 0
        ? `Types: ${selectedNodeTypes.size}`
        : null;
    const selectedTagsLabel = selectedFilterTags.size > 0
        ? `${tagOperator.replace('_', ' ')}: ${selectedFilterTags.size}`
        : null;
    const nodeTypeOptions: Array<{
        id: MessageNodeType;
        label: string;
        icon: ReactNode;
        tone: string;
    }> = [
        {
            id: 'thread_link',
            label: 'Thread link',
            icon: <GitBranch size={11} />,
            tone: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-300',
        },
        {
            id: 'user_message',
            label: 'User',
            icon: <User size={11} />,
            tone: 'bg-slate-100 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300',
        },
        {
            id: 'assistant_message',
            label: 'Assistant',
            icon: <Bot size={11} />,
            tone: 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300',
        },
        {
            id: 'commit_message',
            label: 'Commit',
            icon: <GitCommitHorizontal size={11} />,
            tone: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300',
        },
    ];
    const toolbarButtonClass = "border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.74)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:border-[hsl(var(--app-border-strong)/0.75)] hover:bg-[hsl(var(--app-accent-soft)/0.52)] hover:text-foreground active:scale-[0.98]";
    const activeToolbarButtonClass = "border-[hsl(var(--app-accent)/0.35)] bg-[hsl(var(--app-accent-soft)/0.72)] text-[hsl(var(--app-accent))] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.05)]";
    const toolbarDividerClass = "h-5 w-px bg-[hsl(var(--app-border)/0.68)]";
    const pillClass = "inline-flex items-center gap-1.5 rounded-md border border-[hsl(var(--app-accent)/0.18)] bg-[hsl(var(--app-accent-soft)/0.48)] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--app-accent))]";
    const sectionClass = "rounded-xl border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong)/0.62)] p-3 space-y-2.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]";
    const toggleButtonClass = "h-7 px-2.5 text-[11px] font-medium transition-all duration-150";

    const iconButtonBase = "group relative flex items-center justify-center rounded-lg transition-all duration-150 ease-out";
    const iconButtonGhost = cn("h-8 w-8 px-0", toolbarButtonClass);
    const iconContainer = "flex items-center justify-center transition-transform duration-150 group-active:scale-95";
    const iconGlow = "absolute inset-0 rounded-lg bg-[hsl(var(--app-accent-soft)/0.28)] opacity-0 transition-opacity duration-150 group-hover:opacity-100";
    const mergeButtonActive = mergeDropdownOpen || mergeSourceCount > 0 || mergeRunIndicator !== 'idle';
    const mergeAriaLabel = mergeSourceCount > 0
        ? `Merge panel (${mergeSourceCount} ${mergeSourceCount === 1 ? 'source' : 'sources'})`
        : 'Merge panel';
    const mergeTooltipLabel = mergeRunIndicator === 'running'
        ? 'Merge review or apply is running.'
        : mergeRunIndicator === 'completed'
            ? 'Merge review completed. Review and apply from this dropdown.'
            : mergeSourceCount > 0
                ? `${mergeSourceCount} merge ${mergeSourceCount === 1 ? 'source' : 'sources'} selected.`
                : 'Open the merge workflow without switching to chat.';
    const leafStatusToneClass = {
        active: 'bg-amber-500/12 text-amber-700 dark:bg-amber-400/12 dark:text-amber-300',
        success: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300',
        danger: 'bg-red-500/12 text-red-700 dark:bg-red-400/12 dark:text-red-300',
        muted: 'bg-slate-500/12 text-slate-600 dark:bg-slate-400/12 dark:text-slate-300',
    };
    const threadListFilterOptions: Array<{ id: ThreadListFilter; label: string; count: number }> = [
        { id: 'all', label: 'All', count: threadItems.length },
        { id: 'active', label: 'Active', count: activeThreadCount },
        { id: 'done', label: 'Done', count: doneThreadCount },
    ];
    return (
        <div
            ref={controlsRef}
            className="z-20 flex-shrink-0 border-b border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel)/0.92)] shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.03)] backdrop-blur-md"
        >
            {/* Main Row - Compact */}
            <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                {/* LEFT GROUP: Compact Actions */}
                <div className="flex items-center gap-2">
                    {/* Filter - Modern Compact */}
                    <div className="relative">
                    <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className={cn(
                                iconButtonBase,
                                toolbarButtonClass,
                                "h-8 gap-1.5 pl-2.5 text-xs font-medium",
                                activeFilterCount > 0 ? "pr-7" : "pr-2",
                                activeFilterCount > 0 && activeToolbarButtonClass
                            )}
                        >
                            <span className={iconContainer}>
                                <SlidersHorizontal size={13} strokeWidth={2} />
                            </span>
                            <span className="hidden md:inline font-medium">{filterButtonText}</span>
                            <span className={cn(
                                "min-w-[1.25rem] rounded-md border px-1.5 py-0 text-center text-[10px] font-semibold tabular-nums transition-all",
                                activeFilterCount > 0
                                    ? "border-[hsl(var(--app-accent)/0.22)] bg-[hsl(var(--app-accent)/0.12)] text-[hsl(var(--app-accent))]"
                                    : "border-[hsl(var(--app-border)/0.55)] bg-[hsl(var(--background)/0.72)] text-muted-foreground"
                            )}>
                                {matchingCount}
                            </span>
                        </button>
                    </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-[min(420px,calc(100vw-2rem))] p-0 overflow-hidden" align="start">
                            <div className="border-b border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel-strong)/0.64)] p-4 pb-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/10 text-primary">
                                            <Filter size={14} />
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold leading-none">Graph Filters</p>
                                            <p className="text-[11px] text-muted-foreground mt-1">
                                                {matchingCount} of {messageNodeCount} message nodes match
                                            </p>
                                        </div>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 px-2.5 text-[11px] font-medium hover:bg-muted/60"
                                        onClick={onClearAllFilters}
                                        disabled={activeFilterCount === 0}
                                    >
                                        Clear all
                                    </Button>
                                </div>
                                <div className="mt-4 flex items-center justify-between rounded-xl border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.78)] px-3 py-2.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] backdrop-blur-sm">
                                    <div className="flex items-center gap-2">
                                        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-muted/60">
                                            <Settings2 size={12} className="text-muted-foreground" />
                                        </div>
                                        <div>
                                            <p className="text-[11px] font-semibold text-foreground">
                                                Match Mode
                                            </p>
                                            <p className="text-[10px] text-muted-foreground">
                                                Control how filters combine
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 rounded-lg bg-[hsl(var(--app-bg-muted)/0.72)] p-0.5">
                                        <Button
                                            size="sm"
                                            variant={groupOperator === 'and' ? 'default' : 'ghost'}
                                            className={cn(
                                                toggleButtonClass,
                                                groupOperator === 'and' && "shadow-sm",
                                                groupOperator !== 'and' && "hover:bg-muted/60"
                                            )}
                                            onClick={() => onGroupOperatorChange('and')}
                                        >
                                            All
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant={groupOperator === 'or' ? 'default' : 'ghost'}
                                            className={cn(
                                                toggleButtonClass,
                                                groupOperator === 'or' && "shadow-sm",
                                                groupOperator !== 'or' && "hover:bg-muted/60"
                                            )}
                                            onClick={() => onGroupOperatorChange('or')}
                                        >
                                            Any
                                        </Button>
                                    </div>
                                </div>
                                <div className="mt-3 grid grid-cols-2 gap-2">
                                    <Button
                                        size="sm"
                                        variant={keepAncestors ? 'default' : 'outline'}
                                        className={cn(
                                            toggleButtonClass,
                                            'justify-start gap-2 h-8',
                                            !keepAncestors && "bg-background/50 border-border/40 hover:bg-muted/60"
                                        )}
                                        onClick={() => onKeepAncestorsChange(!keepAncestors)}
                                    >
                                        <Check size={12} className={cn(!keepAncestors && "opacity-0")} />
                                        Keep ancestors
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant={keepDescendants ? 'default' : 'outline'}
                                        className={cn(
                                            toggleButtonClass,
                                            'justify-start gap-2 h-8',
                                            !keepDescendants && "bg-background/50 border-border/40 hover:bg-muted/60"
                                        )}
                                        onClick={() => onKeepDescendantsChange(!keepDescendants)}
                                    >
                                        <Check size={12} className={cn(!keepDescendants && "opacity-0")} />
                                        Keep descendants
                                    </Button>
                                </div>
                            </div>

                            <div className="max-h-[min(70vh,720px)] overflow-y-auto px-3 pb-3 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
                                <div className="space-y-3 pr-2">
                                    <div className={sectionClass}>
                                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft)/0.66)] text-[hsl(var(--app-accent))]">
                                                <Clock3 size={11} />
                                            </div>
                                            Time Range
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {[
                                                { value: 'all', label: 'All time' },
                                                { value: '1h', label: '1h' },
                                                { value: '5h', label: '5h' },
                                                { value: '24h', label: '24h' },
                                                { value: '7d', label: '7d' },
                                                { value: '30d', label: '30d' },
                                                { value: 'custom', label: 'Custom' },
                                            ].map((preset) => (
                                                <Button
                                                    key={preset.value}
                                                    size="sm"
                                                    variant={timePreset === preset.value ? 'default' : 'outline'}
                                                    className={toggleButtonClass}
                                                    onClick={() => onTimePresetChange(preset.value as TimePreset)}
                                                >
                                                    {timePreset === preset.value && <Check size={11} className="mr-1" />}
                                                    {preset.label}
                                                </Button>
                                            ))}
                                        </div>
                                        {timePreset === 'custom' && (
                                            <div className="grid grid-cols-2 gap-2">
                                                <Input
                                                    type="date"
                                                    value={customTimeFrom}
                                                    onChange={(e) => onCustomTimeFromChange(e.target.value)}
                                                    className="h-8 text-xs"
                                                />
                                                <Input
                                                    type="date"
                                                    value={customTimeTo}
                                                    onChange={(e) => onCustomTimeToChange(e.target.value)}
                                                    className="h-8 text-xs"
                                                />
                                            </div>
                                        )}
                                    </div>

                                    <div className={sectionClass}>
                                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft)/0.66)] text-[hsl(var(--app-accent))]">
                                                <GitCommitHorizontal size={11} />
                                            </div>
                                            Node Type
                                        </div>
                                        <div className="grid grid-cols-1 gap-1.5">
                                            {nodeTypeOptions.map((option) => (
                                                <button
                                                    key={option.id}
                                                    type="button"
                                                    onClick={() => onNodeTypeFilterChange(option.id, !selectedNodeTypes.has(option.id))}
                                                    className={cn(
                                                        "flex items-center justify-between rounded-lg border px-2.5 py-2 text-left transition-all",
                                                        selectedNodeTypes.has(option.id)
                                                            ? "border-[hsl(var(--app-accent)/0.35)] bg-[hsl(var(--app-accent-soft)/0.66)]"
                                                            : "border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.68)] hover:bg-[hsl(var(--app-accent-soft)/0.38)]"
                                                    )}
                                                >
                                                    <span className="flex items-center gap-2 min-w-0">
                                                        <span className={cn("flex h-5 w-5 items-center justify-center rounded-md", option.tone)}>
                                                            {option.icon}
                                                        </span>
                                                        <span className="text-xs font-medium">{option.label}</span>
                                                    </span>
                                                    <span className="flex items-center gap-2">
                                                        <span className="text-[11px] tabular-nums text-muted-foreground">
                                                            {nodeTypeCounts[option.id]}
                                                        </span>
                                                        <span className={cn(
                                                            "flex h-4 w-4 items-center justify-center rounded-sm border",
                                                            selectedNodeTypes.has(option.id)
                                                                ? "border-[hsl(var(--app-accent)/0.4)] bg-[hsl(var(--app-accent))] text-primary-foreground"
                                                                : "border-[hsl(var(--app-border)/0.62)] bg-background"
                                                        )}>
                                                            <Check size={10} className={cn(!selectedNodeTypes.has(option.id) && "opacity-0")} />
                                                        </span>
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className={sectionClass}>
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft)/0.66)] text-[hsl(var(--app-accent))]">
                                                    <Bot size={11} />
                                                </div>
                                                Agent
                                            </div>
                                            <div className="flex items-center gap-1 rounded-lg bg-[hsl(var(--app-bg-muted)/0.72)] p-0.5">
                                                <Button
                                                    size="sm"
                                                    variant={agentOperator === 'any_of' ? 'default' : 'ghost'}
                                                    className={cn(toggleButtonClass, agentOperator === 'any_of' && "shadow-sm")}
                                                    onClick={() => onAgentOperatorChange('any_of')}
                                                >
                                                    Any
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant={agentOperator === 'none_of' ? 'default' : 'ghost'}
                                                    className={cn(toggleButtonClass, agentOperator === 'none_of' && "shadow-sm")}
                                                    onClick={() => onAgentOperatorChange('none_of')}
                                                >
                                                    None
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="relative">
                                            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                            <Input
                                                value={agentSearch}
                                                onChange={(e) => setAgentSearch(e.target.value)}
                                                placeholder="Search models..."
                                                className="h-8 pl-8 text-xs bg-background/50 border-border/40 focus:border-primary/30"
                                            />
                                        </div>
                                        {uniqueAgentIds.length > 0 ? (
                                            <ScrollArea
                                                className="max-h-32 overscroll-contain rounded-md border border-border/60 bg-background/70"
                                                onWheelCapture={stopNestedScrollPropagation}
                                                onTouchMoveCapture={stopNestedScrollPropagation}
                                            >
                                                <div className="p-1">
                                                    {filteredAgentIds.map((agentId: string) => (
                                                        <DropdownMenuCheckboxItem
                                                            key={agentId}
                                                            checked={selectedAgentIds.has(agentId)}
                                                            onCheckedChange={(checked: boolean) => onAgentFilterChange(agentId, !!checked)}
                                                            onSelect={(e: Event) => e.preventDefault()}
                                                            className="rounded-sm text-xs"
                                                        >
                                                            {agentLabelsById.get(agentId) ?? agentId}
                                                        </DropdownMenuCheckboxItem>
                                                    ))}
                                                </div>
                                            </ScrollArea>
                                        ) : (
                                            <DropdownMenuItem disabled>No models available</DropdownMenuItem>
                                        )}
                                    </div>

                                    <div className={sectionClass}>
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft)/0.66)] text-[hsl(var(--app-accent))]">
                                                    <Tags size={11} />
                                                </div>
                                                Tags
                                            </div>
                                            <div className="flex items-center gap-1 rounded-lg bg-[hsl(var(--app-bg-muted)/0.72)] p-0.5">
                                                <Button
                                                    size="sm"
                                                    variant={tagOperator === 'has_any' ? 'default' : 'ghost'}
                                                    className={cn(toggleButtonClass, tagOperator === 'has_any' && "shadow-sm")}
                                                    onClick={() => onTagOperatorChange('has_any')}
                                                >
                                                    Any
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant={tagOperator === 'has_all' ? 'default' : 'ghost'}
                                                    className={cn(toggleButtonClass, tagOperator === 'has_all' && "shadow-sm")}
                                                    onClick={() => onTagOperatorChange('has_all')}
                                                >
                                                    All
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant={tagOperator === 'has_none' ? 'default' : 'ghost'}
                                                    className={cn(toggleButtonClass, tagOperator === 'has_none' && "shadow-sm")}
                                                    onClick={() => onTagOperatorChange('has_none')}
                                                >
                                                    None
                                                </Button>
                                            </div>
                                        </div>
                                        <div className="relative">
                                            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                            <Input
                                                value={tagSearch}
                                                onChange={(e) => setTagSearch(e.target.value)}
                                                placeholder="Search tags..."
                                                className="h-8 pl-8 text-xs bg-background/50 border-border/40 focus:border-primary/30"
                                            />
                                        </div>
                                        {uniqueTags.length > 0 ? (
                                            <ScrollArea
                                                className="max-h-36 overscroll-contain rounded-md border border-border/60 bg-background/70"
                                                onWheelCapture={stopNestedScrollPropagation}
                                                onTouchMoveCapture={stopNestedScrollPropagation}
                                            >
                                                <div className="p-1">
                                                    {filteredTags.map((tag: string) => (
                                                        <DropdownMenuCheckboxItem
                                                            key={tag}
                                                            checked={selectedFilterTags.has(tag)}
                                                            onCheckedChange={(checked: boolean) => onTagFilterChange(tag, !!checked)}
                                                            onSelect={(e: Event) => e.preventDefault()}
                                                            className="rounded-sm text-xs"
                                                        >
                                                            {tag}
                                                        </DropdownMenuCheckboxItem>
                                                    ))}
                                                </div>
                                            </ScrollArea>
                                        ) : (
                                            <DropdownMenuItem disabled>No tags available</DropdownMenuItem>
                                        )}
                                    </div>
                                    <div className="pt-2 border-t border-border/30">
                                        <div className="flex items-center justify-between">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                {timeLabel && <span className={pillClass}>{timeLabel}</span>}
                                                {selectedNodeTypesLabel && <span className={pillClass}>{selectedNodeTypesLabel}</span>}
                                                {selectedAgentsLabel && <span className={pillClass}>{selectedAgentsLabel}</span>}
                                                {selectedTagsLabel && <span className={pillClass}>{selectedTagsLabel}</span>}
                                                {(groupOperator === 'or' && activeFilterCount > 1) && (
                                                    <span className={pillClass}>Match: Any</span>
                                                )}
                                                {activeFilterCount === 0 && (
                                                    <span className="text-[11px] text-muted-foreground italic">No filters applied</span>
                                                )}
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                                                onClick={onClearTagFilters}
                                                disabled={selectedFilterTags.size === 0}
                                            >
                                                Clear tags
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    {activeFilterCount > 0 && (
                        <button
                            type="button"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            }}
                            onClick={onClearAllFilters}
                            className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full p-0.5 text-white/90 transition-colors hover:bg-white/20 hover:text-white"
                            aria-label="Clear all graph filters"
                        >
                            <X size={10} strokeWidth={2.5} />
                        </button>
                    )}
                    </div>

                </div>

                {/* RIGHT GROUP: Compact */}
                <div className="flex items-center gap-2">
                    {/* View Mode Toggle - Pill Style (matches chat/merge tabs) */}
                    <div className="flex items-center rounded-lg border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-bg-muted)/0.72)] p-0.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
                        <button
                            type="button"
                            onClick={() => onViewModeChange('branch')}
                            className={cn(
                                "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-150",
                                viewMode === 'branch'
                                    ? "bg-[hsl(var(--app-panel))] text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72),0_1px_2px_hsl(var(--foreground)/0.05)]"
                                    : "text-muted-foreground hover:bg-[hsl(var(--app-panel)/0.58)] hover:text-foreground"
                            )}
                            title="Branch View"
                        >
                            <GitBranch className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Branch</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => onViewModeChange('timeline')}
                            className={cn(
                                "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-150",
                                viewMode === 'timeline'
                                    ? "bg-[hsl(var(--app-panel))] text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72),0_1px_2px_hsl(var(--foreground)/0.05)]"
                                    : "text-muted-foreground hover:bg-[hsl(var(--app-panel)/0.58)] hover:text-foreground"
                            )}
                            title="Timeline View"
                        >
                            <CalendarDays className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Timeline</span>
                        </button>
                    </div>

                    {onExecutionTimelineOpenChange && renderExecutionTimelinePanel ? (
                        <Popover open={executionTimelineOpen} onOpenChange={onExecutionTimelineOpenChange}>
                            <PopoverTrigger asChild>
                                <button
                                    type="button"
                                    aria-label={executionTimelineOpen ? 'Close execution timeline' : 'Open execution timeline'}
                                    className={cn(
                                        iconButtonBase,
                                        toolbarButtonClass,
                                        "h-8 w-8 px-0",
                                        executionTimelineOpen && activeToolbarButtonClass,
                                    )}
                                    title="Execution timeline"
                                >
                                    <Clock3 className="h-3.5 w-3.5" />
                                </button>
                            </PopoverTrigger>
                            <PopoverContent
                                align="end"
                                side="bottom"
                                sideOffset={10}
                                className="z-50 w-[min(980px,calc(100vw-1.5rem))] border-none bg-transparent p-0 shadow-none"
                                onOpenAutoFocus={(event) => event.preventDefault()}
                            >
                                {renderExecutionTimelinePanel(() => onExecutionTimelineOpenChange(false))}
                            </PopoverContent>
                        </Popover>
                    ) : null}

                    <span className={toolbarDividerClass} aria-hidden="true" />

                    {threadItems.length > 0 ? (
                        <DropdownMenu modal={false} open={threadDropdownOpen} onOpenChange={setThreadDropdownOpen}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            type="button"
                                            className={cn(
                                                iconButtonBase,
                                                toolbarButtonClass,
                                                "h-8 w-8 px-0",
                                                hasCurrentThread
                                                    ? activeToolbarButtonClass
                                                    : "",
                                                hasActiveThread && !hasCurrentThread && "border-[hsl(var(--app-warning)/0.38)] bg-[hsl(var(--app-warning)/0.1)] text-[hsl(var(--app-warning))]"
                                            )}
                                            aria-label={`Threads (${threadItems.length})`}
                                        >
                                            <span className={iconGlow} />
                                            <span className={iconContainer}>
                                                <ParallelThreadsIcon size={15} strokeWidth={2} />
                                            </span>
                                            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--background)/0.92)] px-1 text-[9px] font-semibold leading-none tabular-nums text-foreground shadow-sm">
                                                {threadItems.length}
                                            </span>
                                            {doneThreadCount > 0 ? (
                                                <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[hsl(var(--background))] bg-[hsl(var(--app-success))]" />
                                            ) : null}
                                        </button>
                                    </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" align="end">
                                    Thread roots in this workspace graph.
                                </TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent
                                className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden p-0"
                                align="end"
                            >
                                <div className="border-b border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel-strong)/0.64)] px-3 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft)/0.66)] text-[hsl(var(--app-accent))]">
                                                <ParallelThreadsIcon size={14} strokeWidth={2} />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-sm font-semibold leading-none text-foreground">Threads</p>
                                                <p className="mt-1 text-[11px] text-muted-foreground">
                                                    {threadItems.length} graph {threadItems.length === 1 ? 'thread' : 'threads'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                                            {activeThreadCount} active
                                        </div>
                                    </div>
                                    <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.72)] p-1 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
                                        {threadListFilterOptions.map((option) => {
                                            const selected = threadListFilter === option.id;

                                            return (
                                                <button
                                                    key={option.id}
                                                    type="button"
                                                    aria-label={`${option.label} ${option.count}`}
                                                    aria-pressed={selected}
                                                    onClick={(event) => {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        setThreadListFilter(option.id);
                                                    }}
                                                    className={cn(
                                                        "rounded-md px-2 py-1.5 text-[11px] font-semibold leading-none transition-[background-color,color,box-shadow] duration-150",
                                                        selected
                                                            ? "bg-[hsl(var(--app-panel))] text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68),0_1px_2px_hsl(var(--foreground)/0.05)]"
                                                            : "text-muted-foreground hover:bg-[hsl(var(--app-panel)/0.72)] hover:text-foreground"
                                                    )}
                                                >
                                                    <span>{option.label}</span>
                                                    <span className="ml-1 tabular-nums opacity-70">{option.count}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div
                                    className="max-h-[min(24rem,calc(100vh-9rem))] overflow-y-auto overscroll-contain p-1.5 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
                                    onWheelCapture={stopNestedScrollPropagation}
                                    onTouchMoveCapture={stopNestedScrollPropagation}
                                >
                                    {!hasFilteredThreads && !hasCollapsedDoneThreadRows ? (
                                        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                                            No {threadListFilter === 'done' ? 'done' : 'active'} threads.
                                        </div>
                                    ) : null}
                                    {filteredOpenThreadItems.map((thread) => {
                                        const metadata = formatThreadMetadata(thread);
                                        const activityLabel = thread.runningCount > 1 ? `${thread.runningCount} running` : 'Active';
                                        const actionLabel = thread.done ? `Reopen thread ${thread.label}` : `Mark done ${thread.label}`;
                                        const unreadCompletedLeafCount = thread.unreadCompletedLeafCount ?? 0;

                                        return (
                                            <div
                                                key={thread.threadRootId}
                                                className={cn(
                                                    "group/thread flex items-center gap-2 rounded-lg px-2 py-2 transition-colors",
                                                    thread.current
                                                        ? "bg-[hsl(var(--app-accent-soft)/0.58)]"
                                                        : "hover:bg-[hsl(var(--app-accent-soft)/0.34)]",
                                                    thread.done && "opacity-80"
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        onThreadFocus(thread.threadRootId);
                                                        setThreadDropdownOpen(false);
                                                    }}
                                                    aria-label={`Open thread ${thread.label}`}
                                                    className="min-w-0 flex-1 rounded-md text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                                                >
                                                    <span className="flex min-w-0 items-center gap-1.5">
                                                        <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                                                            {thread.label}
                                                        </span>
                                                        {thread.current ? (
                                                            <span className="shrink-0 rounded-md bg-[hsl(var(--app-accent)/0.12)] px-1.5 py-0.5 text-[9px] font-semibold leading-none text-[hsl(var(--app-accent))]">
                                                                Current
                                                            </span>
                                                        ) : null}
                                                        {thread.runningCount > 0 ? (
                                                            <span className="shrink-0 rounded-md bg-[hsl(var(--app-warning)/0.12)] px-1.5 py-0.5 text-[9px] font-semibold leading-none text-[hsl(var(--app-warning))]">
                                                                {activityLabel}
                                                            </span>
                                                        ) : thread.done ? (
                                                            <span className="shrink-0 rounded-md bg-[hsl(var(--app-bg-muted))] px-1.5 py-0.5 text-[9px] font-semibold leading-none text-muted-foreground">
                                                                Done
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                    <span className="mt-1 block truncate text-[11px] leading-none text-muted-foreground">
                                                        {metadata}
                                                    </span>
                                                </button>
                                                <ThreadUnreadBadge
                                                    count={unreadCompletedLeafCount}
                                                    className="shrink-0"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => onThreadDoneChange(thread.threadRootId, !thread.done)}
                                                    aria-label={actionLabel}
                                                    className={cn(
                                                        "shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors",
                                                        thread.done
                                                            ? "text-[hsl(var(--app-accent))] hover:bg-[hsl(var(--app-accent-soft)/0.58)]"
                                                            : "text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground group-hover/thread:opacity-100"
                                                    )}
                                                >
                                                    {thread.done ? 'Reopen' : 'Done'}
                                                </button>
                                            </div>
                                        );
                                    })}
                                    {showDoneThreadGroup ? (
                                        <div className="mt-1 border-t border-[hsl(var(--app-border)/0.5)] pt-1.5">
                                            <div className="flex items-center justify-between px-2 py-1">
                                                <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                                                    Done threads
                                                </span>
                                                {threadListFilter === 'all' ? (
                                                    <button
                                                        type="button"
                                                        aria-label={localDoneThreadsCollapsed ? 'Show done threads' : 'Hide done threads'}
                                                        onClick={() => handleDoneThreadsCollapsedChange(!localDoneThreadsCollapsed)}
                                                        className="rounded-md px-2 py-1 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                                    >
                                                        {localDoneThreadsCollapsed ? 'Show' : 'Hide'}
                                                    </button>
                                                ) : null}
                                            </div>
                                            {hasVisibleDoneThreadRows ? (
                                                <div className="mt-0.5 space-y-0.5">
                                                    {filteredDoneThreadItems.map((thread) => {
                                                        const metadata = formatThreadMetadata(thread);
                                                        const unreadCompletedLeafCount = thread.unreadCompletedLeafCount ?? 0;

                                                        return (
                                                            <div
                                                                key={thread.threadRootId}
                                                                className={cn(
                                                                    "group/thread flex items-center gap-2 rounded-lg px-2 py-2 opacity-78 transition-colors",
                                                                    thread.current
                                                                        ? "bg-[hsl(var(--app-accent-soft)/0.58)]"
                                                                        : "hover:bg-[hsl(var(--app-accent-soft)/0.34)]"
                                                                )}
                                                            >
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        onThreadFocus(thread.threadRootId);
                                                                        setThreadDropdownOpen(false);
                                                                    }}
                                                                    aria-label={`Open thread ${thread.label}`}
                                                                    className="min-w-0 flex-1 rounded-md text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                                                                >
                                                                    <span className="flex min-w-0 items-center gap-1.5">
                                                                        <span className="min-w-0 truncate text-xs font-semibold text-foreground">
                                                                            {thread.label}
                                                                        </span>
                                                                        <span className="shrink-0 rounded-md bg-[hsl(var(--app-bg-muted))] px-1.5 py-0.5 text-[9px] font-semibold leading-none text-muted-foreground">
                                                                            Done
                                                                        </span>
                                                                    </span>
                                                                    <span className="mt-1 block truncate text-[11px] leading-none text-muted-foreground">
                                                                        {metadata}
                                                                    </span>
                                                                </button>
                                                                <ThreadUnreadBadge
                                                                    count={unreadCompletedLeafCount}
                                                                    className="shrink-0"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => onThreadDoneChange(thread.threadRootId, false)}
                                                                    aria-label={`Reopen thread ${thread.label}`}
                                                                    className="shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold text-[hsl(var(--app-accent))] transition-colors hover:bg-[hsl(var(--app-accent-soft)/0.58)]"
                                                                >
                                                                    Reopen
                                                                </button>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}

                    {/* Merge workflow */}
                    <Popover open={mergeDropdownOpen} onOpenChange={setMergeDropdownOpen}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <PopoverTrigger asChild>
                                    <button
                                        type="button"
                                        className={cn(
                                            iconButtonBase,
                                            toolbarButtonClass,
                                            "h-8 w-8 px-0",
                                            mergeButtonActive && activeToolbarButtonClass,
                                            mergeRunIndicator === 'running' && "border-[hsl(var(--app-warning)/0.38)] bg-[hsl(var(--app-warning)/0.1)] text-[hsl(var(--app-warning))]",
                                            mergeAttentionActive && "animate-pulse"
                                        )}
                                        aria-label={mergeAriaLabel}
                                    >
                                        <span className={iconGlow} />
                                        <span className={iconContainer}>
                                            <SimpleMergeIcon size={16} strokeWidth={2} />
                                        </span>
                                        {mergeSourceCount > 0 ? (
                                            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--background)/0.94)] px-1 text-[9px] font-semibold leading-none tabular-nums text-foreground shadow-sm">
                                                {mergeSourceCount > 99 ? '99+' : mergeSourceCount}
                                            </span>
                                        ) : null}
                                        {mergeRunIndicator === 'running' ? (
                                            <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-[hsl(var(--background))] bg-[hsl(var(--app-warning))] text-white">
                                                <Loader2 size={9} className="animate-spin" strokeWidth={2.4} />
                                            </span>
                                        ) : mergeRunIndicator === 'completed' ? (
                                            <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-[hsl(var(--background))] bg-[hsl(var(--app-success))] text-white">
                                                <CheckCircle2 size={10} strokeWidth={2.4} />
                                            </span>
                                        ) : null}
                                    </button>
                                </PopoverTrigger>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" align="end">
                                {mergeTooltipLabel}
                            </TooltipContent>
                        </Tooltip>
                        <PopoverContent
                            align="end"
                            side="bottom"
                            sideOffset={8}
                            collisionPadding={12}
                            className="h-[min(760px,calc(100vh-5rem))] w-[min(1020px,calc(100vw-2rem))] overflow-hidden rounded-[18px] border border-[hsl(var(--app-border)/0.7)] bg-[linear-gradient(180deg,hsl(var(--app-panel)/0.98),hsl(var(--app-bg)/0.96))] p-0 shadow-[0_32px_90px_-42px_hsl(var(--foreground)/0.55),0_12px_28px_-22px_hsl(var(--foreground)/0.36),inset_0_1px_0_hsl(var(--foreground)/0.045)] backdrop-blur-xl dark:bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-bg)/0.98))]"
                            onOpenAutoFocus={(event) => event.preventDefault()}
                            onWheelCapture={stopNestedScrollPropagation}
                            onTouchMoveCapture={stopNestedScrollPropagation}
                        >
                            {renderMergePanel ? (
                                renderMergePanel(() => setMergeDropdownOpen(false))
                            ) : (
                                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                                    Merge panel is unavailable in this view.
                                </div>
                            )}
                        </PopoverContent>
                    </Popover>

                    {/* Leaf nodes */}
                    <DropdownMenu>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        className={cn(iconButtonBase, iconButtonGhost)}
                                        aria-label="Leaf nodes"
                                    >
                                        <span className={iconGlow} />
                                        <span className={iconContainer}>
                                            <Leaf size={15} strokeWidth={2} />
                                        </span>
                                    </button>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" align="end">
                                Branch endpoints with no child nodes, ordered newest first.
                            </TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent className="w-80 overflow-hidden p-0" align="end">
                            <div className="border-b border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel-strong)/0.64)] p-3">
                                <div className="flex items-center gap-2">
                                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft)/0.66)] text-[hsl(var(--app-accent))]">
                                        <Leaf size={14} />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold leading-none">Leaf Nodes</p>
                                        <p className="mt-1 text-[11px] text-muted-foreground">
                                            {leafNodes.length} branch endpoints, newest first
                                        </p>
                                    </div>
                                </div>
                            </div>
                            {leafNodes.length > 0 ? (
                                <div
                                    className="max-h-80 overflow-y-auto overscroll-contain p-1.5 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
                                    onWheelCapture={stopNestedScrollPropagation}
                                    onTouchMoveCapture={stopNestedScrollPropagation}
                                >
                                    {leafNodes.map((node) => (
                                        <DropdownMenuItem
                                            key={node.id}
                                            onClick={() => onLeafNodeFocus(node.id)}
                                            className="flex cursor-pointer flex-col items-stretch gap-1.5 rounded-md px-2 py-2"
                                        >
                                            <span className="block truncate text-xs font-medium text-foreground">
                                                {node.label}
                                            </span>
                                            <span className="flex min-w-0 items-center gap-1.5">
                                                <span className="min-w-0 truncate rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                                                    {node.modelLabel}
                                                </span>
                                                <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none", leafStatusToneClass[node.statusTone])}>
                                                    {node.statusLabel}
                                                </span>
                                                <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                                                    {node.timestampLabel}
                                                </span>
                                            </span>
                                        </DropdownMenuItem>
                                    ))}
                                </div>
                            ) : (
                                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                                    No leaf nodes available
                                </div>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Settings - Modern Icon Button */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="Display settings"
                                className={cn(
                                    iconButtonBase,
                                    iconButtonGhost
                                )}
                            >
                                <span className={iconGlow} />
                                <span className={iconContainer}>
                                    <LayoutGrid size={15} strokeWidth={2} />
                                </span>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-64 overflow-hidden p-0" align="end">
                            <div className="border-b border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel-strong)/0.64)] p-3">
                                <div className="flex items-center gap-2">
                                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft)/0.66)] text-[hsl(var(--app-accent))]">
                                        <Settings2 size={14} />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold leading-none">Display Settings</p>
                                        <p className="mt-1 text-[11px] text-muted-foreground">Customize your view</p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-2">
                                {viewMode === 'branch' && (
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger className="text-xs">
                                            <GitBranch size={14} className="mr-2" />
                                            Layout Engine
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent className="w-56">
                                            <DropdownMenuRadioGroup value={layoutMode} onValueChange={(v) => onLayoutModeChange(v as LayoutMode)}>
                                                <DropdownMenuRadioItem value="dagre" className="cursor-pointer text-xs hover:bg-muted focus:bg-muted">Dagre (Classic)</DropdownMenuRadioItem>
                                                <DropdownMenuRadioItem value="lane" className="cursor-pointer text-xs hover:bg-muted focus:bg-muted">Lane (Temporal)</DropdownMenuRadioItem>
                                                <DropdownMenuRadioItem value="tidy" className="cursor-pointer text-xs hover:bg-muted focus:bg-muted">Tidy Tree (Compact)</DropdownMenuRadioItem>
                                                <DropdownMenuRadioItem value="sugiyama" className="cursor-pointer text-xs hover:bg-muted focus:bg-muted">Sugiyama (Hierarchical)</DropdownMenuRadioItem>
                                            </DropdownMenuRadioGroup>

                                            {layoutMode === 'lane' && (
                                                <>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                        Lane Strategy
                                                    </DropdownMenuLabel>
                                                    <DropdownMenuRadioGroup value={laneStrategy} onValueChange={(v) => onLaneStrategyChange(v as LaneStrategy)}>
                                                        <DropdownMenuRadioItem value="right" className="cursor-pointer text-xs hover:bg-muted focus:bg-muted">Right Drift</DropdownMenuRadioItem>
                                                        <DropdownMenuRadioItem value="balanced" className="cursor-pointer text-xs hover:bg-muted focus:bg-muted">Balanced</DropdownMenuRadioItem>
                                                    </DropdownMenuRadioGroup>
                                                </>
                                            )}
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                )}

                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger className="text-xs">
                                        <Zap size={14} className="mr-2 text-amber-500" />
                                        Insights ({insightsCount})
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent className="w-56">
                                        <DropdownMenuCheckboxItem
                                            checked={insightsVisible}
                                            onCheckedChange={onToggleInsightsVisible}
                                            className="text-xs"
                                        >
                                            Show Insight Panel
                                        </DropdownMenuCheckboxItem>
                                        <DropdownMenuCheckboxItem
                                            checked={showInsightsInGraph}
                                            onCheckedChange={onToggleShowInsightsInGraph}
                                            className="text-xs"
                                        >
                                            Show Insights in Graph
                                        </DropdownMenuCheckboxItem>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                            </div>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <span className={toolbarDividerClass} aria-hidden="true" />

                    {/* Graph reset */}
                    <HoverCard openDelay={500} closeDelay={80}>
                        <HoverCardTrigger asChild>
                            <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={onResetLayout}
                                    className={cn(
                                        iconButtonBase,
                                        iconButtonGhost,
                                        "relative overflow-hidden",
                                        viewMode !== 'branch' && "cursor-not-allowed opacity-40",
                                        isRefreshingGraph && "border-[hsl(var(--app-accent)/0.35)] bg-[hsl(var(--app-accent-soft)/0.72)] text-[hsl(var(--app-accent))]"
                                    )}
                                    disabled={viewMode !== 'branch' || isRefreshingGraph}
                                    aria-label="Reset graph"
                                >
                                    <span className={iconGlow} />
                                    <span className={cn(
                                        iconContainer,
                                        isRefreshingGraph && "animate-spin"
                                    )}>
                                        <RotateCcw 
                                            size={15} 
                                            strokeWidth={2} 
                                            className={cn(
                                                "transition-all duration-200",
                                                isRefreshingGraph && "drop-shadow-sm"
                                            )} 
                                        />
                                    </span>
                                </button>
                                {nextRefreshLabel ? (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <span className="inline-flex">
                                                <span
                                                    className="inline-flex h-5 min-w-10 cursor-help items-center justify-center rounded-md border border-[hsl(var(--app-accent)/0.2)] bg-[hsl(var(--app-accent-soft)/0.54)] px-2 text-[10px] font-semibold text-[hsl(var(--app-accent))] [font-variant-numeric:tabular-nums]"
                                                >
                                                    {nextRefreshLabel}
                                                </span>
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom" align="end">
                                            Next automatic graph sync is due soon. Reset now to reload repo state and remount the graph canvas.
                                        </TooltipContent>
                                    </Tooltip>
                                ) : null}
                            </div>
                        </HoverCardTrigger>
                        <HoverCardContent
                            side="bottom"
                            align="end"
                            className="w-[360px] rounded-xl border-border/50 bg-background/95 p-0 shadow-2xl backdrop-blur-md"
                        >
                            <div className="space-y-3 p-3">
                                <div className="space-y-1">
                                    <div className="text-sm font-semibold text-foreground">Reset Graph</div>
                                    <div className="text-xs leading-relaxed text-muted-foreground [text-wrap:pretty]">
                                        Clears cached graph measurements, remounts the canvas, checks your local repo, and reloads graph data.
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    {computedSyncStatusItems.map((item) => (
                                        <div
                                            key={item.key}
                                            className="rounded-lg border border-border/40 bg-muted/20 px-2.5 py-2 shadow-sm"
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 space-y-0.5">
                                                    <div className="text-xs font-medium text-foreground">{item.label}</div>
                                                    <div className="text-[11px] text-muted-foreground">{item.source}</div>
                                                </div>
                                                <div className="flex shrink-0 items-center gap-1">
                                                    <span
                                                        className={cn(
                                                            "inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] font-medium [font-variant-numeric:tabular-nums]",
                                                            item.tone === 'muted'
                                                                ? "border-border/50 bg-muted/40 text-muted-foreground"
                                                                : "border-[hsl(var(--app-accent)/0.2)] bg-[hsl(var(--app-accent-soft)/0.46)] text-[hsl(var(--app-accent))]"
                                                        )}
                                                    >
                                                        {item.countdownLabel}
                                                    </span>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => onRefreshSyncItem(item.key)}
                                                        disabled={Boolean(item.isRefreshing)}
                                                        className="h-6 w-6 rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                                        aria-label={`Refresh ${item.label}`}
                                                    >
                                                        <RefreshCw size={11} className={cn(item.isRefreshing && 'animate-spin')} />
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="mt-1 text-[11px] text-muted-foreground">{item.cadenceLabel}</div>
                                            <div className="mt-1 text-[11px] leading-relaxed text-foreground/80 [text-wrap:pretty]">
                                                {item.detail}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </HoverCardContent>
                    </HoverCard>
                </div>
            </div>
        </div>
    );
}
