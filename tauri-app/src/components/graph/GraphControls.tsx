import { ReactNode, RefObject, SyntheticEvent, TouchEvent, WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    User,
    Leaf,
    ChevronLeft,
    ChevronRight,
	    Loader2,
	    CheckCircle2,
	    Brain,
	    Highlighter,
	    Trash2,
	} from 'lucide-react';
	import { cn } from '../../lib/utils';
	import type { Insight, Message, MessageHighlightColor, Summary } from '../../stores/workspaceStore';
import type { MergeTabRunIndicator } from '../../stores/integrationStore';
import { LayoutMode, LaneStrategy } from '../../hooks/graph/useGraphLayout';
import { AgentOperator, GroupOperator, MessageNodeType, TagOperator, TimePreset } from '../../hooks/graph/useTagFilter';
import { NodeHoverCardContent } from '../NodeHoverCardContent';
import { useWorkspaceProjection } from '../../hooks/useWorkspaceProjection';
import { useAgentRunHoverHydration } from '../../hooks/useAgentRunHoverHydration';
import { shouldHydrateAgentRunHover } from '../../lib/agentRunHoverHydrationPolicy';
import { useRunStatusStore } from '../../stores/runStatusStore';

export interface ThreadHoverProjectionInput {
    messages: Message[];
    summaries: Summary[];
    disabledSummaryIds: Set<string>;
}

export function ParallelThreadsIcon({ size = 15, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
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

export type ViewMode = 'branch' | 'list';

export interface LeafNodeNavigationItem {
    id: string;
    label: string;
    modelLabel: string;
    statusLabel: string;
    statusTone: 'active' | 'success' | 'danger' | 'muted';
    timestampLabel: string;
}

export interface HighlightNavigationItem {
    id: string;
    messageId: string;
    label: string;
    exact: string;
    color: MessageHighlightColor;
    timestampLabel: string;
}

export interface ThreadNavigationItem {
    threadRootId: string;
    label: string;
    fullLabel?: string;
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
    draftPreviewText?: string | null;
}

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
    insightInboxCount?: number;
    insightsEnabled?: boolean;
    insightsVisible: boolean;
    showInsightsInGraph: boolean;
    onToggleInsightsEnabled?: () => void;
    onToggleInsightsVisible: () => void;
    onToggleShowInsightsInGraph: () => void;
    renderInsightPanel?: (onClose: () => void) => ReactNode;

    // Actions
    threadItems: ThreadNavigationItem[];
    onThreadFocus: (threadRootId: string) => void;
    onThreadDoneChange: (threadRootId: string, done: boolean) => void;
    onThreadDelete?: (threadRootId: string) => void;
    doneThreadsCollapsed: boolean;
    onDoneThreadsCollapsedChange: (collapsed: boolean) => void;
    leafNodes: LeafNodeNavigationItem[];
    allLeafNodes?: LeafNodeNavigationItem[];
    onLeafNodeFocus: (id: string) => void;
    highlightItems?: HighlightNavigationItem[];
    activeHighlightId?: string | null;
    onHighlightFocus?: (item: HighlightNavigationItem) => void;
    onHighlightDelete?: (item: HighlightNavigationItem) => void;
    mergeSourceCount: number;
    mergeRunIndicator: MergeTabRunIndicator;
    mergeAttentionNonce: number;
    renderMergePanel?: (onClose: () => void) => ReactNode;
}

export const getThreadUnreadBadgeCount = (
    thread: Pick<ThreadNavigationItem, 'done' | 'unreadCompletedLeafCount'>,
): number => (thread.done ? 0 : thread.unreadCompletedLeafCount ?? 0);

export const stopNestedScrollPropagation = (event: WheelEvent | TouchEvent) => {
    event.stopPropagation();
};

export const formatThreadMetadata = (thread: ThreadNavigationItem) => (
    `${thread.turnCount} ${thread.turnCount === 1 ? 'turn' : 'turns'} · ${thread.commitCount} ${thread.commitCount === 1 ? 'commit' : 'commits'} · ${thread.updatedLabel}`
);

const stopThreadHoverCardControlEvent = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
};

