// @ts-nocheck
import React, { Profiler, startTransition, useMemo, useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
    ReactFlow,
    Controls,
    Node,
    ReactFlowProvider,
    useReactFlow,
    useStoreApi,
    MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Stores
import { useWorkspaceStore, Message, Summary, Scope } from '../stores/workspaceStore';
import { useIntegrationStore } from '../stores/integrationStore';

// Hooks - Data
import { useMessages, useSummaries, useDeleteMessageBranch, useToggleCollapse } from '../hooks/useMessages';

import { useWorkspaces } from '../hooks/useWorkspaces';
import { useModels } from '../hooks/useModels';
import { useAgents } from '../hooks/useAgents';
import { useBranches } from '../hooks/useBranches';
import { branchKeys } from '../hooks/useBranches';
import { trackedRefKeys, useTrackedRefs } from '../hooks/useTrackedRefs';
import { useGitSync } from '../hooks/useGitSync';
import { getEnabledTrackedGitRefs, getTrackedRefsNeedingSync, useGitRefSnapshot } from '../hooks/useGitRefSnapshot';
import { useScopes } from '../hooks/useScopes';
import { useLocalNodes } from '../hooks/useLocalNodes';
import { useGraphMessages } from '../hooks/useLiveMessages';
import { getPublicShareUrl, useCreateNodePublicShare } from '../hooks/useWorkspacePublicShare';

// Hooks - Graph (extracted)
import { useTagFilter } from '../hooks/graph/useTagFilter';
import { useNodeSelection } from '../hooks/graph/useNodeSelection';
import { useGraphLayout, LayoutMode, LaneStrategy } from '../hooks/graph/useGraphLayout';
import { useWorkspaceProjection } from '../hooks/useWorkspaceProjection';
import { clearCachedGraphSnapshot, graphSnapshotToSummaries, useGraphSnapshot } from '../hooks/useGraphSnapshot';
// Utils
import { LlmNodeData, getLlmLegend } from '../lib/graphUtils';
import { collectDeleteBranchMessageIds, getDeleteBranchPreview, getTopLevelDeleteBranchIds } from '../domain/deleteBranchPreview';
import { getBranchPointerCommitSha, getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import { addDeletedGraphCommitShas, readDeletedGraphCommitShas } from '../lib/graph/commitGraphTombstones';
import { getLeafMessagesByRecency } from '../lib/graph/leafNodes';
import { collapseRenderedFocusRoute } from '../domain/scopedFocusRoute';
import { cn } from '../lib/utils';
import { useDiff } from '../contexts/DiffContext';
import { useToastHelpers } from './Toast';
import { useRunStatusStore } from '../stores/runStatusStore';
import { agentRunManager } from '../agent-runs/agentRunManager';

// Components - Nodes/Edges
import SummaryEdge from './SummaryEdge';
import { HorizontalThenVerticalEdge } from './HorizontalThenVerticalEdge';
import { ContextSmoothStepEdge } from './ContextSmoothStepEdge';

// Components - Graph (extracted)
import { GraphControls, type LeafNodeNavigationItem, ViewMode } from './graph/GraphControls';
import { GraphLegend } from './graph/GraphLegend';
import { MiniMapPanel } from './graph/MiniMapPanel';
import { GraphCanvasIndexPanel, type GraphEdgeLegendId } from './graph/GraphCanvasIndexPanel';
import { GraphInteractionContext } from './graph/GraphInteractionContext';
import { GraphHoverProjectionContext } from './graph/GraphHoverProjectionContext';
import { TrackedBranchesPanel } from './TrackedBranchesPanel';
import { FloatingSelectionMenu } from './graph/FloatingSelectionMenu';

// Components - Dialogs/Panels
import { SummaryCreationDialog } from './SummaryCreationDialog';
import { TimelineView } from './TimelineView';
import AdvancedSearchPanel from './AdvancedSearchPanel';
import { ScopedNodeContextMenu, type ScopedContextMenuState } from './ScopedNodeContextMenu';
import { AddCommitDialog } from './AddCommitDialog';
import { DeleteBranchDialog, type DeleteBranchDialogPhase } from './DeleteBranchDialog';

import { Activity } from 'lucide-react';
import { agentClient } from '../lib/agentClient';
import { createProfilerOnRender, startFocusInteraction } from '../lib/interactionProfiler';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { recordFundamentalCounter } from '../perf/fundamentalCounters';
import { createGraphDiagnosticCapture, registerGraphDiagnosticProvider } from '../lib/graphDiagnostics';
import { markGraphInteractionEnd, markGraphInteractionStart, scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { withExplicitReactFlowNodeDimensions } from '../lib/reactFlowNodeDimensions';
import type { FocusTriggerMetrics } from '../types/nodes';

import { GraphNodeDispatcher } from './nodes/graph/GraphNodeDispatcher';
import { GraphTurnGroupHull } from './nodes/graph/GraphTurnGroupHull';

// ═══════════════════════════════════════════════════════════════════════════
// NODE & EDGE TYPES
// ═══════════════════════════════════════════════════════════════════════════

const nodeTypes = {
    user_message: GraphNodeDispatcher,
    assistant_message: GraphNodeDispatcher,
    commit_message: GraphNodeDispatcher,
    canonical_commit: GraphNodeDispatcher,
    layout_derived_commit_group: GraphNodeDispatcher,
    summary_block: GraphNodeDispatcher,
    turn_group_hull: GraphTurnGroupHull,
};

const edgeTypes = {
    summaryEdge: SummaryEdge,
    horizontalThenVertical: HorizontalThenVerticalEdge,
    smoothstep: ContextSmoothStepEdge,
    compactLineage: HorizontalThenVerticalEdge,
};

const EMPTY_MEASURED_NODE_HEIGHTS = new Map<string, number>();
const FOCUS_READING_MIN_ZOOM = 0.72;
const FOCUS_READING_MAX_ZOOM = 1.05;
const FOCUS_VIEWPORT_BAND_X = 0.44;
const FOCUS_VIEWPORT_BAND_Y = 0.42;
const FOCUS_MIN_ANIMATION_MS = 160;
const FOCUS_MAX_ANIMATION_MS = 320;
const FOCUS_DISTANCE_FOR_MAX_DURATION = 2200;
const FOCUS_CENTER_MAX_RETRY_FRAMES = 18;
const NODE_HEIGHT_MEASURE_EPSILON = 4;
const GRAPH_HEIGHT_MEASURE_FLUSH_MS = 32;
const VIEWPORT_INTERACTION_STALE_MS = 12_000;
const ACTIVE_GRAPH_WINDOW_MAX_VISIBLE_NODES = 160;
const ACTIVE_GRAPH_WINDOW_OVERSCAN_SCREENS = 1.35;
const ACTIVE_GRAPH_WINDOW_UPDATE_THROTTLE_MS = 80;
const ACTIVE_GRAPH_WINDOW_FALLBACK_NODE_WIDTH = 120;
const ACTIVE_GRAPH_WINDOW_FALLBACK_NODE_HEIGHT = 120;
const ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE = 900;
const ACTIVE_GRAPH_RUN_STATUSES = new Set(['pending', 'creating', 'initializing', 'running', 'streaming']);
const GRAPH_GEOMETRY_DIAGNOSTICS_ENABLED = import.meta.env.VITE_GRAPH_GEOMETRY_DIAGNOSTICS === 'true';

const cleanNodePreview = (value: string | null | undefined): string => (
    (value || '')
        .replace(/```[\s\S]*?```/g, '[Code]')
        .replace(/`[^`]+`/g, '[Code]')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/#+\s/g, '')
        .replace(/\s+/g, ' ')
        .trim()
);

const formatLeafTimestamp = (message: Message): string => {
    const timestamp = message.last_event_at || message.updatedAt || message.createdAt;
    const date = new Date(timestamp || '');

    if (Number.isNaN(date.getTime())) {
        return 'unknown time';
    }

    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
};

const getLeafModelLabel = (message: Message, agentLabelsById: Map<string, string>): string => {
    if (message.llmModel) {
        return message.llmModel.split('/').pop() || message.llmModel;
    }
    if (message.agent_id && agentLabelsById.has(message.agent_id)) {
        return agentLabelsById.get(message.agent_id) || 'Model unknown';
    }
    if (message.llmProvider) {
        return message.llmProvider;
    }
    if (message.commit?.sha) {
        return message.commit.sha.slice(0, 7);
    }
    return 'Model unknown';
};

const getLeafStatusMeta = (message: Message): Pick<LeafNodeNavigationItem, 'statusLabel' | 'statusTone'> => {
    switch (message.status) {
        case 'pending':
        case 'creating':
        case 'initializing':
            return { statusLabel: 'Pending', statusTone: 'active' };
        case 'running':
        case 'streaming':
            return { statusLabel: 'Running', statusTone: 'active' };
        case 'completed':
            return { statusLabel: 'Done', statusTone: 'success' };
        case 'error':
        case 'failed':
            return { statusLabel: 'Failed', statusTone: 'danger' };
        case 'cancelled':
            return { statusLabel: 'Cancelled', statusTone: 'muted' };
        default:
            return { statusLabel: message.commit ? 'Committed' : 'No status', statusTone: 'muted' };
    }
};

const toLeafNodeNavigationItem = (
    message: Message,
    agentLabelsById: Map<string, string>,
): LeafNodeNavigationItem => {
    const isCommit = Boolean(message.commit);
    const fallbackLabel = isCommit ? 'Commit' : message.role === 'user' ? 'User message' : 'Assistant message';
    const label = cleanNodePreview(message.aiLabel || message.commit?.subject || message.content) || fallbackLabel;
    const statusMeta = getLeafStatusMeta(message);

    return {
        id: message.id,
        label: label.length > 72 ? `${label.slice(0, 69)}...` : label,
        modelLabel: getLeafModelLabel(message, agentLabelsById),
        statusLabel: statusMeta.statusLabel,
        statusTone: statusMeta.statusTone,
        timestampLabel: formatLeafTimestamp(message),
    };
};

type SendFlowGraphDiagnosticFlags = {
    disableGraphSurface: boolean;
    disableGraphAutoCenter: boolean;
    disableOnlyRenderVisibleElements: boolean;
};

const getSendFlowGraphDiagnosticFlags = (): SendFlowGraphDiagnosticFlags => {
    const defaults = {
        disableGraphSurface: false,
        disableGraphAutoCenter: false,
        disableOnlyRenderVisibleElements: false,
    };
    if (typeof window === 'undefined' || !import.meta.env.DEV) return defaults;
    try {
        const raw = window.localStorage.getItem('agentree-send-flow-diag');
        if (!raw) return defaults;
        const parsed = JSON.parse(raw) as Partial<SendFlowGraphDiagnosticFlags>;
        return {
            disableGraphSurface: parsed.disableGraphSurface === true,
            disableGraphAutoCenter: parsed.disableGraphAutoCenter === true,
            disableOnlyRenderVisibleElements: parsed.disableOnlyRenderVisibleElements === true,
        };
    } catch {
        return defaults;
    }
};

type GraphCommitSnapshot = {
    selectedWorkspaceId: string | null;
    messagesRef: Message[] | null;
    graphMessagesRef: Message[] | null;
    summariesRef: Summary[] | null;
    branchPointersRef: unknown;
    branchPointersByNodeIdRef: unknown;
    measuredHeightsRef: Map<string, number>;
    layoutNodesRef: Node<any>[] | null;
    layoutEdgesRef: Edge[] | null;
    renderNodesRef: Node<any>[] | null;
    previewEdgesRef: Edge[] | null;
    focusedMessageId: string | null;
    focusNonce: number;
    graphResetNonce: number;
    tagFilterKey: string;
    activeScopeId: string | null;
    viewMode: ViewMode;
    runningCount: number;
    graphSnapshotStatus: string;
    messagesQueryStatus: string;
    timestamp: number;
};

const didRefChange = (left: unknown, right: unknown) => left !== right;

type ActiveGraphWindowEntry = {
    id: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
    centerX: number;
    centerY: number;
    index: number;
};

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface GraphViewInternalProps {
    messagesOverride?: Message[];
    focusedIdOverride?: string | null;
    onNodeClickOverride?: (event: React.MouseEvent | null, nodeOrMessageId: Node<LlmNodeData | object> | string) => void;
    hideControls?: boolean;
    hideBackground?: boolean;
    hideLegend?: boolean;
    className?: string;
    forcedViewMode?: ViewMode;
}

const REF_SYNC_INTERVAL_MS = 60_000;
const GRAPH_DATA_INTERVAL_MS = 10 * 60_000;
const SUMMARIES_INTERVAL_MS = 10 * 60_000;
const CONVERSATIONS_INTERVAL_MS = 3 * 60 * 60_000;
const REPO_REF_SYNC_ENABLED = true;
const AUTO_REFRESH_ENABLED = false;

type AutoRefreshKey = 'repo' | 'graph' | 'summaries' | 'workspaces';

const AUTO_REFRESH_INTERVALS: Record<AutoRefreshKey, number> = {
    repo: REF_SYNC_INTERVAL_MS,
    graph: GRAPH_DATA_INTERVAL_MS,
    summaries: SUMMARIES_INTERVAL_MS,
    workspaces: CONVERSATIONS_INTERVAL_MS,
};

const AUTO_REFRESH_LABELS: Record<AutoRefreshKey, string> = {
    repo: 'Repo refs',
    graph: 'Messages and branches',
    summaries: 'Summaries',
    workspaces: 'Workspaces',
};

const AUTO_REFRESH_SOURCES: Record<AutoRefreshKey, string> = {
    repo: 'Source: local git repo',
    graph: 'Source: server graph data',
    summaries: 'Source: server summaries',
    workspaces: 'Source: server workspace list',
};

const AUTO_REFRESH_DETAILS: Record<AutoRefreshKey, string> = {
    repo: 'Checks tracked git refs in the attached repo for new commits.',
    graph: 'Reloads graph messages, tracked refs, and branch pointers. Also runs immediately after repo changes are detected.',
    summaries: 'Reloads summary overlays and also catches up immediately after graph changes.',
    workspaces: 'Refreshes project metadata like names, timestamps, and repo attachment info.',
};

const formatCountdownLabel = (msRemaining: number | null) => {
    if (msRemaining === null) return 'Paused';
    if (msRemaining <= 0) return 'Now';
    const totalSeconds = Math.ceil(msRemaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
};

const formatCadenceLabel = (intervalMs: number) => {
    const totalSeconds = Math.round(intervalMs / 1000);
    if (totalSeconds < 60) return `Every ${totalSeconds}s`;
    const minutes = Math.round(totalSeconds / 60);
    return `Every ${minutes}m`;
};

const GRAPH_DIAGNOSTIC_MAX_OVERLAPS = 200;
const GRAPH_DIAGNOSTIC_MAX_MEASURE_EVENTS = 160;
const GRAPH_DIAGNOSTIC_STALE_HEIGHT_EPSILON = 4;
const GRAPH_MIN_ZOOM = 0.05;
const GRAPH_MAX_ZOOM = 2.5;

const roundMetric = (value: number | null | undefined, digits = 2) => (
    typeof value === 'number' && Number.isFinite(value)
        ? Number(value.toFixed(digits))
        : null
);

const rectSnapshot = (rect: DOMRect | null, origin?: DOMRect | null) => {
    if (!rect) return null;
    const originLeft = origin?.left ?? 0;
    const originTop = origin?.top ?? 0;
    return {
        left: roundMetric(rect.left - originLeft),
        top: roundMetric(rect.top - originTop),
        width: roundMetric(rect.width),
        height: roundMetric(rect.height),
        right: roundMetric(rect.right - originLeft),
        bottom: roundMetric(rect.bottom - originTop),
    };
};

const numericDimension = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
);

const boxesOverlap = (left: any, right: any) => (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
);

const overlapArea = (left: any, right: any) => {
    const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
    const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
    return width > 0 && height > 0 ? width * height : 0;
};

const collectOverlaps = (boxes: any[]) => {
    const overlaps: any[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
        const left = boxes[i];
        if (left.ignoreOverlap) continue;
        for (let j = i + 1; j < boxes.length; j += 1) {
            const right = boxes[j];
            if (right.ignoreOverlap) continue;
            if (!boxesOverlap(left, right)) continue;
            const area = overlapArea(left, right);
            if (area <= 1) continue;
            overlaps.push({
                a: left.id,
                b: right.id,
                area: roundMetric(area),
                overlapWidth: roundMetric(Math.min(left.right, right.right) - Math.max(left.left, right.left)),
                overlapHeight: roundMetric(Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)),
                aType: left.type,
                bType: right.type,
            });
        }
    }
    return overlaps
        .sort((left, right) => (right.area ?? 0) - (left.area ?? 0))
        .slice(0, GRAPH_DIAGNOSTIC_MAX_OVERLAPS);
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

function GraphViewInternal({
    messagesOverride,
    focusedIdOverride,
    onNodeClickOverride,
    hideControls = false,
    hideBackground = false,
    hideLegend = false,
    className: propClassName,
    forcedViewMode,
}: GraphViewInternalProps) {
    const queryClient = useQueryClient();
    const sendFlowGraphDiagFlags = useMemo(() => getSendFlowGraphDiagnosticFlags(), []);
    // ─────────────────────────────────────────────────────────────────────────
    // STORE SUBSCRIPTIONS
    // ─────────────────────────────────────────────────────────────────────────
    const storeFocusedMessageId = useWorkspaceStore(state => state.focusedMessageId);
    const dispatchFocus = useWorkspaceStore(state => state.dispatchFocus);
    const focusNonce = useWorkspaceStore(state => state.focusNonce);
    const selectedWorkspaceId = useWorkspaceStore(state => state.selectedWorkspaceId);
    const lastFocusedMessageByWorkspace = useWorkspaceStore(state => state.lastFocusedMessageByWorkspace);
    const activeSendFlowFocus = useWorkspaceStore(state => state.activeSendFlowFocus);
    const lastFocusSource = useWorkspaceStore(state => state.lastFocusSource);
    const lastFocusMetadata = useWorkspaceStore(state => state.lastFocusMetadata);
    const activeScopeId = useWorkspaceStore(state => state.activeScopeId);
    const disabledSummaryIds = useWorkspaceStore(state => state.disabledSummaryIds);
    const toggleSummaryDisabled = useWorkspaceStore(state => state.toggleSummaryDisabled);
    const contextPathMessageIds = useWorkspaceStore(state => state.contextPathMessageIds);

    // Insights
    const insights = useWorkspaceStore(state => state.insights);
    const insightsVisible = useWorkspaceStore(state => state.insightsVisible);
    const showInsightsInGraph = useWorkspaceStore(state => state.showInsightsInGraph);
    const toggleInsightsVisible = useWorkspaceStore(state => state.toggleInsightsVisible);
    const toggleShowInsightsInGraph = useWorkspaceStore(state => state.toggleShowInsightsInGraph);
    const dismissInsight = useWorkspaceStore(state => state.dismissInsight);
    const runningCount = useRunStatusStore((state) => state.getRunningCount(selectedWorkspaceId));
    const contextPathMessageIdSet = useMemo(() => new Set(contextPathMessageIds), [contextPathMessageIds]);
    const activeRunStatusNodeIdKey = useRunStatusStore((state) => (
        Object.values(state.byNodeId)
            .filter((entry) => {
                if (selectedWorkspaceId && entry.workspaceId !== selectedWorkspaceId) return false;
                if (!entry.status) return false;
                return ACTIVE_GRAPH_RUN_STATUSES.has(entry.status);
            })
            .map((entry) => entry.nodeId)
            .sort()
            .join('|')
    ));
    const activeRunStatusNodeIds = useMemo(() => new Set(
        activeRunStatusNodeIdKey ? activeRunStatusNodeIdKey.split('|').filter(Boolean) : []
    ), [activeRunStatusNodeIdKey]);
    const activeSendFlowMessageIdKey = useMemo(() => {
        if (activeSendFlowFocus?.workspaceId !== selectedWorkspaceId) return '';
        return Array.from(new Set([
            activeSendFlowFocus.preferredMessageId,
            ...activeSendFlowFocus.guardedMessageIds,
        ].filter(Boolean))).sort().join('|');
    }, [activeSendFlowFocus, selectedWorkspaceId]);
    const activePinnedMessageIdKey = useMemo(() => (
        Array.from(new Set([
            ...Array.from(activeRunStatusNodeIds),
            ...(activeSendFlowMessageIdKey ? activeSendFlowMessageIdKey.split('|') : []),
        ].filter(Boolean))).sort().join('|')
    ), [activeRunStatusNodeIds, activeSendFlowMessageIdKey]);
    const [graphResetNonce, setGraphResetNonce] = useState(0);

    // ─────────────────────────────────────────────────────────────────────────
    // DATA QUERIES
    // ─────────────────────────────────────────────────────────────────────────
    const graphSnapshotQuery = useGraphSnapshot(selectedWorkspaceId || null, graphResetNonce);
    const shouldHydrateFullMessages = graphSnapshotQuery.isSuccess || graphSnapshotQuery.isError;
    const messagesQuery = useMessages(selectedWorkspaceId || '');
    const localNodesQuery = useLocalNodes(selectedWorkspaceId || null);
    const summariesQuery = useSummaries(selectedWorkspaceId || '', { enabled: shouldHydrateFullMessages });
    const { data: workspacesData } = useWorkspaces();
    const workspaces = useMemo(() => workspacesData ?? [], [workspacesData]);
    const { data: allModelsData } = useModels();
    const allModels = useMemo(() => allModelsData ?? [], [allModelsData]);
    const { data: agentsData } = useAgents();
    const agents = useMemo(() => agentsData ?? [], [agentsData]);
    const { data: branchPointersData } = useBranches(selectedWorkspaceId || null);
    const branchPointers = useMemo(() => branchPointersData ?? [], [branchPointersData]);
    const scopesQuery = useScopes(selectedWorkspaceId || null);
    const scopes = useMemo(() => (scopesQuery.data?.scopes ?? []) as Scope[], [scopesQuery.data?.scopes]);

    const workspaceRepoMap = useMemo(() => {
        return new Map(workspaces.map(c => [c.id, c.git_repo_path ?? c.folderPath ?? null]));
    }, [workspaces]);
    // Stable references for messages and summaries
    const snapshotSummaries = useMemo(() => graphSnapshotToSummaries(graphSnapshotQuery.data), [graphSnapshotQuery.data]);
    const snapshotCommits = useMemo(() => graphSnapshotQuery.data?.commits ?? [], [graphSnapshotQuery.data?.commits]);
    const snapshotCommitParents = useMemo(() => graphSnapshotQuery.data?.commitParents ?? [], [graphSnapshotQuery.data?.commitParents]);
    const snapshotCommitObservations = useMemo(() => graphSnapshotQuery.data?.commitObservations ?? [], [graphSnapshotQuery.data?.commitObservations]);
    const persistedGraphMessages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);
    const storeMessages = useGraphMessages(selectedWorkspaceId, persistedGraphMessages, localNodesQuery.data);
    const summaries = useMemo(() => summariesQuery.data ?? snapshotSummaries, [snapshotSummaries, summariesQuery.data]);
    const graphUsingSnapshot = false;
    const [viewMode, setViewMode] = useState<ViewMode>('branch');
    const [branchViewActivationNonce, setBranchViewActivationNonce] = useState(0);
    const scopeViewMode = 'project' as const;

    const graphFocusedMessageIdRef = useRef<string | null>(storeFocusedMessageId);
    const isUserFocusSource = lastFocusSource === 'graph' || lastFocusSource === 'chat' || lastFocusSource === 'timeline';
    const focusFlowId = typeof lastFocusMetadata?.flowId === 'string' ? lastFocusMetadata.flowId : null;
    const isComposerSendFlowFocusSource =
        lastFocusSource === 'composer' &&
        !!focusFlowId &&
        activeSendFlowFocus?.flowId === focusFlowId;
    const canUseLiveFocusedMessageId = isUserFocusSource || isComposerSendFlowFocusSource;

    useEffect(() => {
        if (runningCount > 0 && !canUseLiveFocusedMessageId) return;
        graphFocusedMessageIdRef.current = storeFocusedMessageId;
    }, [canUseLiveFocusedMessageId, runningCount, storeFocusedMessageId]);

    const messages = messagesOverride ?? storeMessages;
    const focusedMessageId = focusedIdOverride !== undefined
        ? focusedIdOverride
        : (runningCount > 0 && !canUseLiveFocusedMessageId ? graphFocusedMessageIdRef.current : storeFocusedMessageId);
    const agentLabelsById = useMemo(() => {
        const labels = new Map<string, string>(agents.map((agent) => [agent.id, agent.name]));
        for (const message of messages as Message[]) {
            if (!message.agent_id || labels.has(message.agent_id)) continue;
            if (message.llmModel) {
                labels.set(message.agent_id, message.llmModel);
            } else if (message.llmProvider) {
                labels.set(message.agent_id, message.llmProvider);
            }
        }
        return labels;
    }, [agents, messages]);
    const scopeNameById = useMemo(() => {
        const map = new Map<string, string>();
        for (const scope of scopes) {
            map.set(scope.id, scope.name);
        }
        return map;
    }, [scopes]);
    const scopeColorById = useMemo(() => {
        const map = new Map<string, string | null>();
        for (const scope of scopes) {
            map.set(scope.id, scope.color || null);
        }
        return map;
    }, [scopes]);
    const branchPointersByNodeId = useMemo(() => {
        const map = new Map<string, typeof branchPointers>();
        const pointersByCommit = new Map<string, typeof branchPointers>();

        for (const pointer of branchPointers) {
            const commitSha = getBranchPointerCommitSha(pointer);
            if (commitSha) {
                const commitList = pointersByCommit.get(commitSha) ?? [];
                commitList.push(pointer);
                pointersByCommit.set(commitSha, commitList);
            }
        }

        for (const msg of messages as Message[]) {
            const commitSha = getMessageOutputCommitSha(msg);
            if (!commitSha) continue;
            const commitPointers = pointersByCommit.get(commitSha);
            if (!commitPointers || commitPointers.length === 0) continue;
            map.set(msg.id, commitPointers);
        }

        return map;
    }, [branchPointers, messages]);

    const graphMessages = useMemo(() => (
        (messages as Message[]).map((message) => {
            const resolvedPointers = branchPointersByNodeId.get(message.id) ?? [];
            const currentPointers = message.branchPointers ?? [];
            if (currentPointers === resolvedPointers) return message;
            if (currentPointers.length === resolvedPointers.length && currentPointers.every((pointer, index) => pointer.id === resolvedPointers[index]?.id)) {
                return message;
            }
            return {
                ...message,
                branchPointers: resolvedPointers,
            };
        })
    ), [branchPointersByNodeId, messages]);
    const leafNodeNavigationItems = useMemo(() => (
        getLeafMessagesByRecency(graphMessages as Message[])
            .map((message) => toLeafNodeNavigationItem(message, agentLabelsById))
    ), [agentLabelsById, graphMessages]);
    const activeGraphComputationHold = runningCount > 0 || activeSendFlowFocus?.workspaceId === selectedWorkspaceId;
    const graphComputationMessagesRef = useRef<Message[]>(graphMessages as Message[]);
    const graphComputationMessages = useMemo(() => {
        const current = graphComputationMessagesRef.current;
        if (!activeGraphComputationHold) {
            graphComputationMessagesRef.current = graphMessages as Message[];
            recordFundamentalCounter('graph.computation-messages', {
                mode: 'live',
                messageCount: graphMessages.length,
                runningCount,
                activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            });
            return graphMessages as Message[];
        }

        if (!current || current.length === 0 || graphMessages.length !== current.length) {
            graphComputationMessagesRef.current = graphMessages as Message[];
            recordFundamentalCounter('graph.computation-messages', {
                mode: 'active-refresh',
                messageCount: graphMessages.length,
                previousMessageCount: current?.length ?? 0,
                runningCount,
                activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            });
            return graphMessages as Message[];
        }

        const activePinnedMessageIds = activePinnedMessageIdKey
            ? activePinnedMessageIdKey.split('|').filter(Boolean)
            : [];
        if (activePinnedMessageIds.length > 0) {
            const currentIds = new Set(current.map((message) => message.id));
            const incomingIds = new Set((graphMessages as Message[]).map((message) => message.id));
            const hasNewPinnedMessage = activePinnedMessageIds.some((id) => incomingIds.has(id) && !currentIds.has(id));
            if (hasNewPinnedMessage) {
                graphComputationMessagesRef.current = graphMessages as Message[];
                recordFundamentalCounter('graph.computation-messages', {
                    mode: 'active-refresh-pinned',
                    messageCount: graphMessages.length,
                    previousMessageCount: current.length,
                    pinnedMessageCount: activePinnedMessageIds.length,
                    runningCount,
                    activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
                });
                return graphMessages as Message[];
            }
        }

        recordFundamentalCounter('graph.computation-messages', {
            mode: 'active-held',
            messageCount: current.length,
            incomingMessageCount: graphMessages.length,
            runningCount,
            activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
        });
        return current;
    }, [activeGraphComputationHold, activePinnedMessageIdKey, activeSendFlowFocus?.workspaceId, graphMessages, runningCount, selectedWorkspaceId]);

    useEffect(() => {
        if (focusedIdOverride !== undefined || !selectedWorkspaceId || graphMessages.length === 0) return;
        if (activeSendFlowFocus?.workspaceId === selectedWorkspaceId) return;

        const workspaceMessages = graphMessages as Message[];
        const messageIds = new Set(workspaceMessages.map((message) => message.id));
        if (focusedMessageId && messageIds.has(focusedMessageId)) return;

        const rememberedFocusId = lastFocusedMessageByWorkspace[selectedWorkspaceId] ?? null;
        const fallbackMessageId = rememberedFocusId && messageIds.has(rememberedFocusId)
            ? rememberedFocusId
            : [...workspaceMessages].sort((a, b) => {
                const aTime = new Date(a.updatedAt || a.createdAt).getTime();
                const bTime = new Date(b.updatedAt || b.createdAt).getTime();
                return bTime - aTime;
            })[0]?.id ?? null;

        if (!fallbackMessageId || fallbackMessageId === focusedMessageId) return;

        dispatchFocus({
            messageId: fallbackMessageId,
            source: 'system',
            metadata: {
                reason: rememberedFocusId === fallbackMessageId ? 'restore-workspace-focus' : 'default-workspace-focus',
            },
        });
    }, [
        dispatchFocus,
        focusedIdOverride,
        focusedMessageId,
        graphMessages,
        lastFocusedMessageByWorkspace,
        activeSendFlowFocus,
        selectedWorkspaceId,
    ]);

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        if (typeof window === 'undefined' || window.localStorage.getItem('agentree.debug.branch-pointers') !== 'true') return;

        const mainPointer = branchPointers.find((pointer) => pointer.name === 'main');
        const externalCommitCount = graphMessages.filter((message) =>
            message.role === 'assistant' &&
            typeof (message.execution_data as any)?.meta?.imported_from_ref === 'string'
        ).length;

        console.debug('[BranchPointers][GraphView]', {
            totalPointers: branchPointers.length,
            mainPointer: mainPointer ? {
                id: mainPointer.id,
                nodeId: mainPointer.node_id,
                commitSha: getBranchPointerCommitSha(mainPointer),
                gitRef: mainPointer.git_ref,
            } : null,
            externalCommitCount,
        });
    }, [branchPointers, graphMessages]);

    // ─────────────────────────────────────────────────────────────────────────
    // MUTATIONS
    // ─────────────────────────────────────────────────────────────────────────
    const deleteMessageBranchMutation = useDeleteMessageBranch();
    const createNodePublicShare = useCreateNodePublicShare();
    const { mutate: toggleCollapse } = useToggleCollapse();
    const { openDiff } = useDiff();
    const toast = useToastHelpers();


    // ─────────────────────────────────────────────────────────────────────────
    // LOCAL STATE
    // ─────────────────────────────────────────────────────────────────────────
    const [layoutMode, setLayoutMode] = useState<LayoutMode>('tidy');
    const [laneStrategy, setLaneStrategy] = useState<LaneStrategy>('right');
    const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
    const [isIndexVisible, setIsIndexVisible] = useState(true);
    const [previewEdgeType, setPreviewEdgeType] = useState<GraphEdgeLegendId | null>(null);
    const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<GraphEdgeLegendId>>(
        () => new Set(['conversation', 'context-break'])
    );
    const [controlsHeight, setControlsHeight] = useState(0);
    const [measuredNodeHeights, setMeasuredNodeHeights] = useState<Map<string, number>>(() => EMPTY_MEASURED_NODE_HEIGHTS);
    const selectionAnchorIdRef = useRef<string | null>(null);
    const [isBulkDeleteAlertOpen, setIsBulkDeleteAlertOpen] = useState(false);
    const [bulkDeleteIds, setBulkDeleteIds] = useState<string[]>([]);
    const [bulkDeleteExplicitCommitShas, setBulkDeleteExplicitCommitShas] = useState<string[]>([]);
    const [removeCommitsFromGraph, setRemoveCommitsFromGraph] = useState(false);
    const [deletedGraphCommitShas, setDeletedGraphCommitShas] = useState<Set<string>>(() => new Set());
    const [bulkDeletePhase, setBulkDeletePhase] = useState<DeleteBranchDialogPhase>('idle');
    const [scopedContextMenu, setScopedContextMenu] = useState<ScopedContextMenuState | null>(null);
    const [addCommitTargetId, setAddCommitTargetId] = useState<string | null>(null);
    const [graphRenderHoldUntil, setGraphRenderHoldUntil] = useState(0);

    const selectedWorkspace = useMemo(
        () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
        [workspaces, selectedWorkspaceId]
    );
    useEffect(() => {
        setDeletedGraphCommitShas(readDeletedGraphCommitShas(selectedWorkspaceId));
    }, [selectedWorkspaceId]);
    const visibleSnapshotCommits = useMemo(
        () => snapshotCommits.filter((commit) => !deletedGraphCommitShas.has(commit.sha)),
        [deletedGraphCommitShas, snapshotCommits]
    );
    const visibleSnapshotCommitShaSet = useMemo(
        () => new Set(visibleSnapshotCommits.map((commit) => commit.sha)),
        [visibleSnapshotCommits]
    );
    const visibleSnapshotCommitParents = useMemo(
        () => snapshotCommitParents.filter((parent) => visibleSnapshotCommitShaSet.has(parent.child_sha)),
        [snapshotCommitParents, visibleSnapshotCommitShaSet]
    );
    const visibleSnapshotCommitObservations = useMemo(
        () => snapshotCommitObservations.filter((observation) => visibleSnapshotCommitShaSet.has(observation.commit_sha)),
        [snapshotCommitObservations, visibleSnapshotCommitShaSet]
    );
    const repoPath = selectedWorkspace?.git_repo_path ?? selectedWorkspace?.folderPath ?? null;
    const { runSync, isSyncing } = useGitSync(
        selectedWorkspaceId,
        repoPath
    );
    const { data: trackedRefs = [] } = useTrackedRefs(selectedWorkspaceId);
    const enabledTrackedGitRefs = useMemo(
        () => getEnabledTrackedGitRefs(trackedRefs),
        [trackedRefs]
    );
    const { data: gitRefSnapshot } = useGitRefSnapshot(repoPath, enabledTrackedGitRefs);
    const trackedRefsNeedingSync = useMemo(
        () => getTrackedRefsNeedingSync(trackedRefs, gitRefSnapshot),
        [trackedRefs, gitRefSnapshot]
    );
    const trackedRefTipByRef = useMemo(() => new Map(
        (gitRefSnapshot?.refs ?? [])
            .filter((ref) => Boolean(ref.commit_sha))
            .map((ref) => [ref.git_ref, ref.commit_sha])
    ), [gitRefSnapshot]);
    const pendingTrackedRefSyncKey = useMemo(() => trackedRefsNeedingSync
        .map((ref) => `${ref.git_ref}:${trackedRefTipByRef.get(ref.git_ref) ?? ''}`)
        .sort()
        .join('|'), [trackedRefsNeedingSync, trackedRefTipByRef]);
    const [isWindowActive, setIsWindowActive] = useState(() => {
        if (typeof document === 'undefined') return true;
        return document.visibilityState === 'visible' && document.hasFocus();
    });
    const [autoRefreshTargets, setAutoRefreshTargets] = useState<Record<AutoRefreshKey, number | null>>({
        repo: null,
        graph: null,
        summaries: null,
        workspaces: null,
    });
    const [manualRefreshingKeys, setManualRefreshingKeys] = useState<Record<AutoRefreshKey, boolean>>({
        repo: false,
        graph: false,
        summaries: false,
        workspaces: false,
    });
    const [isFullRefreshing, setIsFullRefreshing] = useState(false);
    const autoRefreshInFlightRef = useRef(false);
    const lastAutoSyncSnapshotKeyRef = useRef<string | null>(null);
    const refreshControlsEnabled = viewMode === 'branch' && !!selectedWorkspaceId && !!repoPath && isWindowActive;
    const repoAutoRefreshEligible = REPO_REF_SYNC_ENABLED && refreshControlsEnabled;
    const autoRefreshEligible = repoAutoRefreshEligible || (AUTO_REFRESH_ENABLED && refreshControlsEnabled);

    // ─────────────────────────────────────────────────────────────────────────
    // REFS
    // ─────────────────────────────────────────────────────────────────────────
    const controlsRef = useRef<HTMLDivElement | null>(null);
    const centeredFocusIdRef = useRef<string | null>(null);
    const previousViewModeRef = useRef<ViewMode>(viewMode);
    const layoutNodesRef = useRef<Node<any>[]>([]);
    const layoutEdgesRef = useRef<any[]>([]);
    const measuredNodeHeightsRef = useRef<Map<string, number>>(EMPTY_MEASURED_NODE_HEIGHTS);
    const pendingNodeHeightMeasuresRef = useRef<Map<string, number>>(new Map());
    const heightMeasureFlushTimeoutRef = useRef<number | null>(null);
    const heightMeasureEventsRef = useRef<any[]>([]);
    const runningCountRef = useRef(runningCount);
    const selectedNodeIdsRef = useRef<Set<string>>(new Set());
    const lastActiveRunHeightMeasureDeferLogAtRef = useRef(0);
    const activeRunGraphRenderRef = useRef<{ nodes: Node<any>[]; edges: Edge[]; mode: 'full' | 'hold-visible' } | null>(null);
    const previousGraphRenderRefsRef = useRef<{ nodes: Node<any>[] | null; edges: Edge[] | null }>({ nodes: null, edges: null });
    const previewEdgeTimeoutRef = useRef<number | null>(null);
    const [isViewportInteractingState, setIsViewportInteractingState] = useState(false);
    const [activeGraphWindowViewportVersion, setActiveGraphWindowViewportVersion] = useState(0);
    const viewportMoveStartedAtRef = useRef<number | null>(null);
    const isViewportInteractingRef = useRef(false);
    const viewportInteractionStaleTimeoutRef = useRef<number | null>(null);
    const isViewportPointerDownRef = useRef(false);
    const viewportDragIdRef = useRef<string | null>(null);
    const viewportPointerDownAtRef = useRef<number | null>(null);
    const viewportPointerUpAtRef = useRef<number | null>(null);
    const viewportDragStartViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
    const viewportFirstVisibleMoveLoggedRef = useRef(false);
    const activeGraphWindowLastUpdateAtRef = useRef(0);
    const activeGraphWindowUpdateTimeoutRef = useRef<number | null>(null);
    const rootViewportDragRef = useRef<{
        pointerId: number;
        lastX: number;
        lastY: number;
        moved: boolean;
    } | null>(null);
    const rootWheelEndTimeoutRef = useRef<number | null>(null);
    const imperativeCenteredMessageIdRef = useRef<string | null>(null);
    const branchCanvasRef = useRef<HTMLDivElement | null>(null);
    const nodeLayoutDiagnosticRef = useRef<(nodeId: string, label?: string) => void>(() => undefined);
    const focusCenterFirstFrameRef = useRef<number | null>(null);
    const focusCenterEndTimeoutRef = useRef<number | null>(null);
    const focusCenterRetryFrameRef = useRef<number | null>(null);
    const focusCenterRetryTokenRef = useRef(0);
    const deferredGraphFocusFrameRef = useRef<number | null>(null);
    const pendingGraphFocusRef = useRef<{
        interactionId: string;
        focusedMessageId: string;
        clickAt: number | null;
        dispatchScheduledAt: number | null;
        dispatchCommittedAt: number | null;
    } | null>(null);
    const graphDataReadyLoggedRef = useRef<string | null>(null);
    const graphContentRenderedLoggedRef = useRef<string | null>(null);
    const graphGeometrySnapshotCountRef = useRef(0);
    const rendererGeometryRootRef = useRef<HTMLElement | null>(null);
    const rendererGeometryCorrectionRef = useRef({ x: 0, y: 0 });
    const rendererGeometryLastOffsetKeyRef = useRef<string | null>(null);
    const currentGraphCommitSnapshotRef = useRef<GraphCommitSnapshot | null>(null);
    const previousGraphCommitSnapshotRef = useRef<GraphCommitSnapshot | null>(null);
    const lastHeightMeasureDeferLogAtRef = useRef(0);

    const reactFlowInstance = useReactFlow();
    const reactFlowStore = useStoreApi();

    const graphProfilerOnRender = useMemo(() => createProfilerOnRender('graph-surface', () => {
        const current = currentGraphCommitSnapshotRef.current;
        const previous = previousGraphCommitSnapshotRef.current;
        previousGraphCommitSnapshotRef.current = current;
        if (!current) return {};

        const attribution = {
            viewportInteracting: isViewportInteractingRef.current,
            selectedWorkspaceChanged: previous ? previous.selectedWorkspaceId !== current.selectedWorkspaceId : null,
            messagesRefChanged: previous ? didRefChange(previous.messagesRef, current.messagesRef) : null,
            graphMessagesRefChanged: previous ? didRefChange(previous.graphMessagesRef, current.graphMessagesRef) : null,
            summariesRefChanged: previous ? didRefChange(previous.summariesRef, current.summariesRef) : null,
            branchPointersRefChanged: previous ? didRefChange(previous.branchPointersRef, current.branchPointersRef) : null,
            branchPointersByNodeIdRefChanged: previous ? didRefChange(previous.branchPointersByNodeIdRef, current.branchPointersByNodeIdRef) : null,
            measuredHeightsRefChanged: previous ? didRefChange(previous.measuredHeightsRef, current.measuredHeightsRef) : null,
            layoutNodesRefChanged: previous ? didRefChange(previous.layoutNodesRef, current.layoutNodesRef) : null,
            layoutEdgesRefChanged: previous ? didRefChange(previous.layoutEdgesRef, current.layoutEdgesRef) : null,
            renderNodesRefChanged: previous ? didRefChange(previous.renderNodesRef, current.renderNodesRef) : null,
            previewEdgesRefChanged: previous ? didRefChange(previous.previewEdgesRef, current.previewEdgesRef) : null,
            focusedMessageChanged: previous ? previous.focusedMessageId !== current.focusedMessageId : null,
            focusNonceChanged: previous ? previous.focusNonce !== current.focusNonce : null,
            graphResetNonceChanged: previous ? previous.graphResetNonce !== current.graphResetNonce : null,
            tagFilterChanged: previous ? previous.tagFilterKey !== current.tagFilterKey : null,
            activeScopeChanged: previous ? previous.activeScopeId !== current.activeScopeId : null,
            viewModeChanged: previous ? previous.viewMode !== current.viewMode : null,
            runningCountChanged: previous ? previous.runningCount !== current.runningCount : null,
            graphSnapshotStatusChanged: previous ? previous.graphSnapshotStatus !== current.graphSnapshotStatus : null,
            messagesQueryStatusChanged: previous ? previous.messagesQueryStatus !== current.messagesQueryStatus : null,
            counts: {
                messages: current.messagesRef?.length ?? 0,
                graphMessages: current.graphMessagesRef?.length ?? 0,
                summaries: current.summariesRef?.length ?? 0,
                measuredHeights: current.measuredHeightsRef.size,
                layoutNodes: current.layoutNodesRef?.length ?? 0,
                layoutEdges: current.layoutEdgesRef?.length ?? 0,
                renderNodes: current.renderNodesRef?.length ?? 0,
                previewEdges: current.previewEdgesRef?.length ?? 0,
                running: current.runningCount,
            },
        };

        const shouldRecordAttribution = (
            Boolean(attribution.viewportInteracting) ||
            attribution.selectedWorkspaceChanged === true ||
            attribution.messagesRefChanged === true ||
            attribution.graphMessagesRefChanged === true ||
            attribution.summariesRefChanged === true ||
            attribution.measuredHeightsRefChanged === true ||
            attribution.focusedMessageChanged === true ||
            attribution.focusNonceChanged === true ||
            attribution.tagFilterChanged === true ||
            attribution.activeScopeChanged === true ||
            attribution.viewModeChanged === true ||
            attribution.runningCountChanged === true ||
            attribution.graphSnapshotStatusChanged === true ||
            attribution.messagesQueryStatusChanged === true
        );

        if (shouldRecordAttribution) {
            recordPerfEvent('graph.commit.attribution', attribution, { source: 'GraphView' });
        }
        return attribution;
    }), []);

    const resetReactFlowInternalScrollState = useCallback((reason = 'manual') => {
        const canvas = branchCanvasRef.current;
        const root = canvas?.querySelector<HTMLElement>(':scope > .react-flow') ?? null;
        const renderer = root?.querySelector<HTMLElement>(':scope > .react-flow__renderer') ?? null;
        const pane = renderer?.querySelector<HTMLElement>(':scope > .react-flow__pane') ?? null;
        const targets = [
            ['root', root],
            ['renderer', renderer],
            ['pane', pane],
        ] as const;
        const changed = targets
            .map(([name, element]) => {
                if (!element) return null;
                const before = {
                    left: element.scrollLeft,
                    top: element.scrollTop,
                };
                if (before.left === 0 && before.top === 0) return null;
                element.scrollLeft = 0;
                element.scrollTop = 0;
                return {
                    name,
                    before,
                    after: {
                        left: element.scrollLeft,
                        top: element.scrollTop,
                    },
                };
            })
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

        if (changed.length > 0) {
            recordPerfEvent('graph.geometry.internal-scroll-reset', {
                reason,
                changed,
            }, { source: 'GraphView' });
        }

        return changed;
    }, []);

    const normalizeReactFlowLayerGeometry = useCallback((reason = 'manual') => {
        const canvas = branchCanvasRef.current;
        const root = canvas?.querySelector<HTMLElement>(':scope > .react-flow') ?? null;
        const renderer = root?.querySelector<HTMLElement>(':scope > .react-flow__renderer') ?? null;
        if (!canvas || !root || !renderer) return null;
        if (rendererGeometryRootRef.current !== root) {
            rendererGeometryRootRef.current = root;
            rendererGeometryCorrectionRef.current = { x: 0, y: 0 };
            rendererGeometryLastOffsetKeyRef.current = null;
            root.style.removeProperty('--agentree-rf-renderer-correction-x');
            root.style.removeProperty('--agentree-rf-renderer-correction-y');
        }

        const scrollReset = resetReactFlowInternalScrollState(reason);
        if (scrollReset.length > 0) {
            rendererGeometryLastOffsetKeyRef.current = null;
        }

        const rootRect = root.getBoundingClientRect();
        const rendererRect = renderer.getBoundingClientRect();
        const deltaX = rendererRect.left - rootRect.left;
        const deltaY = rendererRect.top - rootRect.top;
        if (Math.abs(deltaX) <= 0.5 && Math.abs(deltaY) <= 0.5) return rendererGeometryCorrectionRef.current;

        const offsetKey = `${Math.round(deltaX)}:${Math.round(deltaY)}:${Math.round(rootRect.width)}:${Math.round(rootRect.height)}`;
        if (rendererGeometryLastOffsetKeyRef.current !== offsetKey) {
            rendererGeometryLastOffsetKeyRef.current = offsetKey;
            recordPerfEvent('graph.geometry.renderer-offset-observed', {
                reason,
                delta: {
                    x: roundMetric(deltaX),
                    y: roundMetric(deltaY),
                },
                rootRect: rectSnapshot(rootRect),
                rendererRect: rectSnapshot(rendererRect),
            }, { source: 'GraphView' });
        }

        return rendererGeometryCorrectionRef.current;
    }, [resetReactFlowInternalScrollState]);

    const resetReactFlowLayerGeometryCorrection = useCallback((reason = 'manual') => {
        const root = rendererGeometryRootRef.current;
        if (root) {
            root.style.removeProperty('--agentree-rf-renderer-correction-x');
            root.style.removeProperty('--agentree-rf-renderer-correction-y');
        }
        rendererGeometryRootRef.current = null;
        rendererGeometryCorrectionRef.current = { x: 0, y: 0 };
        rendererGeometryLastOffsetKeyRef.current = null;
        recordPerfEvent('graph.geometry.renderer-correction-reset', {
            reason,
        }, { source: 'GraphView' });
    }, []);

    const captureGraphGeometrySnapshot = useCallback((reason = 'manual') => {
        const isManualCapture = reason === 'manual' || reason.startsWith('debug');
        if (!GRAPH_GEOMETRY_DIAGNOSTICS_ENABLED && !isManualCapture) {
            return null;
        }

        const canvas = branchCanvasRef.current;
        const canvasRect = canvas?.getBoundingClientRect() ?? null;
        const root = canvas?.querySelector<HTMLElement>(':scope > .react-flow') ?? null;
        const renderer = root?.querySelector<HTMLElement>(':scope > .react-flow__renderer') ?? null;
        const pane = renderer?.querySelector<HTMLElement>(':scope > .react-flow__pane') ?? null;
        const viewportElement = renderer?.querySelector<HTMLElement>('.react-flow__viewport') ?? null;
        const controls = root?.querySelector<HTMLElement>('.react-flow__controls') ?? null;
        const controlsPanel = controls?.closest<HTMLElement>('.react-flow__panel') ?? null;
        const minimap = canvas?.querySelector<HTMLElement>('.react-flow__minimap') ?? null;
        const minimapRegion = canvas?.querySelector<HTMLElement>('[aria-label="Graph minimap"]') ?? null;
        const minimapPanel = minimapRegion?.parentElement ?? minimap?.closest<HTMLElement>('.react-flow__panel') ?? null;
        const indexPanel = canvas?.querySelector<HTMLElement>('[aria-label="Graph canvas index"]') ?? null;
        const selectedDomNode = focusedMessageId
            ? canvas?.querySelector<HTMLElement>(`[data-agentree-graph-node-id="${CSS.escape(focusedMessageId)}"]`) ?? null
            : null;
        const selectedFlowNode = selectedDomNode?.closest<HTMLElement>('.react-flow__node') ?? null;
        const viewport = reactFlowInstance.getViewport();
        const canvasWidth = canvasRect?.width ?? 0;
        const canvasHeight = canvasRect?.height ?? 0;

        const rect = (element: Element | null | undefined) => rectSnapshot(element?.getBoundingClientRect?.() ?? null, canvasRect);
        const absRect = (element: Element | null | undefined) => rectSnapshot(element?.getBoundingClientRect?.() ?? null);
        const styles = (element: HTMLElement | null | undefined) => {
            if (!element) return null;
            const computed = window.getComputedStyle(element);
            return {
                position: computed.position,
                display: computed.display,
                offset: {
                    left: element.offsetLeft,
                    top: element.offsetTop,
                    width: element.offsetWidth,
                    height: element.offsetHeight,
                    parentClassName: element.offsetParent instanceof HTMLElement ? element.offsetParent.className : null,
                },
                scroll: {
                    left: element.scrollLeft,
                    top: element.scrollTop,
                    width: element.scrollWidth,
                    height: element.scrollHeight,
                    clientWidth: element.clientWidth,
                    clientHeight: element.clientHeight,
                },
                inset: {
                    top: computed.top,
                    right: computed.right,
                    bottom: computed.bottom,
                    left: computed.left,
                },
                margin: {
                    top: computed.marginTop,
                    right: computed.marginRight,
                    bottom: computed.marginBottom,
                    left: computed.marginLeft,
                },
                width: computed.width,
                height: computed.height,
                overflow: computed.overflow,
                transform: computed.transform,
                translate: computed.translate,
                scale: computed.scale,
                rotate: computed.rotate,
                pointerEvents: computed.pointerEvents,
                zIndex: computed.zIndex,
            };
        };
        const distanceFromCanvasEdges = (element: Element | null | undefined) => {
            const elementRect = element?.getBoundingClientRect?.() ?? null;
            if (!elementRect || !canvasRect) return null;
            return {
                left: roundMetric(elementRect.left - canvasRect.left),
                top: roundMetric(elementRect.top - canvasRect.top),
                right: roundMetric(canvasRect.right - elementRect.right),
                bottom: roundMetric(canvasRect.bottom - elementRect.bottom),
            };
        };
        const matchesCanvas = (element: Element | null | undefined) => {
            const elementRect = element?.getBoundingClientRect?.() ?? null;
            if (!elementRect || !canvasRect) return null;
            return {
                leftDelta: roundMetric(elementRect.left - canvasRect.left),
                topDelta: roundMetric(elementRect.top - canvasRect.top),
                widthDelta: roundMetric(elementRect.width - canvasRect.width),
                heightDelta: roundMetric(elementRect.height - canvasRect.height),
            };
        };

        const rootMatch = matchesCanvas(root);
        const rendererMatch = matchesCanvas(renderer);
        const paneMatch = matchesCanvas(pane);
        const controlsEdges = distanceFromCanvasEdges(controlsPanel ?? controls);
        const minimapEdges = distanceFromCanvasEdges(minimapPanel ?? minimapRegion ?? minimap);
        const focusedNodeRect = rect(selectedFlowNode ?? selectedDomNode);

        const anomalies = {
            missingCanvas: !canvas,
            missingReactFlowRoot: !root,
            missingRenderer: !renderer,
            missingPane: !pane,
            missingControls: !controls,
            rootNotCanvasSized: !!rootMatch && (
                Math.abs(rootMatch.leftDelta ?? 0) > 1 ||
                Math.abs(rootMatch.topDelta ?? 0) > 1 ||
                Math.abs(rootMatch.widthDelta ?? 0) > 1 ||
                Math.abs(rootMatch.heightDelta ?? 0) > 1
            ),
            rendererNotCanvasSized: !!rendererMatch && (
                Math.abs(rendererMatch.leftDelta ?? 0) > 1 ||
                Math.abs(rendererMatch.topDelta ?? 0) > 1 ||
                Math.abs(rendererMatch.widthDelta ?? 0) > 1 ||
                Math.abs(rendererMatch.heightDelta ?? 0) > 1
            ),
            paneNotCanvasSized: !!paneMatch && (
                Math.abs(paneMatch.leftDelta ?? 0) > 1 ||
                Math.abs(paneMatch.topDelta ?? 0) > 1 ||
                Math.abs(paneMatch.widthDelta ?? 0) > 1 ||
                Math.abs(paneMatch.heightDelta ?? 0) > 1
            ),
            controlsNotNearBottom: !!controlsEdges && typeof controlsEdges.bottom === 'number' && (controlsEdges.bottom < 0 || controlsEdges.bottom > 64),
            controlsNotNearLeft: !!controlsEdges && typeof controlsEdges.left === 'number' && (controlsEdges.left < 0 || controlsEdges.left > 64),
            minimapOutsideCanvas: !!minimapEdges && (
                (minimapEdges.left ?? 0) < -1 ||
                (minimapEdges.top ?? 0) < -1 ||
                (minimapEdges.right ?? 0) < -1 ||
                (minimapEdges.bottom ?? 0) < -1
            ),
            focusedNodeOutsideCanvas: !!focusedNodeRect && (
                focusedNodeRect.right < 0 ||
                focusedNodeRect.left > canvasWidth ||
                focusedNodeRect.bottom < 0 ||
                focusedNodeRect.top > canvasHeight
            ),
        };

        const snapshot = {
            reason,
            sequence: graphGeometrySnapshotCountRef.current,
            workspaceId: selectedWorkspaceId,
            focusedMessageId,
            viewMode,
            layoutMode,
            laneStrategy,
            graphResetNonce,
            rendererCorrection: rendererGeometryCorrectionRef.current,
            counts: {
                nodes: layoutNodesRef.current.length,
                edges: layoutEdgesRef.current.length,
                measuredNodeHeights: measuredNodeHeightsRef.current.size,
            },
            viewport: {
                x: roundMetric(viewport.x),
                y: roundMetric(viewport.y),
                zoom: roundMetric(viewport.zoom, 4),
            },
            viewportTransform: viewportElement ? window.getComputedStyle(viewportElement).transform : null,
            d3: (() => {
                const { d3Zoom, d3Selection } = reactFlowStore.getState();
                return {
                    hasD3Zoom: Boolean(d3Zoom),
                    hasD3Selection: Boolean(d3Selection),
                };
            })(),
            window: {
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio,
                visualViewport: window.visualViewport ? {
                    width: roundMetric(window.visualViewport.width),
                    height: roundMetric(window.visualViewport.height),
                    offsetLeft: roundMetric(window.visualViewport.offsetLeft),
                    offsetTop: roundMetric(window.visualViewport.offsetTop),
                    scale: roundMetric(window.visualViewport.scale, 4),
                } : null,
            },
            document: {
                bodyRect: rectSnapshot(document.body.getBoundingClientRect()),
                rootRect: rectSnapshot(document.documentElement.getBoundingClientRect()),
            },
            canvas: {
                rect: rect(canvas),
                absRect: absRect(canvas),
                style: styles(canvas),
            },
            reactFlow: {
                root: { rect: rect(root), absRect: absRect(root), matchCanvas: rootMatch, className: root?.className ?? null, style: styles(root) },
                renderer: { rect: rect(renderer), absRect: absRect(renderer), matchCanvas: rendererMatch, className: renderer?.className ?? null, style: styles(renderer) },
                pane: { rect: rect(pane), absRect: absRect(pane), matchCanvas: paneMatch, className: pane?.className ?? null, style: styles(pane) },
                viewport: { rect: rect(viewportElement), absRect: absRect(viewportElement), className: viewportElement?.className ?? null, style: styles(viewportElement) },
            },
            overlays: {
                controls: {
                    rect: rect(controls),
                    panelRect: rect(controlsPanel),
                    edges: controlsEdges,
                    className: controls?.className ?? null,
                    panelClassName: controlsPanel?.className ?? null,
                    style: styles(controls),
                    panelStyle: styles(controlsPanel),
                },
                minimap: {
                    rect: rect(minimap),
                    regionRect: rect(minimapRegion),
                    panelRect: rect(minimapPanel),
                    edges: minimapEdges,
                    className: minimap?.className ?? null,
                    panelClassName: minimapPanel?.className ?? null,
                    style: styles(minimap),
                    panelStyle: styles(minimapPanel),
                },
                indexPanel: {
                    rect: rect(indexPanel),
                    edges: distanceFromCanvasEdges(indexPanel),
                    className: indexPanel?.className ?? null,
                    style: styles(indexPanel),
                },
            },
            focusedNode: {
                rect: focusedNodeRect,
                contentRect: rect(selectedDomNode),
                className: selectedFlowNode?.className ?? null,
            },
            anomalies,
        };

        graphGeometrySnapshotCountRef.current += 1;
        recordPerfEvent('graph.geometry.snapshot', snapshot, { source: 'GraphView' });
        if (GRAPH_GEOMETRY_DIAGNOSTICS_ENABLED) {
            console.info('[GraphGeometry]', snapshot);
        }
        return snapshot;
    }, [
        focusedMessageId,
        graphResetNonce,
        laneStrategy,
        layoutMode,
        reactFlowInstance,
        reactFlowStore,
        selectedWorkspaceId,
        viewMode,
    ]);

    const getGraphPointerDebugInfo = useCallback((target: HTMLElement | null) => {
        const root = target?.closest?.('.react-flow') as HTMLElement | null;
        const pane = target?.closest?.('.react-flow__pane') as HTMLElement | null;
        const renderer = target?.closest?.('.react-flow__renderer') as HTMLElement | null;
        const node = target?.closest?.('.react-flow__node') as HTMLElement | null;
        const edge = target?.closest?.('.react-flow__edge') as HTMLElement | null;
        const targetClasses = target?.className;
        const rootClasses = root?.className;
        const paneClasses = pane?.className;
        return {
            targetTag: target?.tagName ?? null,
            targetClassName: typeof targetClasses === 'string' ? targetClasses : null,
            targetDataId: target?.getAttribute?.('data-id') ?? null,
            rootClassName: typeof rootClasses === 'string' ? rootClasses : null,
            rootCursor: root ? window.getComputedStyle(root).cursor : null,
            paneClassName: typeof paneClasses === 'string' ? paneClasses : null,
            paneCursor: pane ? window.getComputedStyle(pane).cursor : null,
            rendererPointerEvents: renderer ? window.getComputedStyle(renderer).pointerEvents : null,
            isDirectReactFlowRoot: Boolean(target?.classList?.contains('react-flow')),
            isInsideReactFlowRoot: Boolean(root),
            isDirectPaneTarget: Boolean(target?.classList?.contains('react-flow__pane')),
            isInsidePane: Boolean(pane),
            isInsideNode: Boolean(node),
            isInsideEdge: Boolean(edge),
        };
    }, []);

    const recordRootFallbackGeometry = useCallback((
        reason: 'pointer-drag' | 'wheel',
        target: HTMLElement | null,
    ) => {
        const canvas = branchCanvasRef.current;
        const canvasRect = canvas?.getBoundingClientRect() ?? null;
        const root = target?.closest?.('.react-flow') as HTMLElement | null;
        const renderer = root?.querySelector<HTMLElement>(':scope > .react-flow__renderer') ?? null;
        const pane = renderer?.querySelector<HTMLElement>(':scope > .react-flow__pane') ?? null;
        const viewportElement = renderer?.querySelector<HTMLElement>('.react-flow__viewport') ?? null;
        const viewport = reactFlowInstance.getViewport();
        const { d3Zoom, d3Selection } = reactFlowStore.getState();

        recordPerfEvent('graph.viewport.root-fallback.geometry', {
            reason,
            viewport: {
                x: roundMetric(viewport.x),
                y: roundMetric(viewport.y),
                zoom: roundMetric(viewport.zoom, 4),
            },
            hasD3Zoom: Boolean(d3Zoom),
            hasD3Selection: Boolean(d3Selection),
            canvasRect: rectSnapshot(canvasRect),
            rootRect: rectSnapshot(root?.getBoundingClientRect() ?? null, canvasRect),
            rendererRect: rectSnapshot(renderer?.getBoundingClientRect() ?? null, canvasRect),
            paneRect: rectSnapshot(pane?.getBoundingClientRect() ?? null, canvasRect),
            viewportRect: rectSnapshot(viewportElement?.getBoundingClientRect() ?? null, canvasRect),
            rootClassName: root?.className ?? null,
            rendererClassName: renderer?.className ?? null,
            paneClassName: pane?.className ?? null,
            rootPointerEvents: root ? window.getComputedStyle(root).pointerEvents : null,
            rendererPointerEvents: renderer ? window.getComputedStyle(renderer).pointerEvents : null,
            panePointerEvents: pane ? window.getComputedStyle(pane).pointerEvents : null,
            rendererTransform: renderer ? window.getComputedStyle(renderer).transform : null,
            paneTransform: pane ? window.getComputedStyle(pane).transform : null,
            viewportTransform: viewportElement ? window.getComputedStyle(viewportElement).transform : null,
        }, { source: 'GraphView' });
    }, [reactFlowInstance, reactFlowStore]);

    const setViewportInteractingDomState = useCallback((interacting: boolean) => {
        const canvas = branchCanvasRef.current;
        if (!canvas) return;
        if (interacting) {
            canvas.dataset.viewportInteracting = 'true';
        } else {
            delete canvas.dataset.viewportInteracting;
        }
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // CUSTOM HOOKS
    // ─────────────────────────────────────────────────────────────────────────
    const graphFilterStorageKey = selectedWorkspaceId
        ? `agentree.graphFilters.v1.workspace.${selectedWorkspaceId}`
        : 'agentree.graphFilters.v1.workspace.none';
    const tagFilter = useTagFilter(graphComputationMessages, branchPointers, scopes, graphFilterStorageKey);
    const nodeSelection = useNodeSelection(graphComputationMessages);
    const { openMergeSession } = useIntegrationStore();
    const disabledSummaryIdsSet = useMemo(() => new Set(disabledSummaryIds), [disabledSummaryIds]);
    const workspaceProjection = useWorkspaceProjection(
        graphComputationMessages,
        scopes,
        summaries as Summary[],
        focusedMessageId,
        disabledSummaryIdsSet,
        'graph',
        visibleSnapshotCommits,
        visibleSnapshotCommitParents,
        visibleSnapshotCommitObservations,
    );
    const handleMergeSelection = useCallback((selectionIds?: Iterable<string>) => {
        const { setRightPanelTab } = useWorkspaceStore.getState();
        const selectedIds = selectionIds ? Array.from(selectionIds) : Array.from(nodeSelection.selectedNodeIds);
        if (selectedIds.length < 2) {
            toast.error('Selection required', 'Select at least 2 nodes to merge');
            return;
        }

        // Get the selected messages
        const selectedMessages = selectedIds
            .map((id) => (messages as Message[]).find((m: Message) => m.id === id))
            .filter((m): m is Message => !!m);

        // Check that all have git commits
        const messagesWithCommits = selectedMessages
            .map((message) => ({ message, commitSha: getMessageOutputCommitSha(message) }))
            .filter((item): item is { message: Message; commitSha: string } => !!item.commitSha);
        if (messagesWithCommits.length < selectedMessages.length) {
            toast.error('Invalid selection', 'All selected nodes must have git commits');
            return;
        }

        // Use the last selected node as target, others as sources
        // User can change this in the workspace
        const target = messagesWithCommits[messagesWithCommits.length - 1];
        const sources = messagesWithCommits.slice(0, -1);

        if (!selectedWorkspaceId) return;

        const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath;
        if (!repoPath) {
            toast.error('No repository', 'This workspace has no git repository');
            return;
        }

        // Open the integration workspace
        openMergeSession(selectedWorkspaceId, repoPath);
        setRightPanelTab('merge');

        // Add target and sources to the session
        const { setTarget, addSource } = useIntegrationStore.getState();

        setTarget({
            id: target.message.id,
            type: 'graph-node',
            label: target.message.aiLabel || target.message.content.slice(0, 50) || target.message.id.slice(0, 8),
            commitSha: target.commitSha,
            nodeId: target.message.id,
        });

        for (const source of sources) {
            addSource({
                id: source.message.id,
                type: 'graph-node',
                label: source.message.aiLabel || source.message.content.slice(0, 50) || source.message.id.slice(0, 8),
                commitSha: source.commitSha,
                nodeId: source.message.id,
            });
        }

        // Clear the selection
        nodeSelection.clearSelection();
    }, [nodeSelection, messages, selectedWorkspace, selectedWorkspaceId, openMergeSession, toast]);

    const handleGenerateSummaryForIds = useCallback((messageIds: string[]) => {
        nodeSelection.replaceSelection(messageIds);
        window.requestAnimationFrame(() => {
            nodeSelection.handleSummarize();
        });
    }, [nodeSelection]);

    const handleMergeForIds = useCallback((messageIds: string[]) => {
        handleMergeSelection(messageIds);
    }, [handleMergeSelection]);

    const handleAddCommitsToMergePanel = useCallback((messageIds: string[]) => {
        if (!selectedWorkspaceId) return;

        const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath;
        if (!repoPath) {
            toast.error('No repository', 'This workspace has no git repository');
            return;
        }

        const integrationState = useIntegrationStore.getState();
        if (!integrationState.session || integrationState.session.workspaceId !== selectedWorkspaceId || integrationState.session.repoPath !== repoPath) {
            openMergeSession(selectedWorkspaceId, repoPath);
        }

        const { addSource } = useIntegrationStore.getState();
        const mergeableMessages = messageIds
            .map((id) => (messages as Message[]).find((message: Message) => message.id === id))
            .map((message) => ({ message, commitSha: getMessageOutputCommitSha(message) }))
            .filter((item): item is { message: Message; commitSha: string } => !!item.message && !!item.commitSha);

        let addedCount = 0;
        for (const { message, commitSha } of mergeableMessages) {
            const added = addSource({
                id: message.id,
                type: 'graph-node',
                label: message.aiLabel || message.content.slice(0, 50) || message.id.slice(0, 8),
                commitSha,
                nodeId: message.id,
            });
            if (added) addedCount += 1;
        }

        const duplicateCount = mergeableMessages.length - addedCount;
        if (addedCount > 0) {
            toast.success(
                'Added to merge panel',
                addedCount === 1 ? '1 commit added to merge sources.' : `${addedCount} commits added to merge sources.`
            );
        }
        if (duplicateCount > 0) {
            toast.info(
                'Already in merge panel',
                duplicateCount === 1 ? '1 commit was already present.' : `${duplicateCount} commits were already present.`
            );
        }
    }, [messages, openMergeSession, selectedWorkspace, selectedWorkspaceId, toast]);

    const handleToggleCollapse = useCallback((id: string, collapsed: boolean) => {
        if (!selectedWorkspaceId) return;
        toggleCollapse({ workspaceId: selectedWorkspaceId, messageId: id, collapsed });
    }, [selectedWorkspaceId, toggleCollapse]);

    const handleSelect = useCallback((id: string, multi: boolean) => {
        nodeSelection.toggleSelection(id, multi);
    }, [nodeSelection.toggleSelection]);

    const flushMeasuredNodeHeights = useCallback(() => {
        heightMeasureFlushTimeoutRef.current = null;
        const pending = pendingNodeHeightMeasuresRef.current;
        if (pending.size === 0) return;
        if (runningCountRef.current > 0) {
            const nowMs = performance.now();
            if (nowMs - lastActiveRunHeightMeasureDeferLogAtRef.current > 1000) {
                lastActiveRunHeightMeasureDeferLogAtRef.current = nowMs;
                recordPerfEvent('graph.node-measure.flush-deferred', {
                    pendingCount: pending.size,
                    activeRunCount: runningCountRef.current,
                    reason: 'active-run',
                }, { source: 'GraphView' });
            }
            heightMeasureFlushTimeoutRef.current = window.setTimeout(
                flushMeasuredNodeHeights,
                250
            );
            return;
        }
        if (isViewportInteractingRef.current) {
            const nowMs = performance.now();
            if (nowMs - lastHeightMeasureDeferLogAtRef.current > 500) {
                lastHeightMeasureDeferLogAtRef.current = nowMs;
                recordPerfEvent('graph.node-measure.flush-deferred', {
                    pendingCount: pending.size,
                    viewportInteracting: true,
                    dragId: viewportDragIdRef.current,
                }, { source: 'GraphView' });
            }
            heightMeasureFlushTimeoutRef.current = window.setTimeout(
                flushMeasuredNodeHeights,
                GRAPH_HEIGHT_MEASURE_FLUSH_MS
            );
            return;
        }
        pendingNodeHeightMeasuresRef.current = new Map();

        setMeasuredNodeHeights((current) => {
            let next: Map<string, number> | null = null;
            const diagnostics = [...heightMeasureEventsRef.current];
            const changedMeasures: Array<{
                nodeId: string;
                previousHeight: number | null;
                nextHeight: number;
                delta: number | null;
            }> = [];

            pending.forEach((roundedHeight, id) => {
                const previousHeight = (next ?? current).get(id);
                const delta = previousHeight === undefined ? null : roundedHeight - previousHeight;
                diagnostics.push({
                    at: new Date().toISOString(),
                    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                    id,
                    previousHeight: previousHeight ?? null,
                    measuredHeight: roundedHeight,
                    delta,
                });

                if (previousHeight !== undefined && Math.abs(previousHeight - roundedHeight) < NODE_HEIGHT_MEASURE_EPSILON) {
                    return;
                }

                if (!next) next = new Map(current);
                next.set(id, roundedHeight);
                changedMeasures.push({
                    nodeId: id,
                    previousHeight: previousHeight ?? null,
                    nextHeight: roundedHeight,
                    delta,
                });
            });

            heightMeasureEventsRef.current = diagnostics.slice(-GRAPH_DIAGNOSTIC_MAX_MEASURE_EVENTS);
            if (!next) return current;
            recordPerfEvent('graph.node-measure.batch-changed', {
                changedCount: changedMeasures.length,
                pendingCount: pending.size,
                viewportInteracting: isViewportInteractingRef.current,
                sample: changedMeasures.slice(0, 8),
            }, { source: 'GraphView' });
            measuredNodeHeightsRef.current = next;
            return next;
        });
    }, []);

    const handleMeasureNodeHeight = useCallback((id: string, height: number) => {
        if (!Number.isFinite(height) || height <= 0) return;
        const roundedHeight = Math.ceil(height);
        const currentHeight = measuredNodeHeightsRef.current.get(id);
        const pendingHeight = pendingNodeHeightMeasuresRef.current.get(id);

        if (
            currentHeight !== undefined &&
            Math.abs(currentHeight - roundedHeight) < NODE_HEIGHT_MEASURE_EPSILON
        ) {
            return;
        }
        if (
            pendingHeight !== undefined &&
            Math.abs(pendingHeight - roundedHeight) < NODE_HEIGHT_MEASURE_EPSILON
        ) {
            return;
        }

        pendingNodeHeightMeasuresRef.current.set(id, roundedHeight);
        if (heightMeasureFlushTimeoutRef.current === null) {
            heightMeasureFlushTimeoutRef.current = window.setTimeout(
                flushMeasuredNodeHeights,
                GRAPH_HEIGHT_MEASURE_FLUSH_MS
            );
        }
    }, [flushMeasuredNodeHeights]);

    useEffect(() => {
        measuredNodeHeightsRef.current = measuredNodeHeights;
    }, [measuredNodeHeights]);

    useEffect(() => {
        selectedNodeIdsRef.current = nodeSelection.selectedNodeIds;
    }, [nodeSelection.selectedNodeIds]);

    useEffect(() => {
        runningCountRef.current = runningCount;
        if (runningCount !== 0) return;
        if (pendingNodeHeightMeasuresRef.current.size === 0) return;
        if (heightMeasureFlushTimeoutRef.current !== null) return;
        heightMeasureFlushTimeoutRef.current = window.setTimeout(
            flushMeasuredNodeHeights,
            GRAPH_HEIGHT_MEASURE_FLUSH_MS
        );
    }, [flushMeasuredNodeHeights, runningCount]);

    const handleScopedNodeContextMenu = useCallback((id: string, event: React.MouseEvent) => {
        const selectedNodeIds = selectedNodeIdsRef.current;
        const scopedIds = selectedNodeIds.has(id) ? Array.from(selectedNodeIds) : [id];
        setScopedContextMenu({
            x: event.clientX,
            y: event.clientY,
            scopedIds,
        });
    }, []);

    const handleShareNode = useCallback(async (messageId: string) => {
        if (!selectedWorkspaceId) {
            toast.error('No workspace selected', 'Select a workspace before sharing a node.');
            return;
        }

        try {
            const result = await createNodePublicShare.mutateAsync({
                workspaceId: selectedWorkspaceId,
                nodeId: messageId,
            });
            const url = getPublicShareUrl(result.share.publicId);
            await navigator.clipboard.writeText(url).catch(() => undefined);
            toast.success('Public link created', 'The node subgraph link was copied.');
        } catch (error) {
            console.error('[GraphView] Failed to create public node share:', error);
            toast.error('Unable to create link', 'The public node link could not be created.');
        }
    }, [createNodePublicShare, selectedWorkspaceId, toast]);

    const stopViewportInteraction = useCallback((viewportOverride?: { x: number; y: number; zoom: number }) => {
        if (!isViewportInteractingRef.current) return;

        isViewportInteractingRef.current = false;
        setIsViewportInteractingState(false);
        if (viewportInteractionStaleTimeoutRef.current !== null) {
            window.clearTimeout(viewportInteractionStaleTimeoutRef.current);
            viewportInteractionStaleTimeoutRef.current = null;
        }
        const startedAt = viewportMoveStartedAtRef.current;
        viewportMoveStartedAtRef.current = null;
        setViewportInteractingDomState(false);
        markGraphInteractionEnd('viewport-drag');

        const viewport = viewportOverride ?? reactFlowInstance.getViewport();
        const endedAt = performance.now();
        const pointerDownAt = viewportPointerDownAtRef.current;
        const pointerUpAt = viewportPointerUpAtRef.current;
        recordPerfEvent('graph.viewport-move.end', {
            dragId: viewportDragIdRef.current,
            x: Number(viewport.x.toFixed(2)),
            y: Number(viewport.y.toFixed(2)),
            zoom: Number(viewport.zoom.toFixed(3)),
            pointerDownAt,
            pointerUpAt,
            pointerDownToMoveEndMs: pointerDownAt === null ? null : Number((endedAt - pointerDownAt).toFixed(2)),
            pointerUpToMoveEndMs: pointerUpAt === null ? null : Number((endedAt - pointerUpAt).toFixed(2)),
        }, {
            source: 'GraphView',
            durationMs: startedAt === null ? undefined : Number((performance.now() - startedAt).toFixed(2)),
        });
        viewportDragIdRef.current = null;
        viewportPointerDownAtRef.current = null;
        viewportPointerUpAtRef.current = null;
        viewportDragStartViewportRef.current = null;
        viewportFirstVisibleMoveLoggedRef.current = false;
    }, [reactFlowInstance, setViewportInteractingDomState]);

    const startViewportInteraction = useCallback((viewport: { x: number; y: number; zoom: number }) => {
        if (isViewportInteractingRef.current) return;

        focusCenterRetryTokenRef.current += 1;
        if (focusCenterRetryFrameRef.current !== null) {
            window.cancelAnimationFrame(focusCenterRetryFrameRef.current);
            focusCenterRetryFrameRef.current = null;
        }
        if (focusCenterFirstFrameRef.current !== null) {
            window.cancelAnimationFrame(focusCenterFirstFrameRef.current);
            focusCenterFirstFrameRef.current = null;
        }
        if (focusCenterEndTimeoutRef.current !== null) {
            window.clearTimeout(focusCenterEndTimeoutRef.current);
            focusCenterEndTimeoutRef.current = null;
        }
        recordPerfEvent('graph.focus-center.cancelled', {
            reason: 'viewport-interaction',
            dragId: viewportDragIdRef.current,
        }, { source: 'GraphView' });

        isViewportInteractingRef.current = true;
        setIsViewportInteractingState(true);
        const startedAt = performance.now();
        viewportMoveStartedAtRef.current = startedAt;
        setViewportInteractingDomState(true);
        markGraphInteractionStart('viewport-drag');
        if (viewportInteractionStaleTimeoutRef.current !== null) {
            window.clearTimeout(viewportInteractionStaleTimeoutRef.current);
        }
        viewportInteractionStaleTimeoutRef.current = window.setTimeout(() => {
            viewportInteractionStaleTimeoutRef.current = null;
            if (!isViewportInteractingRef.current) return;
            recordPerfEvent('graph.viewport-move.stale-ended', {
                dragId: viewportDragIdRef.current,
                staleMs: Number((performance.now() - startedAt).toFixed(2)),
            }, { source: 'GraphView' });
            stopViewportInteraction();
        }, VIEWPORT_INTERACTION_STALE_MS);
        viewportDragStartViewportRef.current = viewport;
        viewportFirstVisibleMoveLoggedRef.current = false;
        recordPerfEvent('graph.viewport-move.start', {
            dragId: viewportDragIdRef.current,
            x: Number(viewport.x.toFixed(2)),
            y: Number(viewport.y.toFixed(2)),
            zoom: Number(viewport.zoom.toFixed(3)),
            pointerDownAt: viewportPointerDownAtRef.current,
            pointerDownToMoveStartMs: viewportPointerDownAtRef.current === null
                ? null
                : Number((startedAt - viewportPointerDownAtRef.current).toFixed(2)),
        }, { source: 'GraphView' });
    }, [setViewportInteractingDomState, stopViewportInteraction]);

    const ensureViewportInteractionStarted = useCallback((
        viewport: { x: number; y: number; zoom: number },
        sourceLayer: string,
    ) => {
        if (!viewportDragIdRef.current) {
            viewportDragIdRef.current = `${sourceLayer}-${Date.now()}`;
        }
        if (viewportPointerDownAtRef.current === null) {
            viewportPointerDownAtRef.current = performance.now();
        }
        startViewportInteraction(viewport);
    }, [startViewportInteraction]);

    const scheduleActiveGraphWindowUpdate = useCallback((reason: string, throttle = true) => {
        if (activeGraphWindowUpdateTimeoutRef.current !== null) return;
        const now = performance.now();
        const elapsed = now - activeGraphWindowLastUpdateAtRef.current;
        const delayMs = throttle
            ? Math.max(0, ACTIVE_GRAPH_WINDOW_UPDATE_THROTTLE_MS - elapsed)
            : 0;
        activeGraphWindowUpdateTimeoutRef.current = window.setTimeout(() => {
            activeGraphWindowUpdateTimeoutRef.current = null;
            activeGraphWindowLastUpdateAtRef.current = performance.now();
            setActiveGraphWindowViewportVersion((version) => version + 1);
            recordFundamentalCounter('graph.active-window.viewport-update', {
                reason,
                runningCount: runningCountRef.current,
            });
        }, delayMs);
    }, []);

    useEffect(() => () => {
        if (activeGraphWindowUpdateTimeoutRef.current !== null) {
            window.clearTimeout(activeGraphWindowUpdateTimeoutRef.current);
            activeGraphWindowUpdateTimeoutRef.current = null;
        }
    }, []);

    const applyViewportPan = useCallback((dx: number, dy: number) => {
        const viewport = reactFlowInstance.getViewport();
        const { d3Zoom, d3Selection } = reactFlowStore.getState();
        if (d3Zoom && d3Selection) {
            d3Zoom.translateBy(d3Selection, dx / viewport.zoom, dy / viewport.zoom);
            return;
        }
        reactFlowInstance.setViewport({
            x: viewport.x + dx,
            y: viewport.y + dy,
            zoom: viewport.zoom,
        });
    }, [reactFlowInstance, reactFlowStore]);

    const applyViewportWheelFallback = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        const root = (event.target as HTMLElement | null)?.closest?.('.react-flow') as HTMLElement | null;
        if (!root || !(event.target instanceof HTMLElement) || !event.target.classList.contains('react-flow')) return false;

        const viewport = reactFlowInstance.getViewport();
        const { d3Zoom, d3Selection } = reactFlowStore.getState();
        ensureViewportInteractionStarted(viewport, event.ctrlKey ? 'root-wheel-pinch' : 'root-wheel-pan');
        recordRootFallbackGeometry('wheel', event.target instanceof HTMLElement ? event.target : null);

        if (event.ctrlKey) {
            const d3Node = d3Selection?.node?.() as HTMLElement | null | undefined;
            const zoomSurfaceRect = (d3Node ?? root).getBoundingClientRect();
            const pointerX = event.clientX - zoomSurfaceRect.left;
            const pointerY = event.clientY - zoomSurfaceRect.top;
            const deltaModeFactor = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002;
            const isMac = /Mac|iPhone|iPad|iPod/.test(window.navigator.platform);
            const pinchFactor = isMac ? 10 : 1;
            const zoomDelta = -event.deltaY * deltaModeFactor * pinchFactor;
            const nextZoom = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, viewport.zoom * Math.pow(2, zoomDelta)));
            if (d3Zoom && d3Selection) {
                d3Zoom.scaleTo(d3Selection, nextZoom, [pointerX, pointerY], event.nativeEvent);
            } else {
                const anchor = reactFlowInstance.screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                });
                reactFlowInstance.setViewport({
                    x: pointerX - anchor.x * nextZoom,
                    y: pointerY - anchor.y * nextZoom,
                    zoom: nextZoom,
                });
            }
        } else {
            const normalize = event.deltaMode === 1 ? 20 : 1;
            if (d3Zoom && d3Selection) {
                d3Zoom.translateBy(
                    d3Selection,
                    -(event.deltaX * normalize * 0.5) / viewport.zoom,
                    -(event.deltaY * normalize * 0.5) / viewport.zoom,
                );
            } else {
                reactFlowInstance.setViewport({
                    x: viewport.x - event.deltaX * normalize * 0.5,
                    y: viewport.y - event.deltaY * normalize * 0.5,
                    zoom: viewport.zoom,
                });
            }
        }

        if (rootWheelEndTimeoutRef.current !== null) {
            window.clearTimeout(rootWheelEndTimeoutRef.current);
        }
        rootWheelEndTimeoutRef.current = window.setTimeout(() => {
            rootWheelEndTimeoutRef.current = null;
            stopViewportInteraction(reactFlowInstance.getViewport());
        }, 180);

        event.preventDefault();
        event.stopPropagation();
        return true;
    }, [ensureViewportInteractionStarted, reactFlowInstance, reactFlowStore, recordRootFallbackGeometry, stopViewportInteraction]);

    const clearFocusCenterTimers = useCallback(() => {
        if (focusCenterFirstFrameRef.current !== null) {
            window.cancelAnimationFrame(focusCenterFirstFrameRef.current);
            focusCenterFirstFrameRef.current = null;
        }
        if (focusCenterEndTimeoutRef.current !== null) {
            window.clearTimeout(focusCenterEndTimeoutRef.current);
            focusCenterEndTimeoutRef.current = null;
        }
    }, []);

    const clearQueuedFocusCenter = useCallback(() => {
        focusCenterRetryTokenRef.current += 1;
        if (focusCenterRetryFrameRef.current !== null) {
            window.cancelAnimationFrame(focusCenterRetryFrameRef.current);
            focusCenterRetryFrameRef.current = null;
        }
    }, []);

    const centerFocusedNode = useCallback((
        messageId: string,
        triggerMetrics?: FocusTriggerMetrics & {
            interactionId?: string | null;
            allowDuringActiveRun?: boolean;
        }
    ) => {
        if (viewMode !== 'branch') return null;
        const activeRunCount = runningCountRef.current;
        if (activeRunCount > 0 && !triggerMetrics?.allowDuringActiveRun) {
            recordPerfEvent('graph.focus-center.skipped', {
                focusedMessageId: messageId,
                reason: 'active-run',
                runningCount: activeRunCount,
                allowDuringActiveRun: Boolean(triggerMetrics?.allowDuringActiveRun),
            }, { source: 'GraphView' });
            return null;
        }
        if (sendFlowGraphDiagFlags.disableGraphAutoCenter) {
            recordPerfEvent('graph.focus-center.skipped', {
                focusedMessageId: messageId,
                reason: 'diagnostic-disable-auto-center',
            }, { source: 'GraphView' });
            return null;
        }
        if (isViewportInteractingRef.current) {
            recordPerfEvent('graph.focus-center.skipped', {
                focusedMessageId: messageId,
                reason: 'viewport-interaction',
                dragId: viewportDragIdRef.current,
            }, { source: 'GraphView' });
            return null;
        }

        const targetNode = layoutNodesRef.current.find((node) => node.id === messageId);

        if (!targetNode) return null;

        const width = typeof targetNode.width === 'number'
            ? targetNode.width
            : typeof targetNode.style?.width === 'number'
                ? targetNode.style.width
                : 180;
        const height = typeof targetNode.height === 'number'
            ? targetNode.height
            : typeof targetNode.style?.height === 'number'
                ? targetNode.style.height
                : 140;
        const canvasWidth = branchCanvasRef.current?.clientWidth ?? 0;
        const canvasHeight = branchCanvasRef.current?.clientHeight ?? 0;
        if (canvasWidth <= 0 || canvasHeight <= 0) return null;

        const currentViewport = reactFlowInstance.getViewport();
        const currentZoom = currentViewport.zoom;
        const targetZoom = currentZoom < FOCUS_READING_MIN_ZOOM
            ? FOCUS_READING_MIN_ZOOM
            : currentZoom > FOCUS_READING_MAX_ZOOM
                ? FOCUS_READING_MAX_ZOOM
                : currentZoom;
        const nodeCenterX = targetNode.position.x + width / 2;
        const nodeCenterY = targetNode.position.y + height / 2;
        const finalViewport = {
            x: FOCUS_VIEWPORT_BAND_X * canvasWidth - nodeCenterX * targetZoom,
            y: FOCUS_VIEWPORT_BAND_Y * canvasHeight - nodeCenterY * targetZoom,
            zoom: targetZoom,
        };
        const deltaX = finalViewport.x - currentViewport.x;
        const deltaY = finalViewport.y - currentViewport.y;
        const viewportDistance = Math.hypot(deltaX, deltaY);
        const zoomDelta = Math.abs(targetZoom - currentZoom);
        const distanceProgress = Math.min(1, viewportDistance / FOCUS_DISTANCE_FOR_MAX_DURATION);
        const zoomProgress = Math.min(1, zoomDelta / 0.8);
        const animationProgress = Math.max(distanceProgress, zoomProgress);
        const animationDurationMs = Math.round(
            FOCUS_MIN_ANIMATION_MS + (FOCUS_MAX_ANIMATION_MS - FOCUS_MIN_ANIMATION_MS) * animationProgress
        );
        const centerStartedAt = performance.now();
        const pointerToClickMs = triggerMetrics?.pointerDownAt == null
            ? null
            : Number((triggerMetrics.clickAt - triggerMetrics.pointerDownAt).toFixed(2));
        const clickToCenterStartMs = triggerMetrics?.clickAt == null
            ? null
            : Number((centerStartedAt - triggerMetrics.clickAt).toFixed(2));
        const pointerDownToCenterStartMs = triggerMetrics?.pointerDownAt == null
            ? null
            : Number((centerStartedAt - triggerMetrics.pointerDownAt).toFixed(2));

        centeredFocusIdRef.current = `${messageId}:${targetNode.id}`;
        clearFocusCenterTimers();
        recordPerfEvent('graph.focus-center.start', {
            interactionId: triggerMetrics?.interactionId ?? null,
            focusedMessageId: messageId,
            targetNodeId: targetNode.id,
            targetX: targetNode.position.x,
            targetY: targetNode.position.y,
            targetZoom,
            currentZoom,
            viewportDistance: Number(viewportDistance.toFixed(2)),
            zoomDelta: Number(zoomDelta.toFixed(3)),
            animationDurationMs,
            viewportBandX: FOCUS_VIEWPORT_BAND_X,
            viewportBandY: FOCUS_VIEWPORT_BAND_Y,
            pointerDownAt: triggerMetrics?.pointerDownAt ?? null,
            clickAt: triggerMetrics?.clickAt ?? null,
            pointerToClickMs,
            clickToCenterStartMs,
            pointerDownToCenterStartMs,
        }, { source: 'GraphView' });

        reactFlowInstance.setViewport(finalViewport, { duration: animationDurationMs });
        focusCenterFirstFrameRef.current = window.requestAnimationFrame(() => {
            const now = performance.now();
            recordPerfEvent('graph.focus-center.first-frame', {
                interactionId: triggerMetrics?.interactionId ?? null,
                focusedMessageId: messageId,
                targetNodeId: targetNode.id,
                clickToFirstFrameMs: triggerMetrics?.clickAt == null
                    ? null
                    : Number((now - triggerMetrics.clickAt).toFixed(2)),
                pointerDownToFirstFrameMs: triggerMetrics?.pointerDownAt == null
                    ? null
                    : Number((now - triggerMetrics.pointerDownAt).toFixed(2)),
            }, { source: 'GraphView' });
            focusCenterFirstFrameRef.current = null;
        });
        focusCenterEndTimeoutRef.current = window.setTimeout(() => {
            recordPerfEvent('graph.focus-center.end', {
                focusedMessageId: messageId,
                targetNodeId: targetNode.id,
                zoom: reactFlowInstance.getZoom(),
                x: Number(reactFlowInstance.getViewport().x.toFixed(2)),
                y: Number(reactFlowInstance.getViewport().y.toFixed(2)),
                animationDurationMs,
            }, { source: 'GraphView' });
            normalizeReactFlowLayerGeometry(`focus-center-end:${messageId}`);
            captureGraphGeometrySnapshot(`focus-center-end:${messageId}`);
            focusCenterEndTimeoutRef.current = null;
        }, animationDurationMs + 40);
        return {
            targetNodeId: targetNode.id,
            animationDurationMs,
            viewportDistance: Number(viewportDistance.toFixed(2)),
            zoomDelta: Number(zoomDelta.toFixed(3)),
        };
    }, [captureGraphGeometrySnapshot, clearFocusCenterTimers, normalizeReactFlowLayerGeometry, reactFlowInstance, sendFlowGraphDiagFlags.disableGraphAutoCenter, viewMode]);

    const queueFocusedNodeCenter = useCallback((messageId: string, centerKey: string, options?: { respectImperativeCenter?: boolean }) => {
        if (viewMode !== 'branch') return;
        if (centeredFocusIdRef.current === centerKey) return;
        const isUserFocusSource = lastFocusSource === 'graph' || lastFocusSource === 'chat' || lastFocusSource === 'timeline';
        const focusFlowId = typeof lastFocusMetadata?.flowId === 'string' ? lastFocusMetadata.flowId : null;
        const isComposerSendFlowFocusSource =
            lastFocusSource === 'composer' &&
            !!focusFlowId &&
            activeSendFlowFocus?.flowId === focusFlowId;
        const canUseLiveFocusedMessageId = isUserFocusSource || isComposerSendFlowFocusSource;
        const shouldSuppressAgentDrivenCentering = !canUseLiveFocusedMessageId && (
            runningCount > 0 ||
            activeSendFlowFocus?.workspaceId === selectedWorkspaceId
        );
        if (shouldSuppressAgentDrivenCentering) {
            clearQueuedFocusCenter();
            centeredFocusIdRef.current = centerKey;
            recordPerfEvent('graph.focus-center.skipped', {
                focusedMessageId: messageId,
                reason: runningCount > 0 ? 'active-run' : 'active-send-flow',
                runningCount,
                source: lastFocusSource,
                flowId: focusFlowId,
            }, { source: 'GraphView' });
            return;
        }

        if (options?.respectImperativeCenter && imperativeCenteredMessageIdRef.current === messageId) {
            imperativeCenteredMessageIdRef.current = null;
            centeredFocusIdRef.current = centerKey;
            return;
        }

        clearQueuedFocusCenter();

        const retryToken = focusCenterRetryTokenRef.current;
        let attemptCount = 0;

        const attemptCenter = () => {
            if (focusCenterRetryTokenRef.current !== retryToken) return;
            focusCenterRetryFrameRef.current = null;

            const centered = centerFocusedNode(messageId, {
                clickAt: performance.now(),
                pointerDownAt: null,
                allowDuringActiveRun: canUseLiveFocusedMessageId,
            });
            if (centered) {
                centeredFocusIdRef.current = centerKey;
                return;
            }

            attemptCount += 1;
            if (attemptCount >= FOCUS_CENTER_MAX_RETRY_FRAMES) return;

            focusCenterRetryFrameRef.current = window.requestAnimationFrame(attemptCenter);
        };

        focusCenterRetryFrameRef.current = window.requestAnimationFrame(attemptCenter);
    }, [activeSendFlowFocus, centerFocusedNode, clearQueuedFocusCenter, lastFocusMetadata, lastFocusSource, runningCount, selectedWorkspaceId, viewMode]);

    const handleReactFlowInit = useCallback(() => {
        normalizeReactFlowLayerGeometry('react-flow-init');
        captureGraphGeometrySnapshot('react-flow-init');
        window.requestAnimationFrame(() => {
            normalizeReactFlowLayerGeometry('react-flow-init:raf');
            captureGraphGeometrySnapshot('react-flow-init:raf');
        });
        window.setTimeout(() => {
            normalizeReactFlowLayerGeometry('react-flow-init:600ms');
            captureGraphGeometrySnapshot('react-flow-init:600ms');
        }, 600);
        if (!focusedMessageId) return;
        queueFocusedNodeCenter(
            focusedMessageId,
            `init:${selectedWorkspaceId ?? 'none'}:${branchViewActivationNonce}:${focusNonce}:${focusedMessageId}`
        );
    }, [
        branchViewActivationNonce,
        captureGraphGeometrySnapshot,
        focusNonce,
        focusedMessageId,
        normalizeReactFlowLayerGeometry,
        queueFocusedNodeCenter,
        selectedWorkspaceId,
    ]);

    const handleFocus = useCallback((id: string, triggerMetrics?: FocusTriggerMetrics) => {
        const message = graphComputationMessagesRef.current.find((candidate) => candidate.id === id) ?? null;
        const interaction = startFocusInteraction({
            source: message?.role === 'assistant'
                ? 'graph.agent-card'
                : message?.role === 'user'
                    ? 'graph.turn-node'
                    : 'graph.commit-node',
            targetId: id,
            targetType: message?.role === 'assistant'
                ? 'assistant-message'
                : message?.role === 'user'
                    ? 'user-message'
                    : 'commit',
            metadata: {
                pointerDownAt: triggerMetrics?.pointerDownAt ?? null,
                clickAt: triggerMetrics?.clickAt ?? null,
                pointerToClickMs: triggerMetrics?.pointerDownAt == null
                    ? null
                    : Number((triggerMetrics.clickAt - triggerMetrics.pointerDownAt).toFixed(2)),
                ...(triggerMetrics?.metadata ?? {}),
            },
        });
        recordPerfEvent('graph.focus.click', {
            interactionId: interaction.id,
            focusedMessageId: id,
            pointerDownAt: triggerMetrics?.pointerDownAt ?? null,
            clickAt: triggerMetrics?.clickAt ?? null,
            pointerToClickMs: triggerMetrics?.pointerDownAt == null
                ? null
                : Number((triggerMetrics.clickAt - triggerMetrics.pointerDownAt).toFixed(2)),
        }, { source: 'GraphView' });
        markGraphInteractionStart('graph-focus');
        pendingGraphFocusRef.current = {
            interactionId: interaction.id,
            focusedMessageId: id,
            clickAt: triggerMetrics?.clickAt ?? null,
            dispatchScheduledAt: null,
            dispatchCommittedAt: null,
        };
        const centerResult = centerFocusedNode(id, {
            ...triggerMetrics,
            interactionId: interaction.id,
            allowDuringActiveRun: true,
        });
        if (centerResult) {
            imperativeCenteredMessageIdRef.current = id;
        }
        window.setTimeout(() => {
            markGraphInteractionEnd('graph-focus');
        }, (centerResult?.animationDurationMs ?? 220) + 140);
        if (deferredGraphFocusFrameRef.current !== null) {
            window.cancelAnimationFrame(deferredGraphFocusFrameRef.current);
        }
        deferredGraphFocusFrameRef.current = window.requestAnimationFrame(() => {
            const dispatchScheduledAt = performance.now();
            if (pendingGraphFocusRef.current?.interactionId === interaction.id) {
                pendingGraphFocusRef.current.dispatchScheduledAt = dispatchScheduledAt;
            }
            recordPerfEvent('graph.focus.dispatch.scheduled', {
                interactionId: interaction.id,
                focusedMessageId: id,
                clickToDispatchScheduledMs: triggerMetrics?.clickAt == null
                    ? null
                    : Number((dispatchScheduledAt - triggerMetrics.clickAt).toFixed(2)),
            }, { source: 'GraphView' });
            dispatchFocus({
                messageId: id,
                source: 'graph',
                metadata: {
                    interactionId: interaction.id,
                    recenterAnimationDurationMs: centerResult?.animationDurationMs ?? null,
                    recenterViewportDistance: centerResult?.viewportDistance ?? null,
                    recenterZoomDelta: centerResult?.zoomDelta ?? null,
                    ...(triggerMetrics?.metadata ?? {}),
                },
            });
            startTransition(() => {
                nodeSelection.clearSelection();
            });
            deferredGraphFocusFrameRef.current = null;
        });
    }, [centerFocusedNode, dispatchFocus, nodeSelection.clearSelection]);

    const { nodes: layoutNodes, edges: layoutEdges } = useGraphLayout({
        projection: workspaceProjection,
        messages: graphComputationMessages,
        summaries: summaries as Summary[],
        measuredNodeHeights,
        layoutMode,
        laneStrategy,
        disabledSummaryIds: disabledSummaryIdsSet,
        focusedMessageId,
        contextPathMessageIds: contextPathMessageIdSet,
        matchingMessageIds: tagFilter.matchingMessageIds,
        filterActive: tagFilter.filterActive,
        hasNodeTypeFilter: tagFilter.hasNodeTypeFilter,
        keepAncestors: tagFilter.keepAncestors,
        keepDescendants: tagFilter.keepDescendants,
        insights,
        showInsightsInGraph,
        workspaceRepoMap,
        branchPointersByNodeId,
        activeScopeId,
        scopeViewMode,
        scopeNameById,
        scopeColorById,
        resetNonce: graphResetNonce,
        onToggleSummary: toggleSummaryDisabled,
        onToggleCollapse: handleToggleCollapse,
        onFocus: handleFocus,
        onSelect: handleSelect,
        onMeasureNodeHeight: handleMeasureNodeHeight,
        onContextMenu: handleScopedNodeContextMenu
    } as any);

    useLayoutEffect(() => {
        layoutNodesRef.current = layoutNodes;
    }, [layoutNodes]);

    useLayoutEffect(() => {
        layoutEdgesRef.current = layoutEdges;
    }, [layoutEdges]);

    useEffect(() => {
        if (viewMode === 'branch') return;
        resetReactFlowLayerGeometryCorrection(`view-mode:${viewMode}`);
    }, [resetReactFlowLayerGeometryCorrection, viewMode]);

    useLayoutEffect(() => {
        if (viewMode !== 'branch') return;
        normalizeReactFlowLayerGeometry('layout-effect');
        const frameId = window.requestAnimationFrame(() => {
            normalizeReactFlowLayerGeometry('layout-effect:raf');
        });
        return () => window.cancelAnimationFrame(frameId);
    }, [
        focusedMessageId,
        graphResetNonce,
        layoutEdges.length,
        layoutNodes.length,
        normalizeReactFlowLayerGeometry,
        selectedWorkspaceId,
        viewMode,
    ]);

    useEffect(() => {
        const pending = pendingGraphFocusRef.current;
        if (!pending || pending.focusedMessageId !== focusedMessageId) return;
        if (pending.dispatchCommittedAt === null) {
            pending.dispatchCommittedAt = performance.now();
            recordPerfEvent('graph.focus.dispatch.committed', {
                interactionId: pending.interactionId,
                focusedMessageId,
                clickToDispatchCommittedMs: pending.clickAt == null
                    ? null
                    : Number((pending.dispatchCommittedAt - pending.clickAt).toFixed(2)),
                dispatchScheduledToCommittedMs: pending.dispatchScheduledAt == null
                    ? null
                    : Number((pending.dispatchCommittedAt - pending.dispatchScheduledAt).toFixed(2)),
            }, { source: 'GraphView' });
        }

        const rafId = window.requestAnimationFrame(() => {
            const latest = pendingGraphFocusRef.current;
            if (!latest || latest.interactionId !== pending.interactionId || latest.focusedMessageId !== focusedMessageId) return;
            const now = performance.now();
            recordPerfEvent('graph.focus.render-ready', {
                interactionId: latest.interactionId,
                focusedMessageId,
                clickToRenderReadyMs: latest.clickAt == null
                    ? null
                    : Number((now - latest.clickAt).toFixed(2)),
                dispatchCommittedToRenderReadyMs: latest.dispatchCommittedAt == null
                    ? null
                    : Number((now - latest.dispatchCommittedAt).toFixed(2)),
                nodeCount: layoutNodes.length,
                edgeCount: layoutEdges.length,
            }, { source: 'GraphView' });
            pendingGraphFocusRef.current = null;
        });

        return () => window.cancelAnimationFrame(rafId);
    }, [focusedMessageId, layoutEdges.length, layoutNodes.length]);

    useEffect(() => {
        if (!selectedWorkspaceId || graphMessages.length === 0) return;
        if (graphDataReadyLoggedRef.current === selectedWorkspaceId) return;

        graphDataReadyLoggedRef.current = selectedWorkspaceId;
        recordPerfEvent('graph.data-ready', {
            elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
            workspaceId: selectedWorkspaceId,
            messageCount: graphMessages.length,
            summaryCount: summaries.length,
            branchPointerCount: branchPointers.length,
            scopeCount: scopes.length,
            queryStatus: messagesQuery.status,
            usingSnapshot: graphUsingSnapshot,
        }, { source: 'GraphView' });
    }, [
        branchPointers.length,
        graphUsingSnapshot,
        graphMessages.length,
        messagesQuery.status,
        scopes.length,
        selectedWorkspaceId,
        summaries.length,
    ]);

    useEffect(() => {
        if (!selectedWorkspaceId) {
            graphDataReadyLoggedRef.current = null;
            graphContentRenderedLoggedRef.current = null;
            return;
        }
        if (viewMode !== 'branch' || layoutNodes.length === 0) return;
        if (graphContentRenderedLoggedRef.current === selectedWorkspaceId) return;

        const rafId = window.requestAnimationFrame(() => {
            if (graphContentRenderedLoggedRef.current === selectedWorkspaceId) return;
            graphContentRenderedLoggedRef.current = selectedWorkspaceId;
            recordPerfEvent('graph.first-content-render', {
                elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                workspaceId: selectedWorkspaceId,
                nodeCount: layoutNodes.length,
                edgeCount: layoutEdges.length,
                messageCount: graphMessages.length,
                viewMode,
                layoutMode,
                usingSnapshot: graphUsingSnapshot,
            }, { source: 'GraphView' });
        });

        return () => window.cancelAnimationFrame(rafId);
    }, [
        graphMessages.length,
        graphUsingSnapshot,
        layoutEdges.length,
        layoutMode,
        layoutNodes.length,
        selectedWorkspaceId,
        viewMode,
    ]);

    const previewEdges = useMemo(() => {
        const visibleEdges = layoutEdges.filter((edge) => {
            const edgeLegendType = (edge.data as any)?.edgeLegendType as GraphEdgeLegendId | undefined;
            return edgeLegendType ? visibleEdgeTypes.has(edgeLegendType) : false;
        });

        if (!previewEdgeType) return visibleEdges;

        const matchesPreview = (edge: any) => {
            if (previewEdgeType === 'context-path') return edge?.data?.isOnContextPath === true || edge?.animated === true;
            return edge?.data?.edgeLegendType === previewEdgeType;
        };

        return layoutEdges
            .filter((edge) => {
                const edgeLegendType = (edge.data as any)?.edgeLegendType as GraphEdgeLegendId | undefined;
                const visibleByType = edgeLegendType ? visibleEdgeTypes.has(edgeLegendType) : false;
                return visibleByType || matchesPreview(edge);
            })
            .map((edge) => {
                const matched = matchesPreview(edge);
                return {
                    ...edge,
                    animated: matched,
                    style: {
                        ...edge.style,
                        stroke: matched ? '#f59e0b' : edge.style?.stroke,
                        strokeWidth: matched ? Math.max(Number(edge.style?.strokeWidth ?? 2), 4) : edge.style?.strokeWidth,
                        opacity: matched ? 1 : 0.18,
                    },
                    zIndex: matched ? 30 : -5,
                };
            });
    }, [layoutEdges, previewEdgeType, visibleEdgeTypes]);

    // ─────────────────────────────────────────────────────────────────────────
    // EFFECTS
    // ─────────────────────────────────────────────────────────────────────────

    // Measure controls height
    useEffect(() => {
        if (controlsRef.current) {
            setControlsHeight(controlsRef.current.offsetHeight);
        }
    }, [viewMode]);

    useEffect(() => {
        if (viewMode !== 'branch') return;
        const frameId = window.requestAnimationFrame(() => {
            normalizeReactFlowLayerGeometry('branch-render:raf');
            if (GRAPH_GEOMETRY_DIAGNOSTICS_ENABLED) {
                captureGraphGeometrySnapshot('branch-render:raf');
            }
        });
        const timeoutIds = [250, 1000, 2500].map((delay) =>
            window.setTimeout(() => {
                normalizeReactFlowLayerGeometry(`branch-render:${delay}ms`);
                if (GRAPH_GEOMETRY_DIAGNOSTICS_ENABLED) {
                    captureGraphGeometrySnapshot(`branch-render:${delay}ms`);
                }
            }, delay)
        );

        return () => {
            window.cancelAnimationFrame(frameId);
            timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
        };
    }, [
        captureGraphGeometrySnapshot,
        focusedMessageId,
        graphResetNonce,
        layoutEdges.length,
        layoutNodes.length,
        normalizeReactFlowLayerGeometry,
        selectedWorkspaceId,
        viewMode,
    ]);

    useEffect(() => {
        if (viewMode !== 'branch') return;
        const canvas = branchCanvasRef.current;
        if (!canvas || typeof ResizeObserver === 'undefined') return;

        let timeoutId: number | null = null;
        const scheduleResizeSnapshot = (reason: string) => {
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }
            timeoutId = window.setTimeout(() => {
                timeoutId = null;
                captureGraphGeometrySnapshot(reason);
            }, 80);
        };

        const observer = new ResizeObserver((entries) => {
            if (GRAPH_GEOMETRY_DIAGNOSTICS_ENABLED) {
                const changed = entries.map((entry) => ({
                    className: (entry.target as HTMLElement).className,
                    width: roundMetric(entry.contentRect.width),
                    height: roundMetric(entry.contentRect.height),
                }));
                recordPerfEvent('graph.geometry.resize-observed', {
                    workspaceId: selectedWorkspaceId,
                    changed,
                }, { source: 'GraphView' });
            }
            normalizeReactFlowLayerGeometry('resize-observer');
            if (GRAPH_GEOMETRY_DIAGNOSTICS_ENABLED) {
                scheduleResizeSnapshot('resize-observer');
            }
        });

        observer.observe(canvas);
        const root = canvas.querySelector<HTMLElement>(':scope > .react-flow');
        if (root) observer.observe(root);
        const renderer = root?.querySelector<HTMLElement>(':scope > .react-flow__renderer') ?? null;
        if (renderer) observer.observe(renderer);
        const pane = renderer?.querySelector<HTMLElement>(':scope > .react-flow__pane') ?? null;
        if (pane) observer.observe(pane);

        return () => {
            observer.disconnect();
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }
        };
    }, [captureGraphGeometrySnapshot, normalizeReactFlowLayerGeometry, selectedWorkspaceId, viewMode]);

    useEffect(() => {
        return () => {
            if (heightMeasureFlushTimeoutRef.current !== null) {
                window.clearTimeout(heightMeasureFlushTimeoutRef.current);
                heightMeasureFlushTimeoutRef.current = null;
            }
            pendingNodeHeightMeasuresRef.current.clear();
            if (previewEdgeTimeoutRef.current !== null) {
                window.clearTimeout(previewEdgeTimeoutRef.current);
            }
            if (viewportInteractionStaleTimeoutRef.current !== null) {
                window.clearTimeout(viewportInteractionStaleTimeoutRef.current);
                viewportInteractionStaleTimeoutRef.current = null;
            }
            if (deferredGraphFocusFrameRef.current !== null) {
                window.cancelAnimationFrame(deferredGraphFocusFrameRef.current);
                deferredGraphFocusFrameRef.current = null;
            }
            resetReactFlowLayerGeometryCorrection('graph-unmount');
            clearQueuedFocusCenter();
            clearFocusCenterTimers();
        };
    }, [clearFocusCenterTimers, clearQueuedFocusCenter, resetReactFlowLayerGeometryCorrection]);

    // Reset on workspace/view change
    useEffect(() => {
        setScopedContextMenu(null);
    }, [selectedWorkspaceId, messagesOverride, viewMode, layoutMode, laneStrategy]);

    useEffect(() => {
        if (!forcedViewMode || forcedViewMode === viewMode) return;
        setViewMode(forcedViewMode);
    }, [forcedViewMode, viewMode]);

    useEffect(() => {
        const previousViewMode = previousViewModeRef.current;
        previousViewModeRef.current = viewMode;

        if (previousViewMode !== 'branch' && viewMode === 'branch') {
            centeredFocusIdRef.current = null;
            setBranchViewActivationNonce((value) => value + 1);
        }
    }, [viewMode]);

    useLayoutEffect(() => {
        if (viewMode !== 'branch' || !focusedMessageId) return;

        const focusEventKey = [
            selectedWorkspaceId ?? 'none',
            branchViewActivationNonce,
            focusNonce,
            focusedMessageId,
            viewMode,
            scopeViewMode,
            activeScopeId ?? 'none',
            layoutMode,
            laneStrategy,
            layoutNodes.length,
            layoutEdges.length,
            tagFilter.activeFilterCount,
            tagFilter.matchingCount,
            tagFilter.keepAncestors ? 'ancestors' : 'no-ancestors',
            tagFilter.keepDescendants ? 'descendants' : 'no-descendants',
            showInsightsInGraph ? insights.length : 0,
            graphResetNonce,
        ].join(':');

        recordPerfEvent('graph.focus-center.queued', {
            focusedMessageId,
            focusNonce,
            source: lastFocusSource,
            flowId: typeof lastFocusMetadata?.flowId === 'string' ? lastFocusMetadata.flowId : null,
            phase: typeof lastFocusMetadata?.phase === 'string' ? lastFocusMetadata.phase : null,
            viewportInteracting: isViewportInteractingRef.current,
            layoutNodeCount: layoutNodes.length,
            layoutEdgeCount: layoutEdges.length,
        }, { source: 'GraphView' });
        queueFocusedNodeCenter(focusedMessageId, focusEventKey, { respectImperativeCenter: true });
    }, [
        activeScopeId,
        branchViewActivationNonce,
        focusNonce,
        focusedMessageId,
        graphResetNonce,
        insights.length,
        laneStrategy,
        lastFocusSource,
        lastFocusMetadata,
        layoutEdges.length,
        layoutMode,
        layoutNodes.length,
        queueFocusedNodeCenter,
        scopeViewMode,
        selectedWorkspaceId,
        showInsightsInGraph,
        tagFilter.activeFilterCount,
        tagFilter.keepAncestors,
        tagFilter.keepDescendants,
        tagFilter.matchingCount,
        viewMode,
    ]);

    useEffect(() => {
        const handlePointerRelease = () => {
            if (!isViewportPointerDownRef.current) return;
            isViewportPointerDownRef.current = false;
            viewportPointerUpAtRef.current = performance.now();
            recordPerfEvent('graph.drag.pointer-up', {
                dragId: viewportDragIdRef.current,
                pointerDownAt: viewportPointerDownAtRef.current,
                pointerUpAt: viewportPointerUpAtRef.current,
                pointerDownToPointerUpMs: viewportPointerDownAtRef.current === null
                    ? null
                    : Number((viewportPointerUpAtRef.current - viewportPointerDownAtRef.current).toFixed(2)),
            }, { source: 'GraphView' });
            stopViewportInteraction();
        };

        window.addEventListener('pointerup', handlePointerRelease);
        window.addEventListener('pointercancel', handlePointerRelease);
        window.addEventListener('blur', handlePointerRelease);

        return () => {
            window.removeEventListener('pointerup', handlePointerRelease);
            window.removeEventListener('pointercancel', handlePointerRelease);
            window.removeEventListener('blur', handlePointerRelease);
        };
    }, [stopViewportInteraction]);

    const messageMap = useMemo(() => new Map(messages.map((m: Message) => [m.id, m])), [messages]);
    const collectCommitShasForDelete = useCallback((rootMessageIds: Iterable<string>, explicitCommitShas: Iterable<string> = []) => {
        const commitShas = new Set<string>();
        for (const sha of explicitCommitShas) {
            if (sha && !deletedGraphCommitShas.has(sha)) commitShas.add(sha);
        }

        const impactedMessageIds = collectDeleteBranchMessageIds(rootMessageIds, messageMap);
        for (const messageId of impactedMessageIds) {
            const message = messageMap.get(messageId);
            const outputCommitSha = message ? getMessageOutputCommitSha(message) : null;
            if (outputCommitSha && !deletedGraphCommitShas.has(outputCommitSha)) {
                commitShas.add(outputCommitSha);
            }
        }

        for (const commit of snapshotCommits) {
            if (
                commit.sha &&
                commit.produced_by_node_id &&
                impactedMessageIds.has(commit.produced_by_node_id) &&
                !deletedGraphCommitShas.has(commit.sha)
            ) {
                commitShas.add(commit.sha);
            }
        }

        return Array.from(commitShas);
    }, [deletedGraphCommitShas, messageMap, snapshotCommits]);
    const bulkDeleteAvailableCommitShas = useMemo(
        () => collectCommitShasForDelete(bulkDeleteIds, bulkDeleteExplicitCommitShas),
        [bulkDeleteExplicitCommitShas, bulkDeleteIds, collectCommitShasForDelete]
    );
    const bulkDeletePreview = useMemo(
        () => getDeleteBranchPreview(
            bulkDeleteIds,
            messageMap,
            removeCommitsFromGraph ? bulkDeleteAvailableCommitShas.length : 0
        ),
        [bulkDeleteAvailableCommitShas.length, bulkDeleteIds, messageMap, removeCommitsFromGraph]
    );

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (nodeSelection.selectedNodeIds.size > 0) {
                    e.preventDefault();
                    setScopedContextMenu(null);
                    nodeSelection.clearSelection();
                    selectionAnchorIdRef.current = null;
                }
                return;
            }

            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setIsSearchPanelOpen(true);
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [nodeSelection]);

    // ─────────────────────────────────────────────────────────────────────────
    // HANDLERS
    // ─────────────────────────────────────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleNodeClick = useCallback((...args: any[]) => {
        let messageId: string | null = null;
        let eventOrNull: React.MouseEvent | null = null;
        let nodeOrMessageId: Node<LlmNodeData | object> | string | undefined;

        if (args.length === 1 && typeof args[0] === 'string') {
            // Timeline click
            nodeOrMessageId = args[0];
            messageId = args[0];
        } else if (args.length === 2 && typeof args[1] === 'object' && args[1]?.id) {
            // React Flow click
            eventOrNull = args[0] as React.MouseEvent;
            nodeOrMessageId = args[1] as Node<LlmNodeData | object>;
            const node = nodeOrMessageId;
            if (runningCountRef.current === 0) {
                nodeLayoutDiagnosticRef.current(node.id, 'node-click');
            }
            const nodeData = node.data as any;
            if (node.type === 'user_message' || node.type === 'assistant_message' || node.type === 'commit_message') {
                messageId = nodeData?.entity?.messageId ?? node.id;
            } else if (node.type === 'summary_block') {
                messageId = nodeData?.entity?.focusMessageId ?? null;
            } else {
                return;
            }
        } else {
            return;
        }

        if (messageId) {
            // Simplified node click - selection handled by individual views
            selectionAnchorIdRef.current = messageId;

            if (onNodeClickOverride) {
                if (args.length === 1) {
                    onNodeClickOverride(null, messageId);
                } else {
                    onNodeClickOverride(eventOrNull!, nodeOrMessageId as Node);
                }
            } else {
                if (viewMode === 'timeline') {
                    startTransition(() => {
                        dispatchFocus({ messageId, source: 'timeline' });
                    });
                } else {
                    handleFocus(messageId, {
                        pointerDownAt: null,
                        clickAt: performance.now(),
                        metadata: { via: 'react-flow-node-click' },
                    });
                }
            }
        }
    }, [
        dispatchFocus,
        handleFocus,
        onNodeClickOverride,
        viewMode,
    ]);

    const handlePaneClick = useCallback(() => {
        setScopedContextMenu(null);
        nodeSelection.clearSelection();
        selectionAnchorIdRef.current = null;
    }, [nodeSelection]);

    const handleBranchViewportPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        const debugInfo = getGraphPointerDebugInfo(target);
        if (event.pointerType === 'touch') {
            recordPerfEvent('graph.drag.pointer-down.ignored', {
                reason: 'touch-native-gesture',
                pointerType: event.pointerType,
                button: event.button,
                x: Number(event.clientX.toFixed(2)),
                y: Number(event.clientY.toFixed(2)),
                ...debugInfo,
            }, { source: 'GraphView' });
            return;
        }
        if (event.button !== 0 && event.button !== 1) {
            recordPerfEvent('graph.drag.pointer-down.ignored', {
                reason: 'button',
                pointerType: event.pointerType,
                button: event.button,
                x: Number(event.clientX.toFixed(2)),
                y: Number(event.clientY.toFixed(2)),
                ...debugInfo,
            }, { source: 'GraphView' });
            return;
        }
        const canStartViewportDrag = debugInfo.isDirectPaneTarget || debugInfo.isInsideEdge;
        if (!target || !canStartViewportDrag) {
            if (
                event.pointerType === 'mouse' &&
                event.button === 0 &&
                debugInfo.isDirectReactFlowRoot &&
                !event.shiftKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                event.currentTarget instanceof HTMLElement
            ) {
                const viewport = reactFlowInstance.getViewport();
                rootViewportDragRef.current = {
                    pointerId: event.pointerId,
                    lastX: event.clientX,
                    lastY: event.clientY,
                    moved: false,
                };
                event.currentTarget.setPointerCapture?.(event.pointerId);
                isViewportPointerDownRef.current = true;
                viewportDragIdRef.current = `root-drag-${Date.now()}`;
                viewportPointerDownAtRef.current = performance.now();
                viewportPointerUpAtRef.current = null;
                viewportDragStartViewportRef.current = null;
                viewportFirstVisibleMoveLoggedRef.current = false;
                recordPerfEvent('graph.drag.pointer-down', {
                    dragId: viewportDragIdRef.current,
                    pointerType: event.pointerType,
                    button: event.button,
                    x: Number(event.clientX.toFixed(2)),
                    y: Number(event.clientY.toFixed(2)),
                    fallback: 'direct-root',
                    ...debugInfo,
                }, { source: 'GraphView' });
                recordRootFallbackGeometry('pointer-drag', target);
                ensureViewportInteractionStarted(viewport, 'root-drag');
                event.preventDefault();
                return;
            }
            recordPerfEvent('graph.drag.pointer-down.ignored', {
                reason: 'not-pane-edge-or-root',
                pointerType: event.pointerType,
                button: event.button,
                x: Number(event.clientX.toFixed(2)),
                y: Number(event.clientY.toFixed(2)),
                ...debugInfo,
            }, { source: 'GraphView' });
            return;
        }
        isViewportPointerDownRef.current = true;
        viewportDragIdRef.current = `drag-${Date.now()}`;
        viewportPointerDownAtRef.current = performance.now();
        viewportPointerUpAtRef.current = null;
        viewportDragStartViewportRef.current = null;
        viewportFirstVisibleMoveLoggedRef.current = false;
        recordPerfEvent('graph.drag.pointer-down', {
            dragId: viewportDragIdRef.current,
            pointerType: event.pointerType,
            button: event.button,
            x: Number(event.clientX.toFixed(2)),
            y: Number(event.clientY.toFixed(2)),
            ...debugInfo,
        }, { source: 'GraphView' });
    }, [ensureViewportInteractionStarted, getGraphPointerDebugInfo, reactFlowInstance, recordRootFallbackGeometry]);

    const handleBranchViewportPointerMoveCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const rootDrag = rootViewportDragRef.current;
        if (!rootDrag || rootDrag.pointerId !== event.pointerId) return;
        const dx = event.clientX - rootDrag.lastX;
        const dy = event.clientY - rootDrag.lastY;
        rootViewportDragRef.current = {
            ...rootDrag,
            lastX: event.clientX,
            lastY: event.clientY,
            moved: rootDrag.moved || Math.hypot(dx, dy) > 0,
        };
        applyViewportPan(dx, dy);
        event.preventDefault();
    }, [applyViewportPan]);

    const handleBranchViewportPointerUpCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const rootDrag = rootViewportDragRef.current;
        if (!rootDrag || rootDrag.pointerId !== event.pointerId) return;
        rootViewportDragRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
    }, []);

    const handleBranchViewportWheelCapture = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        applyViewportWheelFallback(event);
    }, [applyViewportWheelFallback]);

    const scheduleAutoRefresh = useCallback((key: AutoRefreshKey, fromTime = Date.now()) => {
        setAutoRefreshTargets((current) => ({
            ...current,
            [key]: fromTime + AUTO_REFRESH_INTERVALS[key],
        }));
    }, []);

    const resetAutoRefreshSchedule = useCallback((fromTime = Date.now()) => {
        setAutoRefreshTargets({
            repo: REPO_REF_SYNC_ENABLED ? fromTime + REF_SYNC_INTERVAL_MS : null,
            graph: AUTO_REFRESH_ENABLED ? fromTime + GRAPH_DATA_INTERVAL_MS : null,
            summaries: AUTO_REFRESH_ENABLED ? fromTime + SUMMARIES_INTERVAL_MS : null,
            workspaces: AUTO_REFRESH_ENABLED ? fromTime + CONVERSATIONS_INTERVAL_MS : null,
        });
    }, []);

    const refetchGraphData = useCallback(async () => {
        if (!selectedWorkspaceId) return;

        await Promise.all([
            scheduleMessagesRefreshWhenGraphIdle(queryClient, selectedWorkspaceId, {
                refetchActive: true,
                reason: 'graph-refresh',
            }),
            queryClient.invalidateQueries({ queryKey: ['graph-snapshot', selectedWorkspaceId] }),
            queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(selectedWorkspaceId) }),
            queryClient.invalidateQueries({ queryKey: branchKeys.workspace(selectedWorkspaceId) }),
        ]);

        await Promise.all([
            queryClient.refetchQueries({ queryKey: ['graph-snapshot', selectedWorkspaceId], type: 'active' }),
            queryClient.refetchQueries({ queryKey: trackedRefKeys.workspace(selectedWorkspaceId), type: 'active' }),
            queryClient.refetchQueries({ queryKey: branchKeys.workspace(selectedWorkspaceId), type: 'active' }),
        ]);
    }, [queryClient, selectedWorkspaceId]);

    const refetchSummaries = useCallback(async () => {
        if (!selectedWorkspaceId) return;

        await queryClient.invalidateQueries({ queryKey: ['summaries', selectedWorkspaceId] });
        await queryClient.refetchQueries({ queryKey: ['summaries', selectedWorkspaceId], type: 'active' });
    }, [queryClient, selectedWorkspaceId]);

    const refetchWorkspaces = useCallback(async () => {
        await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
        await queryClient.refetchQueries({ queryKey: ['workspaces'], type: 'active' });
    }, [queryClient]);

    const runFullRefresh = useCallback(async () => {
        if (viewMode !== 'branch' || !selectedWorkspaceId) return;

        setIsFullRefreshing(true);
        try {
            try {
                await runSync();
            } catch (error) {
                console.error('[GraphView] Tracked branch sync failed during refresh:', error);
                toast.error(
                    'Sync failed',
                    error instanceof Error ? error.message : 'Unable to sync tracked git refs.'
                );
            }

            await Promise.all([
                refetchGraphData(),
                refetchSummaries(),
                refetchWorkspaces(),
            ]);
        } finally {
            setIsFullRefreshing(false);
        }
    }, [refetchWorkspaces, refetchGraphData, refetchSummaries, runSync, selectedWorkspaceId, toast, viewMode]);

    const handleRefreshSyncItem = useCallback(async (key: string) => {
        if (!refreshControlsEnabled) return;

        const refreshKey = key as AutoRefreshKey;
        setManualRefreshingKeys((current) => ({ ...current, [refreshKey]: true }));

        try {
            if (refreshKey === 'repo') {
                const syncResult = await runSync();
                scheduleAutoRefresh('repo');

                if (syncResult?.didSync) {
                    await refetchGraphData();
                    if (AUTO_REFRESH_ENABLED) {
                        scheduleAutoRefresh('graph');
                    }
                    await refetchSummaries();
                    if (AUTO_REFRESH_ENABLED) {
                        scheduleAutoRefresh('summaries');
                    }
                }
                return;
            }

            if (refreshKey === 'graph') {
                await refetchGraphData();
                scheduleAutoRefresh('graph');
                return;
            }

            if (refreshKey === 'summaries') {
                await refetchSummaries();
                scheduleAutoRefresh('summaries');
                return;
            }

            if (refreshKey === 'workspaces') {
                await refetchWorkspaces();
                scheduleAutoRefresh('workspaces');
            }
        } catch (error) {
            console.error(`[GraphView] Manual refresh failed for ${refreshKey}:`, error);
            toast.error(
                'Refresh failed',
                error instanceof Error ? error.message : `Unable to refresh ${refreshKey}.`
            );
        } finally {
            setManualRefreshingKeys((current) => ({ ...current, [refreshKey]: false }));
        }
    }, [
        refreshControlsEnabled,
        refetchWorkspaces,
        refetchGraphData,
        refetchSummaries,
        runSync,
        scheduleAutoRefresh,
        toast,
    ]);

    const handleResetLayout = useCallback(async () => {
        if (!selectedWorkspaceId) return;

        setMeasuredNodeHeights(EMPTY_MEASURED_NODE_HEIGHTS);
        measuredNodeHeightsRef.current = EMPTY_MEASURED_NODE_HEIGHTS;
        pendingNodeHeightMeasuresRef.current.clear();
        if (heightMeasureFlushTimeoutRef.current !== null) {
            window.clearTimeout(heightMeasureFlushTimeoutRef.current);
            heightMeasureFlushTimeoutRef.current = null;
        }
        heightMeasureEventsRef.current = [];
        setControlsHeight(0);
        setScopedContextMenu(null);
        nodeSelection.clearSelection();
        selectionAnchorIdRef.current = null;
        centeredFocusIdRef.current = null;
        imperativeCenteredMessageIdRef.current = null;
        pendingGraphFocusRef.current = null;
        graphDataReadyLoggedRef.current = null;
        graphContentRenderedLoggedRef.current = null;
        clearFocusCenterTimers();
        if (deferredGraphFocusFrameRef.current !== null) {
            window.cancelAnimationFrame(deferredGraphFocusFrameRef.current);
            deferredGraphFocusFrameRef.current = null;
        }

        await clearCachedGraphSnapshot(selectedWorkspaceId);
        queryClient.removeQueries({ queryKey: ['graph-snapshot', selectedWorkspaceId] });
        queryClient.removeQueries({ queryKey: ['messages', selectedWorkspaceId] });
        queryClient.removeQueries({ queryKey: ['summaries', selectedWorkspaceId] });
        queryClient.removeQueries({ queryKey: trackedRefKeys.workspace(selectedWorkspaceId) });
        queryClient.removeQueries({ queryKey: branchKeys.workspace(selectedWorkspaceId) });
        setGraphResetNonce((value) => value + 1);

        await runFullRefresh();
        resetAutoRefreshSchedule();

        window.requestAnimationFrame(() => {
            if (controlsRef.current) {
                setControlsHeight(controlsRef.current.offsetHeight);
            }
            if (focusedMessageId) {
                queueFocusedNodeCenter(
                    focusedMessageId,
                    `reset-layout:${selectedWorkspaceId}:${graphResetNonce + 1}:${focusedMessageId}`
                );
                return;
            }
            reactFlowInstance.fitView({ padding: 0.28, duration: 300 });
        });
    }, [
        clearFocusCenterTimers,
        focusedMessageId,
        graphResetNonce,
        nodeSelection,
        queueFocusedNodeCenter,
        queryClient,
        reactFlowInstance,
        resetAutoRefreshSchedule,
        runFullRefresh,
        selectedWorkspaceId,
    ]);

    const handlePreviewEdgeType = useCallback((edgeTypeId: GraphEdgeLegendId) => {
        setPreviewEdgeType(edgeTypeId);
        if (previewEdgeTimeoutRef.current !== null) {
            window.clearTimeout(previewEdgeTimeoutRef.current);
        }
        previewEdgeTimeoutRef.current = window.setTimeout(() => {
            setPreviewEdgeType(null);
            previewEdgeTimeoutRef.current = null;
        }, 2600);
    }, []);

    const handleToggleEdgeType = useCallback((edgeTypeId: GraphEdgeLegendId) => {
        if (edgeTypeId === 'context-path') return;
        setVisibleEdgeTypes((current) => {
            const next = new Set(current);
            if (next.has(edgeTypeId)) {
                next.delete(edgeTypeId);
            } else {
                next.add(edgeTypeId);
            }
            return next;
        });
    }, []);

    useEffect(() => {
        const updateWindowActive = () => {
            setIsWindowActive(document.visibilityState === 'visible' && document.hasFocus());
        };

        updateWindowActive();
        window.addEventListener('focus', updateWindowActive);
        window.addEventListener('blur', updateWindowActive);
        document.addEventListener('visibilitychange', updateWindowActive);

        return () => {
            window.removeEventListener('focus', updateWindowActive);
            window.removeEventListener('blur', updateWindowActive);
            document.removeEventListener('visibilitychange', updateWindowActive);
        };
    }, []);

    useEffect(() => {
        if (!autoRefreshEligible) {
            setAutoRefreshTargets({
                repo: null,
                graph: null,
                summaries: null,
                workspaces: null,
            });
            return;
        }

        resetAutoRefreshSchedule();
    }, [autoRefreshEligible, resetAutoRefreshSchedule, selectedWorkspaceId, repoPath]);

    useEffect(() => {
        lastAutoSyncSnapshotKeyRef.current = null;
    }, [selectedWorkspaceId, repoPath]);

    useEffect(() => {
        if (!autoRefreshEligible || isSyncing || autoRefreshInFlightRef.current) return;
        if (!pendingTrackedRefSyncKey) return;
        if (lastAutoSyncSnapshotKeyRef.current === pendingTrackedRefSyncKey) return;

        autoRefreshInFlightRef.current = true;

        const runChangedRefSync = async () => {
            const refreshStartedAt = Date.now();
            try {
                let syncResult = null;
                try {
                    syncResult = await runSync();
                } catch (error) {
                    console.error('[GraphView] Auto tracked ref sync failed:', error);
                    return;
                }

                lastAutoSyncSnapshotKeyRef.current = pendingTrackedRefSyncKey;
                scheduleAutoRefresh('repo', refreshStartedAt);
                if (!syncResult?.didSync) return;

                await refetchGraphData();
                await refetchSummaries();
                if (AUTO_REFRESH_ENABLED) {
                    scheduleAutoRefresh('graph', refreshStartedAt);
                    scheduleAutoRefresh('summaries', refreshStartedAt);
                }
            } finally {
                autoRefreshInFlightRef.current = false;
            }
        };

        void runChangedRefSync();
    }, [
        autoRefreshEligible,
        isSyncing,
        pendingTrackedRefSyncKey,
        refetchGraphData,
        refetchSummaries,
        runSync,
        scheduleAutoRefresh,
    ]);

    useEffect(() => {
        if (!autoRefreshEligible || isSyncing || autoRefreshInFlightRef.current) return;

        const now = Date.now();
        const dueKeys = (Object.entries(autoRefreshTargets) as Array<[AutoRefreshKey, number | null]>)
            .filter(([, dueAt]) => dueAt !== null && dueAt <= now)
            .map(([key]) => key);

        if (dueKeys.length > 0) {
            autoRefreshInFlightRef.current = true;

            const runDueRefreshes = async () => {
                const refreshStartedAt = Date.now();
                let graphHandled = false;
                let summariesHandled = false;

                try {
                    if (dueKeys.includes('repo')) {
                        let syncResult = null;
                        const shouldRunRepoSync = !gitRefSnapshot || Boolean(pendingTrackedRefSyncKey);
                        if (shouldRunRepoSync) {
                            try {
                                syncResult = await runSync();
                                if (pendingTrackedRefSyncKey) {
                                    lastAutoSyncSnapshotKeyRef.current = pendingTrackedRefSyncKey;
                                }
                            } catch (error) {
                                console.error('[GraphView] Auto repo sync failed:', error);
                            }
                        }
                        scheduleAutoRefresh('repo', refreshStartedAt);

                        const repoChanged = Boolean(syncResult?.didSync);
                        if (repoChanged) {
                            await refetchGraphData();
                            if (AUTO_REFRESH_ENABLED) {
                                scheduleAutoRefresh('graph', refreshStartedAt);
                            }
                            graphHandled = true;
                            await refetchSummaries();
                            if (AUTO_REFRESH_ENABLED) {
                                scheduleAutoRefresh('summaries', refreshStartedAt);
                            }
                            summariesHandled = true;
                        }
                    }

                    if (dueKeys.includes('graph') && !graphHandled) {
                        await refetchGraphData();
                        scheduleAutoRefresh('graph', refreshStartedAt);
                    }

                    if (dueKeys.includes('summaries') && !summariesHandled) {
                        await refetchSummaries();
                        scheduleAutoRefresh('summaries', refreshStartedAt);
                    }

                    if (dueKeys.includes('workspaces')) {
                        await refetchWorkspaces();
                        scheduleAutoRefresh('workspaces', refreshStartedAt);
                    }
                } finally {
                    autoRefreshInFlightRef.current = false;
                }
            };

            void runDueRefreshes();
            return;
        }

        const nextDueAt = Object.values(autoRefreshTargets)
            .filter((value): value is number => value !== null)
            .sort((a, b) => a - b)[0];

        if (!nextDueAt) return;

        const timerId = window.setTimeout(() => {
            setAutoRefreshTargets((current) => ({ ...current }));
        }, Math.max(0, nextDueAt - now));

        return () => window.clearTimeout(timerId);
    }, [
        autoRefreshEligible,
        autoRefreshTargets,
        isSyncing,
        refetchWorkspaces,
        refetchGraphData,
        refetchSummaries,
        gitRefSnapshot,
        pendingTrackedRefSyncKey,
        runSync,
        scheduleAutoRefresh,
    ]);

    const handleNavigateToMessage = useCallback((messageId: string, workspaceId: string) => {
        setIsSearchPanelOpen(false);
        if (workspaceId === selectedWorkspaceId) {
            dispatchFocus({ messageId, source: 'system', metadata: { reason: 'search-navigation' } });
        }
    }, [dispatchFocus, selectedWorkspaceId]);

    const handleStopAgent = useCallback(async (nodeId: string) => {
        if (!selectedWorkspaceId) return;

        try {
            await agentClient.stopAgent(nodeId);
            agentRunManager.dispatch(nodeId, {
                type: 'terminal',
                status: 'cancelled',
                reason: 'cancelled',
            }, {
                workspaceId: selectedWorkspaceId,
                role: 'assistant',
            });
            await scheduleMessagesRefreshWhenGraphIdle(queryClient, selectedWorkspaceId, { reason: 'stop-agent' });
        } catch (error) {
            console.error('[GraphView] Failed to stop agent from timeline:', error);
            toast.error('Unable to stop agent', 'The stop request did not complete.');
        }
    }, [queryClient, selectedWorkspaceId, toast]);

    const getBulkDeleteTargets = useCallback((selectedIds: Set<string>) => {
        if (selectedIds.size === 0) return [] as string[];
        return getTopLevelDeleteBranchIds(selectedIds, messageMap);
    }, [messageMap]);

    const getExplicitCommitDeleteTargets = useCallback((selectedIds: Iterable<string>) => {
        const shas = new Set<string>();
        for (const id of selectedIds) {
            if (!id.startsWith('commit:')) continue;
            const sha = id.slice('commit:'.length);
            if (sha && !deletedGraphCommitShas.has(sha)) shas.add(sha);
        }
        return Array.from(shas);
    }, [deletedGraphCommitShas]);

    const openBulkDeleteDialog = useCallback((messageIds: Iterable<string>, commitShas: Iterable<string> = []) => {
        const rootIds = getBulkDeleteTargets(new Set(messageIds));
        const explicitCommitShas = Array.from(new Set(commitShas)).filter((sha) => sha && !deletedGraphCommitShas.has(sha));
        setBulkDeleteIds(rootIds);
        setBulkDeleteExplicitCommitShas(explicitCommitShas);
        setRemoveCommitsFromGraph(rootIds.length === 0 && explicitCommitShas.length > 0);
        setBulkDeletePhase('idle');
        setIsBulkDeleteAlertOpen(true);
    }, [deletedGraphCommitShas, getBulkDeleteTargets]);

    const resetBulkDeleteDialog = useCallback(() => {
        setIsBulkDeleteAlertOpen(false);
        setBulkDeleteIds([]);
        setBulkDeleteExplicitCommitShas([]);
        setRemoveCommitsFromGraph(false);
        setBulkDeletePhase('idle');
    }, []);

    const handleBulkDeleteConfirm = useCallback(async () => {
        const commitShasToDelete = removeCommitsFromGraph ? bulkDeleteAvailableCommitShas : [];
        if (!selectedWorkspaceId || (bulkDeleteIds.length === 0 && commitShasToDelete.length === 0)) {
            resetBulkDeleteDialog();
            return;
        }
        setBulkDeletePhase('deleting');
        try {
            for (const id of bulkDeleteIds) {
                await deleteMessageBranchMutation.mutateAsync({
                    workspaceId: selectedWorkspaceId,
                    messageId: id,
                });
            }
            if (commitShasToDelete.length > 0) {
                setDeletedGraphCommitShas(addDeletedGraphCommitShas(selectedWorkspaceId, commitShasToDelete));
            }
            nodeSelection.clearSelection();
            setBulkDeletePhase('success');
            window.setTimeout(resetBulkDeleteDialog, 750);
        } catch (error) {
            console.error('[GraphView] Bulk delete failed:', error);
            toast.error('Delete failed', 'Some nodes could not be deleted.');
            setBulkDeletePhase('idle');
        }
    }, [bulkDeleteAvailableCommitShas, bulkDeleteIds, deleteMessageBranchMutation, nodeSelection, removeCommitsFromGraph, resetBulkDeleteDialog, selectedWorkspaceId, toast]);

    // ─────────────────────────────────────────────────────────────────────────
    // DERIVED VALUES
    // ─────────────────────────────────────────────────────────────────────────
    const legendData = useMemo(() => getLlmLegend(graphMessages as Message[], allModels), [graphMessages, allModels]);
    const summaryById = workspaceProjection.summaryMap;
    const selectionBreakdown = useMemo(() => {
        let selectedMessageCount = 0;
        let selectedCommitCount = 0;

        for (const selectedId of nodeSelection.selectedNodeIds) {
            if (selectedId.startsWith('commit:')) {
                selectedCommitCount += 1;
                continue;
            }

            if (summaryById.has(selectedId)) {
                selectedMessageCount += 1;
                continue;
            }

            const entity = workspaceProjection.entitiesById.get(selectedId) ?? workspaceProjection.entitiesByMessageId.get(selectedId);
            if (!entity) continue;
            if (entity.kind === 'commit_message') {
                selectedCommitCount += 1;
            } else {
                selectedMessageCount += 1;
            }
        }

        return { selectedMessageCount, selectedCommitCount };
    }, [workspaceProjection.entitiesById, workspaceProjection.entitiesByMessageId, nodeSelection.selectedNodeIds, summaryById]);
    const selectedMessageNodeIds = useMemo(() => (
        Array.from(nodeSelection.selectedNodeIds).filter((selectedId) => messageMap.has(selectedId))
    ), [messageMap, nodeSelection.selectedNodeIds]);
    const syncStatusItems = useMemo(() => {
        return (Object.keys(AUTO_REFRESH_INTERVALS) as AutoRefreshKey[]).map((key) => {
            return {
                key,
                label: AUTO_REFRESH_LABELS[key],
                source: AUTO_REFRESH_SOURCES[key],
                cadenceLabel: formatCadenceLabel(AUTO_REFRESH_INTERVALS[key]),
                dueAt: autoRefreshTargets[key],
                detail: AUTO_REFRESH_DETAILS[key],
                enabled: key === 'repo' ? REPO_REF_SYNC_ENABLED : AUTO_REFRESH_ENABLED,
                isRefreshing: key === 'repo' ? (isSyncing || manualRefreshingKeys[key]) : manualRefreshingKeys[key],
            };
        });
    }, [autoRefreshTargets, isSyncing, manualRefreshingKeys]);

    const backgroundClass = hideBackground
        ? 'bg-transparent dark:bg-transparent'
        : cn(
            'transition-colors duration-300',
            [
                'bg-[radial-gradient(circle_at_top_left,rgba(147,197,253,0.72),transparent_34%),',
                'radial-gradient(circle_at_bottom_right,rgba(129,140,248,0.32),transparent_32%),',
                'radial-gradient(circle,rgba(51,65,85,0.18)_1.3px,transparent_1.3px),',
                'linear-gradient(135deg,#dbeafe_0%,#eff6ff_22%,#ffffff_48%,#eef2ff_100%)]',
                'bg-[size:auto,auto,20px_20px,auto]'
            ].join(''),
            [
                'dark:bg-[radial-gradient(circle_at_top_left,rgba(96,165,250,0.24),transparent_30%),',
                'radial-gradient(circle_at_bottom_right,rgba(129,140,248,0.18),transparent_28%),',
                'radial-gradient(circle,rgba(148,163,184,0.16)_1.2px,transparent_1.2px),',
                'linear-gradient(135deg,#0f172a_0%,#111827_42%,#020617_100%)]',
                'dark:bg-[size:auto,auto,20px_20px,auto]'
            ].join('')
        );
    const branchNodesForRender = useMemo(() => {
        const startedAt = performance.now();
        const result = layoutNodes.map((node) => withExplicitReactFlowNodeDimensions({
            ...node,
            selected: nodeSelection.selectedNodeIds.has(node.id),
        }));
        recordFundamentalCounter('graph.render.prepare-nodes', {
            nodeCount: layoutNodes.length,
            selectedCount: nodeSelection.selectedNodeIds.size,
            runningCount: runningCountRef.current,
            activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
        }, performance.now() - startedAt);
        return result;
    }, [activeSendFlowFocus?.workspaceId, layoutNodes, nodeSelection.selectedNodeIds, selectedWorkspaceId]);
    const activeGraphRenderHold = runningCount > 0 || activeSendFlowFocus?.workspaceId === selectedWorkspaceId;
    useEffect(() => {
        if (activeGraphRenderHold) {
            setGraphRenderHoldUntil(Number.POSITIVE_INFINITY);
            return;
        }

        setGraphRenderHoldUntil((current) => (
            current === Number.POSITIVE_INFINITY
                ? performance.now() + 5000
                : current
        ));
    }, [activeGraphRenderHold]);

    useEffect(() => {
        if (graphRenderHoldUntil === 0 || graphRenderHoldUntil === Number.POSITIVE_INFINITY) return;
        const remainingMs = graphRenderHoldUntil - performance.now();
        if (remainingMs <= 0) {
            setGraphRenderHoldUntil(0);
            return;
        }
        const timeoutId = window.setTimeout(() => setGraphRenderHoldUntil(0), remainingMs);
        return () => window.clearTimeout(timeoutId);
    }, [graphRenderHoldUntil]);

    const shouldHoldGraphRenderForSendFlow = activeGraphRenderHold || graphRenderHoldUntil > performance.now();
    const activePinnedGraphNodeIds = useMemo(() => {
        const ids = new Set(activePinnedMessageIdKey ? activePinnedMessageIdKey.split('|').filter(Boolean) : []);
        if (focusedMessageId) ids.add(focusedMessageId);
        if (ids.size === 0) return ids;

        const messageById = new Map((graphComputationMessages as Message[]).map((message) => [message.id, message]));
        for (const id of Array.from(ids)) {
            const message = messageById.get(id);
            if (message?.parentId) ids.add(message.parentId);
        }

        const renderNodeIds = new Set<string>();
        for (const node of branchNodesForRender) {
            if (ids.has(node.id)) {
                renderNodeIds.add(node.id);
                continue;
            }
            const data = node.data;
            if (Array.isArray(data?.batch?.messageIds) && data.batch.messageIds.some((id: string) => ids.has(id))) {
                renderNodeIds.add(node.id);
                continue;
            }
            const messageId = data?.entity?.focusMessageId ?? data?.entity?.messageId;
            if (typeof messageId === 'string' && ids.has(messageId)) {
                renderNodeIds.add(node.id);
            }
        }
        return renderNodeIds;
    }, [activePinnedMessageIdKey, branchNodesForRender, focusedMessageId, graphComputationMessages]);
    const activeGraphWindowSpatialIndex = useMemo(() => {
        const startedAt = performance.now();
        const numericDimension = (value: unknown) => {
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string') {
                const parsed = Number.parseFloat(value);
                return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
        };
        const nodeById = new Map<string, Node<any>>();
        const entriesById = new Map<string, ActiveGraphWindowEntry>();
        const cellEntries = new Map<string, ActiveGraphWindowEntry[]>();
        const cellKey = (cellX: number, cellY: number) => `${cellX}:${cellY}`;

        branchNodesForRender.forEach((node, index) => {
            nodeById.set(node.id, node);
            const position = node.position ?? (node as any).absolutePosition ?? { x: 0, y: 0 };
            const width =
                numericDimension((node.style as any)?.width) ??
                numericDimension((node as any).width) ??
                ACTIVE_GRAPH_WINDOW_FALLBACK_NODE_WIDTH;
            const height =
                numericDimension((node.style as any)?.height) ??
                numericDimension((node as any).height) ??
                ACTIVE_GRAPH_WINDOW_FALLBACK_NODE_HEIGHT;
            const left = Number(position.x ?? 0);
            const top = Number(position.y ?? 0);
            const entry: ActiveGraphWindowEntry = {
                id: node.id,
                left,
                top,
                right: left + width,
                bottom: top + height,
                centerX: left + width / 2,
                centerY: top + height / 2,
                index,
            };
            entriesById.set(node.id, entry);

            const minCellX = Math.floor(entry.left / ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE);
            const maxCellX = Math.floor(entry.right / ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE);
            const minCellY = Math.floor(entry.top / ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE);
            const maxCellY = Math.floor(entry.bottom / ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE);
            for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
                    const key = cellKey(cellX, cellY);
                    const list = cellEntries.get(key) ?? [];
                    list.push(entry);
                    cellEntries.set(key, list);
                }
            }
        });

        recordFundamentalCounter('graph.active-window.spatial-index', {
            nodeCount: branchNodesForRender.length,
            cellCount: cellEntries.size,
        }, performance.now() - startedAt);

        return {
            nodeById,
            entriesById,
            query(rect: { left: number; right: number; top: number; bottom: number }) {
                const result = new Map<string, ActiveGraphWindowEntry>();
                const minCellX = Math.floor(rect.left / ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE);
                const maxCellX = Math.floor(rect.right / ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE);
                const minCellY = Math.floor(rect.top / ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE);
                const maxCellY = Math.floor(rect.bottom / ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE);
                for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
                        const list = cellEntries.get(cellKey(cellX, cellY));
                        if (!list) continue;
                        for (const entry of list) {
                            if (
                                entry.right >= rect.left &&
                                entry.left <= rect.right &&
                                entry.bottom >= rect.top &&
                                entry.top <= rect.bottom
                            ) {
                                result.set(entry.id, entry);
                            }
                        }
                    }
                }
                return Array.from(result.values());
            },
        };
    }, [branchNodesForRender]);
    const graphRenderElements = useMemo(() => {
        const buildHeldElements = (nodeIds: Set<string>, reason = 'active-window') => {
            const nodes = Array.from(nodeIds)
                .map((id) => activeGraphWindowSpatialIndex.nodeById.get(id))
                .filter((node): node is Node<any> => Boolean(node));
            const resolvedNodeIds = new Set(nodes.map((node) => node.id));
            const edges = previewEdges.filter((edge) => resolvedNodeIds.has(edge.source) && resolvedNodeIds.has(edge.target));
            const key = `${reason}:${nodes.map((node) => node.id).join('|')}::${edges.map((edge) => edge.id).join('|')}`;
            return {
                nodes,
                edges,
                mode: 'hold-visible' as const,
                key,
            };
        };

        if (shouldHoldGraphRenderForSendFlow) {
            const canvas = branchCanvasRef.current;
            const viewport = reactFlowInstance.getViewport();
            const zoom = Math.max(viewport.zoom || 1, 0.0001);
            const canvasWidth = canvas?.clientWidth || window.innerWidth || 1200;
            const canvasHeight = canvas?.clientHeight || window.innerHeight || 800;
            const viewportLeft = -viewport.x / zoom;
            const viewportTop = -viewport.y / zoom;
            const viewportWidth = canvasWidth / zoom;
            const viewportHeight = canvasHeight / zoom;
            const viewportRight = viewportLeft + viewportWidth;
            const viewportBottom = viewportTop + viewportHeight;
            const marginX = viewportWidth * ACTIVE_GRAPH_WINDOW_OVERSCAN_SCREENS;
            const marginY = viewportHeight * ACTIVE_GRAPH_WINDOW_OVERSCAN_SCREENS;
            const windowRect = {
                left: viewportLeft - marginX,
                right: viewportRight + marginX,
                top: viewportTop - marginY,
                bottom: viewportBottom + marginY,
            };
            const centerX = viewportLeft + viewportWidth / 2;
            const centerY = viewportTop + viewportHeight / 2;
            const pinnedEntries = Array.from(activePinnedGraphNodeIds)
                .map((id) => activeGraphWindowSpatialIndex.entriesById.get(id))
                .filter((entry): entry is ActiveGraphWindowEntry => Boolean(entry));
            const nodeWindowEntries = [
                ...activeGraphWindowSpatialIndex.query(windowRect),
                ...pinnedEntries,
            ]
                .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === index)
                .map((entry) => ({
                    id: entry.id,
                    isPinned: activePinnedGraphNodeIds.has(entry.id),
                    distanceFromViewportCenter: Math.hypot(entry.centerX - centerX, entry.centerY - centerY),
                    index: entry.index,
                }))
                .sort((left, right) => (
                    Number(right.isPinned) - Number(left.isPinned) ||
                    left.distanceFromViewportCenter - right.distanceFromViewportCenter ||
                    left.index - right.index
                ));

            const visibleNodeIds = new Set<string>();
            for (const id of activePinnedGraphNodeIds) {
                visibleNodeIds.add(id);
            }
            for (const entry of nodeWindowEntries) {
                if (visibleNodeIds.size >= ACTIVE_GRAPH_WINDOW_MAX_VISIBLE_NODES && !entry.isPinned) break;
                visibleNodeIds.add(entry.id);
            }

            if (visibleNodeIds.size > 0) {
                const next = buildHeldElements(visibleNodeIds, 'active-window');
                if (next.nodes.length > 0) {
                    if (activeRunGraphRenderRef.current?.mode === 'hold-visible' && activeRunGraphRenderRef.current.key === next.key) {
                        return activeRunGraphRenderRef.current;
                    }
                    activeRunGraphRenderRef.current = next;
                    recordFundamentalCounter('graph.active-window.elements', {
                        nodeCount: next.nodes.length,
                        edgeCount: next.edges.length,
                        pinnedCount: activePinnedGraphNodeIds.size,
                        candidateCount: nodeWindowEntries.length,
                        viewportVersion: activeGraphWindowViewportVersion,
                        indexed: true,
                    });
                    return next;
                }
            }

            if (activeRunGraphRenderRef.current) {
                return activeRunGraphRenderRef.current;
            }
        }
        const next = {
            nodes: branchNodesForRender,
            edges: previewEdges,
            mode: 'full' as const,
        };
        activeRunGraphRenderRef.current = next;
        return next;
    }, [activeGraphWindowSpatialIndex, activeGraphWindowViewportVersion, activePinnedGraphNodeIds, branchNodesForRender, previewEdges, reactFlowInstance, shouldHoldGraphRenderForSendFlow]);

    useEffect(() => {
        const previous = previousGraphRenderRefsRef.current;
        recordFundamentalCounter('graph.render.refs', {
            mode: graphRenderElements.mode,
            nodeCount: graphRenderElements.nodes.length,
            edgeCount: graphRenderElements.edges.length,
            runningCount,
            activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            nodesRefChanged: previous.nodes !== graphRenderElements.nodes,
            edgesRefChanged: previous.edges !== graphRenderElements.edges,
            focusedMessageId,
            viewportInteracting: isViewportInteractingRef.current,
        });
        previousGraphRenderRefsRef.current = {
            nodes: graphRenderElements.nodes,
            edges: graphRenderElements.edges,
        };
    }, [
        activeSendFlowFocus?.workspaceId,
        focusedMessageId,
        graphRenderElements.edges,
        graphRenderElements.mode,
        graphRenderElements.nodes,
        runningCount,
        selectedWorkspaceId,
    ]);

    const graphInteractionContextValue = useMemo(() => ({
        selectedNodeIds: nodeSelection.selectedNodeIds,
        isSelectionGestureActive: nodeSelection.isSelectionGestureActive,
        isViewportInteracting: isViewportInteractingState,
    }), [isViewportInteractingState, nodeSelection.isSelectionGestureActive, nodeSelection.selectedNodeIds]);

    currentGraphCommitSnapshotRef.current = {
        selectedWorkspaceId,
        messagesRef: messages as Message[],
        graphMessagesRef: graphComputationMessages,
        summariesRef: summaries as Summary[],
        branchPointersRef: branchPointers,
        branchPointersByNodeIdRef: branchPointersByNodeId,
        measuredHeightsRef: measuredNodeHeights,
        layoutNodesRef: layoutNodes,
        layoutEdgesRef: layoutEdges,
        renderNodesRef: graphRenderElements.nodes,
        previewEdgesRef: graphRenderElements.edges,
        focusedMessageId,
        focusNonce,
        graphResetNonce,
        tagFilterKey: [
            tagFilter.filterActive ? 1 : 0,
            tagFilter.hasNodeTypeFilter ? 1 : 0,
            tagFilter.activeFilterCount,
            tagFilter.matchingCount,
            tagFilter.keepAncestors ? 1 : 0,
            tagFilter.keepDescendants ? 1 : 0,
        ].join(':'),
        activeScopeId,
        viewMode,
        runningCount,
        graphSnapshotStatus: graphSnapshotQuery.status,
        messagesQueryStatus: messagesQuery.status,
        timestamp: performance.now(),
    };

    const recordGraphNodeLayoutDiagnostic = useCallback((nodeId: string, label = 'manual') => {
        const nodeById = new Map(branchNodesForRender.map((node) => [node.id, node]));
        const absolutePositionCache = new Map<string, { x: number; y: number }>();
        const getNodeSize = (node: Node<any>) => {
            const styleWidth = node.style?.width;
            const styleHeight = node.style?.height;
            const width = typeof styleWidth === 'number'
                ? styleWidth
                : typeof node.width === 'number'
                    ? node.width
                    : 220;
            const height = typeof styleHeight === 'number'
                ? styleHeight
                : typeof node.height === 'number'
                    ? node.height
                    : node.type === 'assistant_message'
                        ? 130
                        : node.type === 'commit_message'
                            ? 110
                            : 100;
            return { width, height };
        };
        const getAbsolutePosition = (node: Node<any>): { x: number; y: number } => {
            const cached = absolutePositionCache.get(node.id);
            if (cached) return cached;
            const parentId = (node as any).parentId ?? (node as any).parentNode ?? null;
            const parent = parentId ? nodeById.get(parentId) : null;
            const parentPosition = parent ? getAbsolutePosition(parent) : { x: 0, y: 0 };
            const position = {
                x: parentPosition.x + node.position.x,
                y: parentPosition.y + node.position.y,
            };
            absolutePositionCache.set(node.id, position);
            return position;
        };
        const describeNode = (node: Node<any> | undefined) => {
            if (!node) return null;
            const position = getAbsolutePosition(node);
            const size = getNodeSize(node);
            const data = node.data as any;
            return {
                id: node.id,
                type: node.type ?? null,
                parentId: (node as any).parentId ?? (node as any).parentNode ?? null,
                x: Number(position.x.toFixed(2)),
                y: Number(position.y.toFixed(2)),
                width: Number(size.width.toFixed(2)),
                height: Number(size.height.toFixed(2)),
                centerX: Number((position.x + size.width / 2).toFixed(2)),
                centerY: Number((position.y + size.height / 2).toFixed(2)),
                messageId: data?.entity?.messageId ?? data?.entity?.focusMessageId ?? data?.batch?.representativeMessageId ?? null,
                turnGroupId: data?.entity?.turnGroupId ?? data?.batch?.batch?.turnGroupId ?? null,
                scopeId: data?.entity?.scopeId ?? data?.scopeId ?? null,
            };
        };
        const getCenter = (node: Node<any>) => {
            const position = getAbsolutePosition(node);
            const size = getNodeSize(node);
            return {
                x: position.x + size.width / 2,
                y: position.y + size.height / 2,
            };
        };

        const selectedNode = nodeById.get(nodeId);
        const connectedEdges = previewEdges
            .filter((edge) => edge.source === nodeId || edge.target === nodeId)
            .map((edge) => {
                const source = nodeById.get(edge.source);
                const target = nodeById.get(edge.target);
                if (!source || !target) {
                    return {
                        id: edge.id,
                        type: edge.type ?? null,
                        source: edge.source,
                        target: edge.target,
                        missingEndpoint: !source ? 'source' : 'target',
                    };
                }
                const sourceCenter = getCenter(source);
                const targetCenter = getCenter(target);
                const dx = targetCenter.x - sourceCenter.x;
                const dy = targetCenter.y - sourceCenter.y;
                return {
                    id: edge.id,
                    type: edge.type ?? null,
                    source: edge.source,
                    target: edge.target,
                    dx: Number(dx.toFixed(2)),
                    dy: Number(dy.toFixed(2)),
                    length: Number(Math.hypot(dx, dy).toFixed(2)),
                    sourceNode: describeNode(source),
                    targetNode: describeNode(target),
                    data: {
                        isReference: Boolean((edge.data as any)?.isReference),
                        layout: (edge.data as any)?.layout ?? null,
                        edgeLegendType: (edge.data as any)?.edgeLegendType ?? null,
                    },
                };
            })
            .sort((left, right) => (('length' in right ? right.length : 0) - ('length' in left ? left.length : 0)));

        recordPerfEvent('graph.node-layout.inspect', {
            label,
            requestedNodeId: nodeId,
            found: Boolean(selectedNode),
            node: describeNode(selectedNode),
            connectedEdgeCount: connectedEdges.length,
            longestConnectedEdges: connectedEdges.slice(0, 12),
            viewport: reactFlowInstance.getViewport(),
        }, { source: 'GraphView' });
    }, [branchNodesForRender, previewEdges, reactFlowInstance]);

    useEffect(() => {
        nodeLayoutDiagnosticRef.current = recordGraphNodeLayoutDiagnostic;
        const debugTarget = window as any;
        const previousDebug = debugTarget.__AGENTREE_GRAPH_DEBUG__ ?? {};
        debugTarget.__AGENTREE_GRAPH_DEBUG__ = {
            ...previousDebug,
            inspectNode: (nodeId: string, label = 'manual') => recordGraphNodeLayoutDiagnostic(nodeId, label),
            captureGeometry: (reason = 'manual') => {
                normalizeReactFlowLayerGeometry(`debug-capture:${reason}`);
                captureGraphGeometrySnapshot(reason);
            },
        };
        return () => {
            if (debugTarget.__AGENTREE_GRAPH_DEBUG__?.inspectNode) {
                delete debugTarget.__AGENTREE_GRAPH_DEBUG__.inspectNode;
            }
            if (debugTarget.__AGENTREE_GRAPH_DEBUG__?.captureGeometry) {
                delete debugTarget.__AGENTREE_GRAPH_DEBUG__.captureGeometry;
            }
        };
    }, [captureGraphGeometrySnapshot, normalizeReactFlowLayerGeometry, recordGraphNodeLayoutDiagnostic]);

    const createGraphLayoutDiagnosticCapture = useCallback((label?: string) => {
        const canvasElement = branchCanvasRef.current;
        const canvasRect = canvasElement?.getBoundingClientRect() ?? null;
        const reactFlowRoot = canvasElement?.querySelector<HTMLElement>(':scope > .react-flow') ?? null;
        const reactFlowRenderer = reactFlowRoot?.querySelector<HTMLElement>(':scope > .react-flow__renderer') ?? null;
        const reactFlowPane = reactFlowRenderer?.querySelector<HTMLElement>(':scope > .react-flow__pane') ?? null;
        const reactFlowViewport = reactFlowRenderer?.querySelector<HTMLElement>('.react-flow__viewport') ?? null;
        const viewport = reactFlowInstance.getViewport();
        const zoom = viewport.zoom || 1;
        const measuredHeights = measuredNodeHeightsRef.current;
        const messageById = new Map((graphMessages as Message[]).map((message: Message) => [message.id, message]));
        const nodeById = new Map(branchNodesForRender.map((node) => [node.id, node]));
        const absolutePositionCache = new Map<string, { x: number; y: number }>();
        const contextPathMessageIdSet = new Set(contextPathMessageIds);
        const visualNodeByMessageId = new Map<string, string>();
        for (const node of branchNodesForRender) {
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
            } else if (messageById.has(node.id)) {
                visualNodeByMessageId.set(node.id, node.id);
            }
        }
        const renderedContextRoute = collapseRenderedFocusRoute(
            graphMessages.map((message) => message.id).filter((messageId) => contextPathMessageIdSet.has(messageId)),
            (messageId) => visualNodeByMessageId.get(messageId)
        );

        const resolveAbsolutePosition = (node: Node<any>): { x: number; y: number } => {
            const cached = absolutePositionCache.get(node.id);
            if (cached) return cached;
            const parentId = (node as any).parentId ?? (node as any).parentNode ?? null;
            const parent = parentId ? nodeById.get(parentId) : null;
            const parentPosition = parent ? resolveAbsolutePosition(parent) : { x: 0, y: 0 };
            const resolved = {
                x: parentPosition.x + (node.position?.x ?? 0),
                y: parentPosition.y + (node.position?.y ?? 0),
            };
            absolutePositionCache.set(node.id, resolved);
            return resolved;
        };

        const domNodes = new Map<string, any>();
        canvasElement?.querySelectorAll<HTMLElement>('[data-agentree-graph-node-id]').forEach((element) => {
            const id = element.getAttribute('data-agentree-graph-node-id');
            if (!id) return;
            const reactFlowNode = element.closest<HTMLElement>('.react-flow__node');
            const contentRect = element.getBoundingClientRect();
            const wrapperRect = reactFlowNode?.getBoundingClientRect() ?? null;
            domNodes.set(id, {
                id,
                heightKey: element.getAttribute('data-agentree-graph-height-key'),
                contentRect: rectSnapshot(contentRect, canvasRect),
                wrapperRect: rectSnapshot(wrapperRect, canvasRect),
                contentGraphHeight: roundMetric(contentRect.height / zoom),
                wrapperGraphHeight: wrapperRect ? roundMetric(wrapperRect.height / zoom) : null,
                className: reactFlowNode?.className ?? null,
            });
        });

        const layoutBoxes = branchNodesForRender.map((node) => {
            const absolutePosition = resolveAbsolutePosition(node);
            const styleWidth = numericDimension((node.style as any)?.width);
            const styleHeight = numericDimension((node.style as any)?.height);
            const reactFlowWidth = numericDimension((node as any).width);
            const reactFlowHeight = numericDimension((node as any).height);
            const width = styleWidth ?? reactFlowWidth ?? 0;
            const height = styleHeight ?? reactFlowHeight ?? 0;
            return {
                id: node.id,
                type: node.type ?? null,
                parentId: (node as any).parentId ?? (node as any).parentNode ?? null,
                left: absolutePosition.x,
                top: absolutePosition.y,
                right: absolutePosition.x + width,
                bottom: absolutePosition.y + height,
                width,
                height,
                ignoreOverlap: node.type === 'turn_group_hull' || width <= 0 || height <= 0,
            };
        });

        const domBoxes = Array.from(domNodes.values())
            .map((domNode) => {
                const node = nodeById.get(domNode.id);
                const rect = domNode.contentRect;
                if (!rect) return null;
                return {
                    id: domNode.id,
                    type: node?.type ?? null,
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    width: rect.width,
                    height: rect.height,
                    ignoreOverlap: node?.type === 'turn_group_hull' || rect.width <= 0 || rect.height <= 0,
                };
            })
            .filter(Boolean);

        const nodes = branchNodesForRender.map((node) => {
            const message = messageById.get(node.id);
            const absolutePosition = resolveAbsolutePosition(node);
            const styleHeight = numericDimension((node.style as any)?.height);
            const reactFlowHeight = numericDimension((node as any).height);
            const measuredHeight = measuredHeights.get(node.id) ?? null;
            const domNode = domNodes.get(node.id) ?? null;
            const actualGraphHeight = domNode?.contentGraphHeight ?? null;
            const layoutHeight = styleHeight ?? reactFlowHeight;
            const heightDelta = actualGraphHeight !== null && layoutHeight !== null
                ? roundMetric(actualGraphHeight - layoutHeight)
                : null;
            return {
                id: node.id,
                type: node.type ?? null,
                parentId: (node as any).parentId ?? (node as any).parentNode ?? null,
                position: {
                    x: roundMetric(node.position?.x),
                    y: roundMetric(node.position?.y),
                },
                absolutePosition: {
                    x: roundMetric(absolutePosition.x),
                    y: roundMetric(absolutePosition.y),
                },
                dimensions: {
                    styleWidth: numericDimension((node.style as any)?.width),
                    styleHeight,
                    reactFlowWidth: numericDimension((node as any).width),
                    reactFlowHeight,
                    measuredHeight,
                    domContentGraphHeight: actualGraphHeight,
                    domWrapperGraphHeight: domNode?.wrapperGraphHeight ?? null,
                    heightDelta,
                },
                dom: domNode,
                data: {
                    heightKey: (node.data as any)?.heightKey ?? null,
                    role: message?.role ?? null,
                    status: message?.status ?? null,
                    updatedAt: message?.updatedAt ?? null,
                    contentLength: typeof message?.content === 'string' ? message.content.length : null,
                    collapsed: message?.collapsed ?? null,
                    scopeId: message?.scope_id ?? null,
                    agentId: message?.agent_id ?? null,
                    hasExecutionData: Boolean(message?.execution_data),
                    outputCommitSha: getMessageOutputCommitSha(message),
                },
                selected: Boolean((node as any).selected),
            };
        });

        const staleMeasuredHeightCount = nodes.filter((node: any) => (
            typeof node.dimensions.heightDelta === 'number' &&
            Math.abs(node.dimensions.heightDelta) >= GRAPH_DIAGNOSTIC_STALE_HEIGHT_EPSILON
        )).length;
        const maxHeightDelta = nodes.reduce((max: number | null, node: any) => {
            const delta = typeof node.dimensions.heightDelta === 'number'
                ? Math.abs(node.dimensions.heightDelta)
                : null;
            if (delta === null) return max;
            return max === null ? delta : Math.max(max, delta);
        }, null);
        const layoutOverlaps = collectOverlaps(layoutBoxes);
        const domOverlaps = collectOverlaps(domBoxes);

        return createGraphDiagnosticCapture(label, {
            nodeCount: branchNodesForRender.length,
            edgeCount: layoutEdges.length,
            renderedNodeCount: domNodes.size,
            layoutOverlapCount: layoutOverlaps.length,
            domOverlapCount: domOverlaps.length,
            maxHeightDelta: roundMetric(maxHeightDelta),
            staleMeasuredHeightCount,
        }, {
            workspaceId: selectedWorkspaceId,
            activeScopeId,
            focusedMessageId,
            viewMode,
            layoutMode,
            laneStrategy,
            graphResetNonce,
            graphUsingSnapshot,
            queryStatus: {
                graphSnapshot: graphSnapshotQuery.status,
                messages: messagesQuery.status,
                summaries: summariesQuery.status,
            },
            counts: {
                messages: (graphMessages as Message[]).length,
                summaries: summaries.length,
                branchPointers: branchPointers.length,
                scopes: scopes.length,
                measuredHeights: measuredHeights.size,
                running: runningCount,
            },
            filters: {
                active: tagFilter.filterActive,
                activeFilterCount: tagFilter.activeFilterCount,
                matchingCount: tagFilter.matchingCount,
                keepAncestors: tagFilter.keepAncestors,
                keepDescendants: tagFilter.keepDescendants,
                scopeViewMode,
            },
            viewport: {
                x: roundMetric(viewport.x),
                y: roundMetric(viewport.y),
                zoom: roundMetric(viewport.zoom, 4),
            },
            reactFlowGeometry: {
                rootRect: rectSnapshot(reactFlowRoot?.getBoundingClientRect() ?? null, canvasRect),
                rendererRect: rectSnapshot(reactFlowRenderer?.getBoundingClientRect() ?? null, canvasRect),
                paneRect: rectSnapshot(reactFlowPane?.getBoundingClientRect() ?? null, canvasRect),
                viewportRect: rectSnapshot(reactFlowViewport?.getBoundingClientRect() ?? null, canvasRect),
                rootClassName: reactFlowRoot?.className ?? null,
                rendererClassName: reactFlowRenderer?.className ?? null,
                paneClassName: reactFlowPane?.className ?? null,
                rootPointerEvents: reactFlowRoot ? window.getComputedStyle(reactFlowRoot).pointerEvents : null,
                rendererPointerEvents: reactFlowRenderer ? window.getComputedStyle(reactFlowRenderer).pointerEvents : null,
                panePointerEvents: reactFlowPane ? window.getComputedStyle(reactFlowPane).pointerEvents : null,
                rendererTransform: reactFlowRenderer ? window.getComputedStyle(reactFlowRenderer).transform : null,
                viewportTransform: reactFlowViewport ? window.getComputedStyle(reactFlowViewport).transform : null,
            },
            canvasRect: rectSnapshot(canvasRect),
            controlsHeight,
            selectedNodeIds: Array.from(nodeSelection.selectedNodeIds),
            overlaps: {
                layout: layoutOverlaps,
                dom: domOverlaps,
            },
            recentHeightMeasureEvents: heightMeasureEventsRef.current,
            contextPathRoute: {
                nodes: contextPathMessageIds,
                renderedNodes: renderedContextRoute.nodeIds,
                renderedEdges: renderedContextRoute.edges,
                visualContextEdges: layoutEdges
                    .filter((edge: any) => edge.animated || edge.style?.stroke === '#4338ca')
                    .map((edge: any) => ({
                        id: edge.id,
                        source: edge.source,
                        target: edge.target,
                        type: edge.type ?? null,
                        data: edge.data ?? null,
                        animated: Boolean(edge.animated),
                        stroke: edge.style?.stroke ?? null,
                        strokeWidth: edge.style?.strokeWidth ?? null,
                    })),
            },
            nodes,
            edges: layoutEdges.map((edge) => ({
                id: edge.id,
                source: edge.source,
                target: edge.target,
                type: edge.type ?? null,
                data: edge.data ?? null,
                animated: Boolean((edge as any).animated),
                style: {
                    stroke: (edge as any).style?.stroke ?? null,
                    strokeWidth: (edge as any).style?.strokeWidth ?? null,
                    opacity: (edge as any).style?.opacity ?? null,
                    strokeDasharray: (edge as any).style?.strokeDasharray ?? null,
                },
                zIndex: (edge as any).zIndex ?? null,
            })),
        });
    }, [
        activeScopeId,
        branchNodesForRender,
        branchPointers.length,
        controlsHeight,
        focusedMessageId,
        graphMessages,
        graphResetNonce,
        graphSnapshotQuery.status,
        graphUsingSnapshot,
        laneStrategy,
        layoutEdges,
        layoutMode,
        messagesQuery.status,
        nodeSelection.selectedNodeIds,
        reactFlowInstance,
        runningCount,
        scopeViewMode,
        scopes.length,
        selectedWorkspaceId,
        summaries,
        summariesQuery.status,
        tagFilter.activeFilterCount,
        tagFilter.filterActive,
        tagFilter.keepAncestors,
        tagFilter.keepDescendants,
        tagFilter.matchingCount,
        viewMode,
        contextPathMessageIds,
    ]);

    useEffect(() => (
        registerGraphDiagnosticProvider(createGraphLayoutDiagnosticCapture)
    ), [createGraphLayoutDiagnosticCapture]);

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER
    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div className={cn('h-full w-full relative overflow-hidden flex flex-col', propClassName)}>
            {/* Controls */}
            {!hideControls && (
                <>
                    <GraphControls
                        controlsRef={controlsRef as React.RefObject<HTMLDivElement>}
                        viewMode={viewMode}
                        onViewModeChange={setViewMode}
                        layoutMode={layoutMode}
                        onLayoutModeChange={setLayoutMode}
                        laneStrategy={laneStrategy}
                        onLaneStrategyChange={setLaneStrategy}
                        timePreset={tagFilter.timePreset}
                        customTimeFrom={tagFilter.customTimeFrom}
                        customTimeTo={tagFilter.customTimeTo}
                        onTimePresetChange={tagFilter.setTimePreset}
                        onCustomTimeFromChange={tagFilter.setCustomTimeFrom}
                        onCustomTimeToChange={tagFilter.setCustomTimeTo}
                        uniqueAgentIds={tagFilter.uniqueAgentIds}
                        agentLabelsById={agentLabelsById}
                        selectedAgentIds={tagFilter.selectedAgentIds}
                        availableScopes={tagFilter.availableScopes}
                        scopeFilterMode={tagFilter.scopeFilterMode}
                        selectedScopeIds={tagFilter.selectedScopeIds}
                        selectedNodeTypes={tagFilter.selectedNodeTypes}
                        agentOperator={tagFilter.agentOperator}
                        onAgentOperatorChange={tagFilter.setAgentOperator}
                        onAgentFilterChange={tagFilter.handleAgentFilterChange}
                        onScopeFilterChange={tagFilter.handleScopeFilterChange}
                        onSelectAllScopes={tagFilter.handleSelectAllScopes}
                        onSelectNoScopes={tagFilter.handleSelectNoScopes}
                        onNodeTypeFilterChange={tagFilter.handleNodeTypeFilterChange}
                        uniqueTags={tagFilter.uniqueTags}
                        selectedFilterTags={tagFilter.selectedFilterTags}
                        tagOperator={tagFilter.tagOperator}
                        onTagOperatorChange={tagFilter.setTagOperator}
                        groupOperator={tagFilter.groupOperator}
                        onGroupOperatorChange={tagFilter.setGroupOperator}
                        keepAncestors={tagFilter.keepAncestors}
                        keepDescendants={tagFilter.keepDescendants}
                        onKeepAncestorsChange={tagFilter.setKeepAncestors}
                        onKeepDescendantsChange={tagFilter.setKeepDescendants}
                        activeFilterCount={tagFilter.activeFilterCount}
                        matchingCount={tagFilter.matchingCount}
                        messageNodeCount={tagFilter.messageNodeCount}
                        nodeTypeCounts={tagFilter.nodeTypeCounts}
                        filterButtonText={tagFilter.filterButtonText}
                        onTagFilterChange={tagFilter.handleTagFilterChange}
                        onClearTagFilters={tagFilter.handleClearTagFilters}
                        onClearAllFilters={tagFilter.handleClearAllFilters}
                        insights={insights}
                        insightsVisible={insightsVisible}
                        showInsightsInGraph={showInsightsInGraph}
                        onToggleInsightsVisible={toggleInsightsVisible}
                        onToggleShowInsightsInGraph={toggleShowInsightsInGraph}
                        leafNodes={leafNodeNavigationItems}
                        onLeafNodeFocus={handleFocus}
                        onResetLayout={handleResetLayout}
                        isRefreshingGraph={isSyncing || isFullRefreshing}
                        autoRefreshEligible={autoRefreshEligible}
                        syncStatusItems={syncStatusItems}
                        onRefreshSyncItem={handleRefreshSyncItem}
                    />
                    <TrackedBranchesPanel
                        workspaceId={selectedWorkspaceId}
                        repoPath={selectedWorkspace?.git_repo_path ?? selectedWorkspace?.folderPath ?? null}
                    />
                </>
            )}

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative">
                {viewMode === 'branch' ? (
                    <div
                        ref={branchCanvasRef}
                        className={cn('agentree-graph-canvas h-full w-full', backgroundClass)}
                        onPointerDownCapture={handleBranchViewportPointerDownCapture}
                        onPointerMoveCapture={handleBranchViewportPointerMoveCapture}
                        onPointerUpCapture={handleBranchViewportPointerUpCapture}
                        onPointerCancelCapture={handleBranchViewportPointerUpCapture}
                        onWheelCapture={handleBranchViewportWheelCapture}
                    >
                        <GraphInteractionContext.Provider value={graphInteractionContextValue}>
                            <GraphHoverProjectionContext.Provider
                                value={{
                                    messages: messages as Message[],
                                    scopes,
                                    summaries: summaries as Summary[],
                                    disabledSummaryIds: disabledSummaryIdsSet,
                                }}
                            >
                            <div aria-hidden="true" className="h-full w-full">
                                {sendFlowGraphDiagFlags.disableGraphSurface ? (
                                    <div
                                        data-agentree-diag="graph-surface-disabled"
                                        className="flex h-full w-full items-center justify-center text-xs text-muted-foreground"
                                    >
                                        Graph surface disabled for send-flow diagnostics
                                    </div>
                                ) : (
                                    <Profiler id="GraphSurface" onRender={graphProfilerOnRender}>
                                        <ReactFlow
                                            key={`graph-flow-${selectedWorkspaceId ?? 'none'}-${graphResetNonce}`}
                                            nodes={graphRenderElements.nodes}
                                            edges={graphRenderElements.edges}
                                            nodeTypes={nodeTypes}
                                            edgeTypes={edgeTypes}
                                            onNodeClick={handleNodeClick}
                                            onSelectionChange={nodeSelection.onSelectionChange}
                                            onSelectionStart={nodeSelection.onSelectionStart}
                                            onSelectionEnd={nodeSelection.onSelectionEnd}
                                            onInit={handleReactFlowInit}
                                            onPaneClick={handlePaneClick}
                                            onMoveStart={(event, viewport) => {
                                                const target = event?.target instanceof HTMLElement ? event.target : null;
                                                const pointerEventTargetIsNode = event?.type !== 'wheel'
                                                    && target
                                                    && getGraphPointerDebugInfo(target).isInsideNode;
                                                if (pointerEventTargetIsNode) {
                                                    recordPerfEvent('graph.viewport-move.start.ignored', {
                                                        reason: 'node-target',
                                                        eventType: event?.type ?? null,
                                                        targetDataId: target?.getAttribute('data-id') ?? null,
                                                    }, { source: 'GraphView' });
                                                    return;
                                                }
                                                const sourceLayer = event?.type === 'wheel'
                                                    ? (event.ctrlKey ? 'wheel-pinch' : 'wheel-pan')
                                                        : event?.type === 'touchstart'
                                                            ? 'touch-gesture'
                                                            : 'react-flow';
                                                ensureViewportInteractionStarted(viewport, sourceLayer);
                                                if (graphRenderElements.mode === 'hold-visible') {
                                                    scheduleActiveGraphWindowUpdate('move-start', false);
                                                }
                                            }}
                                            onMove={(event, viewport) => {
                                                if (graphRenderElements.mode === 'hold-visible') {
                                                    scheduleActiveGraphWindowUpdate('move', true);
                                                }
                                                if (!isViewportInteractingRef.current) return;
                                                if (viewportFirstVisibleMoveLoggedRef.current) return;
                                                const startViewport = viewportDragStartViewportRef.current;
                                                if (!startViewport) return;

                                                const dx = viewport.x - startViewport.x;
                                                const dy = viewport.y - startViewport.y;
                                                const distancePx = Math.hypot(dx, dy);
                                                const zoomDelta = Math.abs(viewport.zoom - startViewport.zoom);
                                                if (distancePx < 12 && zoomDelta < 0.01) return;

                                                viewportFirstVisibleMoveLoggedRef.current = true;
                                                const now = performance.now();
                                                recordPerfEvent('graph.drag.first-visible-move', {
                                                    dragId: viewportDragIdRef.current,
                                                    x: Number(viewport.x.toFixed(2)),
                                                    y: Number(viewport.y.toFixed(2)),
                                                    zoom: Number(viewport.zoom.toFixed(3)),
                                                    distancePx: Number(distancePx.toFixed(2)),
                                                    zoomDelta: Number(zoomDelta.toFixed(4)),
                                                    pointerDownAt: viewportPointerDownAtRef.current,
                                                    pointerDownToFirstVisibleMoveMs: viewportPointerDownAtRef.current === null
                                                        ? null
                                                        : Number((now - viewportPointerDownAtRef.current).toFixed(2)),
                                                    sourceLayer: event?.type === 'wheel'
                                                        ? (event.ctrlKey ? 'wheel-pinch' : 'wheel-pan')
                                                        : event?.type === 'touchmove'
                                                            ? 'touch-gesture'
                                                            : 'react-flow',
                                                }, { source: 'GraphView' });
                                            }}
                                            onMoveEnd={(_event, viewport) => {
                                                stopViewportInteraction(viewport);
                                                if (graphRenderElements.mode === 'hold-visible') {
                                                    scheduleActiveGraphWindowUpdate('move-end', false);
                                                }
                                            }}
                                            fitView={!sendFlowGraphDiagFlags.disableGraphAutoCenter && !focusedMessageId}
                                            fitViewOptions={{ padding: 0.28, duration: 400 }}
                                            onlyRenderVisibleElements={graphRenderElements.mode !== 'hold-visible' && !sendFlowGraphDiagFlags.disableOnlyRenderVisibleElements}
                                            nodesDraggable={false}
                                            nodesConnectable={false}
                                            elementsSelectable={false}
                                            selectionOnDrag={false}
                                            selectionKeyCode="Shift"
                                            panActivationKeyCode={null}
                                            panOnDrag={[0, 1]}
                                            panOnScroll
                                            zoomOnScroll
                                            zoomOnPinch
                                            preventScrolling
                                            minZoom={GRAPH_MIN_ZOOM}
                                            maxZoom={GRAPH_MAX_ZOOM}
                                            className="agentree-react-flow-root"
                                            style={{ width: '100%', height: '100%' }}
                                        >
                                            <Controls showInteractive={false} />
                                        </ReactFlow>
                                    </Profiler>
                                )}
                            </div>
                            </GraphHoverProjectionContext.Provider>
                        </GraphInteractionContext.Provider>
                        {!sendFlowGraphDiagFlags.disableGraphSurface && (
                            <>
                                <MiniMapPanel />
                                <GraphCanvasIndexPanel
                                    isVisible={isIndexVisible}
                                    onToggleVisible={setIsIndexVisible}
                                    onPreviewEdgeType={handlePreviewEdgeType}
                                    visibleEdgeTypes={visibleEdgeTypes}
                                    onToggleEdgeType={handleToggleEdgeType}
                                    onFocusMessage={handleFocus}
                                    nodes={graphRenderElements.nodes}
                                    messages={graphMessages as Message[]}
                                    agentLabelsById={agentLabelsById}
                                    scopeNameById={scopeNameById}
                                    scopeColorById={scopeColorById}
                                />
                            </>
                        )}
                        {nodeSelection.showActionMenu && (
                            <FloatingSelectionMenu
                                position={nodeSelection.actionMenuPosition}
                                selectedCount={nodeSelection.selectedCount}
                                selectedMessageCount={selectionBreakdown.selectedMessageCount}
                                selectedCommitCount={selectionBreakdown.selectedCommitCount}
                                canViewDiff={selectedMessageNodeIds.length === 2}
                                canGenerateSummary={nodeSelection.canGenerateSummary}
                                canMerge={selectedMessageNodeIds.length >= 2}
                                onDelete={() => {
                                    openBulkDeleteDialog(
                                        nodeSelection.selectedNodeIds,
                                        getExplicitCommitDeleteTargets(nodeSelection.selectedNodeIds)
                                    );
                                }}
                                onViewDiff={() => {
                                    if (selectedMessageNodeIds.length === 2) {
                                        openDiff(selectedMessageNodeIds[0], selectedMessageNodeIds[1]);
                                    }
                                    nodeSelection.clearSelection();
                                }}
                                onGenerateSummary={nodeSelection.handleSummarize}
                                onMerge={handleMergeSelection}
                            />
                        )}
                    </div>
                ) : (
                    <div className={cn('h-full w-full', backgroundClass)}>
                        <TimelineView
                            projection={workspaceProjection}
                            focusedMessageId={focusedMessageId}
                            onNodeClick={handleNodeClick}
                            filterActive={tagFilter.filterActive}
                            matchingMessageIds={tagFilter.matchingMessageIds}
                            topOffset={controlsHeight}
                            activeScopeId={activeScopeId}
                            scopeViewMode={scopeViewMode}
                            scopeNameById={scopeNameById}
                            onStopAgent={handleStopAgent}
                            selectedNodeIds={nodeSelection.selectedNodeIds}
                            onSelectionChange={nodeSelection.onSelectionChange}
                            onRequestDeleteMessages={(messageIds) => {
                                openBulkDeleteDialog(messageIds);
                            }}
                            onAddCommitsToMergePanel={handleAddCommitsToMergePanel}
                        />
                    </div>
                )}
            </div>

            {viewMode !== 'timeline' && runningCount > 0 && (
                <button
                    type="button"
                    onClick={() => setViewMode('timeline')}
                    className="absolute bottom-6 left-6 z-40 animate-in slide-in-from-bottom-4 fade-in duration-200"
                >
                    <div className="flex items-center gap-2 rounded-full border border-emerald-500/20 bg-background/85 px-4 py-2 text-sm font-medium text-foreground shadow-lg backdrop-blur-md ring-1 ring-emerald-500/10 transition-colors hover:bg-background">
                        <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
                        <span>{runningCount} Running</span>
                        <Activity size={14} className="text-emerald-600 dark:text-emerald-400" />
                    </div>
                </button>
            )}

            <ScopedNodeContextMenu
                contextMenu={scopedContextMenu}
                projection={workspaceProjection}
                onClose={() => setScopedContextMenu(null)}
                onDeleteMessages={(messageIds) => {
                    openBulkDeleteDialog(messageIds);
                }}
                onDeleteTargets={({ messageIds, commitShas }) => {
                    openBulkDeleteDialog(messageIds, commitShas);
                }}
                onAddCommitsToMergePanel={handleAddCommitsToMergePanel}
                onAddCommitToNode={setAddCommitTargetId}
                onShareNode={handleShareNode}
            />
            <AddCommitDialog
                open={!!addCommitTargetId}
                workspaceId={selectedWorkspaceId}
                repoPath={repoPath}
                baseCommitSha={selectedWorkspace?.base_commit_sha ?? null}
                parentNodeId={addCommitTargetId}
                messages={messages as Message[]}
                onOpenChange={(open) => {
                    if (!open) setAddCommitTargetId(null);
                }}
            />

            {/* Advanced Search Panel */}
            <AdvancedSearchPanel
                isOpen={isSearchPanelOpen}
                onClose={() => setIsSearchPanelOpen(false)}
                onNavigateToMessage={handleNavigateToMessage}
            />

            {/* Summary Creation Dialog */}
            <SummaryCreationDialog
                isOpen={nodeSelection.isSummaryDialogOpen}
                onClose={nodeSelection.closeSummaryDialog}
                startMessageId={nodeSelection.summarySelectionStart}
                endMessageId={nodeSelection.summarySelectionEnd}
            />

            <DeleteBranchDialog
                open={isBulkDeleteAlertOpen}
                title="Delete selected nodes?"
                preview={bulkDeletePreview}
                phase={bulkDeletePhase}
                removableCommitCount={bulkDeleteAvailableCommitShas.length}
                removeCommitsFromGraph={removeCommitsFromGraph}
                onRemoveCommitsFromGraphChange={setRemoveCommitsFromGraph}
                onOpenChange={(open) => {
                    if (bulkDeletePhase === 'deleting' || bulkDeletePhase === 'success') return;
                    if (open) {
                        setIsBulkDeleteAlertOpen(true);
                    } else {
                        resetBulkDeleteDialog();
                    }
                }}
                onCancel={resetBulkDeleteDialog}
                onConfirm={handleBulkDeleteConfirm}
            />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT WITH PROVIDER
// ═══════════════════════════════════════════════════════════════════════════

export function GraphView(props: GraphViewInternalProps) {
    const sendFlowGraphDiagFlags = getSendFlowGraphDiagnosticFlags();
    if (sendFlowGraphDiagFlags.disableGraphSurface) {
        return (
            <div
                data-agentree-diag="graph-surface-disabled"
                className={cn(
                    'flex h-full w-full items-center justify-center bg-muted/20 text-xs text-muted-foreground',
                    props.className
                )}
            >
                Graph surface disabled for send-flow diagnostics
            </div>
        );
    }

    return (
        <ReactFlowProvider>
            <GraphViewInternal {...props} />
        </ReactFlowProvider>
    );
}
