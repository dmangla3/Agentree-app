import { useMemo, useRef } from 'react';
import { Node, Edge, Position } from '@xyflow/react';
import { isActiveAgentStatus } from '@shared/agentStatus';
import { BranchPointer, Message, Summary, Insight } from '../../stores/workspaceStore';
import type { WorkspaceProjection } from '../../domain/workspaceProjection';
import { collapseRenderedFocusRoute } from '../../domain/focusRoute';
import { recordPerfEvent } from '../../lib/perfRecorder';
import { recordFundamentalCounter } from '../../perf/fundamentalCounters';
import {
    createMessageHeightKey,
    hasAssistantOutputPreview,
    mapMessagesToGraphElements,
    getLayoutedElements,
    getLaneLayoutedElements,
    getTidyTreeLayoutedElements,
    getSugiyamaLayoutedElements,
} from '../../lib/graphUtils';
import { resolveNodeState } from '../../lib/runStateResolver';
import { getMessageOutputCommitSha } from '../../lib/graph/commitAccessors';
import { getAssistantCommitCount, getToolCallCount } from '../../domain/nodes';
import type { GraphNodeSectionId } from '../../components/graph/GraphCanvasIndexPanel';
import type { FocusTriggerMetrics } from '../../types/nodes';
import {
    getSubgraphThreadDelegationRequestId,
    getSubgraphThreadLinkTargetId,
} from '../../lib/graphSubgraphThreads';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type LayoutMode = 'dagre' | 'lane' | 'tidy' | 'sugiyama';
export type LaneStrategy = 'right' | 'balanced';

export interface UseGraphLayoutOptions {
    projection: WorkspaceProjection;
    messages: Message[];
    attachedThreadMessages?: Message[];
    summaries: Summary[];
    measuredNodeHeights: Map<string, number>;
    layoutMode: LayoutMode;
    laneStrategy: LaneStrategy;
    disabledSummaryIds: Set<string>;
    focusedMessageId: string | null;
    contextPathMessageIds: Set<string>;
    composerBaseCommitSha?: string | null;
    matchingMessageIds: Set<string>;
    filterActive: boolean;
    hasNodeTypeFilter: boolean;
    keepAncestors: boolean;
    keepDescendants: boolean;
    constrainedCommitFiltering?: boolean;
    pinnedCommitShas?: Set<string>;
    hiddenThreadRootIds?: Set<string>;
    layoutCacheScopeKey?: string;
    visibleNodeSections: Set<GraphNodeSectionId>;
    insights: Insight[];
    showInsightsInGraph: boolean;
    showMergedAgentreeCommits?: boolean;
    workspaceRepoMap: Map<string, string | null>;
    branchPointersByNodeId: Map<string, BranchPointer[]>;
    resetNonce?: number;
    onToggleSummary: (id: string) => void;
    onToggleCollapse: (id: string, collapsed: boolean) => void;
    onFocus: (id: string, metrics?: FocusTriggerMetrics) => void;
    onOpenThread?: (threadRootId: string) => void;
    onSelect: (id: string, multi: boolean) => void;
    onContextMenu: (id: string, e: React.MouseEvent) => void;
    onMeasureNodeHeight?: (id: string, height: number) => void;
}