const stopThreadHoverCardPropagation = (event: SyntheticEvent) => {
    event.stopPropagation();
};

export function ThreadUnreadBadge({
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
    const previewRunStatus = useRunStatusStore(state => previewNodeId ? state.byNodeId[previewNodeId]?.status ?? null : null);
    useAgentRunHoverHydration(previewNodeId, shouldHydrateAgentRunHover(previewEntity, previewRunStatus));
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

function ThreadDraftHoverCardContent({ draftPreviewText }: { draftPreviewText: string }) {
    return (
        <div
            data-agentree-thread-hover-card="true"
            className="w-[360px] max-w-[calc(100vw-48px)] rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.98)] p-3 text-left shadow-xl shadow-black/10 backdrop-blur-md"
        >
            <div className="mb-2 flex items-center gap-1.5 border-b border-[hsl(var(--app-border)/0.4)] pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                <User size={12} strokeWidth={2.1} />
                <span>Draft</span>
            </div>
            <p className="max-h-48 overflow-hidden whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground">
                {draftPreviewText}
            </p>
        </div>
    );
}

export function ThreadNodeHoverCard({
    thread,
    projectionInput,
    side,
    children,
}: ThreadNodeHoverCardProps) {
    const hoverContentRef = useRef<HTMLDivElement | null>(null);
    const pointerInsideHoverContentRef = useRef(false);
    const [hoverOpen, setHoverOpen] = useState(false);
    const draftPreviewText = thread.draftPreviewText?.trim() || null;
    const previewNodeIds = useMemo(() => {
        const nodeIds = thread.previewNodeIds ?? [];
        if (!projectionInput) return nodeIds;
        const assistantMessageIds = new Set(
            projectionInput.messages
                .filter((message) => message.role === 'assistant')
                .map((message) => message.id),
        );
        return nodeIds.filter((nodeId) => assistantMessageIds.has(nodeId));
    }, [projectionInput, thread.previewNodeIds]);
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

    const closeHoverCard = () => {
        pointerInsideHoverContentRef.current = false;
        setHoverOpen(false);
    };

    const closeHoverCardUnlessFocusRemainsInside = () => {
        const hoverContent = hoverContentRef.current;
        if (hoverContent && hoverContent.contains(document.activeElement)) return;
        closeHoverCard();
    };

    useEffect(() => {
        if (!hoverOpen) return;
        window.addEventListener('agentree:graph-viewport-interaction-start', closeHoverCard);
        return () => {
            window.removeEventListener('agentree:graph-viewport-interaction-start', closeHoverCard);
        };
    }, [hoverOpen]);

    useEffect(() => {
        if (!hoverOpen) return;
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
    }, [hoverOpen]);

    const hasProjectedPreview = Boolean(projectionInput && previewNodeIds.length > 0);
    if (!hasProjectedPreview && !draftPreviewText) {
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
                if (pointerInsideHoverContentRef.current) {
                    setHoverOpen(true);
                    return;
                }
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
                onPointerEnter={() => {
                    pointerInsideHoverContentRef.current = true;
                }}
                onPointerLeave={() => {
                    closeHoverCardUnlessFocusRemainsInside();
                }}
                onPointerDownCapture={(event) => event.stopPropagation()}
                onMouseDownCapture={(event) => event.stopPropagation()}
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
                {hoverOpen && projectionInput && previewNodeIds.length > 0 ? (
                    <ThreadNodeHoverCardContent
                        thread={thread}
                        projectionInput={projectionInput}
                        previewNodeIds={previewNodeIds}
                        previewIndex={previewIndex}
                        onPreviewIndexChange={setPreviewIndex}
                    />
                ) : hoverOpen && draftPreviewText ? (
                    <ThreadDraftHoverCardContent draftPreviewText={draftPreviewText} />
                ) : null}
            </HoverCardContent>
        </HoverCard>
    );
}


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
    insightInboxCount,
    insightsEnabled = true,
    insightsVisible,
    showInsightsInGraph,
    onToggleInsightsEnabled,
    onToggleInsightsVisible,
    onToggleShowInsightsInGraph,
    renderInsightPanel,
	    leafNodes,
	    allLeafNodes,
	    onLeafNodeFocus,
	    highlightItems = [],
	    activeHighlightId = null,
	    onHighlightFocus,
	    onHighlightDelete,
	    mergeSourceCount,
    mergeRunIndicator,
    mergeAttentionNonce,
    renderMergePanel,
}: GraphControlsProps) {
    const insightsCount = insightInboxCount ?? insights.length;
    const [agentSearch, setAgentSearch] = useState('');
    const [tagSearch, setTagSearch] = useState('');
    const [leafNodeScope, setLeafNodeScope] = useState<'all' | 'current'>('all');
    const [mergeDropdownOpen, setMergeDropdownOpen] = useState(false);
    const [mergeAttentionActive, setMergeAttentionActive] = useState(false);
    const lastMergeAttentionNonceRef = useRef(mergeAttentionNonce);
    useEffect(() => {
        if (mergeAttentionNonce <= 0 || mergeAttentionNonce === lastMergeAttentionNonceRef.current) return;
        lastMergeAttentionNonceRef.current = mergeAttentionNonce;
        setMergeAttentionActive(true);
        const timeoutId = window.setTimeout(() => setMergeAttentionActive(false), 1600);
        return () => window.clearTimeout(timeoutId);
    }, [mergeAttentionNonce]);
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
    const insightTooltipLabel = insightsCount > 0
        ? `${insightsCount} background attention ${insightsCount === 1 ? 'item' : 'items'}`
        : 'Attention inbox is empty';
    const handleInsightInboxOpenChange = useCallback((open: boolean) => {
        if (open === insightsVisible) return;
        onToggleInsightsVisible();
    }, [insightsVisible, onToggleInsightsVisible]);
	    const leafStatusToneClass = {
	        active: 'bg-amber-500/12 text-amber-700 dark:bg-amber-400/12 dark:text-amber-300',
	        success: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300',
	        danger: 'bg-red-500/12 text-red-700 dark:bg-red-400/12 dark:text-red-300',
	        muted: 'bg-slate-500/12 text-slate-600 dark:bg-slate-400/12 dark:text-slate-300',
	    };
	    const highlightColorClass: Record<MessageHighlightColor, string> = {
	        yellow: 'bg-yellow-300 ring-yellow-500/40',
	        green: 'bg-green-300 ring-green-500/40',
	        blue: 'bg-blue-300 ring-blue-500/40',
	        rose: 'bg-rose-300 ring-rose-500/40',
	    };
	    const visibleLeafNodes = leafNodeScope === 'all' ? (allLeafNodes ?? leafNodes) : leafNodes;
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
                            onClick={() => onViewModeChange('list')}
                            className={cn(
                                "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-150",
                                viewMode === 'list'
                                    ? "bg-[hsl(var(--app-panel))] text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72),0_1px_2px_hsl(var(--foreground)/0.05)]"
                                    : "text-muted-foreground hover:bg-[hsl(var(--app-panel)/0.58)] hover:text-foreground"
                            )}
                            title="List View"
                        >
                            <CalendarDays className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">List</span>
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

                    <Popover open={insightsVisible} onOpenChange={handleInsightInboxOpenChange}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <PopoverTrigger asChild>
                                    <button
                                        type="button"
                                        className={cn(
                                            iconButtonBase,
                                            toolbarButtonClass,
                                            'h-8 w-8 px-0',
                                            insightsVisible ? activeToolbarButtonClass : '',
                                        )}
                                        aria-label={`Attention inbox (${insightsCount})`}
                                        title="Background attention inbox."
                                    >
                                        <span className={iconGlow} />
                                        <span className={iconContainer}>
                                            <Brain size={15} strokeWidth={2} />
                                        </span>
                                        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[hsl(var(--app-border)/0.7)] bg-[hsl(var(--background)/0.92)] px-1 text-[9px] font-semibold leading-none tabular-nums text-foreground shadow-sm">
                                            {insightsCount > 99 ? '99+' : insightsCount}
                                        </span>
                                    </button>
                                </PopoverTrigger>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" align="end">
                                {insightTooltipLabel}
                            </TooltipContent>
                        </Tooltip>
                        <PopoverContent
                            align="end"
                            side="bottom"
                            sideOffset={10}
                            collisionPadding={12}
                            className="z-50 h-[min(760px,calc(100vh-5rem))] w-[min(440px,calc(100vw-1.5rem))] overflow-hidden rounded-[22px] border border-slate-200/82 bg-slate-50/96 p-0 shadow-[0_30px_90px_-46px_rgba(15,23,42,0.66),0_14px_34px_-24px_rgba(15,23,42,0.34),inset_0_1px_0_rgba(255,255,255,0.76)] backdrop-blur-xl dark:border-slate-800/88 dark:bg-slate-950/96 dark:shadow-[0_30px_92px_-46px_rgba(0,0,0,0.82),inset_0_1px_0_rgba(255,255,255,0.04)]"
                            onOpenAutoFocus={(event) => event.preventDefault()}
                            onWheelCapture={stopNestedScrollPropagation}
                            onTouchMoveCapture={stopNestedScrollPropagation}
                        >
                            {renderInsightPanel ? (
                                renderInsightPanel(() => handleInsightInboxOpenChange(false))
                            ) : (
                                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                                    Attention inbox is unavailable in this view.
                                </div>
                            )}
                        </PopoverContent>
                    </Popover>

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

	                    {/* Highlights */}
	                    <DropdownMenu>
	                        <Tooltip>
	                            <TooltipTrigger asChild>
	                                <DropdownMenuTrigger asChild>
	                                    <button
	                                        type="button"
	                                        className={cn(
	                                            iconButtonBase,
	                                            iconButtonGhost,
	                                            highlightItems.length > 0 && "text-foreground"
	                                        )}
	                                        aria-label="Highlights"
	                                    >
	                                        <span className={iconGlow} />
	                                        <span className={iconContainer}>
	                                            <Highlighter size={15} strokeWidth={2} />
	                                        </span>
	                                        {highlightItems.length > 0 ? (
	                                            <span className="absolute -right-1 -top-1 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full border border-background bg-yellow-400 px-1 font-mono text-[8px] font-bold leading-none text-yellow-950 shadow-sm">
	                                                {highlightItems.length > 99 ? '99+' : highlightItems.length}
	                                            </span>
	                                        ) : null}
	                                    </button>
	                                </DropdownMenuTrigger>
	                            </TooltipTrigger>
	                            <TooltipContent side="bottom" align="end">
	                                Saved text highlights
	                            </TooltipContent>
	                        </Tooltip>
	                        <DropdownMenuContent className="w-96 overflow-hidden p-0" align="end">
	                            <div className="border-b border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel-strong)/0.64)] p-3">
	                                <div className="flex items-center gap-2">
	                                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-yellow-400/18 text-yellow-700 dark:text-yellow-300">
	                                        <Highlighter size={14} />
	                                    </div>
	                                    <div>
	                                        <p className="text-sm font-semibold leading-none">Highlights</p>
	                                        <p className="mt-1 text-[11px] text-muted-foreground">
	                                            {highlightItems.length} saved text ranges
	                                        </p>
	                                    </div>
	                                </div>
	                            </div>
	                            {highlightItems.length > 0 ? (
	                                <div
	                                    className="max-h-80 overflow-y-auto overscroll-contain p-1.5 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
	                                    onWheelCapture={stopNestedScrollPropagation}
	                                    onTouchMoveCapture={stopNestedScrollPropagation}
	                                >
	                                    {highlightItems.map((item) => (
	                                        <DropdownMenuItem
	                                            key={item.id}
	                                            onClick={() => onHighlightFocus?.(item)}
	                                            className={cn(
	                                                "group/item flex cursor-pointer items-start gap-2 rounded-md px-2 py-2",
	                                                activeHighlightId === item.id && "bg-yellow-400/10"
	                                            )}
	                                        >
	                                            <span className={cn("mt-0.5 h-3 w-3 shrink-0 rounded-full ring-2", highlightColorClass[item.color])} />
	                                            <span className="min-w-0 flex-1">
	                                                <span className="block truncate text-xs font-medium text-foreground">
	                                                    {item.exact}
	                                                </span>
	                                                <span className="mt-1 flex min-w-0 items-center gap-1.5">
	                                                    <span className="min-w-0 truncate text-[10px] text-muted-foreground">
	                                                        {item.label}
	                                                    </span>
	                                                    <span className="shrink-0 text-[10px] text-muted-foreground/80">
	                                                        {item.timestampLabel}
	                                                    </span>
	                                                </span>
	                                            </span>
	                                            {onHighlightDelete ? (
	                                                <button
	                                                    type="button"
	                                                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover/item:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/30"
	                                                    aria-label="Delete highlight"
	                                                    title="Delete highlight"
	                                                    onClick={(event) => {
	                                                        event.preventDefault();
	                                                        event.stopPropagation();
	                                                        onHighlightDelete(item);
	                                                    }}
	                                                >
	                                                    <Trash2 size={12} />
	                                                </button>
	                                            ) : null}
	                                        </DropdownMenuItem>
	                                    ))}
	                                </div>
	                            ) : (
	                                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
	                                    No highlights yet
	                                </div>
	                            )}
	                        </DropdownMenuContent>
	                    </DropdownMenu>

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
                                            {visibleLeafNodes.length} branch endpoints, newest first
                                        </p>
                                    </div>
                                </div>
                                <div
                                    className="mt-3 grid grid-cols-2 rounded-md border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.5)] p-0.5"
                                    role="group"
                                    aria-label="Leaf node thread scope"
                                >
                                    {(['all', 'current'] as const).map((scope) => (
                                        <button
                                            key={scope}
                                            type="button"
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                setLeafNodeScope(scope);
                                            }}
                                            className={cn(
                                                "h-7 rounded-[5px] text-[11px] font-medium transition-[background-color,color,box-shadow]",
                                                leafNodeScope === scope
                                                    ? "bg-[hsl(var(--app-panel))] text-foreground shadow-sm"
                                                    : "text-muted-foreground hover:text-foreground",
                                            )}
                                            aria-pressed={leafNodeScope === scope}
                                        >
                                            {scope === 'all' ? 'All threads' : 'This thread'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {visibleLeafNodes.length > 0 ? (
                                <div
                                    className="max-h-80 overflow-y-auto overscroll-contain p-1.5 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
                                    onWheelCapture={stopNestedScrollPropagation}
                                    onTouchMoveCapture={stopNestedScrollPropagation}
                                >
                                    {visibleLeafNodes.map((node) => (
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
                                        Insights
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent className="w-56">
                                        <DropdownMenuCheckboxItem
                                            checked={insightsEnabled}
                                            onCheckedChange={() => onToggleInsightsEnabled?.()}
                                            className="text-xs"
                                        >
                                            Generate Insights
                                        </DropdownMenuCheckboxItem>
                                        <DropdownMenuCheckboxItem
                                            checked={showInsightsInGraph}
                                            onCheckedChange={onToggleShowInsightsInGraph}
                                            className="text-xs"
                                        >
                                            Show Insight Nodes in Graph
                                        </DropdownMenuCheckboxItem>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                            </div>
                        </DropdownMenuContent>
                    </DropdownMenu>

                </div>
            </div>
        </div>
    );
}
