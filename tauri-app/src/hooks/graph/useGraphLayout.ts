import { useMemo, useRef } from 'react';
import { Node, Edge, Position } from '@xyflow/react';
import { BranchPointer, Message, Summary, Insight } from '../../stores/workspaceStore';
import type { WorkspaceProjection } from '../../domain/workspaceProjection';
import { collapseRenderedFocusRoute } from '../../domain/scopedFocusRoute';
import { recordPerfEvent } from '../../lib/perfRecorder';
import { recordFundamentalCounter } from '../../perf/fundamentalCounters';
import {
    mapMessagesToGraphElements,
    getLayoutedElements,
    getLaneLayoutedElements,
    getTidyTreeLayoutedElements,
    getSugiyamaLayoutedElements,
} from '../../lib/graphUtils';
import { resolveNodeState } from '../../lib/runStateResolver';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type LayoutMode = 'dagre' | 'lane' | 'tidy' | 'sugiyama';
export type LaneStrategy = 'right' | 'balanced';

export interface UseGraphLayoutOptions {
    projection: WorkspaceProjection;
    messages: Message[];
    summaries: Summary[];
    measuredNodeHeights: Map<string, number>;
    layoutMode: LayoutMode;
    laneStrategy: LaneStrategy;
    disabledSummaryIds: Set<string>;
    focusedMessageId: string | null;
    matchingMessageIds: Set<string>;
    filterActive: boolean;
    hasNodeTypeFilter: boolean;
    keepAncestors: boolean;
    keepDescendants: boolean;
    insights: Insight[];
    showInsightsInGraph: boolean;
    workspaceRepoMap: Map<string, string | null>;
    branchPointersByNodeId: Map<string, BranchPointer[]>;
    activeScopeId: string | null;
    scopeViewMode: 'project' | 'scope';
    scopeNameById: Map<string, string>;
    scopeColorById: Map<string, string | null>;
    resetNonce?: number;
    onToggleSummary: (id: string) => void;
    onToggleCollapse: (id: string, collapsed: boolean) => void;
    onFocus: (id: string) => void;
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

const readLookupValue = <T,>(
    lookup: Map<string, T> | Record<string, T> | null | undefined,
    key: string
): T | undefined => {
    if (!lookup) return undefined;
    if (lookup instanceof Map) return lookup.get(key);
    return lookup[key];
};

const lookupEntries = <T,>(lookup: Map<string, T> | Record<string, T> | null | undefined): [string, T][] => {
    if (!lookup) return [];
    if (lookup instanceof Map) return Array.from(lookup.entries());
    return Object.entries(lookup) as [string, T][];
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

const DEFAULT_EDGE_STROKE_WIDTH = 4;
const FOCUSED_PATH_EDGE_STROKE_WIDTH = 7;
const DEFAULT_SUMMARY_EDGE_STROKE_WIDTH = 4;
const FOCUSED_SUMMARY_EDGE_STROKE_WIDTH = 6.5;
const ACTIVE_EDGE_STROKE = '#4f46e5';
const INACTIVE_EDGE_STROKE = '#64748b';

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

interface LayoutCacheKey {
    messagesFingerprint: string;
    summariesFingerprint: string;
    disabledSummaryIdsFingerprint: string;
    filterFingerprint: string;
    filterActive: boolean;
    hasNodeTypeFilter: boolean;
    keepAncestors: boolean;
    keepDescendants: boolean;
    layoutMode: string;
    laneStrategy: string;
    insightsFingerprint: string;
    showInsightsInGraph: boolean;
    activeScopeId: string | null;
    scopeViewMode: 'project' | 'scope';
    resetNonce: number;
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
    visualFingerprint: string;
    onFocus: UseGraphLayoutOptions['onFocus'];
    onSelect: UseGraphLayoutOptions['onSelect'];
    onContextMenu: UseGraphLayoutOptions['onContextMenu'];
    result: UseGraphLayoutResult;
}

const cacheKeysEqual = (a: LayoutCacheKey, b: LayoutCacheKey): boolean => {
    return (
        a.messagesFingerprint === b.messagesFingerprint &&
        a.summariesFingerprint === b.summariesFingerprint &&
        a.disabledSummaryIdsFingerprint === b.disabledSummaryIdsFingerprint &&
        a.filterFingerprint === b.filterFingerprint &&
        a.filterActive === b.filterActive &&
        a.hasNodeTypeFilter === b.hasNodeTypeFilter &&
        a.keepAncestors === b.keepAncestors &&
        a.keepDescendants === b.keepDescendants &&
        a.layoutMode === b.layoutMode &&
        a.laneStrategy === b.laneStrategy &&
        a.insightsFingerprint === b.insightsFingerprint &&
        a.showInsightsInGraph === b.showInsightsInGraph &&
        a.activeScopeId === b.activeScopeId &&
        a.scopeViewMode === b.scopeViewMode &&
        a.resetNonce === b.resetNonce
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
        summaries,
        measuredNodeHeights,
        layoutMode,
        laneStrategy,
        disabledSummaryIds,
        focusedMessageId,
        matchingMessageIds,
        filterActive,
        hasNodeTypeFilter,
        keepAncestors,
        keepDescendants,
        insights,
        showInsightsInGraph,
        workspaceRepoMap,
        branchPointersByNodeId,
        activeScopeId,
        scopeViewMode,
        scopeNameById,
        scopeColorById,
        resetNonce = 0,
        onToggleSummary,
        onToggleCollapse,
        onFocus,
        onSelect,
        onContextMenu,
        onMeasureNodeHeight
    } = options;

    const layoutCacheRef = useRef<LayoutCacheEntry | null>(null);
    const visualCacheRef = useRef<VisualCacheEntry | null>(null);

    const { nodes, edges } = useMemo(() => {
        const startedAt = performance.now();
        const visualFingerprint = lookupEntries(scopeNameById)
            .map(([id, name]) => `${id}:${name}:${readLookupValue(scopeColorById, id) || ''}`)
            .sort()
            .join(';');
        const messagesVisualFingerprint = createMessagesVisualFingerprint(messages);
        const currentCacheKey: LayoutCacheKey = {
            messagesFingerprint: createMessagesFingerprint(messages),
            summariesFingerprint: createSummariesFingerprint(summaries),
            disabledSummaryIdsFingerprint: Array.from(disabledSummaryIds).sort().join(','),
            filterFingerprint: createFilterFingerprint(matchingMessageIds),
            filterActive,
            hasNodeTypeFilter,
            keepAncestors,
            keepDescendants,
            layoutMode,
            laneStrategy,
            insightsFingerprint: insights.map((insight) => insight.id).sort().join(','),
            showInsightsInGraph,
            activeScopeId,
            scopeViewMode,
            resetNonce,
        };
        const keyChanges = changedLayoutKeyFields(layoutCacheRef.current?.key, currentCacheKey);

        if (layoutCacheRef.current && cacheKeysEqual(layoutCacheRef.current.key, currentCacheKey)) {
            const previousVisual = visualCacheRef.current;
            const visualChanges = previousVisual ? {
                cachedNodesChanged: previousVisual.cachedNodes !== layoutCacheRef.current.nodes,
                cachedEdgesChanged: previousVisual.cachedEdges !== layoutCacheRef.current.edges,
                messagesFingerprintChanged: previousVisual.messagesFingerprint !== currentCacheKey.messagesFingerprint,
                messagesVisualFingerprintChanged: previousVisual.messagesVisualFingerprint !== messagesVisualFingerprint,
                filterFingerprintChanged: previousVisual.filterFingerprint !== currentCacheKey.filterFingerprint,
                filterActiveChanged: previousVisual.filterActive !== currentCacheKey.filterActive,
                hasNodeTypeFilterChanged: previousVisual.hasNodeTypeFilter !== currentCacheKey.hasNodeTypeFilter,
                focusedMessageChanged: previousVisual.focusedMessageId !== focusedMessageId,
                visualFingerprintChanged: previousVisual.visualFingerprint !== visualFingerprint,
                onFocusChanged: previousVisual.onFocus !== onFocus,
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
                previousVisual.cachedNodes === layoutCacheRef.current.nodes &&
                previousVisual.cachedEdges === layoutCacheRef.current.edges &&
                previousVisual.messagesFingerprint === currentCacheKey.messagesFingerprint &&
                previousVisual.messagesVisualFingerprint === messagesVisualFingerprint &&
                previousVisual.filterFingerprint === currentCacheKey.filterFingerprint &&
                previousVisual.filterActive === currentCacheKey.filterActive &&
                previousVisual.hasNodeTypeFilter === currentCacheKey.hasNodeTypeFilter &&
                previousVisual.focusedMessageId === focusedMessageId &&
                previousVisual.visualFingerprint === visualFingerprint &&
                previousVisual.onFocus === onFocus &&
                previousVisual.onSelect === onSelect &&
                previousVisual.onContextMenu === onContextMenu
            ) {
                recordGraphLayoutAttribution('cache-hit', performance.now() - startedAt, keyChanges, {
                    messageCount: messages.length,
                    summaryCount: summaries.length,
                    nodeCount: layoutCacheRef.current.nodes.length,
                    edgeCount: layoutCacheRef.current.edges.length,
                    layoutMode,
                });
                return previousVisual.result;
            }

            const visualResult = applyVisualProperties(
                layoutCacheRef.current.nodes,
                layoutCacheRef.current.edges,
                messages,
                projection,
                focusedMessageId,
                matchingMessageIds,
                filterActive,
                hasNodeTypeFilter,
                keepAncestors,
                keepDescendants,
                scopeNameById,
                scopeColorById,
                onFocus,
                onSelect,
                onContextMenu
            );
            visualCacheRef.current = {
                cachedNodes: layoutCacheRef.current.nodes,
                cachedEdges: layoutCacheRef.current.edges,
                messagesFingerprint: currentCacheKey.messagesFingerprint,
                messagesVisualFingerprint,
                filterFingerprint: currentCacheKey.filterFingerprint,
                filterActive: currentCacheKey.filterActive,
                hasNodeTypeFilter: currentCacheKey.hasNodeTypeFilter,
                focusedMessageId,
                visualFingerprint,
                onFocus,
                onSelect,
                onContextMenu,
                result: visualResult,
            };
            recordGraphLayoutAttribution('visual-only', performance.now() - startedAt, keyChanges, {
                messageCount: messages.length,
                summaryCount: summaries.length,
                nodeCount: layoutCacheRef.current.nodes.length,
                edgeCount: layoutCacheRef.current.edges.length,
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
                activeScopeId,
                scopeViewMode,
                scopeNameById,
                scopeColorById,
                onToggleCollapse,
                onFocus,
                onSelect,
                onContextMenu,
                onMeasureNodeHeight
        );

        if (mappedNodes.length === 0) {
            const emptyResult = { nodes: [], edges: [] };
            layoutCacheRef.current = { key: currentCacheKey, nodes: emptyResult.nodes, edges: emptyResult.edges };
            visualCacheRef.current = {
                cachedNodes: emptyResult.nodes,
                cachedEdges: emptyResult.edges,
                messagesFingerprint: currentCacheKey.messagesFingerprint,
                messagesVisualFingerprint,
                filterFingerprint: currentCacheKey.filterFingerprint,
                filterActive: currentCacheKey.filterActive,
                hasNodeTypeFilter: currentCacheKey.hasNodeTypeFilter,
                focusedMessageId,
                visualFingerprint,
                onFocus,
                onSelect,
                onContextMenu,
                result: emptyResult,
            };
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
                layoutedNodes = layoutedNodes.map(node => node.type?.includes('message') || node.type?.includes('Node') ? { ...node, sourcePosition: Position.Right, targetPosition: Position.Left } : node);
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

        layoutCacheRef.current = { key: currentCacheKey, nodes: layoutedNodes, edges: layoutedEdges };
        const visualResult = applyVisualProperties(
            layoutedNodes,
            layoutedEdges,
            messages,
            projection,
            focusedMessageId,
            matchingMessageIds,
            filterActive,
            hasNodeTypeFilter,
            keepAncestors,
            keepDescendants,
            scopeNameById,
            scopeColorById,
            onFocus,
            onSelect,
            onContextMenu
        );
        visualCacheRef.current = {
            cachedNodes: layoutedNodes,
            cachedEdges: layoutedEdges,
            messagesFingerprint: currentCacheKey.messagesFingerprint,
            messagesVisualFingerprint,
            filterFingerprint: currentCacheKey.filterFingerprint,
            filterActive: currentCacheKey.filterActive,
            hasNodeTypeFilter: currentCacheKey.hasNodeTypeFilter,
            focusedMessageId,
            visualFingerprint,
            onFocus,
            onSelect,
            onContextMenu,
            result: visualResult,
        };
        recordGraphLayoutAttribution('recomputed', performance.now() - startedAt, keyChanges, {
            messageCount: messages.length,
            summaryCount: summaries.length,
            nodeCount: layoutedNodes.length,
            edgeCount: layoutedEdges.length,
            layoutMode,
        });
        return visualResult;
    }, [
        messages, summaries, measuredNodeHeights, layoutMode, laneStrategy, disabledSummaryIds,
        focusedMessageId, matchingMessageIds, filterActive, hasNodeTypeFilter, keepAncestors, keepDescendants, insights, showInsightsInGraph,
        workspaceRepoMap, branchPointersByNodeId, activeScopeId, scopeViewMode,
        scopeNameById, scopeColorById, onToggleSummary, onToggleCollapse,
        onFocus, onSelect, onContextMenu, onMeasureNodeHeight, resetNonce
    ]);

    return { nodes, edges };
}

function applyVisualProperties(
    cachedNodes: Node<any>[],
    cachedEdges: Edge[],
    messages: Message[],
    projection: WorkspaceProjection,
    focusedMessageId: string | null,
    matchingMessageIds: Set<string>,
    filterActive: boolean,
    _hasNodeTypeFilter: boolean,
    _keepAncestors: boolean,
    _keepDescendants: boolean,
    scopeNameById: Map<string, string>,
    scopeColorById: Map<string, string | null>,
    onFocus: (id: string) => void,
    onSelect: (id: string, multi: boolean) => void,
    onContextMenu: (id: string, e: React.MouseEvent) => void
): { nodes: Node<any>[]; edges: Edge[] } {
    const startedAt = performance.now();
    const messageMap = new Map(messages.map(m => [m.id, m]));
    const nodeById = new Map(cachedNodes.map(node => [node.id, node]));
    const focusPathNodes = new Set<string>();
    const focusPathEdges = new Set<string>();
    const focusPathVisualEdges = new Set<string>();
    const activeSummaryIds = new Set<string>();
    const scopedRoute = projection.scopedFocusRoute;
    scopedRoute.messageIds.forEach((messageId) => focusPathNodes.add(messageId));
    scopedRoute.edges.forEach((edgeId) => focusPathEdges.add(edgeId));

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

    collapseRenderedFocusRoute(scopedRoute.messageIds, (messageId) => visualNodeByMessageId.get(messageId))
        .edges
        .forEach((edgeId) => focusPathVisualEdges.add(edgeId));

    for (const node of cachedNodes) {
        if (node.type !== 'summary_block') continue;
        const data = node.data;
        const endMessageId = data.endMessageId ?? data.entity?.summary?.endMessageId;
        if (focusedMessageId && endMessageId && endMessageId !== focusedMessageId && focusPathNodes.has(endMessageId)) {
            activeSummaryIds.add(node.id);
        }
    }

    const isNodeInFocusPath = (nodeId: string): boolean => {
        const node = nodeById.get(nodeId);
        if (!node) return focusPathNodes.has(nodeId);
        const data = node.data;
        if (data?.batch?.messageIds?.some((id: string) => focusPathNodes.has(id))) return true;
        const focusId = data?.entity?.focusMessageId ?? data?.entity?.messageId ?? node.id;
        return focusPathNodes.has(focusId);
    };

    const isExternalClusterFocusEdge = (edge: Edge): boolean => {
        return focusPathVisualEdges.has(`${edge.source}->${edge.target}`);
    };

    const updatedNodes = cachedNodes.map(node => {
        // Handle hulls separately or just pass through
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
        const isSummaryNode = node.type === 'summary_block';
        const isFocused = focusId === focusedMessageId || (data.batch?.messageIds.includes(focusedMessageId || ''));
        const isInFocusPath = isSummaryNode
            ? activeSummaryIds.has(node.id)
            : focusPathNodes.has(focusId) || (data.batch?.messageIds.some((id: string) => focusPathNodes.has(id)));
        const matchesTagFilter = !filterActive || matchingMessageIds.has(selectionId) || (data.batch?.messageIds.some((id: string) => matchingMessageIds.has(id)));

        // Pass the latest callbacks and visual state
        return {
            ...node,
            data: {
                ...data,
                ...(latestEntity ? { entity: latestEntity } : {}),
                ...(latestMessage ? {
                    message: latestMessage,
                    agentStatus: resolveNodeState(latestMessage, null).status ?? (latestMessage.agent_id ? 'pending' : null),
                    isAgentRunning: ['pending', 'running', 'streaming'].includes(String(resolveNodeState(latestMessage, null).status ?? '')),
                    agentId: latestMessage.agent_id ?? null,
                    collapsed: latestMessage.collapsed,
                } : {}),
                onFocus,
                onSelect,
                onContextMenu,
                focusedMessageId,
                isFocused,
                isInFocusPath,
                matchesTagFilter,
                filterActive,
                // Update specific entity data if needed
                scopeName: data.entity?.scopeId ? (readLookupValue(scopeNameById, data.entity.scopeId) || null) : data.scopeName,
                scopeColor: data.entity?.scopeId ? (readLookupValue(scopeColorById, data.entity.scopeId) || null) : data.scopeColor,
            },
        };
    });

    const updatedEdges = cachedEdges.map(edge => {
        const sourceId = edge.source as string;
        const targetId = edge.target as string;
        const isCanonicalMessageEdge = messageMap.has(sourceId) && messageMap.has(targetId);
        const isSummaryEdge = edge.type === 'summaryEdge';
        const isOnFocusPath = isSummaryEdge
            ? activeSummaryIds.has(targetId) || (activeSummaryIds.has(sourceId) && isNodeInFocusPath(targetId))
            : focusPathVisualEdges.has(`${sourceId}->${targetId}`) || (
                isCanonicalMessageEdge
                    ? focusPathEdges.has(`${sourceId}->${targetId}`)
                    : isExternalClusterFocusEdge(edge)
            );
        const sourceMessage = messageMap.get(edge.source as string);
        const isContextBreak = sourceMessage?.context_active === false;
        const activeStroke = ACTIVE_EDGE_STROKE;
        const inactiveStroke = INACTIVE_EDGE_STROKE;
        return {
            ...edge,
            animated: isOnFocusPath,
            style: {
                ...edge.style,
                stroke: isOnFocusPath ? activeStroke : inactiveStroke,
                strokeWidth: isSummaryEdge
                    ? (isOnFocusPath ? FOCUSED_SUMMARY_EDGE_STROKE_WIDTH : DEFAULT_SUMMARY_EDGE_STROKE_WIDTH)
                    : (isOnFocusPath ? FOCUSED_PATH_EDGE_STROKE_WIDTH : DEFAULT_EDGE_STROKE_WIDTH),
                strokeDasharray: isContextBreak ? '6 6' : undefined,
                opacity: isContextBreak ? 0.6 : 1,
            },
            zIndex: isOnFocusPath ? 10 : (isSummaryEdge ? -3 : 0),
        };
    });

    recordFundamentalCounter('graph.visual.apply', {
        nodeCount: cachedNodes.length,
        edgeCount: cachedEdges.length,
        messageCount: messages.length,
        focusPathNodeCount: focusPathNodes.size,
        focusPathEdgeCount: focusPathEdges.size,
        focusedMessageId,
        filterActive,
    }, performance.now() - startedAt);

    return { nodes: updatedNodes, edges: updatedEdges };
}