export interface UseGraphLayoutResult {
    nodes: Node<any>[];
    edges: Edge[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const HEIGHT_FINGERPRINT_TEXT_BUCKET_SIZE = 36;
const MAX_LAYOUT_SCOPE_CACHE_ENTRIES = 8;

const getRenderedNodeWidth = (node: Node<any>): number => {
    if (typeof node.style?.width === 'number') return node.style.width;
    if (typeof (node as any).width === 'number') return (node as any).width;
    return 0;
};

const getNodeCenterX = (node: Node<any>): number => (
    node.position.x + getRenderedNodeWidth(node) / 2
);

export const isSyntheticGeneratedCommitSidecarNode = (node: Node<any>): boolean => {
    const entity = node.data?.entity;
    return node.type === 'commit_message' &&
        entity?.kind === 'commit_message' &&
        typeof entity.messageId === 'string' &&
        typeof entity.focusMessageId === 'string' &&
        entity.messageId !== entity.focusMessageId;
};

export const isComposerBaseCommitVisualNode = (
    node: Node<any>,
    composerBaseCommitSha: string | null | undefined
): boolean => {
    if (!composerBaseCommitSha) return false;
    const data = node.data;
    if (data?.commit?.sha === composerBaseCommitSha) return true;
    if (Array.isArray(data?.group?.commitShas) && data.group.commitShas.includes(composerBaseCommitSha)) return true;
    if (node.type !== 'commit_message') return false;

    const message = data?.message ?? data?.entity?.message;
    return getMessageOutputCommitSha(message) === composerBaseCommitSha;
};

export const isGraphNodeVisuallyFocused = (
    node: Node<any>,
    focusedMessageId: string | null
): boolean => {
    const data = node.data;
    const focusId = data.entity?.focusMessageId ?? data.entity?.messageId ?? node.id;
    const isFocused =
        focusId === focusedMessageId ||
        data.commit?.sha === focusedMessageId ||
        data.group?.commitShas?.includes(focusedMessageId || '') ||
        (data.batch?.messageIds.includes(focusedMessageId || ''));

    return isFocused && !isSyntheticGeneratedCommitSidecarNode(node);
};

const applyDirectionalEdgeHandles = (nodes: Node<any>[], edges: Edge[]): Edge[] => {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const sameLaneThreshold = 24;

    return edges.map((edge) => {
        if (edge.type === 'summaryEdge' || edge.type === 'smoothstep') return edge;
        const sourceNode = nodesById.get(edge.source);
        const targetNode = nodesById.get(edge.target);
        if (!sourceNode || !targetNode || targetNode.type === 'summary_block') return edge;

        const sourceCenterX = getNodeCenterX(sourceNode);
        const targetCenterX = getNodeCenterX(targetNode);
        const targetHandle = Math.abs(sourceCenterX - targetCenterX) <= sameLaneThreshold
            ? 'top-target'
            : sourceCenterX < targetCenterX
                ? 'left-target'
                : 'right-target';

        return {
            ...edge,
            sourceHandle: edge.sourceHandle ?? 'bottom-source',
            targetHandle,
        };
    });
};

const getHeightFingerprintTextBucket = (value: string | null | undefined, maxBucket: number): number => {
    const length = (value || '').trim().length;
    if (length === 0) return 0;
    return Math.min(maxBucket, Math.ceil(length / HEIGHT_FINGERPRINT_TEXT_BUCKET_SIZE));
};

const createMessagesFingerprint = (messages: Message[]): string => {
    if (!messages || messages.length === 0) return '';
    return messages.map((m) => [
        m.id,
        m.parentId || '',
        m.parentId || '',
        m.role,
        m.collapsed || false,
        getMessageOutputCommitSha(m) || '',
        hasAssistantOutputPreview(m, 'assistant_message') ? 1 : 0,
        getSubgraphThreadDelegationRequestId(m) || '',
        getSubgraphThreadLinkTargetId(m) || '',
        getSubgraphThreadDelegationRequestId(m) ? (m.content || '').trim() : '',
    ].join('|')).join(';');
};

const createMessagesVisualFingerprint = (messages: Message[]): string => {
    if (!messages || messages.length === 0) return '';
    return messages.map((m) => [
        m.id,
        m.updatedAt || '',
        m.status || '',
        m.aiLabel?.trim() || '',
        (m.content || '').trim().length,
        (m.content || '').trim().slice(0, 96),
    ].join('|')).join(';');
};

const createAttachedThreadMessagesFingerprint = (messages: Message[]): string => (
    messages.map((message) => [
        message.id,
        message.parentId || '',
        message.role,
        message.status || '',
        (message.execution_data as any)?.last_terminal_status || '',
        getSubgraphThreadDelegationRequestId(message) || '',
        getSubgraphThreadLinkTargetId(message) || '',
        getSubgraphThreadDelegationRequestId(message) ? (message.content || '').trim() : '',
    ].join('|')).join(';')
);

const readChangedFilesCount = (message: Message): number | undefined => {
    const files = (message.execution_data as any)?.files_changed;
    return Array.isArray(files) && files.length > 0 ? files.length : undefined;
};

const DEFAULT_EDGE_STROKE_WIDTH = 4;
const CONTEXT_PATH_EDGE_STROKE_WIDTH = 7;
const DEFAULT_SUMMARY_EDGE_STROKE_WIDTH = 4;
const FOCUSED_SUMMARY_EDGE_STROKE_WIDTH = 6.5;
const ACTIVE_EDGE_STROKE = '#4f46e5';
const INACTIVE_EDGE_STROKE = '#64748b';
const COMMIT_PARENT_EDGE_STROKE = '#059669';
const BASE_USED_EDGE_STROKE = '#d97706';

export const getGraphEdgeVisualZIndex = ({
    isOnContextPath,
    isSummaryEdge,
    relationship,
    isSecondaryGitParent,
}: {
    isOnContextPath: boolean;
    isSummaryEdge: boolean;
    relationship?: string;
    isSecondaryGitParent: boolean;
}): number => {
    if (isOnContextPath) return 40;
    if (isSummaryEdge) return -3;
    if (relationship === 'git-parent' && isSecondaryGitParent) return -1;
    return 0;
};

const createSummariesFingerprint = (summaries: Summary[]): string => {
    if (!summaries || summaries.length === 0) return '';
    return summaries.map((s) => [
        s.id,
        s.startMessageId,
        s.endMessageId,
        getHeightFingerprintTextBucket(s.content, 3),
        s.tokenCountAfter && s.tokenCountAfter > 0 ? 1 : 0,
    ].join('|')).join(';');
};

const createFilterFingerprint = (matchingMessageIds: Set<string>): string => {
    if (!matchingMessageIds || matchingMessageIds.size === 0) return '';
    return Array.from(matchingMessageIds).sort().join(',');
};

const createCommitProjectionFingerprint = (projection: WorkspaceProjection): string => (
    [
        projection.commitLaneRows.map((row) => [row.type, row.commitSha ?? '', row.groupId ?? '', row.sortTs].join(':')).join(';'),
        projection.layoutDerivedCommitGroups.map((group) => [group.groupId, group.commitShas.join(','), group.expanded ? 1 : 0].join(':')).join(';'),
        Array.from(projection.commitBySha.values())
            .map((commit) => `${commit.sha}:${commit.isMerged ? 1 : 0}`)
            .sort()
            .join(';'),
    ].join('|')
);

interface LayoutCacheKey {
    messagesFingerprint: string;
    attachedThreadMessagesFingerprint: string;
    summariesFingerprint: string;
    disabledSummaryIdsFingerprint: string;
    filterFingerprint: string;
    filterActive: boolean;
    hasNodeTypeFilter: boolean;
    keepAncestors: boolean;
    keepDescendants: boolean;
    constrainedCommitFiltering: boolean;
    pinnedCommitShasFingerprint: string;
    hiddenThreadRootIdsFingerprint: string;
    visibleNodeSectionsFingerprint: string;
    layoutMode: string;
    laneStrategy: string;
    insightsFingerprint: string;
    showInsightsInGraph: boolean;
    showMergedAgentreeCommits: boolean;
    resetNonce: number;
    commitProjectionFingerprint: string;
}

interface LayoutCacheEntry {
    key: LayoutCacheKey;
    nodes: Node<any>[];
    edges: Edge[];
}

interface VisualCacheEntry {
    cachedNodes: Node<any>[];
    cachedEdges: Edge[];
    messagesFingerprint: string;
    messagesVisualFingerprint: string;
    filterFingerprint: string;
    filterActive: boolean;
    hasNodeTypeFilter: boolean;
    focusedMessageId: string | null;
    contextPathFingerprint: string;
    composerBaseCommitSha: string | null;
    visualFingerprint: string;
    onFocus: UseGraphLayoutOptions['onFocus'];
    onOpenThread: UseGraphLayoutOptions['onOpenThread'];
    onSelect: UseGraphLayoutOptions['onSelect'];
    onContextMenu: UseGraphLayoutOptions['onContextMenu'];
    result: UseGraphLayoutResult;
}

const cacheKeysEqual = (a: LayoutCacheKey, b: LayoutCacheKey): boolean => {
    return (
        a.messagesFingerprint === b.messagesFingerprint &&
        a.attachedThreadMessagesFingerprint === b.attachedThreadMessagesFingerprint &&
        a.summariesFingerprint === b.summariesFingerprint &&
        a.disabledSummaryIdsFingerprint === b.disabledSummaryIdsFingerprint &&
        a.filterFingerprint === b.filterFingerprint &&
        a.filterActive === b.filterActive &&
        a.hasNodeTypeFilter === b.hasNodeTypeFilter &&
        a.keepAncestors === b.keepAncestors &&
        a.keepDescendants === b.keepDescendants &&
        a.constrainedCommitFiltering === b.constrainedCommitFiltering &&
        a.pinnedCommitShasFingerprint === b.pinnedCommitShasFingerprint &&
        a.hiddenThreadRootIdsFingerprint === b.hiddenThreadRootIdsFingerprint &&
        a.visibleNodeSectionsFingerprint === b.visibleNodeSectionsFingerprint &&
        a.layoutMode === b.layoutMode &&
        a.laneStrategy === b.laneStrategy &&
        a.insightsFingerprint === b.insightsFingerprint &&
        a.showInsightsInGraph === b.showInsightsInGraph &&
        a.showMergedAgentreeCommits === b.showMergedAgentreeCommits &&
        a.resetNonce === b.resetNonce &&
        a.commitProjectionFingerprint === b.commitProjectionFingerprint
    );
};

const changedLayoutKeyFields = (previous: LayoutCacheKey | null | undefined, current: LayoutCacheKey): string[] => {
    if (!previous) return ['initial'];
    return (Object.keys(current) as Array<keyof LayoutCacheKey>).filter((key) => previous[key] !== current[key]);
};

const recordGraphLayoutAttribution = (
    phase: 'cache-hit' | 'visual-only' | 'recomputed',
    durationMs: number,
    keyChanges: string[],
    details: {
        messageCount: number;
        summaryCount: number;
        nodeCount?: number;
        edgeCount?: number;
        layoutMode: string;
        viewportInteracting?: boolean;
        visualChanges?: Record<string, boolean> | null;
        visualChangeKey?: string;
    }
) => {
    recordFundamentalCounter('graph.layout', {
        phase,
        keyChanges,
        ...details,
    }, durationMs);
    if (phase !== 'recomputed' && durationMs < 25) return;
    recordPerfEvent('graph.layout.attribution', {
        phase,
        durationMs: Number(durationMs.toFixed(2)),
        keyChanges,
        ...details,
    }, { source: 'useGraphLayout' });
};

// ═══════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════

export function useGraphLayout(options: UseGraphLayoutOptions): UseGraphLayoutResult {
    const {
        projection,
        messages,
        attachedThreadMessages = messages,
        summaries,
        measuredNodeHeights,
        layoutMode,
        laneStrategy,
        disabledSummaryIds,
        focusedMessageId,
        contextPathMessageIds,
        composerBaseCommitSha = null,
        matchingMessageIds,
        filterActive,
        hasNodeTypeFilter,
        keepAncestors,
        keepDescendants,
        constrainedCommitFiltering = false,
        pinnedCommitShas = new Set<string>(),
        hiddenThreadRootIds = new Set<string>(),
        layoutCacheScopeKey = 'default',
        visibleNodeSections,
        insights,
        showInsightsInGraph,
        showMergedAgentreeCommits = false,
        workspaceRepoMap,
        branchPointersByNodeId,
        resetNonce = 0,
        onToggleSummary,
        onToggleCollapse,
        onFocus,
        onOpenThread,
        onSelect,
        onContextMenu,
        onMeasureNodeHeight
    } = options;

    const layoutCacheByScopeRef = useRef(new Map<string, LayoutCacheEntry>());
    const visualCacheByScopeRef = useRef(new Map<string, VisualCacheEntry>());

    const { nodes, edges } = useMemo(() => {
        const startedAt = performance.now();
        const layoutCacheEntry = layoutCacheByScopeRef.current.get(layoutCacheScopeKey) ?? null;
        const visualCacheEntry = visualCacheByScopeRef.current.get(layoutCacheScopeKey) ?? null;
        const rememberLayoutCacheEntry = (entry: LayoutCacheEntry) => {
            const cache = layoutCacheByScopeRef.current;
            cache.delete(layoutCacheScopeKey);
            cache.set(layoutCacheScopeKey, entry);
            while (cache.size > MAX_LAYOUT_SCOPE_CACHE_ENTRIES) {
                const oldestKey = cache.keys().next().value as string | undefined;
                if (!oldestKey) break;
                cache.delete(oldestKey);
                visualCacheByScopeRef.current.delete(oldestKey);
            }
        };
        const rememberVisualCacheEntry = (entry: VisualCacheEntry) => {
            const cache = visualCacheByScopeRef.current;
            cache.delete(layoutCacheScopeKey);
            cache.set(layoutCacheScopeKey, entry);
        };
        const visualFingerprint = '';
        const contextPathFingerprint = Array.from(contextPathMessageIds).sort().join(',');
        const messagesVisualFingerprint = createMessagesVisualFingerprint(messages);
        const currentCacheKey: LayoutCacheKey = {
            messagesFingerprint: createMessagesFingerprint(messages),
            attachedThreadMessagesFingerprint: createAttachedThreadMessagesFingerprint(attachedThreadMessages),
            summariesFingerprint: createSummariesFingerprint(summaries),
            disabledSummaryIdsFingerprint: Array.from(disabledSummaryIds).sort().join(','),
            filterFingerprint: createFilterFingerprint(matchingMessageIds),
            filterActive,
            hasNodeTypeFilter,
            keepAncestors,
            keepDescendants,
            constrainedCommitFiltering,
            pinnedCommitShasFingerprint: Array.from(pinnedCommitShas).sort().join(','),
            hiddenThreadRootIdsFingerprint: Array.from(hiddenThreadRootIds).sort().join(','),
            visibleNodeSectionsFingerprint: Array.from(visibleNodeSections).sort().join(','),
            layoutMode,
            laneStrategy,
            insightsFingerprint: insights.map((insight) => insight.id).sort().join(','),
            showInsightsInGraph,
            showMergedAgentreeCommits,
            resetNonce,
            commitProjectionFingerprint: createCommitProjectionFingerprint(projection),
        };
        const keyChanges = changedLayoutKeyFields(layoutCacheEntry?.key, currentCacheKey);

        if (layoutCacheEntry && cacheKeysEqual(layoutCacheEntry.key, currentCacheKey)) {
            const previousVisual = visualCacheEntry;
            const visualChanges = previousVisual ? {
                cachedNodesChanged: previousVisual.cachedNodes !== layoutCacheEntry.nodes,
                cachedEdgesChanged: previousVisual.cachedEdges !== layoutCacheEntry.edges,
                messagesFingerprintChanged: previousVisual.messagesFingerprint !== currentCacheKey.messagesFingerprint,
                messagesVisualFingerprintChanged: previousVisual.messagesVisualFingerprint !== messagesVisualFingerprint,
                filterFingerprintChanged: previousVisual.filterFingerprint !== currentCacheKey.filterFingerprint,
                filterActiveChanged: previousVisual.filterActive !== currentCacheKey.filterActive,
                hasNodeTypeFilterChanged: previousVisual.hasNodeTypeFilter !== currentCacheKey.hasNodeTypeFilter,
                focusedMessageChanged: previousVisual.focusedMessageId !== focusedMessageId,
                contextPathChanged: previousVisual.contextPathFingerprint !== contextPathFingerprint,
                composerBaseCommitChanged: previousVisual.composerBaseCommitSha !== composerBaseCommitSha,
                visualFingerprintChanged: previousVisual.visualFingerprint !== visualFingerprint,
                onFocusChanged: previousVisual.onFocus !== onFocus,
                onOpenThreadChanged: previousVisual.onOpenThread !== onOpenThread,
                onSelectChanged: previousVisual.onSelect !== onSelect,
                onContextMenuChanged: previousVisual.onContextMenu !== onContextMenu,
            } : null;
            const visualChangeKey = visualChanges
                ? Object.entries(visualChanges)
                    .filter(([, changed]) => changed)
                    .map(([key]) => key)
                    .join('+') || 'unknown'
                : 'no-previous-visual';
            if (
                previousVisual &&
                previousVisual.cachedNodes === layoutCacheEntry.nodes &&
                previousVisual.cachedEdges === layoutCacheEntry.edges &&
                previousVisual.messagesFingerprint === currentCacheKey.messagesFingerprint &&
                previousVisual.messagesVisualFingerprint === messagesVisualFingerprint &&
                previousVisual.filterFingerprint === currentCacheKey.filterFingerprint &&
                previousVisual.filterActive === currentCacheKey.filterActive &&
                previousVisual.hasNodeTypeFilter === currentCacheKey.hasNodeTypeFilter &&
                previousVisual.focusedMessageId === focusedMessageId &&
                previousVisual.contextPathFingerprint === contextPathFingerprint &&
                previousVisual.composerBaseCommitSha === composerBaseCommitSha &&
                previousVisual.visualFingerprint === visualFingerprint &&
                previousVisual.onFocus === onFocus &&
                previousVisual.onOpenThread === onOpenThread &&
                previousVisual.onSelect === onSelect &&
                previousVisual.onContextMenu === onContextMenu
            ) {
                recordGraphLayoutAttribution('cache-hit', performance.now() - startedAt, keyChanges, {
                    messageCount: messages.length,
                    summaryCount: summaries.length,
                    nodeCount: layoutCacheEntry.nodes.length,
                    edgeCount: layoutCacheEntry.edges.length,
                    layoutMode,
                });
                return previousVisual.result;
            }

            const visualResult = applyVisualProperties(
                layoutCacheEntry.nodes,
                layoutCacheEntry.edges,
                messages,
                projection,
                focusedMessageId,
                contextPathMessageIds,
                composerBaseCommitSha,
                matchingMessageIds,
                filterActive,
                hasNodeTypeFilter,
                keepAncestors,
                keepDescendants,
                onFocus,
                onOpenThread,
                onSelect,
                onContextMenu,
                previousVisual?.result ?? null
            );
            rememberVisualCacheEntry({
                cachedNodes: layoutCacheEntry.nodes,
                cachedEdges: layoutCacheEntry.edges,
                messagesFingerprint: currentCacheKey.messagesFingerprint,
                messagesVisualFingerprint,
                filterFingerprint: currentCacheKey.filterFingerprint,
                filterActive: currentCacheKey.filterActive,
                hasNodeTypeFilter: currentCacheKey.hasNodeTypeFilter,
                focusedMessageId,
                contextPathFingerprint,
                composerBaseCommitSha,
                visualFingerprint,
                onFocus,
                onOpenThread,
                onSelect,
                onContextMenu,
                result: visualResult,
            });
            recordGraphLayoutAttribution('visual-only', performance.now() - startedAt, keyChanges, {
                messageCount: messages.length,
                summaryCount: summaries.length,
                nodeCount: layoutCacheEntry.nodes.length,
                edgeCount: layoutCacheEntry.edges.length,
                layoutMode,
                visualChanges,
                visualChangeKey,
            });
            return visualResult;
        }

        const { nodes: mappedNodes, edges: mappedEdges } = mapMessagesToGraphElements(
                projection,
                messages,
                summaries,
                null,
                contextPathMessageIds,
                matchingMessageIds,
                filterActive,
                hasNodeTypeFilter,
                keepAncestors,
                keepDescendants,
                disabledSummaryIds,
                onToggleSummary,
                measuredNodeHeights,
                insights,
                showInsightsInGraph,
                workspaceRepoMap,
                branchPointersByNodeId,
                onToggleCollapse,
                onFocus,
                onSelect,
                onContextMenu,
                onMeasureNodeHeight,
                visibleNodeSections,
                constrainedCommitFiltering,
                pinnedCommitShas,
                hiddenThreadRootIds,
                onOpenThread,
                attachedThreadMessages,
                undefined,
                showMergedAgentreeCommits,
        );

        if (mappedNodes.length === 0) {
            const emptyResult = { nodes: [], edges: [] };
            rememberLayoutCacheEntry({ key: currentCacheKey, nodes: emptyResult.nodes, edges: emptyResult.edges });
            rememberVisualCacheEntry({
                cachedNodes: emptyResult.nodes,
                cachedEdges: emptyResult.edges,
                messagesFingerprint: currentCacheKey.messagesFingerprint,
                messagesVisualFingerprint,
                filterFingerprint: currentCacheKey.filterFingerprint,
                filterActive: currentCacheKey.filterActive,
                hasNodeTypeFilter: currentCacheKey.hasNodeTypeFilter,
                focusedMessageId,
                contextPathFingerprint,
                composerBaseCommitSha,
                visualFingerprint,
                onFocus,
                onOpenThread,
                onSelect,
                onContextMenu,
                result: emptyResult,
            });
            recordGraphLayoutAttribution('recomputed', performance.now() - startedAt, keyChanges, {
                messageCount: messages.length,
                summaryCount: summaries.length,
                nodeCount: 0,
                edgeCount: 0,
                layoutMode,
            });
            return emptyResult;
        }

        let layoutedNodes: Node<any>[];
        let layoutedEdges: Edge[];

        switch (layoutMode) {
            case 'lane':
                ({ nodes: layoutedNodes, edges: layoutedEdges } = getLaneLayoutedElements(mappedNodes, mappedEdges, laneStrategy));
                layoutedEdges = layoutedEdges.map(edge => edge.type === 'summaryEdge' ? edge : { ...edge, type: 'horizontalThenVertical' });
                break;
            case 'tidy':
                ({ nodes: layoutedNodes, edges: layoutedEdges } = getTidyTreeLayoutedElements(mappedNodes, mappedEdges));
                break;
            case 'sugiyama':
                ({ nodes: layoutedNodes, edges: layoutedEdges } = getSugiyamaLayoutedElements(mappedNodes, mappedEdges));
                layoutedEdges = layoutedEdges.map(edge => edge.type === 'summaryEdge' ? edge : { ...edge, type: 'compactLineage' });
                layoutedNodes = layoutedNodes.map(node => node.type?.includes('message') || node.type?.includes('Node') ? { ...node, sourcePosition: Position.Bottom, targetPosition: Position.Top } : node);
                break;
            case 'dagre':
            default:
                ({ nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(mappedNodes, mappedEdges));
                break;
        }

        layoutedEdges = applyDirectionalEdgeHandles(layoutedNodes, layoutedEdges);
        rememberLayoutCacheEntry({ key: currentCacheKey, nodes: layoutedNodes, edges: layoutedEdges });
        const visualResult = applyVisualProperties(
            layoutedNodes,
            layoutedEdges,
            messages,
            projection,
            focusedMessageId,
            contextPathMessageIds,
            composerBaseCommitSha,
            matchingMessageIds,
            filterActive,
            hasNodeTypeFilter,
            keepAncestors,
            keepDescendants,
            onFocus,
            onOpenThread,
            onSelect,
            onContextMenu
        );
        rememberVisualCacheEntry({
            cachedNodes: layoutedNodes,
            cachedEdges: layoutedEdges,
            messagesFingerprint: currentCacheKey.messagesFingerprint,
            messagesVisualFingerprint,
            filterFingerprint: currentCacheKey.filterFingerprint,
            filterActive: currentCacheKey.filterActive,
            hasNodeTypeFilter: currentCacheKey.hasNodeTypeFilter,
            focusedMessageId,
            contextPathFingerprint,
            composerBaseCommitSha,
            visualFingerprint,
            onFocus,
            onOpenThread,
            onSelect,
            onContextMenu,
            result: visualResult,
        });
        recordGraphLayoutAttribution('recomputed', performance.now() - startedAt, keyChanges, {
            messageCount: messages.length,
            summaryCount: summaries.length,
            nodeCount: layoutedNodes.length,
            edgeCount: layoutedEdges.length,
            layoutMode,
        });
        return visualResult;
    }, [
        messages, attachedThreadMessages, summaries, projection, measuredNodeHeights, layoutMode, laneStrategy, disabledSummaryIds,
        focusedMessageId, contextPathMessageIds, composerBaseCommitSha, matchingMessageIds, filterActive, hasNodeTypeFilter, keepAncestors, keepDescendants, constrainedCommitFiltering, pinnedCommitShas, hiddenThreadRootIds, insights, showInsightsInGraph, showMergedAgentreeCommits,
        visibleNodeSections,
        workspaceRepoMap, branchPointersByNodeId, onToggleSummary, onToggleCollapse,
        onFocus, onOpenThread, onSelect, onContextMenu, onMeasureNodeHeight, resetNonce, layoutCacheScopeKey
    ]);

    return { nodes, edges };
}

function applyVisualProperties(
    cachedNodes: Node<any>[],
    cachedEdges: Edge[],
    messages: Message[],
    projection: WorkspaceProjection,
    focusedMessageId: string | null,
    contextPathMessageIds: Set<string>,
    composerBaseCommitSha: string | null,
    matchingMessageIds: Set<string>,
    filterActive: boolean,
    _hasNodeTypeFilter: boolean,
    _keepAncestors: boolean,
    _keepDescendants: boolean,
    onFocus: (id: string, metrics?: FocusTriggerMetrics) => void,
    onOpenThread: ((threadRootId: string) => void) | undefined,
    onSelect: (id: string, multi: boolean) => void,
    onContextMenu: (id: string, e: React.MouseEvent) => void,
    previousResult?: UseGraphLayoutResult | null
): { nodes: Node<any>[]; edges: Edge[] } {
    const startedAt = performance.now();
    const messageMap = new Map(messages.map(m => [m.id, m]));
    const nodeById = new Map(cachedNodes.map(node => [node.id, node]));
    const previousNodeById = previousResult ? new Map(previousResult.nodes.map(node => [node.id, node])) : null;
    const previousEdgeById = previousResult ? new Map(previousResult.edges.map(edge => [edge.id, edge])) : null;
    const contextPathNodes = new Set<string>(contextPathMessageIds);
    const contextPathEdges = new Set<string>();
    const contextPathVisualEdges = new Set<string>();
    const activeSummaryIds = new Set<string>();
    contextPathNodes.forEach((messageId) => {
        const message = messageMap.get(messageId);
        const parentId = message?.parentId ?? null;
        if (parentId && contextPathNodes.has(parentId)) {
            contextPathEdges.add(`${parentId}->${messageId}`);
        }
    });

    const visualNodeByMessageId = new Map<string, string>();
    for (const node of cachedNodes) {
        const data = node.data;
        if (Array.isArray(data?.batch?.messageIds)) {
            data.batch.messageIds.forEach((id: unknown) => {
                if (typeof id === 'string') visualNodeByMessageId.set(id, node.id);
            });
            continue;
        }

        const messageId = data?.entity?.messageId ?? data?.entity?.focusMessageId;
        if (typeof messageId === 'string') {
            visualNodeByMessageId.set(messageId, node.id);
        } else if (messageMap.has(node.id)) {
            visualNodeByMessageId.set(node.id, node.id);
        }
    }

    const orderedContextMessageIds = messages
        .map((message) => message.id)
        .filter((messageId) => contextPathNodes.has(messageId));
    collapseRenderedFocusRoute(orderedContextMessageIds, (messageId) => visualNodeByMessageId.get(messageId))
        .edges
        .forEach((edgeId) => contextPathVisualEdges.add(edgeId));

    for (const node of cachedNodes) {
        if (node.type !== 'summary_block') continue;
        const data = node.data;
        const endMessageId = data.endMessageId ?? data.entity?.summary?.endMessageId;
        if (focusedMessageId && endMessageId && endMessageId !== focusedMessageId && contextPathNodes.has(endMessageId)) {
            activeSummaryIds.add(node.id);
        }
    }

    const isNodeInContextPath = (nodeId: string): boolean => {
        const node = nodeById.get(nodeId);
        if (!node) return contextPathNodes.has(nodeId);
        const data = node.data;
        if (data?.batch?.messageIds?.some((id: string) => contextPathNodes.has(id))) return true;
        const focusId = data?.entity?.focusMessageId ?? data?.entity?.messageId ?? node.id;
        return contextPathNodes.has(focusId);
    };

    const isExternalClusterContextEdge = (edge: Edge): boolean => {
        return contextPathVisualEdges.has(`${edge.source}->${edge.target}`);
    };

    let reusedNodeCount = 0;
    let reusedEdgeCount = 0;

    const updatedNodes = cachedNodes.map(node => {
        if (node.type === 'turn_group_hull') return node;

        const data = node.data;
        const focusId = data.entity?.focusMessageId ?? data.entity?.messageId ?? node.id;
        const selectionId = data.entity?.messageId ?? data.entity?.summary?.id ?? node.id;
        const latestEntity = data.entity?.messageId
            ? projection.entitiesByMessageId.get(data.entity.messageId)
            : data.entity?.summary?.id
                ? projection.entitiesBySummaryId.get(data.entity.summary.id)
                : undefined;
        const latestMessage = data.message?.id ? messageMap.get(data.message.id) : undefined;
        const nodeKind = node.type === 'thread_link' || node.type === 'user_message' || node.type === 'assistant_message' || node.type === 'commit_message'
            ? node.type
            : undefined;
        const branchPointers = Array.isArray(data.branchPointers) ? data.branchPointers as BranchPointer[] : [];
        const toolCallCount = latestMessage ? getToolCallCount(latestMessage) : data.toolCallCount;
        const commitCount = latestMessage ? getAssistantCommitCount(latestMessage, messages, messageMap) : data.commitCount;
        const changedFilesCount = latestMessage ? readChangedFilesCount(latestMessage) : data.changedFilesCount;
        const heightKey = latestMessage && latestEntity && nodeKind
            ? createMessageHeightKey({
                message: latestMessage,
                entity: latestEntity as any,
                nodeKind,
                branchPointers,
                toolCallCount: typeof toolCallCount === 'number' ? toolCallCount : undefined,
                commitCount: typeof commitCount === 'number' ? commitCount : undefined,
                changedFilesCount: typeof changedFilesCount === 'number' ? changedFilesCount : undefined,
                attachedThreadCount: Array.isArray(data.attachedThreads) ? data.attachedThreads.length : 0,
            })
            : data.heightKey;
        const isSummaryNode = node.type === 'summary_block';
        const isFocused = isGraphNodeVisuallyFocused(node, focusedMessageId);
        const isComposerBaseCommit = isComposerBaseCommitVisualNode(node, composerBaseCommitSha);
        const isInContextPath = isSummaryNode
            ? activeSummaryIds.has(node.id)
            : contextPathNodes.has(focusId) || (data.batch?.messageIds.some((id: string) => contextPathNodes.has(id)));
        const matchesAttachedThread = Array.isArray(data.attachedThreads)
            && data.attachedThreads.some((thread: { linkMessageId?: unknown }) => (
                typeof thread.linkMessageId === 'string' && matchingMessageIds.has(thread.linkMessageId)
            ));
        const matchesTagFilter = !filterActive
            || matchingMessageIds.has(selectionId)
            || matchesAttachedThread
            || (data.batch?.messageIds.some((id: string) => matchingMessageIds.has(id)));

        const nextData = {
            ...data,
            ...(latestEntity ? { entity: latestEntity } : {}),
            ...(latestMessage ? {
                message: latestMessage,
                agentStatus: resolveNodeState(latestMessage, null).status ?? (latestMessage.agent_id ? 'pending' : null),
                isAgentRunning: isActiveAgentStatus(resolveNodeState(latestMessage, null).status),
                agentId: latestMessage.agent_id ?? null,
                collapsed: latestMessage.collapsed,
                heightKey,
                toolCallCount,
                commitCount,
                changedFilesCount,
            } : {}),
            onFocus,
            onOpenThread,
            onSelect,
            onContextMenu,
            isFocused,
            isComposerBaseCommit,
            isInContextPath,
            matchesTagFilter,
            filterActive,
        };

        const previousNode = previousNodeById?.get(node.id);
        if (previousNode && canReuseVisualNode(previousNode, node, nextData)) {
            reusedNodeCount += 1;
            return previousNode;
        }

        // Pass the latest callbacks and visual state
        return {
            ...node,
            data: nextData,
        };
    });

    const updatedEdges = cachedEdges.map(edge => {
        const sourceId = edge.source as string;
        const targetId = edge.target as string;
        const isCanonicalMessageEdge = messageMap.has(sourceId) && messageMap.has(targetId);
        const isSummaryEdge = edge.type === 'summaryEdge';
        const relationship = (edge.data as any)?.relationship as string | undefined;
        const edgeLegendType = (edge.data as any)?.edgeLegendType as string | undefined;
        const isSecondaryGitParent = relationship === 'git-parent' && (edge.data as any)?.layout === false;
        const isOnContextPath = isSummaryEdge
            ? activeSummaryIds.has(targetId) || (activeSummaryIds.has(sourceId) && isNodeInContextPath(targetId))
            : contextPathVisualEdges.has(`${sourceId}->${targetId}`) || (
                isCanonicalMessageEdge
                    ? contextPathEdges.has(`${sourceId}->${targetId}`)
                    : isExternalClusterContextEdge(edge)
            );
        const sourceMessage = messageMap.get(edge.source as string);
        const isContextBreak = sourceMessage?.context_active === false || edgeLegendType === 'context-break';
        const activeStroke = ACTIVE_EDGE_STROKE;
        const inactiveStroke = relationship === 'git-parent'
            ? COMMIT_PARENT_EDGE_STROKE
            : relationship === 'base-used'
                ? BASE_USED_EDGE_STROKE
                : INACTIVE_EDGE_STROKE;
        const defaultStrokeWidth = relationship === 'git-parent'
            ? (isSecondaryGitParent ? 3 : 4)
            : relationship === 'base-used'
                ? 4.5
                : DEFAULT_EDGE_STROKE_WIDTH;
        const defaultDash = relationship === 'base-used'
            ? '4 5'
            : isContextBreak
                ? '6 6'
                : edge.style?.strokeDasharray;
        const defaultOpacity = isContextBreak
            ? 0.6
            : isSecondaryGitParent
                ? 0.45
            : relationship === 'git-parent' || relationship === 'base-used'
                ? 0.86
                : 1;
        const nextData = {
            ...(edge.data as Record<string, unknown> | undefined),
            isOnContextPath,
        };
        const nextStyle = {
            ...edge.style,
            stroke: isOnContextPath ? activeStroke : inactiveStroke,
            strokeWidth: isSummaryEdge
                ? (isOnContextPath ? FOCUSED_SUMMARY_EDGE_STROKE_WIDTH : DEFAULT_SUMMARY_EDGE_STROKE_WIDTH)
                : (isOnContextPath ? CONTEXT_PATH_EDGE_STROKE_WIDTH : defaultStrokeWidth),
            strokeDasharray: defaultDash,
            opacity: isOnContextPath ? 1 : defaultOpacity,
        };
        const nextZIndex = getGraphEdgeVisualZIndex({
            isOnContextPath,
            isSummaryEdge,
            relationship,
            isSecondaryGitParent,
        });
        const previousEdge = previousEdgeById?.get(edge.id);
        if (
            previousEdge &&
            previousEdge.source === edge.source &&
            previousEdge.target === edge.target &&
            previousEdge.type === edge.type &&
            previousEdge.sourceHandle === edge.sourceHandle &&
            previousEdge.targetHandle === edge.targetHandle &&
            previousEdge.animated === false &&
            previousEdge.zIndex === nextZIndex &&
            shallowEqualRecord(previousEdge.data as Record<string, unknown> | undefined, nextData) &&
            shallowEqualRecord(previousEdge.style as Record<string, unknown> | undefined, nextStyle)
        ) {
            reusedEdgeCount += 1;
            return previousEdge;
        }

        return {
            ...edge,
            animated: false,
            data: nextData,
            style: nextStyle,
            zIndex: nextZIndex,
        };
    });

    recordFundamentalCounter('graph.visual.apply', {
        nodeCount: cachedNodes.length,
        edgeCount: cachedEdges.length,
        messageCount: messages.length,
        contextPathNodeCount: contextPathNodes.size,
        contextPathEdgeCount: contextPathEdges.size,
        focusedMessageId,
        filterActive,
        reusedNodeCount,
        reusedEdgeCount,
    }, performance.now() - startedAt);

    return { nodes: updatedNodes, edges: updatedEdges };
}

const shallowEqualRecord = (
    left: Record<string, unknown> | null | undefined,
    right: Record<string, unknown> | null | undefined
): boolean => {
    if (left === right) return true;
    const leftKeys = Object.keys(left ?? {});
    const rightKeys = Object.keys(right ?? {});
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if ((left as Record<string, unknown>)[key] !== (right as Record<string, unknown>)[key]) return false;
    }
    return true;
};

const messageVisualKey = (message: any): string => {
    if (!message) return '';
    const branchPointerKey = Array.isArray(message.branchPointers)
        ? message.branchPointers.map((pointer: any) => `${pointer.name ?? ''}:${pointer.commitSha ?? pointer.sha ?? ''}`).join(',')
        : '';
    return [
        message.id ?? '',
        message.status ?? '',
        message.agent_id ?? '',
        message.updatedAt ?? '',
        message.content ?? '',
        message.output_commit_sha ?? '',
        message.base_commit_sha ?? '',
        message.git_branch_name ?? '',
        message.collapsed ?? '',
        message.commit?.sha ?? '',
        message.commit?.subject ?? '',
        branchPointerKey,
    ].join('|');
};

const entityVisualKey = (entity: any): string | null => {
    if (!entity) return null;
    return [
        entity.kind ?? '',
        entity.messageId ?? '',
        entity.focusMessageId ?? '',
        entity.summary?.id ?? '',
        entity.preview ?? '',
        entity.shortLabel ?? '',
        entity.shortSha ?? '',
        entity.status ?? '',
        entity.toolCallCount ?? '',
        entity.totalTokens ?? '',
        entity.commitCount ?? '',
        entity.importedFromRef ?? '',
        Array.isArray(entity.parentShas) ? entity.parentShas.join(',') : '',
        messageVisualKey(entity.message),
    ].join('|');
};

const canReuseVisualNode = (
    previousNode: Node<any>,
    sourceNode: Node<any>,
    nextData: Record<string, unknown>
): boolean => {
    if (
        previousNode.type !== sourceNode.type ||
        previousNode.parentId !== sourceNode.parentId ||
        previousNode.sourcePosition !== sourceNode.sourcePosition ||
        previousNode.targetPosition !== sourceNode.targetPosition ||
        previousNode.width !== sourceNode.width ||
        previousNode.height !== sourceNode.height ||
        previousNode.initialWidth !== sourceNode.initialWidth ||
        previousNode.initialHeight !== sourceNode.initialHeight ||
        previousNode.position?.x !== sourceNode.position?.x ||
        previousNode.position?.y !== sourceNode.position?.y ||
        previousNode.style !== sourceNode.style
    ) {
        return false;
    }

    const previousData = previousNode.data as Record<string, unknown>;
    const keysToCompare = [
        'message',
        'heightKey',
        'toolCallCount',
        'commitCount',
        'changedFilesCount',
        'agentStatus',
        'isAgentRunning',
        'agentId',
        'collapsed',
        'onFocus',
        'onOpenThread',
        'onSelect',
        'onContextMenu',
        'isFocused',
        'isComposerBaseCommit',
        'isInContextPath',
        'matchesTagFilter',
        'filterActive',
    ];

    for (const key of keysToCompare) {
        if (previousData[key] !== nextData[key]) return false;
    }

    return entityVisualKey(previousData.entity) === entityVisualKey(nextData.entity);
};
