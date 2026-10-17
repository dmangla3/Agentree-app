// @ts-nocheck
import React, { Profiler, startTransition, useMemo, useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ReactFlow,
    Controls,
    ControlButton,
    Node,
    ReactFlowProvider,
    useReactFlow,
    useStore,
    useStoreApi,
    MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Stores
import { buildComposerDraftKey, useWorkspaceStore, Message, Summary } from '../stores/workspaceStore';
import { getMergeSourcePrunePlan, getMergeTabRunIndicator, useIntegrationStore } from '../stores/integrationStore';

// Hooks - Data
import { useMessages, useSummaries, useDeleteMessageBranch, useDeleteHighlight, useToggleCollapse } from '../hooks/useMessages';

import { useWorkspaces } from '../hooks/useWorkspaces';
import { useModels } from '../hooks/useModels';
import { useAgents } from '../hooks/useAgents';
import { useBranches } from '../hooks/useBranches';
import { branchKeys } from '../hooks/useBranches';
import { trackedRefKeys, useTrackedRefs } from '../hooks/useTrackedRefs';
import { useGitSync } from '../hooks/useGitSync';
import { getEnabledTrackedGitRefs, getTrackedRefsNeedingSync, useGitRefSnapshot } from '../hooks/useGitRefSnapshot';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, useLocalNodes } from '../hooks/useLocalNodes';
import { useGraphMessages } from '../hooks/useLiveMessages';
import { useInsights } from '../hooks/useInsights';
import { getPublicShareUrl, useCreateNodePublicShare } from '../hooks/useWorkspacePublicShare';
import { useCreateThreadSession, useDeleteThreadSession, useThreadSessions } from '../hooks/useThreadSessions';

// Hooks - Graph (extracted)
import { useTagFilter } from '../hooks/graph/useTagFilter';
import { useNodeSelection } from '../hooks/graph/useNodeSelection';
import { useGraphLayout, LayoutMode, LaneStrategy } from '../hooks/graph/useGraphLayout';
import { useWorkspaceProjection } from '../hooks/useWorkspaceProjection';
import { graphSnapshotToSummaries, useGraphSnapshot } from '../hooks/useGraphSnapshot';
// Utils
import { LlmNodeData, getLlmLegend } from '../lib/graphUtils';
import { mapLocalCommitToCommitEntity } from '../lib/localCommitGraphProjection';
import { createSubgraphFilterState, getSubgraphMessageIds, shouldClearSubgraphForFocus } from '../lib/graphSubgraphFilter';
import { buildThreadRootIndex, getEmptyWorkspaceThreadRootId, getHiddenConversationMessageIds, getLatestThreadMessageId } from '../lib/graphThreadRoots';
import { deriveBackfilledThreadSessions, mergeThreadSessionsWithBackfills, threadSessionSortKey } from '../lib/threadSessions';
import { resolveLocalWorkspaceRepoPath } from '../lib/workspaceRepoPath';
import {
    filterCommitContextForThreadScope,
    filterSummariesForThreadScope,
    getInactiveThreadRootIds,
    getThreadScopeKey,
    resolveDoneThreadsReopenedByUserMessages,
    resolveActiveThreadAfterDoneChange,
    resolveInitialActiveThreadRootId,
    resolveThreadGraphScope,
} from '../lib/graphThreadScope';
import {
    readGraphThreadState,
    rememberGraphThreadState,
} from '../lib/graphThreadStateStorage';
import {
    applySubgraphThreadConversions,
    readConvertedSubgraphThreadRootIds,
    rememberConvertedSubgraphThreadRootIds,
} from '../lib/graphSubgraphThreads';
import { buildThreadBands, getThreadDividerRectsFromNodes, type ThreadBand } from '../lib/graphThreadDividers';
import { buildComposerContextPathIds } from '../lib/composerContext';
import { resolveComposerDefaultBaseCommit } from '../lib/composerBaseCommit';
import { buildLiveGitRefs, getComposerBaseSnapshotGitRefs } from '../lib/liveGitRefs';
import { collectDeleteBranchMessageIds, getDeleteBranchPreview, getTopLevelDeleteBranchIds } from '../domain/deleteBranchPreview';
import { getBranchPointerCommitSha, getMessageBaseCommitSha, getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import { shouldRefreshHeldGraphMessagesForStructuralChange } from '../lib/graph/graphComputationHold';
import { reconcileTerminalAgentRunsFromMessages } from '../lib/agentRunTerminalReconciliation';
import { isNoAgentSessionFoundError, markStaleLocalAgentNodeCancelled } from '../lib/localAgentRunTerminal';
import { addDeletedGraphCommitShas, readDeletedGraphCommitShas } from '../lib/graph/commitGraphTombstones';
import { getLeafMessagesByRecency, getLeafNavigationLabel } from '../lib/graph/leafNodes';
import { getThreadAwarenessSummary } from '../lib/graph/threadAwareness';
import {
    buildFullGraphViewportBoundsModel,
    clampGraphViewportToFullGraphBoundsModel,
} from '../lib/graphViewportBounds';
import { collapseRenderedFocusRoute } from '../domain/focusRoute';
import { cn } from '../lib/utils';
import { useDiff } from '../contexts/DiffContext';
import { useToastHelpers } from './Toast';
import { useAuthStore } from '../stores/authStore';
import { useRunStatusStore } from '../stores/runStatusStore';
import { isActiveAgentStatus } from '@shared/agentStatus';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { useGraphViewHotkeys, type GraphNavigationDirection } from '../hotkeys/graphHotkeys';

// Components - Nodes/Edges
import SummaryEdge from './SummaryEdge';
import { HorizontalThenVerticalEdge } from './HorizontalThenVerticalEdge';
import { ContextSmoothStepEdge } from './ContextSmoothStepEdge';

// Components - Graph (extracted)
import { GraphControls, type HighlightNavigationItem, type LeafNodeNavigationItem, type ThreadNavigationItem, ViewMode } from './graph/GraphControls';
import { GraphLegend } from './graph/GraphLegend';
import { MiniMapPanel } from './graph/MiniMapPanel';
import { GraphCanvasIndexPanel, type GraphEdgeLegendId, type GraphNodeSectionId } from './graph/GraphCanvasIndexPanel';
import { GraphInteractionContext } from './graph/GraphInteractionContext';
import { GraphHoverProjectionContext } from './graph/GraphHoverProjectionContext';
import { TrackedBranchesPanel } from './TrackedBranchesPanel';
import { FloatingSelectionMenu } from './graph/FloatingSelectionMenu';
import { MessageHighlightActiveProvider } from './highlights/MessageHighlightActiveContext';
import { getMessageHighlights } from '../lib/messageHighlights';

// Components - Dialogs/Panels
import { SummaryCreationDialog } from './SummaryCreationDialog';
import { ListView } from './ListView';
import { ExecutionTimelineDock } from './timeline/ExecutionTimelineDock';
import AdvancedSearchPanel from './AdvancedSearchPanel';
import { NodeContextMenu, type NodeContextMenuState } from './NodeContextMenu';
import InsightPanel from './InsightPanel';
import { AddCommitDialog } from './AddCommitDialog';
import { DeleteBranchDialog, type DeleteBranchDialogPhase } from './DeleteBranchDialog';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '../../@/components/ui/alert-dialog';
import { classifyMessageNodeKind } from '../domain/nodes';

import { ChevronLeft, ChevronRight, ChevronsRight, GitBranch, X } from 'lucide-react';
import { agentClient } from '../lib/agentClient';
import { getOptionalCloudAuthToken } from '../lib/authSession';
import { workspaceApplication } from '../application/workspaces';
import { flushWorkspaceCloudBootstrap, flushWorkspaceCloudSync, queueLocalSyncFlush } from '../lib/localSyncScheduler';
import { writeClipboardText } from '../lib/clipboard';
import { ensureLocalCommitGraphRepaired } from '../lib/localCommitGraphRepair';
import { createProfilerOnRender, startFocusInteraction } from '../lib/interactionProfiler';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { recordFundamentalCounter } from '../perf/fundamentalCounters';
import { createGraphDiagnosticCapture, registerGraphDiagnosticProvider } from '../lib/graphDiagnostics';
import { markGraphInteractionEnd, markGraphInteractionStart, scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import {
    GRAPH_COMPOSER_DOCK_STATE_EVENT,
    dispatchGraphComposerDockCollapse,
    dispatchGraphComposerDockExpand,
    getGraphComposerDockState,
    type GraphComposerDockState,
} from '../lib/graphComposerDockEvents';
import {
    getGraphNodeDetailDensityCount,
    getGraphNodeDetailEffectiveZoom,
    getGraphNodeDetailLevel,
    getGraphNodeDetailZoomBucket,
    type GraphNodeDetailLevel,
    type GraphNodeDetailZoomBucket,
} from '../lib/graphNodeDetailLevel';
import { withExplicitReactFlowNodeDimensions } from '../lib/reactFlowNodeDimensions';
import { buildExecutionTimelineItems, packExecutionTimelineItems } from '../lib/executionTimelineModel';
import type { AttentionBadgeItem, FocusTriggerMetrics } from '../types/nodes';

import { graphNodeTypes } from './graph/graphNodeTypes';
import { hasLayoutAnchoredGraphNodes, resolveAnchoredGraphWindowNodeIds } from './graph/graphRenderWindow';
import { getGraphEdgeEndpointDotVariant, isInterTurnEndpointEdge, type EdgeEndpointDotVariant } from './graphEdgeEndpointDots';
import type { WorkspaceThreadNavigationModel } from './navigation/WorkspaceNavigator';

const GraphMergePanel = React.lazy(() => import('./MergePanel').then((module) => ({ default: module.MergePanel })));

function GraphMergePanelLoading() {
    return (
        <div className="flex h-full items-center justify-center bg-background/80 p-6">
            <div className="w-full max-w-md space-y-3">
                <div className="app-skeleton h-8 w-40" />
                <div className="app-skeleton h-24 w-full" />
                <div className="app-skeleton h-24 w-5/6" />
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// NODE & EDGE TYPES
// ═══════════════════════════════════════════════════════════════════════════

const edgeTypes = {
    summaryEdge: SummaryEdge,
    horizontalThenVertical: HorizontalThenVerticalEdge,
    smoothstep: ContextSmoothStepEdge,
    compactLineage: HorizontalThenVerticalEdge,
};

const EMPTY_MEASURED_NODE_HEIGHTS = new Map<string, number>();
const FOCUS_READING_MIN_ZOOM = 0.72;
const FOCUS_READING_MAX_ZOOM = 1.0;
const FOCUS_VIEWPORT_BAND_X = 0.44;
const FOCUS_VIEWPORT_BAND_Y = 0.42;
const FOCUS_MIN_ANIMATION_MS = 160;
const FOCUS_MAX_ANIMATION_MS = 320;
const FOCUS_DISTANCE_FOR_MAX_DURATION = 2200;
const FOCUS_CENTER_MAX_RETRY_FRAMES = 18;
const NODE_HEIGHT_MEASURE_EPSILON = 4;
const GRAPH_HEIGHT_MEASURE_FLUSH_MS = 32;
const VIEWPORT_INTERACTION_STALE_MS = 12_000;
const ACTIVE_GRAPH_WINDOW_MAX_VISIBLE_NODES = 96;
const ACTIVE_GRAPH_WINDOW_OVERSCAN_SCREENS = 0.85;
const ACTIVE_GRAPH_WINDOW_UPDATE_THROTTLE_MS = 80;
const ACTIVE_GRAPH_WINDOW_FALLBACK_NODE_WIDTH = 120;
const ACTIVE_GRAPH_WINDOW_FALLBACK_NODE_HEIGHT = 120;
const ACTIVE_GRAPH_WINDOW_SPATIAL_CELL_SIZE = 900;
const EMPTY_GRAPH_INSIGHTS: any[] = [];
const GRAPH_GEOMETRY_DIAGNOSTICS_ENABLED = import.meta.env.VITE_GRAPH_GEOMETRY_DIAGNOSTICS === 'true';

export const shouldTreatGraphMoveAsViewportInteraction = ({
    eventType,
    eventTargetIsNode,
    programmaticFocusCenterActive,
}: {
    eventType: string | null | undefined;
    eventTargetIsNode: boolean;
    programmaticFocusCenterActive: boolean;
}) => {
    if (!eventType) return false;
    if (eventType !== 'wheel' && eventTargetIsNode) return false;
    if (programmaticFocusCenterActive && eventType !== 'wheel' && eventType !== 'touchstart') return false;
    return true;
};

export const shouldClampViewportDuringMove = (input: {
    eventType: string | undefined;
    isViewportInteracting: boolean;
}): boolean => {
    if (!input.isViewportInteracting) return true;
    return input.eventType === 'wheel';
};

export const shouldRestoreViewportAfterGraphNodeCountChange = (input: {
    activeGraphRenderHold: boolean;
    graphRenderMode: 'full' | 'hold-visible';
    isViewportInteracting: boolean;
}): boolean => {
    if (input.isViewportInteracting) return false;
    if (input.activeGraphRenderHold) return false;
    return input.graphRenderMode === 'full';
};

export const shouldDispatchGraphFocusSynchronously = ({
    activeRunCount,
    activeSendFlowWorkspaceId,
    selectedWorkspaceId,
}: {
    activeRunCount: number;
    activeSendFlowWorkspaceId: string | null | undefined;
    selectedWorkspaceId: string | null | undefined;
}) => activeRunCount > 0 || (
    activeSendFlowWorkspaceId != null
    && selectedWorkspaceId != null
    && activeSendFlowWorkspaceId === selectedWorkspaceId
);

export const shouldSkipActiveGraphClickCentering = ({
    activeRunCount,
    activeSendFlowWorkspaceId,
    selectedWorkspaceId,
    triggerVia,
}: {
    activeRunCount: number;
    activeSendFlowWorkspaceId: string | null | undefined;
    selectedWorkspaceId: string | null | undefined;
    triggerVia: unknown;
}) => triggerVia === 'react-flow-node-click' && shouldDispatchGraphFocusSynchronously({
    activeRunCount,
    activeSendFlowWorkspaceId,
    selectedWorkspaceId,
});

export const resolveReactFlowNodeClickFocusMessageId = ({
    nodeType,
    entity,
    nodeId,
}: {
    nodeType: string | undefined;
    entity: { focusMessageId?: string | null; messageId?: string | null } | null | undefined;
    nodeId: string;
}): string | null => {
    if (nodeType === 'user_message') {
        return entity?.focusMessageId ?? null;
    }
    if (nodeType === 'assistant_message' || nodeType === 'commit_message') {
        return entity?.focusMessageId ?? entity?.messageId ?? nodeId;
    }
    if (nodeType === 'summary_block') {
        return entity?.focusMessageId ?? null;
    }
    return null;
};

export const resolveReactFlowNodeClickFocusTarget = ({
    nodeType,
    entity,
    nodeId,
}: {
    nodeType: string | undefined;
    entity: { focusMessageId?: string | null; messageId?: string | null } | null | undefined;
    nodeId: string;
}): { messageId: string | null; centerMessageId: string | null; redirectedFromMessageId: string | null } => {
    const messageId = resolveReactFlowNodeClickFocusMessageId({ nodeType, entity, nodeId });
    if (nodeType === 'user_message' && messageId) {
        const clickedMessageId = entity?.messageId ?? nodeId;
        return {
            messageId,
            centerMessageId: clickedMessageId,
            redirectedFromMessageId: clickedMessageId,
        };
    }
    return {
        messageId,
        centerMessageId: messageId,
        redirectedFromMessageId: null,
    };
};

export const resolveThreadDropdownSelection = ({
    threadRootId,
    messages,
}: {
    threadRootId: string;
    messages: Message[];
}) => getLatestThreadMessageId(threadRootId, messages) ?? null;

export const resolveThreadScopedDefaultFocus = ({
    focusedMessageId,
    lastFocusSource,
    lastFocusMetadata,
    rememberedFocusId,
    messages,
}: {
    focusedMessageId: string | null;
    lastFocusSource: string | null;
    lastFocusMetadata: Record<string, unknown> | null;
    rememberedFocusId: string | null;
    messages: Message[];
}): { messageId: string | null; reason: 'restore-workspace-focus' | 'default-workspace-focus' | 'clear-thread-focus' } | null => {
    const messageIds = new Set(messages.map((message) => message.id));
    if (focusedMessageId && messageIds.has(focusedMessageId)) return null;

    const focusedCommitSha = typeof lastFocusMetadata?.commitSha === 'string'
        ? lastFocusMetadata.commitSha.trim()
        : '';
    if (
        lastFocusSource === 'graph'
        && focusedCommitSha
        && focusedMessageId === focusedCommitSha
        && messages.some((message) => getMessageOutputCommitSha(message) === focusedCommitSha)
    ) {
        return null;
    }

    if (messages.length === 0) {
        return focusedMessageId ? { messageId: null, reason: 'clear-thread-focus' } : null;
    }

    const rememberedMessageId = rememberedFocusId && messageIds.has(rememberedFocusId)
        ? rememberedFocusId
        : null;
    let latestMessage: Message | null = null;
    for (const message of messages) {
        if (!latestMessage) {
            latestMessage = message;
            continue;
        }
        const messageTime = new Date(message.updatedAt || message.createdAt).getTime();
        const latestTime = new Date(latestMessage.updatedAt || latestMessage.createdAt).getTime();
        if (messageTime > latestTime) latestMessage = message;
    }

    const fallbackMessageId = rememberedMessageId ?? latestMessage?.id ?? null;
    if (!fallbackMessageId || fallbackMessageId === focusedMessageId) return null;
    return {
        messageId: fallbackMessageId,
        reason: rememberedMessageId === fallbackMessageId ? 'restore-workspace-focus' : 'default-workspace-focus',
    };
};

export type ThreadDeletePlan =
    | { kind: 'thread-session'; threadRootId: string }
    | { kind: 'message-branch'; threadRootId: string; messageIds: string[] };

export const resolveThreadDeletePlan = ({
    threadRootId,
    threadMessageIds,
}: {
    threadRootId: string;
    threadMessageIds: Set<string> | undefined;
}): ThreadDeletePlan => {
    const messageIds = Array.from(threadMessageIds ?? []);
    return messageIds.length > 0
        ? { kind: 'message-branch', threadRootId, messageIds }
        : { kind: 'thread-session', threadRootId };
};

export const resolveBlockingEmptyThreadRootId = ({
    threadRootIds,
    messageIdsByThreadRootId,
    doneThreadRootIds,
    draftThreadRootIds = new Set<string>(),
}: {
    threadRootIds: string[];
    messageIdsByThreadRootId: Map<string, Set<string>>;
    doneThreadRootIds: Set<string>;
    draftThreadRootIds?: Set<string>;
}): string | null => {
    for (const threadRootId of threadRootIds) {
        if (doneThreadRootIds.has(threadRootId)) continue;
        const threadMessageIds = messageIdsByThreadRootId.get(threadRootId);
        if ((threadMessageIds?.size ?? 0) === 0 && !draftThreadRootIds.has(threadRootId)) return threadRootId;
    }
    return null;
};

export const buildFocusedThreadRootLookup = ({
    messages,
    threadRootIndex,
}: {
    messages: Message[];
    threadRootIndex?: ReturnType<typeof buildThreadRootIndex>;
}): Map<string, string> => {
    const index = threadRootIndex ?? buildThreadRootIndex(messages);
    const lookup = new Map<string, string>();

    index.threadRootIdByMessageId.forEach((threadRootId, messageId) => {
        lookup.set(messageId, threadRootId);
    });

    for (const message of messages) {
        const threadRootId = index.threadRootIdByMessageId.get(message.id);
        if (!threadRootId) continue;

        const outputCommitSha = getMessageOutputCommitSha(message);
        if (outputCommitSha) {
            lookup.set(outputCommitSha, threadRootId);
            lookup.set(`${message.id}:commit`, threadRootId);
        }
    }

    return lookup;
};

export const resolveFocusedThreadRootId = ({
    focusedMessageId,
    messages,
    threadRootIndex,
    focusedThreadRootLookup,
}: {
    focusedMessageId: string | null;
    messages: Message[];
    threadRootIndex?: ReturnType<typeof buildThreadRootIndex>;
    focusedThreadRootLookup?: Map<string, string>;
}): string | null => {
    if (!focusedMessageId) return null;
    const lookup = focusedThreadRootLookup ?? buildFocusedThreadRootLookup({ messages, threadRootIndex });
    return lookup.get(focusedMessageId) ?? null;
};

export const resolveLeafNodeFocusThreadRootId = ({
    leafNodeId,
    focusedThreadRootLookup,
}: {
    leafNodeId: string;
    focusedThreadRootLookup: Map<string, string>;
}): string | null => (
    focusedThreadRootLookup.get(leafNodeId) ?? null
);

const useStableGraphCallback = <Args extends unknown[], ReturnValue>(
    callback: (...args: Args) => ReturnValue
) => {
    const callbackRef = useRef(callback);
    useLayoutEffect(() => {
        callbackRef.current = callback;
    }, [callback]);
    return useCallback((...args: Args) => callbackRef.current(...args), []);
};

const cleanNodePreview = (value: string | null | undefined): string => (
    (value || '')
        .replace(/```[\s\S]*?```/g, '[Code]')
        .replace(/`[^`]+`/g, '[Code]')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/#+\s/g, '')
        .replace(/\s+/g, ' ')
        .trim()
);

export const getThreadDraftPreviewText = (value: string | null | undefined): string | null => {
    const raw = value ?? '';
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
};

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

const formatThreadUpdatedLabel = (timestampMs: number, nowMs: number): string => {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return 'unknown';

    const elapsedMs = Math.max(0, nowMs - timestampMs);
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    if (elapsedSeconds < 45) return 'now';

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours}h ago`;

    const elapsedDays = Math.floor(elapsedHours / 24);
    if (elapsedDays < 7) return `${elapsedDays}d ago`;

    return new Date(timestampMs).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
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
    const statusMeta = getLeafStatusMeta(message);

    return {
        id: message.id,
        label: getLeafNavigationLabel(message),
        modelLabel: getLeafModelLabel(message, agentLabelsById),
        statusLabel: statusMeta.statusLabel,
        statusTone: statusMeta.statusTone,
        timestampLabel: formatLeafTimestamp(message),
    };
};

const toHighlightNavigationItems = (message: Message): HighlightNavigationItem[] => {
    const label = message.aiLabel?.trim()
        || getLeafNavigationLabel(message)
        || (message.role === 'user' ? 'User message' : 'Assistant message');
    return getMessageHighlights(message).map((highlight) => ({
        id: highlight.id,
        messageId: message.id,
        label,
        exact: highlight.range.exact.replace(/\s+/g, ' ').trim(),
        color: highlight.color,
        timestampLabel: formatLeafTimestamp(message),
    }));
};

const getGraphNodeNavigationTime = (message: Message): number => {
    const timestamp = message.last_event_at || message.updatedAt || message.createdAt;
    const parsed = Date.parse(timestamp || '');
    return Number.isFinite(parsed) ? parsed : 0;
};

export const getGraphNodeNavigationIds = (messages: readonly Message[]): string[] => (
    [...messages]
        .filter((message) => message.role === 'assistant')
        .sort((left, right) => (
            getGraphNodeNavigationTime(left) - getGraphNodeNavigationTime(right) ||
            left.id.localeCompare(right.id)
        ))
        .map((message) => message.id)
);

type DirectionalGraphNavigationNode = {
    id: string;
    type?: string;
    data?: any;
    position?: { x?: number; y?: number };
    width?: number;
    height?: number;
    style?: { width?: number | string; height?: number | string };
};

const parseGraphNodeDimension = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

export const resolveDirectionalGraphNavigationTarget = ({
    direction,
    nodes,
    focusedMessageId,
    fallbackPoint,
}: {
    direction: GraphNavigationDirection;
    nodes: readonly DirectionalGraphNavigationNode[];
    focusedMessageId: string | null;
    fallbackPoint: { x: number; y: number };
}): { messageId: string; centerMessageId: string; nodeId: string } | null => {
    const candidates = nodes
        .map((node) => {
            const target = resolveReactFlowNodeClickFocusTarget({
                nodeType: node.type,
                entity: node.data?.entity,
                nodeId: node.id,
            });
            if (!target.messageId || !target.centerMessageId) return null;
            const width = parseGraphNodeDimension(node.width)
                ?? parseGraphNodeDimension(node.style?.width)
                ?? ACTIVE_GRAPH_WINDOW_FALLBACK_NODE_WIDTH;
            const height = parseGraphNodeDimension(node.height)
                ?? parseGraphNodeDimension(node.style?.height)
                ?? ACTIVE_GRAPH_WINDOW_FALLBACK_NODE_HEIGHT;
            const left = Number(node.position?.x ?? 0);
            const top = Number(node.position?.y ?? 0);
            return {
                nodeId: node.id,
                messageId: target.messageId,
                centerMessageId: target.centerMessageId,
                centerX: left + width / 2,
                centerY: top + height / 2,
            };
        })
        .filter((candidate): candidate is {
            nodeId: string;
            messageId: string;
            centerMessageId: string;
            centerX: number;
            centerY: number;
        } => Boolean(candidate));

    if (candidates.length === 0) return null;

    const current = focusedMessageId
        ? candidates.find((candidate) => candidate.messageId === focusedMessageId || candidate.centerMessageId === focusedMessageId) ?? null
        : null;
    const anchor = current
        ? { x: current.centerX, y: current.centerY, nodeId: current.nodeId }
        : { ...fallbackPoint, nodeId: null };

    let best: (typeof candidates)[number] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        if (candidate.nodeId === anchor.nodeId) continue;
        const dx = candidate.centerX - anchor.x;
        const dy = candidate.centerY - anchor.y;
        const primary = direction === 'left'
            ? -dx
            : direction === 'right'
                ? dx
                : direction === 'up'
                    ? -dy
                    : dy;
        if (primary <= 8) continue;
        const cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
        const score = primary + cross * 1.75;
        if (score < bestScore) {
            best = candidate;
            bestScore = score;
        }
    }

    return best
        ? { messageId: best.messageId, centerMessageId: best.centerMessageId, nodeId: best.nodeId }
        : null;
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

const THREAD_ACCENT_COLORS = ['#4f8dd8', '#4f9f75', '#8b6fd6', '#c47a32', '#ba6d92', '#3d9f97'];

function GraphThreadIcon({ className, strokeWidth = 2 }: { className?: string; strokeWidth?: number }) {
    return (
        <svg
            className={className}
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

const getThreadAccentColor = (threadRootId: string): string => {
    let hash = 0;
    for (let index = 0; index < threadRootId.length; index += 1) {
        hash = (hash * 31 + threadRootId.charCodeAt(index)) >>> 0;
    }
    return THREAD_ACCENT_COLORS[hash % THREAD_ACCENT_COLORS.length];
};

function ThreadBandOverlay({
    bands,
    currentThreadRootId,
    threadItems,
}: {
    bands: ThreadBand[];
    currentThreadRootId: string | null;
    threadItems: ThreadNavigationItem[];
}) {
    const { transform, flowWidth, flowHeight } = useStore((state) => ({
        transform: state.transform,
        flowWidth: state.width,
        flowHeight: state.height,
    }));

    if (bands.length === 0 || flowWidth <= 0 || flowHeight <= 0) return null;

    const [translateX, translateY, zoom] = transform;
    const threadLabelById = new Map(threadItems.map((thread) => [thread.threadRootId, thread.label]));
    return (
        <div className="pointer-events-none absolute inset-0 z-[1] overflow-hidden antialiased" aria-hidden="true">
            {bands.map((band, index) => {
                const screenLeft = band.left * zoom + translateX;
                const screenRight = band.right * zoom + translateX;
                const screenTop = band.top * zoom + translateY;
                const screenBottom = band.bottom * zoom + translateY;
                const width = Math.max(1, screenRight - screenLeft);
                const height = Math.max(1, screenBottom - screenTop);
                const isCurrent = currentThreadRootId === band.threadRootId;
                const hasCurrentThread = Boolean(currentThreadRootId);
                const accentColor = getThreadAccentColor(band.threadRootId);
                const label = threadLabelById.get(band.threadRootId) ?? `Thread ${index + 1}`;
                const edgeInset = Math.min(32, Math.max(4, height * 0.08));
                const radius = Math.min(18, Math.max(4, 18 * zoom));
                const labelTop = Math.max(10, Math.min(flowHeight - 34, screenTop + 10));
                const labelLeft = Math.max(12, Math.min(flowWidth - 172, screenLeft + 12));

                if (screenRight < -96 || screenLeft > flowWidth + 96 || screenBottom < -96 || screenTop > flowHeight + 96) {
                    return null;
                }

                return (
                    <React.Fragment key={band.id}>
                        <div
                            className={cn(
                                "absolute top-0 overflow-hidden rounded-[18px] border transition-[opacity,background-color,border-color,box-shadow] duration-300",
                                isCurrent
                                    ? "opacity-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.42),0_18px_40px_-34px_rgba(15,23,42,0.45)] dark:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.5)]"
                                    : "opacity-90"
                            )}
                            style={{
                                width,
                                height,
                                borderRadius: radius,
                                borderColor: `${accentColor}${isCurrent ? '30' : '18'}`,
                                background: `linear-gradient(90deg, ${accentColor}${isCurrent ? '14' : '0A'}, transparent 20%, transparent 80%, ${accentColor}08)`,
                                transform: `translate3d(${screenLeft}px, ${screenTop}px, 0)`,
                            }}
                        >
                            <div
                                className="absolute left-0 w-[3px] rounded-full"
                                style={{
                                    top: edgeInset,
                                    bottom: edgeInset,
                                    background: `linear-gradient(180deg, transparent, ${accentColor}A8 18%, ${accentColor}A8 82%, transparent)`,
                                }}
                            />
                            <div
                                className="absolute right-0 w-px border-r border-dashed"
                                style={{
                                    top: edgeInset,
                                    bottom: edgeInset,
                                    borderColor: `${accentColor}45`,
                                }}
                            />
                            {hasCurrentThread && !isCurrent ? (
                                <div className="absolute inset-0 bg-[hsl(var(--background)/0.18)] backdrop-saturate-[0.72] dark:bg-slate-950/10" />
                            ) : null}
                        </div>
                        <div
                            className={cn(
                                "absolute flex max-w-[160px] items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold leading-none shadow-sm backdrop-blur-md transition-opacity duration-300",
                                isCurrent
                                    ? "bg-[hsl(var(--app-panel)/0.88)] text-foreground opacity-100"
                                    : "bg-[hsl(var(--app-panel)/0.68)] text-muted-foreground opacity-75"
                            )}
                            style={{
                                borderColor: `${accentColor}${isCurrent ? '55' : '2C'}`,
                                color: isCurrent ? accentColor : undefined,
                                transform: `translate3d(${labelLeft}px, ${labelTop}px, 0)`,
                            }}
                        >
                            <GraphThreadIcon className="h-3 w-3 shrink-0" strokeWidth={2.2} />
                            <span className="truncate">{isCurrent ? 'Current thread' : label}</span>
                        </div>
                    </React.Fragment>
                );
            })}
        </div>
    );
}

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
    onThreadNavigationModelChange?: (model: WorkspaceThreadNavigationModel | null) => void;
}

const GRAPH_DIAGNOSTIC_MAX_OVERLAPS = 200;
const GRAPH_DIAGNOSTIC_MAX_MEASURE_EVENTS = 160;
const GRAPH_DIAGNOSTIC_STALE_HEIGHT_EPSILON = 4;
export const GRAPH_MIN_ZOOM = 0.2;
const GRAPH_MAX_ZOOM = 1.0;

export const clampGraphZoom = (zoom: number): number => (
    Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, zoom))
);

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
    onThreadNavigationModelChange,
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
    const disabledSummaryIds = useWorkspaceStore(state => state.disabledSummaryIds);
    const toggleSummaryDisabled = useWorkspaceStore(state => state.toggleSummaryDisabled);
    const composerContextPreview = useWorkspaceStore(state => state.composerContextPreview);
    const setThreadComposerTarget = useWorkspaceStore(state => state.setThreadComposerTarget);
    const composerDraftByWorkspace = useWorkspaceStore(state => state.composerDraftByWorkspace);

    // Insights
    const insights = useWorkspaceStore(state => state.insights);
    const insightCandidates = useWorkspaceStore(state => state.insightCandidates);
    const insightsEnabled = useWorkspaceStore(state => state.insightsEnabled);
    const insightsVisible = useWorkspaceStore(state => state.insightsVisible);
    const showInsightsInGraph = useWorkspaceStore(state => state.showInsightsInGraph);
    const toggleInsightsEnabled = useWorkspaceStore(state => state.toggleInsightsEnabled);
    const toggleInsightsVisible = useWorkspaceStore(state => state.toggleInsightsVisible);
    const toggleShowInsightsInGraph = useWorkspaceStore(state => state.toggleShowInsightsInGraph);
    const mergeSession = useIntegrationStore((state) => state.session);
    const mergeAttentionNonce = useIntegrationStore((state) => state.mergeTabAttentionNonce);
    const mergeSourceCount = mergeSession?.sources.length ?? 0;
    const mergeRunIndicator = getMergeTabRunIndicator(mergeSession);
    const runningCount = useRunStatusStore((state) => state.getRunningCount(selectedWorkspaceId));
    const activeRunStatusNodeIdKey = useRunStatusStore((state) => (
        Object.values(state.byNodeId)
            .filter((entry) => {
                if (selectedWorkspaceId && entry.workspaceId !== selectedWorkspaceId) return false;
                if (entry.role !== 'assistant') return false;
                if (!entry.status) return false;
                return isActiveAgentStatus(entry.status);
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
    const graphResetNonce = 0;
    const [subgraphRootNodeId, setSubgraphRootNodeId] = useState<string | null>(null);
    const initialThreadState = useMemo(() => readGraphThreadState(selectedWorkspaceId), [selectedWorkspaceId]);
    const [activeThreadRootId, setActiveThreadRootId] = useState<string | null>(initialThreadState.activeThreadRootId);
    const [doneThreadRootIds, setDoneThreadRootIds] = useState<Set<string>>(initialThreadState.doneThreadRootIds);
    const [doneThreadsCollapsed, setDoneThreadsCollapsed] = useState(initialThreadState.doneThreadsCollapsed);
    const [threadBarCollapsed, setThreadBarCollapsed] = useState(initialThreadState.threadBarCollapsed);
    const [lastVisitedAtByThreadRootId, setLastVisitedAtByThreadRootId] = useState<Map<string, number>>(
        initialThreadState.lastVisitedAtByThreadRootId
    );
    const [hiddenSubgraphRootIds, setHiddenSubgraphRootIds] = useState<Set<string>>(() => new Set());
    const [convertedSubgraphThreadRootIds, setConvertedSubgraphThreadRootIds] = useState<Set<string>>(
        () => readConvertedSubgraphThreadRootIds(selectedWorkspaceId)
    );
    const previousUserMessageCountsByThreadRootIdRef = useRef<Map<string, number> | null>(null);
    const lastClosedThreadRootIdsRef = useRef<string[]>([]);

    useEffect(() => {
        const state = readGraphThreadState(selectedWorkspaceId);
        setActiveThreadRootId(state.activeThreadRootId);
        setDoneThreadRootIds(state.doneThreadRootIds);
        setDoneThreadsCollapsed(state.doneThreadsCollapsed);
        setThreadBarCollapsed(state.threadBarCollapsed);
        setLastVisitedAtByThreadRootId(state.lastVisitedAtByThreadRootId);
        setHiddenSubgraphRootIds(new Set());
        setConvertedSubgraphThreadRootIds(readConvertedSubgraphThreadRootIds(selectedWorkspaceId));
        setSubgraphRootNodeId(null);
        previousUserMessageCountsByThreadRootIdRef.current = null;
        lastClosedThreadRootIdsRef.current = [];
    }, [selectedWorkspaceId]);

    // ─────────────────────────────────────────────────────────────────────────
    // DATA QUERIES
    // ─────────────────────────────────────────────────────────────────────────
    const graphSnapshotQuery = useGraphSnapshot(selectedWorkspaceId || null, graphResetNonce);
    const shouldHydrateFullMessages = graphSnapshotQuery.isSuccess || graphSnapshotQuery.isError;
    const messagesQuery = useMessages(selectedWorkspaceId || '');
    const localNodesQuery = useLocalNodes(selectedWorkspaceId || null, {
        enabled: messagesQuery.isSuccess || messagesQuery.isError,
    });
    const threadSessionsQuery = useThreadSessions(selectedWorkspaceId || null);
    const createThreadSession = useCreateThreadSession();
    const summariesQuery = useSummaries(selectedWorkspaceId || '', { enabled: shouldHydrateFullMessages && !agentClient.hasRuntime() });
    const { data: workspacesData } = useWorkspaces();
    const workspaces = useMemo(() => workspacesData ?? [], [workspacesData]);
    const selectedWorkspace = useMemo(
        () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
        [workspaces, selectedWorkspaceId]
    );
    const { data: allModelsData } = useModels();
    const allModels = useMemo(() => allModelsData ?? [], [allModelsData]);
    const { data: agentsData } = useAgents();
    const agents = useMemo(() => agentsData ?? [], [agentsData]);
    const { data: branchPointersData } = useBranches(selectedWorkspaceId || null);
    const branchPointers = useMemo(() => branchPointersData ?? [], [branchPointersData]);
    const workspaceRepoMap = useMemo(() => {
        return new Map(workspaces.map(c => [c.id, c.git_repo_path ?? c.folderPath ?? null]));
    }, [workspaces]);
    const localCommitGraphRepoPath = selectedWorkspaceId ? workspaceRepoMap.get(selectedWorkspaceId) ?? null : null;
    // Stable references for messages and summaries
    const snapshotSummaries = useMemo(() => graphSnapshotToSummaries(graphSnapshotQuery.data), [graphSnapshotQuery.data]);
    const localCommitGraphQuery = useQuery({
        queryKey: ['local-commit-graph', selectedWorkspaceId, localCommitGraphRepoPath],
        // Read-only: render from cached/local state immediately. The heavy
        // parent-closure repair runs in the background (see effect below) so it
        // never blocks the graph from painting or stalls pan/zoom.
        queryFn: async () => {
            if (!selectedWorkspaceId) return { commits: [], commitParents: [], commitObservations: [] };
            const startedAt = performance.now();
            const graph = await agentClient.listLocalCommitGraph(selectedWorkspaceId);
            recordPerfEvent('query.local-commit-graph.read', {
                elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                workspaceId: selectedWorkspaceId,
                repoPathPresent: Boolean(localCommitGraphRepoPath),
                repaired: false,
                commitCount: graph.commits.length,
                parentCount: graph.commitParents.length,
                observationCount: graph.commitObservations.length,
            }, {
                source: 'GraphView',
                durationMs: Number((performance.now() - startedAt).toFixed(2)),
            });
            return graph;
        },
        enabled: Boolean(selectedWorkspaceId && agentClient.hasRuntime()),
        staleTime: 5_000,
        gcTime: 5 * 60 * 1000,
    });
    const localCommitGraph = localCommitGraphQuery.data;
    // Reconcile the local commit graph (parent-closure backfill) in the
    // background. Keyed on dataUpdatedAt so it runs after the initial read and
    // after every refresh trigger (workspace switch, agent finalize, manual
    // refresh). The scheduler single-flights and only forces a re-read when it
    // actually imported commits, so no-op passes cost no React work.
    const localCommitGraphDataUpdatedAt = localCommitGraphQuery.dataUpdatedAt;
    useEffect(() => {
        if (!selectedWorkspaceId || !localCommitGraphRepoPath) return;
        ensureLocalCommitGraphRepaired(queryClient, selectedWorkspaceId, localCommitGraphRepoPath, {
            reason: 'graph-commit-reconcile',
        });
    }, [queryClient, selectedWorkspaceId, localCommitGraphRepoPath, localCommitGraphDataUpdatedAt]);
    const snapshotCommits = useMemo(() => {
        if (agentClient.hasRuntime()) {
            return (localCommitGraph?.commits ?? []).map((commit) => mapLocalCommitToCommitEntity(commit, selectedWorkspaceId ?? ''));
        }
        return graphSnapshotQuery.data?.commits ?? [];
    }, [graphSnapshotQuery.data?.commits, localCommitGraph?.commits, selectedWorkspaceId]);
    const snapshotCommitParents = useMemo(() => {
        if (agentClient.hasRuntime()) {
            return (localCommitGraph?.commitParents ?? []).map((parent) => ({
                child_sha: parent.childSha,
                parent_sha: parent.parentSha,
                parent_index: parent.parentIndex,
            }));
        }
        return graphSnapshotQuery.data?.commitParents ?? [];
    }, [graphSnapshotQuery.data?.commitParents, localCommitGraph?.commitParents]);
    const snapshotCommitObservations = useMemo(() => {
        if (agentClient.hasRuntime()) {
            return (localCommitGraph?.commitObservations ?? []).map((observation) => ({
                commit_sha: observation.commitSha,
                git_ref: observation.gitRef ?? null,
                source_kind: observation.sourceKind ?? 'unknown',
                first_seen_at: observation.firstSeenAt ?? undefined,
                last_seen_at: observation.lastSeenAt ?? undefined,
            }));
        }
        return graphSnapshotQuery.data?.commitObservations ?? [];
    }, [graphSnapshotQuery.data?.commitObservations, localCommitGraph?.commitObservations]);
    const persistedGraphMessages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);
    const storeMessages = useGraphMessages(selectedWorkspaceId, persistedGraphMessages, localNodesQuery.data);
    const summaries = useMemo(() => summariesQuery.data ?? snapshotSummaries, [snapshotSummaries, summariesQuery.data]);
    const graphUsingSnapshot = false;
    const [viewMode, setViewMode] = useState<ViewMode>('branch');
    const [branchViewActivationNonce, setBranchViewActivationNonce] = useState(0);
    const [executionTimelineOpen, setExecutionTimelineOpen] = useState(false);
    const handleExecutionTimelineOpenChange = useCallback((open: boolean) => {
        setExecutionTimelineOpen(open);
    }, []);

    const graphFocusedMessageIdRef = useRef<string | null>(storeFocusedMessageId);
    const isUserFocusSource = lastFocusSource === 'graph' || lastFocusSource === 'chat' || lastFocusSource === 'list';
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
	    const completedAssistantInsightSignal = useMemo(() => (
        (messages as Message[]).filter((message) => (
            message.role === 'assistant' &&
            (
                message.status === 'completed' ||
                message.execution_data?.last_terminal_status === 'completed' ||
                (!message.status && Boolean(message.content?.trim()))
            )
        )).length
    ), [messages]);
    const insightControls = useInsights(selectedWorkspaceId, completedAssistantInsightSignal, {
        enabled: agentClient.hasRuntime() && !messagesOverride && insightsEnabled,
        messages: messages as Message[],
        agents,
        workspace: selectedWorkspace,
    });
    const attentionByParentId = useMemo(() => {
        const surfacedCandidateIds = new Set(insights.map((insight) => insight.candidateId ?? insight.id));
        const itemsByParentId = new Map<string, AttentionBadgeItem[]>();
        const pushItem = (parentNodeId: string | null | undefined, item: AttentionBadgeItem) => {
            if (!parentNodeId) return;
            const current = itemsByParentId.get(parentNodeId);
            if (current) {
                current.push(item);
            } else {
                itemsByParentId.set(parentNodeId, [item]);
            }
        };
        for (const insight of insights) {
            pushItem(insight.parentNodeId, {
                id: insight.id,
                kind: insight.agentType,
                label: insight.content,
                status: insight.status ?? 'surfaced',
                priority: insight.priority ?? insight.validationResults?.priority ?? null,
                source: 'insight',
            });
        }
        for (const candidate of insightCandidates) {
            if (candidate.status === 'dismissed') continue;
            if (surfacedCandidateIds.has(candidate.candidateId)) continue;
            pushItem(candidate.parentNodeId, {
                id: candidate.candidateId,
                kind: candidate.agentKind,
                label: candidate.claim,
                status: candidate.status,
                priority: candidate.priority ?? null,
                source: 'candidate',
            });
        }
        for (const [parentNodeId, items] of itemsByParentId) {
            itemsByParentId.set(parentNodeId, items.sort((left, right) => (
                (right.priority ?? 0) - (left.priority ?? 0)
            )));
        }
        return itemsByParentId;
    }, [insightCandidates, insights]);
    const attentionInboxCount = useMemo(() => (
        Array.from(attentionByParentId.values()).reduce((total, items) => total + items.length, 0)
    ), [attentionByParentId]);
    useEffect(() => {
        reconcileTerminalAgentRunsFromMessages(messages as Message[]);
    }, [messages]);
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

    const graphMessages = useMemo(() => {
        const branchPointerMessages = (messages as Message[]).map((message) => {
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
        });
        return applySubgraphThreadConversions({
            messages: branchPointerMessages,
            convertedRootIds: convertedSubgraphThreadRootIds,
        });
    }, [branchPointersByNodeId, convertedSubgraphThreadRootIds, messages]);
    useEffect(() => {
        if (!selectedWorkspaceId) return;
        const availableMessageIds = new Set((messages as Message[]).map((message) => message.id));
        setConvertedSubgraphThreadRootIds((current) => {
            const next = new Set(Array.from(current).filter((messageId) => availableMessageIds.has(messageId)));
            if (next.size === current.size) return current;
            rememberConvertedSubgraphThreadRootIds(selectedWorkspaceId, next);
            return next;
        });
    }, [messages, selectedWorkspaceId]);
    const hiddenGraphFilterCount = hiddenSubgraphRootIds.size;
    const persistedThreadSessions = useMemo(() => {
        const byId = new Map((graphSnapshotQuery.data?.threadSessions ?? []).map((thread) => [thread.id, thread]));
        for (const thread of threadSessionsQuery.data ?? []) {
            byId.set(thread.id, thread);
        }
        return Array.from(byId.values());
    }, [graphSnapshotQuery.data?.threadSessions, threadSessionsQuery.data]);
    const threadSessions = useMemo(() => {
        const merged = mergeThreadSessionsWithBackfills(
            deriveBackfilledThreadSessions(graphMessages as Message[], selectedWorkspaceId),
            persistedThreadSessions,
        );
        return merged.sort((left, right) => {
            const leftKey = threadSessionSortKey(left);
            const rightKey = threadSessionSortKey(right);
            if (leftKey.statusRank !== rightKey.statusRank) return leftKey.statusRank - rightKey.statusRank;
            if (leftKey.updatedAtMs !== rightKey.updatedAtMs) return rightKey.updatedAtMs - leftKey.updatedAtMs;
            return leftKey.id.localeCompare(rightKey.id);
        });
    }, [graphMessages, persistedThreadSessions, selectedWorkspaceId]);
    const emptyThreadRoot = useMemo(() => {
        if (!selectedWorkspaceId || (graphMessages as Message[]).length > 0 || threadSessions.length > 0) return null;
        return {
            threadRootId: getEmptyWorkspaceThreadRootId(selectedWorkspaceId),
            workspaceId: selectedWorkspaceId,
            createdAt: selectedWorkspace?.createdAt ?? selectedWorkspace?.updatedAt ?? null,
        };
    }, [graphMessages, selectedWorkspace?.createdAt, selectedWorkspace?.updatedAt, selectedWorkspaceId, threadSessions.length]);
    const syntheticThreadRoots = useMemo<Array<{ threadRootId: string; workspaceId: string; createdAt: string | null }>>(() => [], []);
    const threadRootIndex = useMemo(() => buildThreadRootIndex(graphMessages as Message[], {
        emptyThreadRootId: emptyThreadRoot?.threadRootId ?? null,
        syntheticThreadRootIds: syntheticThreadRoots.map((root) => root.threadRootId),
        threadSessions,
    }), [emptyThreadRoot?.threadRootId, graphMessages, syntheticThreadRoots, threadSessions]);
    const userMessageCountsByThreadRootId = useMemo(() => {
        const counts = new Map<string, number>();
        for (const message of graphMessages as Message[]) {
            if (message.role !== 'user') continue;
            const threadRootId = threadRootIndex.threadRootIdByMessageId.get(message.id);
            if (!threadRootId) continue;
            counts.set(threadRootId, (counts.get(threadRootId) ?? 0) + 1);
        }
        return counts;
    }, [graphMessages, threadRootIndex]);
    useEffect(() => {
        const previousCounts = previousUserMessageCountsByThreadRootIdRef.current;
        previousUserMessageCountsByThreadRootIdRef.current = userMessageCountsByThreadRootId;
        if (!previousCounts || doneThreadRootIds.size === 0) return;

        const reopenedThreadRootIds = resolveDoneThreadsReopenedByUserMessages({
            doneThreadRootIds,
            previousUserMessageCountsByThreadRootId: previousCounts,
            currentUserMessageCountsByThreadRootId: userMessageCountsByThreadRootId,
        });
        if (reopenedThreadRootIds.length === 0) return;

        const nextDoneThreadRootIds = new Set(doneThreadRootIds);
        for (const threadRootId of reopenedThreadRootIds) {
            nextDoneThreadRootIds.delete(threadRootId);
        }
        const nextActiveThreadRootId = reopenedThreadRootIds[0] ?? activeThreadRootId;
        setDoneThreadRootIds(nextDoneThreadRootIds);
        setActiveThreadRootId(nextActiveThreadRootId);
        rememberGraphThreadState(selectedWorkspaceId, {
            activeThreadRootId: nextActiveThreadRootId,
            doneThreadRootIds: nextDoneThreadRootIds,
            doneThreadsCollapsed,
            threadBarCollapsed,
            lastVisitedAtByThreadRootId,
        });
    }, [
        activeThreadRootId,
        doneThreadRootIds,
        doneThreadsCollapsed,
        lastVisitedAtByThreadRootId,
        selectedWorkspaceId,
        threadBarCollapsed,
        userMessageCountsByThreadRootId,
    ]);
    const emptyThreadDraftPreviewByRootId = useMemo(() => {
        const previews = new Map<string, string>();
        if (!selectedWorkspaceId) return previews;
        for (const threadRootId of threadRootIndex.threadRootIds) {
            const threadMessageIds = threadRootIndex.messageIdsByThreadRootId.get(threadRootId);
            if ((threadMessageIds?.size ?? 0) > 0) continue;
            const draftKey = buildComposerDraftKey(selectedWorkspaceId, threadRootId);
            const preview = draftKey ? getThreadDraftPreviewText(composerDraftByWorkspace[draftKey]) : null;
            if (preview) previews.set(threadRootId, preview);
        }
        return previews;
    }, [composerDraftByWorkspace, selectedWorkspaceId, threadRootIndex.messageIdsByThreadRootId, threadRootIndex.threadRootIds]);
    const draftThreadRootIds = useMemo(
        () => new Set(emptyThreadDraftPreviewByRootId.keys()),
        [emptyThreadDraftPreviewByRootId],
    );
    const blockingEmptyThreadRootId = useMemo(() => resolveBlockingEmptyThreadRootId({
        threadRootIds: threadRootIndex.threadRootIds,
        messageIdsByThreadRootId: threadRootIndex.messageIdsByThreadRootId,
        doneThreadRootIds,
        draftThreadRootIds,
    }), [doneThreadRootIds, draftThreadRootIds, threadRootIndex.messageIdsByThreadRootId, threadRootIndex.threadRootIds]);
    const createThreadDisabled = Boolean(blockingEmptyThreadRootId) || createThreadSession.isPending;
    const createThreadDisabledReason = blockingEmptyThreadRootId
        ? 'Finish the empty thread before starting another.'
        : createThreadSession.isPending
            ? 'Creating thread...'
            : undefined;
    const currentThreadRootId = useMemo(() => (
        subgraphRootNodeId ? threadRootIndex.threadRootIdByMessageId.get(subgraphRootNodeId) ?? null : null
    ), [subgraphRootNodeId, threadRootIndex]);
    const focusedThreadRootLookup = useMemo(() => (
        buildFocusedThreadRootLookup({
            messages: graphMessages as Message[],
            threadRootIndex,
        })
    ), [graphMessages, threadRootIndex]);
    const focusedThreadRootId = useMemo(() => (
        focusedMessageId ? focusedThreadRootLookup.get(focusedMessageId) ?? null : null
    ), [focusedMessageId, focusedThreadRootLookup]);
    const threadIndexItems = useMemo<ThreadNavigationItem[]>(() => {
        const messageById = new Map((graphMessages as Message[]).map((message) => [message.id, message]));
        const threadSessionById = new Map(threadSessions.map((thread) => [thread.id, thread]));
        const now = Date.now();
        const items = threadRootIndex.threadRootIds.map((threadRootId) => {
            const threadSession = threadSessionById.get(threadRootId) ?? null;
            const rootMessageId = threadRootIndex.rootMessageIdByThreadRootId.get(threadRootId) ?? threadRootId;
            const rootMessage = messageById.get(rootMessageId) ?? null;
            const threadMessageIds = Array.from(threadRootIndex.messageIdsByThreadRootId.get(threadRootId) ?? new Set<string>());
            const threadMessages = threadMessageIds
                .map((messageId) => messageById.get(messageId) ?? null)
                .filter((message): message is Message => Boolean(message));
            let lastUpdatedAt = 0;
            let turnCount = 0;
            let firstAssistantMessage: Message | null = null;
            const commitShas = new Set<string>();
            for (const message of threadMessages) {
                const ts = new Date(message.updatedAt || message.createdAt).getTime();
                if (Number.isFinite(ts) && ts > lastUpdatedAt) lastUpdatedAt = ts;
                if (message.role === 'user') turnCount += 1;
                if (message.role === 'assistant') {
                    if (!firstAssistantMessage) {
                        firstAssistantMessage = message;
                    } else {
                        const candidateTs = new Date(message.createdAt).getTime();
                        const currentTs = new Date(firstAssistantMessage.createdAt).getTime();
                        if (Number.isFinite(candidateTs) && (!Number.isFinite(currentTs) || candidateTs < currentTs)) {
                            firstAssistantMessage = message;
                        }
                    }
                }
                const outputCommitSha = getMessageOutputCommitSha(message);
                if (outputCommitSha) commitShas.add(outputCommitSha);
            }
            let runningThreadCount = 0;
            for (const messageId of threadMessageIds) {
                if (activeRunStatusNodeIds.has(messageId)) runningThreadCount += 1;
            }
            const awareness = getThreadAwarenessSummary({
                messages: threadMessages,
                lastVisitedAt: lastVisitedAtByThreadRootId.get(threadRootId) ?? 0,
            });
            const baseCommitSha = getMessageBaseCommitSha(rootMessage)
                ?? getMessageBaseCommitSha(firstAssistantMessage)
                ?? selectedWorkspace?.base_commit_sha
                ?? null;
            const commitCount = commitShas.size;
            const draftPreviewText = emptyThreadDraftPreviewByRootId.get(threadRootId) ?? null;
            const label = threadSession?.title?.trim() || (rootMessage
                ? cleanNodePreview(rootMessage.content || '') || rootMessage.aiLabel || 'Untitled thread'
                : 'New thread');
            const done = doneThreadRootIds.has(threadRootId);
            return {
                threadRootId,
                fullLabel: label,
                parentThreadId: threadSession?.parentThreadId ?? null,
                depth: 0,
                label: label.length > 56 ? `${label.slice(0, 56)}...` : label,
                turnCount,
                commitCount,
                baseCommitSha,
                updatedLabel: formatThreadUpdatedLabel(lastUpdatedAt || now, now),
                runningCount: runningThreadCount,
                hidden: false,
                done,
                current: activeThreadRootId === threadRootId,
                lastUpdatedAt: lastUpdatedAt || now,
                unreadCompletedLeafCount: activeThreadRootId === threadRootId || done ? 0 : awareness.unreadCompletedLeafCount,
                initialPreviewNodeId: awareness.initialPreviewNodeId,
                previewNodeIds: awareness.previewNodeIds,
                draftPreviewText,
            };
        });
        const itemById = new Map(items.map((item) => [item.threadRootId, item]));
        const childrenByParentId = new Map<string, ThreadNavigationItem[]>();
        const roots: ThreadNavigationItem[] = [];
        for (const item of items) {
            if (item.parentThreadId && itemById.has(item.parentThreadId)) {
                childrenByParentId.set(item.parentThreadId, [
                    ...(childrenByParentId.get(item.parentThreadId) ?? []),
                    item,
                ]);
            } else {
                roots.push(item);
            }
        }
        const ordered: ThreadNavigationItem[] = [];
        const visited = new Set<string>();
        const append = (item: ThreadNavigationItem, depth: number) => {
            if (visited.has(item.threadRootId)) return;
            visited.add(item.threadRootId);
            ordered.push({ ...item, depth });
            (childrenByParentId.get(item.threadRootId) ?? []).forEach((child) => append(child, depth + 1));
        };
        roots.forEach((item) => append(item, 0));
        items.forEach((item) => append(item, 0));
        return ordered;
    }, [activeRunStatusNodeIds, activeThreadRootId, doneThreadRootIds, emptyThreadDraftPreviewByRootId, graphMessages, lastVisitedAtByThreadRootId, selectedWorkspace?.base_commit_sha, threadRootIndex, threadSessions]);
    const markThreadVisited = useCallback((threadRootId: string, visitedAt = Date.now()) => {
        setLastVisitedAtByThreadRootId((current) => {
            const currentVisitedAt = current.get(threadRootId) ?? 0;
            if (currentVisitedAt >= visitedAt) return current;
            const next = new Map(current);
            next.set(threadRootId, visitedAt);
            rememberGraphThreadState(selectedWorkspaceId, {
                activeThreadRootId: threadRootId,
                doneThreadRootIds,
                doneThreadsCollapsed,
                threadBarCollapsed,
                lastVisitedAtByThreadRootId: next,
            });
            return next;
        });
    }, [doneThreadRootIds, doneThreadsCollapsed, selectedWorkspaceId, threadBarCollapsed]);
    useEffect(() => {
        if (!selectedWorkspaceId || threadRootIndex.threadRootIds.length === 0) return;
        const nextActiveThreadRootId = resolveInitialActiveThreadRootId({
            preferredThreadRootId: activeThreadRootId,
            threadRootIds: threadRootIndex.threadRootIds,
            threadItems: threadIndexItems,
        });
        if (nextActiveThreadRootId === activeThreadRootId) return;
        setActiveThreadRootId(nextActiveThreadRootId);
        rememberGraphThreadState(selectedWorkspaceId, {
            activeThreadRootId: nextActiveThreadRootId,
            doneThreadRootIds,
            doneThreadsCollapsed,
            threadBarCollapsed,
            lastVisitedAtByThreadRootId,
        });
    }, [
        activeThreadRootId,
        doneThreadRootIds,
        doneThreadsCollapsed,
        lastVisitedAtByThreadRootId,
        selectedWorkspaceId,
        threadBarCollapsed,
        threadIndexItems,
        threadRootIndex.threadRootIds,
    ]);
    const lastRecordedThreadVisitRef = useRef<string | null>(null);
    useEffect(() => {
        if (!selectedWorkspaceId || !activeThreadRootId) return;
        const visitKey = `${selectedWorkspaceId}:${activeThreadRootId}`;
        if (lastRecordedThreadVisitRef.current === visitKey) return;
        lastRecordedThreadVisitRef.current = visitKey;
        markThreadVisited(activeThreadRootId);
    }, [activeThreadRootId, markThreadVisited, selectedWorkspaceId]);
    const threadGraphScope = useMemo(() => resolveThreadGraphScope({
        messages: graphMessages as Message[],
        threadRootIndex,
        activeThreadRootId,
    }), [activeThreadRootId, graphMessages, threadRootIndex]);
    const activeEmptyThreadComposerKeyRef = useRef<string | null>(null);
    useEffect(() => {
        if (!selectedWorkspaceId || !threadGraphScope.activeThreadRootId) {
            activeEmptyThreadComposerKeyRef.current = null;
            return;
        }
        if (threadGraphScope.scopedMessageIds.size > 0) {
            activeEmptyThreadComposerKeyRef.current = null;
            return;
        }
        const emptyThreadKey = `${selectedWorkspaceId}:${threadGraphScope.activeThreadRootId}`;
        if (activeEmptyThreadComposerKeyRef.current === emptyThreadKey) return;
        activeEmptyThreadComposerKeyRef.current = emptyThreadKey;
        dispatchGraphComposerDockExpand();
        setThreadComposerTarget({
            workspaceId: selectedWorkspaceId,
            threadId: threadGraphScope.activeThreadRootId,
            reason: 'empty-thread',
            nonce: Date.now(),
        });
    }, [selectedWorkspaceId, setThreadComposerTarget, threadGraphScope.activeThreadRootId, threadGraphScope.scopedMessageIds.size]);
    const scopedGraphMessages = threadGraphScope.scopedMessages;
    const scopedSummaries = filterSummariesForThreadScope(summaries as Summary[], threadGraphScope);
    const hiddenThreadRootIdsForLayout = useMemo(
        () => getInactiveThreadRootIds(threadRootIndex.threadRootIds, threadGraphScope.activeThreadRootId),
        [threadGraphScope.activeThreadRootId, threadRootIndex.threadRootIds]
    );
    const hiddenConversationMessageIds = useMemo(() => getHiddenConversationMessageIds({
        messages: scopedGraphMessages,
        hiddenThreadRootIds: new Set(),
        hiddenSubgraphRootIds,
    }), [hiddenSubgraphRootIds, scopedGraphMessages]);
    const visibleGraphMessages = useMemo(() => (
        scopedGraphMessages.filter((message) => !hiddenConversationMessageIds.has(message.id))
    ), [hiddenConversationMessageIds, scopedGraphMessages]);
    const [activeHighlightPreview, setActiveHighlightPreview] = useState<HighlightNavigationItem | null>(null);
    const leafNodeNavigationItems = useMemo(() => (
        getLeafMessagesByRecency(visibleGraphMessages as Message[])
            .map((message) => toLeafNodeNavigationItem(message, agentLabelsById))
    ), [agentLabelsById, visibleGraphMessages]);
	    const allLeafNodeNavigationItems = useMemo(() => (
	        getLeafMessagesByRecency(graphMessages as Message[])
	            .map((message) => toLeafNodeNavigationItem(message, agentLabelsById))
	    ), [agentLabelsById, graphMessages]);
	    const highlightNavigationItems = useMemo(() => (
	        (graphMessages as Message[])
	            .flatMap(toHighlightNavigationItems)
	            .sort((left, right) => right.timestampLabel.localeCompare(left.timestampLabel))
	    ), [graphMessages]);
	    useEffect(() => {
	        if (!activeHighlightPreview) return;
	        if (highlightNavigationItems.some((item) => item.id === activeHighlightPreview.id)) return;
	        setActiveHighlightPreview(null);
	    }, [activeHighlightPreview, highlightNavigationItems]);
	    const graphNodeNavigationIds = useMemo(
        () => getGraphNodeNavigationIds(visibleGraphMessages as Message[]),
        [visibleGraphMessages],
    );
    const activeGraphComputationHold = runningCount > 0 || activeSendFlowFocus?.workspaceId === selectedWorkspaceId;
    const graphComputationMessagesRef = useRef<Message[]>(visibleGraphMessages as Message[]);
    const graphComputationMessages = useMemo(() => {
        const current = graphComputationMessagesRef.current;
        if (!activeGraphComputationHold) {
            graphComputationMessagesRef.current = visibleGraphMessages as Message[];
            recordFundamentalCounter('graph.computation-messages', {
                mode: 'live',
                messageCount: visibleGraphMessages.length,
                runningCount,
                activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            });
            return visibleGraphMessages as Message[];
        }

        if (!current || current.length === 0 || visibleGraphMessages.length !== current.length) {
            graphComputationMessagesRef.current = visibleGraphMessages as Message[];
            recordFundamentalCounter('graph.computation-messages', {
                mode: 'active-refresh',
                messageCount: visibleGraphMessages.length,
                previousMessageCount: current?.length ?? 0,
                runningCount,
                activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            });
            return visibleGraphMessages as Message[];
        }

        if (shouldRefreshHeldGraphMessagesForStructuralChange(current, visibleGraphMessages as Message[])) {
            graphComputationMessagesRef.current = visibleGraphMessages as Message[];
            recordFundamentalCounter('graph.computation-messages', {
                mode: 'active-refresh-structural',
                messageCount: visibleGraphMessages.length,
                previousMessageCount: current.length,
                runningCount,
                activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            });
            return visibleGraphMessages as Message[];
        }

        const activePinnedMessageIds = activePinnedMessageIdKey
            ? activePinnedMessageIdKey.split('|').filter(Boolean)
            : [];
        if (activePinnedMessageIds.length > 0) {
            const currentIds = new Set(current.map((message) => message.id));
            const incomingIds = new Set((visibleGraphMessages as Message[]).map((message) => message.id));
            const hasNewPinnedMessage = activePinnedMessageIds.some((id) => incomingIds.has(id) && !currentIds.has(id));
            if (hasNewPinnedMessage) {
                graphComputationMessagesRef.current = visibleGraphMessages as Message[];
                recordFundamentalCounter('graph.computation-messages', {
                    mode: 'active-refresh-pinned',
                    messageCount: visibleGraphMessages.length,
                    previousMessageCount: current.length,
                    pinnedMessageCount: activePinnedMessageIds.length,
                    runningCount,
                    activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
                });
                return visibleGraphMessages as Message[];
            }
        }

        recordFundamentalCounter('graph.computation-messages', {
            mode: 'active-held',
            messageCount: current.length,
            incomingMessageCount: visibleGraphMessages.length,
            runningCount,
            activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
        });
        return current;
    }, [activeGraphComputationHold, activePinnedMessageIdKey, activeSendFlowFocus?.workspaceId, visibleGraphMessages, runningCount, selectedWorkspaceId]);
    const graphProjectionMessagesRef = useRef<Message[]>(visibleGraphMessages as Message[]);
    const graphProjectionMessages = useMemo(() => {
        const current = graphProjectionMessagesRef.current;
        if (!activeGraphComputationHold) {
            graphProjectionMessagesRef.current = visibleGraphMessages as Message[];
            recordFundamentalCounter('graph.projection-messages', {
                mode: 'live',
                messageCount: visibleGraphMessages.length,
                runningCount,
                activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            });
            return visibleGraphMessages as Message[];
        }

        if (!current || current.length === 0 || visibleGraphMessages.length !== current.length) {
            graphProjectionMessagesRef.current = visibleGraphMessages as Message[];
            recordFundamentalCounter('graph.projection-messages', {
                mode: 'active-refresh',
                messageCount: visibleGraphMessages.length,
                previousMessageCount: current?.length ?? 0,
                runningCount,
                activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            });
            return visibleGraphMessages as Message[];
        }

        if (shouldRefreshHeldGraphMessagesForStructuralChange(current, visibleGraphMessages as Message[])) {
            graphProjectionMessagesRef.current = visibleGraphMessages as Message[];
            recordFundamentalCounter('graph.projection-messages', {
                mode: 'active-refresh-structural',
                messageCount: visibleGraphMessages.length,
                previousMessageCount: current.length,
                runningCount,
                activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            });
            return visibleGraphMessages as Message[];
        }

        const activePinnedMessageIds = activePinnedMessageIdKey
            ? activePinnedMessageIdKey.split('|').filter(Boolean)
            : [];
        if (activePinnedMessageIds.length > 0) {
            const currentIds = new Set(current.map((message) => message.id));
            const incomingIds = new Set((visibleGraphMessages as Message[]).map((message) => message.id));
            const hasNewPinnedMessage = activePinnedMessageIds.some((id) => incomingIds.has(id) && !currentIds.has(id));
            if (hasNewPinnedMessage) {
                graphProjectionMessagesRef.current = visibleGraphMessages as Message[];
                recordFundamentalCounter('graph.projection-messages', {
                    mode: 'active-refresh-pinned',
                    messageCount: visibleGraphMessages.length,
                    previousMessageCount: current.length,
                    pinnedMessageCount: activePinnedMessageIds.length,
                    runningCount,
                    activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
                });
                return visibleGraphMessages as Message[];
            }
        }

        recordFundamentalCounter('graph.projection-messages', {
            mode: 'active-held',
            messageCount: current.length,
            incomingMessageCount: visibleGraphMessages.length,
            runningCount,
            activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
        });
        return current;
    }, [activeGraphComputationHold, activePinnedMessageIdKey, activeSendFlowFocus?.workspaceId, visibleGraphMessages, runningCount, selectedWorkspaceId]);
    const contextPathMessageIdSet = useMemo(() => {
        if (!composerContextPreview || composerContextPreview.workspaceId !== selectedWorkspaceId) {
            return new Set<string>();
        }
        return buildComposerContextPathIds({
            parentId: composerContextPreview.parentId,
            messages: graphComputationMessages,
            contextParentId: composerContextPreview.contextParentId,
            contextPolicy: composerContextPreview.contextPolicy,
            contextStartId: composerContextPreview.contextStartId,
        });
    }, [composerContextPreview, graphComputationMessages, selectedWorkspaceId]);
    const contextPathMessageIds = useMemo(
        () => Array.from(contextPathMessageIdSet),
        [contextPathMessageIdSet]
    );
    const composerBaseCommitSha = composerContextPreview?.workspaceId === selectedWorkspaceId
        ? composerContextPreview.baseCommitSha
        : null;

    useEffect(() => {
        if (focusedIdOverride !== undefined || !selectedWorkspaceId) return;
        if (activeSendFlowFocus?.workspaceId === selectedWorkspaceId) return;

        const focusDecision = resolveThreadScopedDefaultFocus({
            focusedMessageId,
            lastFocusSource,
            lastFocusMetadata,
            rememberedFocusId: lastFocusedMessageByWorkspace[selectedWorkspaceId] ?? null,
            messages: scopedGraphMessages as Message[],
        });
        if (!focusDecision) return;

        dispatchFocus({
            messageId: focusDecision.messageId,
            source: 'system',
            metadata: {
                reason: focusDecision.reason,
            },
        });
    }, [
        dispatchFocus,
        focusedIdOverride,
        focusedMessageId,
        lastFocusMetadata,
        lastFocusSource,
        lastFocusedMessageByWorkspace,
        activeSendFlowFocus,
        scopedGraphMessages,
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
	    const deleteHighlightMutation = useDeleteHighlight();
	    const deleteThreadSessionMutation = useDeleteThreadSession();
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
    const [pendingShareNodeId, setPendingShareNodeId] = useState<string | null>(null);
    const [isEnablingShare, setIsEnablingShare] = useState(false);
    const [isIndexVisible, setIsIndexVisible] = useState(true);
    const [previewEdgeType, setPreviewEdgeType] = useState<GraphEdgeLegendId | null>(null);
    const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<Set<GraphEdgeLegendId>>(
        () => new Set(['conversation', 'context-break', 'git-parent'])
    );
    const [visibleNodeSections, setVisibleNodeSections] = useState<Set<GraphNodeSectionId>>(
        () => new Set(['conversation', 'commits'])
    );
    const [controlsHeight, setControlsHeight] = useState(0);
    const [measuredNodeHeights, setMeasuredNodeHeights] = useState<Map<string, number>>(() => EMPTY_MEASURED_NODE_HEIGHTS);
    const selectionAnchorIdRef = useRef<string | null>(null);
    const [isBulkDeleteAlertOpen, setIsBulkDeleteAlertOpen] = useState(false);
    const [bulkDeleteIds, setBulkDeleteIds] = useState<string[]>([]);
    const [bulkDeleteThreadRootId, setBulkDeleteThreadRootId] = useState<string | null>(null);
    const [bulkDeleteExplicitCommitShas, setBulkDeleteExplicitCommitShas] = useState<string[]>([]);
    const [removeCommitsFromGraph, setRemoveCommitsFromGraph] = useState(false);
    const [deletedGraphCommitShas, setDeletedGraphCommitShas] = useState<Set<string>>(() => new Set());
    const [bulkDeletePhase, setBulkDeletePhase] = useState<DeleteBranchDialogPhase>('idle');
    const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
    const [addCommitTargetId, setAddCommitTargetId] = useState<string | null>(null);
	    const [graphRenderHoldUntil, setGraphRenderHoldUntil] = useState(0);
	    const [graphComposerDockState, setGraphComposerDockStateLocal] = useState<GraphComposerDockState>(() => getGraphComposerDockState());

    useEffect(() => {
        setDeletedGraphCommitShas(readDeletedGraphCommitShas(selectedWorkspaceId));
    }, [selectedWorkspaceId]);

    useEffect(() => {
        const handleDockState = (event: Event) => {
            setGraphComposerDockStateLocal(
                event instanceof CustomEvent
                    ? event.detail
                    : getGraphComposerDockState()
            );
        };
        window.addEventListener(GRAPH_COMPOSER_DOCK_STATE_EVENT, handleDockState);
        return () => window.removeEventListener(GRAPH_COMPOSER_DOCK_STATE_EVENT, handleDockState);
    }, []);
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
    const scopedSnapshotCommitContext = useMemo(() => filterCommitContextForThreadScope({
        messages: graphProjectionMessages,
        scope: threadGraphScope,
        commits: visibleSnapshotCommits,
        commitParents: visibleSnapshotCommitParents,
        commitObservations: visibleSnapshotCommitObservations,
    }), [
        graphProjectionMessages,
        threadGraphScope,
        visibleSnapshotCommits,
        visibleSnapshotCommitParents,
        visibleSnapshotCommitObservations,
    ]);
    const scopedVisibleSnapshotCommits = scopedSnapshotCommitContext.commits;
    const scopedVisibleSnapshotCommitParents = scopedSnapshotCommitContext.commitParents;
    const scopedVisibleSnapshotCommitObservations = scopedSnapshotCommitContext.commitObservations;
    const repoPath = resolveLocalWorkspaceRepoPath(selectedWorkspace);
    const { runSync, isSyncing } = useGitSync(
        selectedWorkspaceId,
        repoPath
    );
    const { data: trackedRefs = [] } = useTrackedRefs(selectedWorkspaceId);
    const enabledTrackedGitRefs = useMemo(
        () => getEnabledTrackedGitRefs(trackedRefs),
        [trackedRefs]
    );
    const composerBaseSnapshotGitRefs = useMemo(
        () => getComposerBaseSnapshotGitRefs(enabledTrackedGitRefs),
        [enabledTrackedGitRefs]
    );
    const { data: gitRefSnapshot } = useGitRefSnapshot(repoPath, composerBaseSnapshotGitRefs);
    const trackedRefsNeedingSync = useMemo(
        () => getTrackedRefsNeedingSync(trackedRefs, gitRefSnapshot),
        [trackedRefs, gitRefSnapshot]
    );
    const newThreadLocalRefs = useMemo(() => (
        branchPointers
            .map((pointer) => {
                const commitSha = getBranchPointerCommitSha(pointer)?.trim();
                const gitRef = (pointer.git_ref ?? '').trim();
                if (!commitSha || !gitRef) return null;
                const shortName = (pointer.name ?? gitRef.replace(/^refs\/heads\//, '')).trim() || gitRef;
                return {
                    git_ref: gitRef,
                    short_name: shortName,
                    commit_sha: commitSha,
                };
            })
            .filter((ref): ref is { git_ref: string; short_name: string; commit_sha: string } => Boolean(ref))
    ), [branchPointers]);
    const newThreadLiveRefs = useMemo(() => buildLiveGitRefs({
        refs: newThreadLocalRefs,
        trackedRefs,
        snapshot: gitRefSnapshot,
        includeHead: false,
    }), [gitRefSnapshot, newThreadLocalRefs, trackedRefs]);
    const defaultNewThreadBaseCommitSha = useMemo(() => resolveComposerDefaultBaseCommit({
        targetMode: 'new-thread',
        replyParentMessageId: null,
        selectedNodeId: null,
        messages: [],
        refs: newThreadLiveRefs.refs,
        trackedRefs: newThreadLiveRefs.trackedRefs,
        workspaceBaseCommitSha: selectedWorkspace?.base_commit_sha ?? null,
    }).sha, [newThreadLiveRefs.refs, newThreadLiveRefs.trackedRefs, selectedWorkspace?.base_commit_sha]);
    const pinnedCommitShas = useMemo(() => {
        const shas = new Set<string>();
        for (const pointer of branchPointers) {
            const commitSha = getBranchPointerCommitSha(pointer)?.trim();
            if (commitSha) shas.add(commitSha);
        }
        for (const commitSha of newThreadLiveRefs.tipByRef.values()) {
            const normalized = commitSha?.trim();
            if (normalized) shas.add(normalized);
        }
        return shas;
    }, [branchPointers, newThreadLiveRefs.tipByRef]);
    const pendingTrackedRefSyncKey = useMemo(() => trackedRefsNeedingSync
        .map((ref) => `${ref.git_ref}:${newThreadLiveRefs.tipByRef.get(ref.git_ref) ?? ''}`)
        .sort()
        .join('|'), [trackedRefsNeedingSync, newThreadLiveRefs.tipByRef]);
    const trackedRefSyncInFlightRef = useRef(false);
    const lastTrackedRefSyncSnapshotKeyRef = useRef<string | null>(null);
    const trackedRefSyncEligible = viewMode === 'branch' && !!selectedWorkspaceId && !!repoPath;

    // ─────────────────────────────────────────────────────────────────────────
    // REFS
    // ─────────────────────────────────────────────────────────────────────────
    const controlsRef = useRef<HTMLDivElement | null>(null);
    const centeredFocusIdRef = useRef<string | null>(null);
    const previousViewModeRef = useRef<ViewMode>(viewMode);
    const layoutNodesRef = useRef<Node<any>[]>([]);
    const fullGraphViewportBoundsRef = useRef<ReturnType<typeof buildFullGraphViewportBoundsModel>>(null);
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
    const [activeGraphWindowViewportVersion, setActiveGraphWindowViewportVersion] = useState(0);
    const viewportMoveStartedAtRef = useRef<number | null>(null);
    const isViewportInteractingRef = useRef(false);
    const viewportInteractionStaleTimeoutRef = useRef<number | null>(null);
    const isViewportPointerDownRef = useRef(false);
    const viewportDragIdRef = useRef<string | null>(null);
    const viewportPointerDownAtRef = useRef<number | null>(null);
    const viewportPointerUpAtRef = useRef<number | null>(null);
    const viewportDragStartViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
    const viewportByThreadRootIdRef = useRef(new Map<string, { x: number; y: number; zoom: number }>());
    const threadSwitchStartedAtRef = useRef<number | null>(null);
    const threadSwitchTargetRef = useRef<string | null>(null);
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
    const programmaticFocusCenterActiveRef = useRef(false);
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
    const [graphDetailZoomBucket, setGraphDetailZoomBucket] = useState<GraphNodeDetailZoomBucket>(() => getGraphNodeDetailZoomBucket(1));
    const [graphDetailViewportVersion, setGraphDetailViewportVersion] = useState(0);
    const graphDetailZoomBucketRef = useRef(graphDetailZoomBucket);
    const graphDetailZoomUpdateTimeoutRef = useRef<number | null>(null);
    const clampViewportToGraphBounds = useCallback((viewport: { x: number; y: number; zoom: number }) => {
        const canvas = branchCanvasRef.current;
        if (!canvas) return viewport;
        return clampGraphViewportToFullGraphBoundsModel(viewport, fullGraphViewportBoundsRef.current, {
            width: canvas.clientWidth,
            height: canvas.clientHeight,
        });
    }, []);

    const saveViewportForActiveThread = useCallback((viewportOverride?: { x: number; y: number; zoom: number }) => {
        const threadRootId = threadGraphScope.activeThreadRootId;
        if (!threadRootId) return;
        viewportByThreadRootIdRef.current.set(threadRootId, viewportOverride ?? reactFlowInstance.getViewport());
    }, [reactFlowInstance, threadGraphScope.activeThreadRootId]);

    const restoreViewportForActiveThread = useCallback(() => {
        const threadRootId = threadGraphScope.activeThreadRootId;
        if (!threadRootId) return;
        const savedViewport = viewportByThreadRootIdRef.current.get(threadRootId);
        if (!savedViewport) return;
        window.requestAnimationFrame(() => {
            reactFlowInstance.setViewport(clampViewportToGraphBounds(savedViewport), { duration: 0 });
        });
    }, [clampViewportToGraphBounds, reactFlowInstance, threadGraphScope.activeThreadRootId]);

    useEffect(() => {
        graphDetailZoomBucketRef.current = graphDetailZoomBucket;
    }, [graphDetailZoomBucket]);

    const scheduleGraphDetailZoomBucketUpdate = useCallback((delayMs = 120) => {
        if (graphDetailZoomUpdateTimeoutRef.current !== null) {
            window.clearTimeout(graphDetailZoomUpdateTimeoutRef.current);
        }
        graphDetailZoomUpdateTimeoutRef.current = window.setTimeout(() => {
            graphDetailZoomUpdateTimeoutRef.current = null;
            const nextBucket = getGraphNodeDetailZoomBucket(reactFlowInstance.getZoom());
            if (graphDetailZoomBucketRef.current !== nextBucket) {
                graphDetailZoomBucketRef.current = nextBucket;
                setGraphDetailZoomBucket(nextBucket);
            }
            setGraphDetailViewportVersion((version) => version + 1);
        }, delayMs);
    }, [reactFlowInstance]);

    useEffect(() => {
        return () => {
            if (graphDetailZoomUpdateTimeoutRef.current !== null) {
                window.clearTimeout(graphDetailZoomUpdateTimeoutRef.current);
                graphDetailZoomUpdateTimeoutRef.current = null;
            }
        };
    }, []);

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
        window.dispatchEvent(new CustomEvent(
            interacting
                ? 'agentree:graph-viewport-interaction-start'
                : 'agentree:graph-viewport-interaction-end'
        ));
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    // CUSTOM HOOKS
    // ─────────────────────────────────────────────────────────────────────────
    const graphFilterStorageKey = selectedWorkspaceId
        ? `agentree.graphFilters.v1.workspace.${selectedWorkspaceId}`
        : 'agentree.graphFilters.v1.workspace.none';
    const tagFilter = useTagFilter(graphComputationMessages, branchPointers, graphFilterStorageKey);
    const subgraphMessageIds = useMemo(
        () => getSubgraphMessageIds(graphComputationMessages, subgraphRootNodeId),
        [graphComputationMessages, subgraphRootNodeId]
    );
    const subgraphRootMessage = useMemo(() => {
        if (!subgraphRootNodeId) return null;
        return (graphComputationMessages as Message[]).find((message) => message.id === subgraphRootNodeId) ?? null;
    }, [graphComputationMessages, subgraphRootNodeId]);
    const subgraphRootLabel = useMemo(() => {
        if (!subgraphRootMessage) return 'Selected node';
        const preview = cleanNodePreview(subgraphRootMessage.content);
        if (preview) return preview.length > 72 ? `${preview.slice(0, 72)}...` : preview;
        return subgraphRootMessage.role === 'user' ? 'User node' : 'Assistant node';
    }, [subgraphRootMessage]);
    const subgraphFocusLabel = subgraphRootNodeId && currentThreadRootId === subgraphRootNodeId
        ? 'Thread'
        : 'Subgraph';
    const graphFilterState = useMemo(() => (
        createSubgraphFilterState(subgraphRootNodeId, subgraphMessageIds, {
            matchingMessageIds: tagFilter.matchingMessageIds,
            filterActive: tagFilter.filterActive,
            hasNodeTypeFilter: tagFilter.hasNodeTypeFilter,
            keepAncestors: tagFilter.keepAncestors,
            keepDescendants: tagFilter.keepDescendants,
        })
    ), [
        subgraphRootNodeId,
        tagFilter.filterActive,
        tagFilter.hasNodeTypeFilter,
        tagFilter.keepAncestors,
        tagFilter.keepDescendants,
        tagFilter.matchingMessageIds,
        subgraphMessageIds,
    ]);

    useEffect(() => {
        if (!subgraphRootNodeId) return;
        if (subgraphRootMessage) return;
        setSubgraphRootNodeId(null);
    }, [subgraphRootMessage, subgraphRootNodeId]);

    useEffect(() => {
        if (!shouldClearSubgraphForFocus(subgraphRootNodeId, subgraphMessageIds, focusedMessageId)) return;
        setSubgraphRootNodeId(null);
    }, [focusedMessageId, subgraphMessageIds, subgraphRootNodeId]);

    const graphNodeSectionCounts = useMemo<Record<GraphNodeSectionId, number>>(() => {
        const messageById = new Map((graphComputationMessages as Message[]).map((message) => [message.id, message]));
        let conversation = 0;
        let commits = 0;
        for (const message of graphComputationMessages as Message[]) {
            const nodeKind = classifyMessageNodeKind(message, messageById);
            if (nodeKind === 'commit_message') {
                commits += 1;
            } else {
                conversation += 1;
            }
            if (nodeKind === 'assistant_message' && getMessageOutputCommitSha(message)) {
                commits += 1;
            }
        }
        commits += scopedVisibleSnapshotCommits.length;
        return { conversation, commits };
    }, [graphComputationMessages, scopedVisibleSnapshotCommits.length]);
    const handleToggleNodeSection = useCallback((sectionId: GraphNodeSectionId) => {
        setVisibleNodeSections((previous) => {
            const next = new Set(previous);
            if (next.has(sectionId)) {
                if (next.size === 1) return previous;
                next.delete(sectionId);
            } else {
                next.add(sectionId);
            }
            return next;
        });
    }, []);
    const nodeSelection = useNodeSelection(graphComputationMessages);
    const openMergeSession = useIntegrationStore((state) => state.openMergeSession);
    const disabledSummaryIdsSet = useMemo(() => new Set(disabledSummaryIds), [disabledSummaryIds]);
    const threadHoverProjectionInput = useMemo(() => ({
        messages: graphMessages as Message[],
        summaries: summaries as Summary[],
        disabledSummaryIds: disabledSummaryIdsSet,
    }), [disabledSummaryIdsSet, graphMessages, summaries]);
	    const workspaceProjection = useWorkspaceProjection(
	        graphProjectionMessages,
	        scopedSummaries,
        focusedMessageId,
        disabledSummaryIdsSet,
        'graph',
        scopedVisibleSnapshotCommits,
        scopedVisibleSnapshotCommitParents,
        scopedVisibleSnapshotCommitObservations,
        emptyThreadRoot,
	        syntheticThreadRoots,
	        threadSessions,
	    );
    const executionTimelineProjection = useWorkspaceProjection(
        graphMessages as Message[],
        summaries as Summary[],
        focusedMessageId,
        disabledSummaryIdsSet,
        'execution-timeline',
        visibleSnapshotCommits,
        visibleSnapshotCommitParents,
        visibleSnapshotCommitObservations,
        emptyThreadRoot,
        syntheticThreadRoots,
        threadSessions,
    );
    const executionTimelineModel = useMemo(() => {
        const items = buildExecutionTimelineItems(executionTimelineProjection);
        return packExecutionTimelineItems(items);
    }, [executionTimelineProjection]);
    const handleMergeSelection = useCallback((selectionIds?: Iterable<string>) => {
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
            useIntegrationStore.getState().ensureMergeSession(selectedWorkspaceId, repoPath);
        }

        const mergeableMessages = messageIds
            .map((id) => (messages as Message[]).find((message: Message) => message.id === id))
            .map((message) => ({ message, commitSha: getMessageOutputCommitSha(message) }))
            .filter((item): item is { message: Message; commitSha: string } => !!item.message && !!item.commitSha);

        const incomingSources = mergeableMessages.map(({ message, commitSha }) => ({
            id: message.id,
            type: 'graph-node',
            label: message.aiLabel || message.content.slice(0, 50) || message.id.slice(0, 8),
            commitSha,
            nodeId: message.id,
        }));
        const latestIntegrationState = useIntegrationStore.getState();
        const prunePlan = getMergeSourcePrunePlan(
            latestIntegrationState.session?.sources ?? [],
            incomingSources,
            workspaceProjection.commitBySha
        );
        const { addSource, removeSource } = useIntegrationStore.getState();

        for (const sourceId of prunePlan.sourceIdsToRemove) {
            removeSource(sourceId);
        }

        let addedCount = 0;
        for (const source of prunePlan.sourcesToAdd) {
            const added = addSource(source);
            if (added) addedCount += 1;
        }

        const duplicateCount = prunePlan.skippedSources.length + (prunePlan.sourcesToAdd.length - addedCount);
        if (addedCount > 0) {
            const removedCount = prunePlan.sourceIdsToRemove.length;
            toast.success(
                'Added to merge panel',
                `${addedCount === 1 ? '1 commit added to merge sources.' : `${addedCount} commits added to merge sources.`}${removedCount > 0 ? ` ${removedCount === 1 ? '1 ancestor source was removed.' : `${removedCount} ancestor sources were removed.`}` : ''}`
            );
        }
        if (duplicateCount > 0) {
            toast.info(
                'Already covered',
                duplicateCount === 1 ? '1 commit was already represented by the selected sources.' : `${duplicateCount} commits were already represented by the selected sources.`
            );
        }
    }, [messages, selectedWorkspace, selectedWorkspaceId, toast, workspaceProjection.commitBySha]);

    const handleAddCommitShasToMergePanel = useCallback((commitShas: string[]) => {
        if (!selectedWorkspaceId) return;

        const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath;
        if (!repoPath) {
            toast.error('No repository', 'This workspace has no git repository');
            return;
        }

        const integrationState = useIntegrationStore.getState();
        if (!integrationState.session || integrationState.session.workspaceId !== selectedWorkspaceId || integrationState.session.repoPath !== repoPath) {
            useIntegrationStore.getState().ensureMergeSession(selectedWorkspaceId, repoPath);
        }

        const mergeableCommits = commitShas.map((sha) => ({
            sha,
            commit: workspaceProjection.commitBySha.get(sha) ?? null,
        }));

        const incomingSources = mergeableCommits.map(({ sha, commit }) => {
            const sourceNodeId = commit?.producedByNodeId ?? commit?.visualOwnerNodeId ?? undefined;
            return {
                id: sourceNodeId ?? sha,
                type: sourceNodeId ? 'graph-node' : 'sha',
                label: commit?.subject || commit?.shortSha || sha.slice(0, 8),
                commitSha: sha,
                nodeId: sourceNodeId,
            };
        });
        const latestIntegrationState = useIntegrationStore.getState();
        const prunePlan = getMergeSourcePrunePlan(
            latestIntegrationState.session?.sources ?? [],
            incomingSources,
            workspaceProjection.commitBySha
        );
        const { addSource, removeSource } = useIntegrationStore.getState();

        for (const sourceId of prunePlan.sourceIdsToRemove) {
            removeSource(sourceId);
        }

        let addedCount = 0;
        for (const source of prunePlan.sourcesToAdd) {
            const added = addSource(source);
            if (added) addedCount += 1;
        }

        const duplicateCount = prunePlan.skippedSources.length + (prunePlan.sourcesToAdd.length - addedCount);
        if (addedCount > 0) {
            const removedCount = prunePlan.sourceIdsToRemove.length;
            toast.success(
                'Added to merge panel',
                `${addedCount === 1 ? '1 commit added to merge sources.' : `${addedCount} commits added to merge sources.`}${removedCount > 0 ? ` ${removedCount === 1 ? '1 ancestor source was removed.' : `${removedCount} ancestor sources were removed.`}` : ''}`
            );
        }
        if (duplicateCount > 0) {
            toast.info(
                'Already covered',
                duplicateCount === 1 ? '1 commit was already represented by the selected sources.' : `${duplicateCount} commits were already represented by the selected sources.`
            );
        }
    }, [selectedWorkspace, selectedWorkspaceId, toast, workspaceProjection.commitBySha]);

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

    const handleNodeContextMenu = useCallback((id: string, event: React.MouseEvent) => {
        const selectedNodeIds = selectedNodeIdsRef.current;
        const targetIds = selectedNodeIds.has(id) ? Array.from(selectedNodeIds) : [id];
        setNodeContextMenu({
            x: event.clientX,
            y: event.clientY,
            targetIds,
        });
    }, []);

    const createAndCopyNodeShare = useCallback(async (
        nodeId: string,
        options: { bootstrapOnly?: boolean } = {},
    ) => {
        if (!selectedWorkspaceId) {
            throw new Error('Select a workspace before sharing a node.');
        }
        await flushWorkspaceCloudBootstrap(selectedWorkspaceId);
        if (!options.bootstrapOnly) {
            await flushWorkspaceCloudSync(selectedWorkspaceId);
        }
        const result = await createNodePublicShare.mutateAsync({
            workspaceId: selectedWorkspaceId,
            nodeId,
        });
        await writeClipboardText(getPublicShareUrl(result.share.publicId));
        toast.success('Public link copied', 'Anyone with the link can view this node and its descendants.');
    }, [createNodePublicShare, selectedWorkspaceId, toast]);

    const handleShareNode = useCallback(async (nodeId: string) => {
        if (!selectedWorkspaceId || !selectedWorkspace) {
            toast.error('No workspace selected', 'Select a workspace before sharing a node.');
            return;
        }
        if (createNodePublicShare.isPending || isEnablingShare) return;

        const cloudSyncEnabled = Boolean(
            selectedWorkspace.cloud_backup_enabled ?? selectedWorkspace.cloudBackupEnabled
        );
        if (!cloudSyncEnabled) {
            setPendingShareNodeId(nodeId);
            return;
        }

        try {
            await createAndCopyNodeShare(nodeId);
        } catch (error) {
            console.error('[GraphView] Failed to create public node share:', error);
            toast.error(
                'Unable to create link',
                error instanceof Error ? error.message : 'The node could not be synced and shared.',
            );
        }
    }, [createAndCopyNodeShare, createNodePublicShare.isPending, isEnablingShare, selectedWorkspace, selectedWorkspaceId, toast]);

    const confirmWorkspaceSyncAndShare = useCallback(async () => {
        if (!pendingShareNodeId || !selectedWorkspaceId) return;
        const cloudAccountId = useAuthStore.getState().user?.id;
        if (!cloudAccountId) {
            toast.error('Sign in required', 'Sign in to enable workspace sync.');
            return;
        }

        setIsEnablingShare(true);
        let workspaceWasEnabled = false;
        try {
            const enabledWorkspace = await workspaceApplication.enableCloudBackup(
                selectedWorkspaceId,
                cloudAccountId,
            );
            workspaceWasEnabled = true;
            queryClient.setQueriesData(
                { queryKey: ['workspaces'] },
                (current: any) => Array.isArray(current)
                    ? current.map((workspace) => workspace.id === enabledWorkspace.id ? enabledWorkspace : workspace)
                    : current,
            );
            const nodeId = pendingShareNodeId;
            await createAndCopyNodeShare(nodeId, { bootstrapOnly: true });
            queueLocalSyncFlush({ reason: 'workspace-bootstrap-shared' });
            setPendingShareNodeId(null);
        } catch (error) {
            console.error('[GraphView] Failed to enable sync and share node:', error);
            toast.error(
                'Unable to share node',
                error instanceof Error ? error.message : 'Workspace sync could not be enabled.',
            );
            if (workspaceWasEnabled) setPendingShareNodeId(null);
        } finally {
            setIsEnablingShare(false);
        }
    }, [createAndCopyNodeShare, pendingShareNodeId, queryClient, selectedWorkspaceId, toast]);

    const stopViewportInteraction = useCallback((viewportOverride?: { x: number; y: number; zoom: number }) => {
        if (!isViewportInteractingRef.current) return;

        isViewportInteractingRef.current = false;
        if (viewportInteractionStaleTimeoutRef.current !== null) {
            window.clearTimeout(viewportInteractionStaleTimeoutRef.current);
            viewportInteractionStaleTimeoutRef.current = null;
        }
        const startedAt = viewportMoveStartedAtRef.current;
        viewportMoveStartedAtRef.current = null;
        setViewportInteractingDomState(false);
        markGraphInteractionEnd('viewport-drag');

        const rawViewport = viewportOverride ?? reactFlowInstance.getViewport();
        const viewport = clampViewportToGraphBounds(rawViewport);
        if (
            viewport.x !== rawViewport.x ||
            viewport.y !== rawViewport.y ||
            viewport.zoom !== rawViewport.zoom
        ) {
            reactFlowInstance.setViewport(viewport, { duration: 120 });
        }
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
    }, [clampViewportToGraphBounds, reactFlowInstance, setViewportInteractingDomState]);

    const startViewportInteraction = useCallback((viewport: { x: number; y: number; zoom: number }) => {
        if (isViewportInteractingRef.current) return;

        programmaticFocusCenterActiveRef.current = false;
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
        reactFlowInstance.setViewport(clampViewportToGraphBounds({
            x: viewport.x + dx,
            y: viewport.y + dy,
            zoom: viewport.zoom,
        }));
    }, [clampViewportToGraphBounds, reactFlowInstance, reactFlowStore]);

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
            const nextZoom = clampGraphZoom(viewport.zoom * Math.pow(2, zoomDelta));
            if (d3Zoom && d3Selection) {
                d3Zoom.scaleTo(d3Selection, nextZoom, [pointerX, pointerY], event.nativeEvent);
            } else {
                const anchor = reactFlowInstance.screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                });
                reactFlowInstance.setViewport(clampViewportToGraphBounds({
                    x: pointerX - anchor.x * nextZoom,
                    y: pointerY - anchor.y * nextZoom,
                    zoom: nextZoom,
                }));
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
                reactFlowInstance.setViewport(clampViewportToGraphBounds({
                    x: viewport.x - event.deltaX * normalize * 0.5,
                    y: viewport.y - event.deltaY * normalize * 0.5,
                    zoom: viewport.zoom,
                }));
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
    }, [clampViewportToGraphBounds, ensureViewportInteractionStarted, reactFlowInstance, reactFlowStore, recordRootFallbackGeometry, stopViewportInteraction]);

    const clearFocusCenterTimers = useCallback(() => {
        programmaticFocusCenterActiveRef.current = false;
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
            focusMessageId?: string | null;
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

        const targetNode = layoutNodesRef.current.find((node) => (
            node.id === messageId ||
            (node.data as any)?.entity?.focusMessageId === messageId ||
            (node.data as any)?.entity?.messageId === messageId ||
            (node.data as any)?.commit?.sha === messageId ||
            ((node.data as any)?.group?.commitShas ?? []).includes(messageId)
        ));

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
        const finalViewport = clampViewportToGraphBounds({
            x: FOCUS_VIEWPORT_BAND_X * canvasWidth - nodeCenterX * targetZoom,
            y: FOCUS_VIEWPORT_BAND_Y * canvasHeight - nodeCenterY * targetZoom,
            zoom: targetZoom,
        });
        const deltaX = finalViewport.x - currentViewport.x;
        const deltaY = finalViewport.y - currentViewport.y;
        const viewportDistance = Math.hypot(deltaX, deltaY);
        const zoomDelta = Math.abs(targetZoom - currentZoom);
        const distanceProgress = Math.min(1, viewportDistance / FOCUS_DISTANCE_FOR_MAX_DURATION);
        const zoomProgress = Math.min(1, zoomDelta / 0.8);
        const animationProgress = Math.max(distanceProgress, zoomProgress);
        const activeFocusCenter = activeRunCount > 0 || activeSendFlowFocus?.workspaceId === selectedWorkspaceId;
        const animationDurationMs = activeFocusCenter
            ? 0
            : Math.round(
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

        const focusedMessageIdForEvent = triggerMetrics?.focusMessageId ?? messageId;

        centeredFocusIdRef.current = `${messageId}:${targetNode.id}`;
        clearFocusCenterTimers();
        recordPerfEvent('graph.focus-center.start', {
            interactionId: triggerMetrics?.interactionId ?? null,
            focusedMessageId: focusedMessageIdForEvent,
            centerMessageId: messageId,
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

        programmaticFocusCenterActiveRef.current = true;
        reactFlowInstance.setViewport(finalViewport, { duration: animationDurationMs });
        focusCenterFirstFrameRef.current = window.requestAnimationFrame(() => {
            const now = performance.now();
            recordPerfEvent('graph.focus-center.first-frame', {
                interactionId: triggerMetrics?.interactionId ?? null,
                focusedMessageId: focusedMessageIdForEvent,
                centerMessageId: messageId,
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
            programmaticFocusCenterActiveRef.current = false;
            recordPerfEvent('graph.focus-center.end', {
                focusedMessageId: focusedMessageIdForEvent,
                centerMessageId: messageId,
                targetNodeId: targetNode.id,
                zoom: reactFlowInstance.getZoom(),
                x: Number(reactFlowInstance.getViewport().x.toFixed(2)),
                y: Number(reactFlowInstance.getViewport().y.toFixed(2)),
                animationDurationMs,
            }, { source: 'GraphView' });
            normalizeReactFlowLayerGeometry(`focus-center-end:${messageId}`);
            if (!activeFocusCenter) {
                captureGraphGeometrySnapshot(`focus-center-end:${messageId}`);
            }
            focusCenterEndTimeoutRef.current = null;
        }, animationDurationMs + 40);
        return {
            targetNodeId: targetNode.id,
            animationDurationMs,
            viewportDistance: Number(viewportDistance.toFixed(2)),
            zoomDelta: Number(zoomDelta.toFixed(3)),
        };
    }, [activeSendFlowFocus?.workspaceId, captureGraphGeometrySnapshot, clampViewportToGraphBounds, clearFocusCenterTimers, normalizeReactFlowLayerGeometry, reactFlowInstance, selectedWorkspaceId, sendFlowGraphDiagFlags.disableGraphAutoCenter, viewMode]);

    const queueFocusedNodeCenter = useCallback((messageId: string, centerKey: string, options?: { respectImperativeCenter?: boolean }) => {
        if (viewMode !== 'branch') return;
        if (centeredFocusIdRef.current === centerKey) return;
        const isUserFocusSource = lastFocusSource === 'graph' || lastFocusSource === 'chat' || lastFocusSource === 'list';
        const focusFlowId = typeof lastFocusMetadata?.flowId === 'string' ? lastFocusMetadata.flowId : null;
        const isActiveGraphNodeClick =
            runningCount > 0 &&
            lastFocusSource === 'graph' &&
            lastFocusMetadata?.via === 'react-flow-node-click';
        const canUseLiveFocusedMessageId = isUserFocusSource && !isActiveGraphNodeClick;
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

    const handleFocusImpl = useCallback((id: string, triggerMetrics?: FocusTriggerMetrics & { centerMessageId?: string | null }) => {
        const centerMessageId = triggerMetrics?.centerMessageId ?? id;
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
            centerMessageId,
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
        const liveRunningCount = runningCountRef.current;
        const skipCentering = shouldSkipActiveGraphClickCentering({
            activeRunCount: liveRunningCount,
            activeSendFlowWorkspaceId: activeSendFlowFocus?.workspaceId,
            selectedWorkspaceId,
            triggerVia: triggerMetrics?.metadata?.via,
        });
        const centerResult = skipCentering
            ? null
            : centerFocusedNode(centerMessageId, {
                ...triggerMetrics,
                interactionId: interaction.id,
                allowDuringActiveRun: true,
                focusMessageId: id,
            });
        if (skipCentering) {
            recordPerfEvent('graph.focus-center.skipped', {
                interactionId: interaction.id,
                focusedMessageId: id,
                reason: 'active-graph-node-click',
                runningCount: liveRunningCount,
            }, { source: 'GraphView' });
        }
        if (centerResult) {
            imperativeCenteredMessageIdRef.current = id;
        }
        window.setTimeout(() => {
            markGraphInteractionEnd('graph-focus');
        }, (centerResult?.animationDurationMs ?? 220) + 140);
        if (deferredGraphFocusFrameRef.current !== null) {
            window.cancelAnimationFrame(deferredGraphFocusFrameRef.current);
        }
        const commitGraphFocusDispatch = (dispatchScheduledAt: number) => {
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
        };
        if (shouldDispatchGraphFocusSynchronously({
            activeRunCount: liveRunningCount,
            activeSendFlowWorkspaceId: activeSendFlowFocus?.workspaceId,
            selectedWorkspaceId,
        })) {
            commitGraphFocusDispatch(performance.now());
            deferredGraphFocusFrameRef.current = null;
            return;
        }
        deferredGraphFocusFrameRef.current = window.requestAnimationFrame(() => {
            commitGraphFocusDispatch(performance.now());
            deferredGraphFocusFrameRef.current = null;
        });
    }, [activeSendFlowFocus?.workspaceId, centerFocusedNode, dispatchFocus, nodeSelection.clearSelection, selectedWorkspaceId]);
    const handleFocus = useStableGraphCallback(handleFocusImpl);
    const graphNodeNavigationIndex = focusedMessageId ? graphNodeNavigationIds.indexOf(focusedMessageId) : -1;
    const previousGraphNodeId = graphNodeNavigationIndex > 0 ? graphNodeNavigationIds[graphNodeNavigationIndex - 1] : null;
    const nextGraphNodeId = graphNodeNavigationIndex >= 0 && graphNodeNavigationIndex < graphNodeNavigationIds.length - 1
        ? graphNodeNavigationIds[graphNodeNavigationIndex + 1]
        : null;
    const latestGraphNodeId = graphNodeNavigationIds[graphNodeNavigationIds.length - 1] ?? null;
    const canFocusLatestGraphNode = Boolean(latestGraphNodeId && latestGraphNodeId !== focusedMessageId);
    const handleFocusGraphNavigationNode = useCallback((messageId: string, action: 'previous-node' | 'next-node' | 'latest-node') => {
        handleFocus(messageId, {
            pointerDownAt: null,
            clickAt: performance.now(),
            metadata: {
                via: 'viewport-controls',
                action,
            },
        });
    }, [handleFocus]);
    const handleDirectionalGraphNavigation = useCallback((direction: GraphNavigationDirection) => {
        if (viewMode !== 'branch') return;
        const canvas = branchCanvasRef.current;
        const fallbackPoint = canvas
            ? reactFlowInstance.screenToFlowPosition({
                x: canvas.getBoundingClientRect().left + canvas.clientWidth / 2,
                y: canvas.getBoundingClientRect().top + canvas.clientHeight / 2,
            })
            : { x: 0, y: 0 };
        const target = resolveDirectionalGraphNavigationTarget({
            direction,
            nodes: layoutNodesRef.current,
            focusedMessageId,
            fallbackPoint,
        });
        if (!target) return;
        handleFocus(target.messageId, {
            centerMessageId: target.centerMessageId,
            pointerDownAt: null,
            clickAt: performance.now(),
            metadata: {
                via: 'keyboard',
                action: `navigate-${direction}`,
                targetNodeId: target.nodeId,
            },
        });
    }, [focusedMessageId, handleFocus, reactFlowInstance, viewMode]);

    const handleViewSubgraph = useCallback((messageId: string) => {
        setSubgraphRootNodeId(messageId);
        setViewMode('branch');
        nodeSelection.clearSelection();
        dispatchFocus({
            messageId,
            source: 'graph',
            metadata: { reason: 'view-subgraph' },
        });
    }, [dispatchFocus, nodeSelection.clearSelection]);

    const handleFocusThread = useCallback((threadRootId: string) => {
        const switchStartedAt = performance.now();
        threadSwitchStartedAtRef.current = switchStartedAt;
        threadSwitchTargetRef.current = threadRootId;
        recordPerfEvent('graph.thread-switch.start', {
            fromThreadRootId: threadGraphScope.activeThreadRootId,
            toThreadRootId: threadRootId,
        }, { source: 'GraphView' });
        saveViewportForActiveThread();
        const focusMessageId = resolveThreadDropdownSelection({
            threadRootId,
            messages: graphMessages as Message[],
        });
        if (threadGraphScope.activeThreadRootId && threadGraphScope.activeThreadRootId !== threadRootId) {
            markThreadVisited(threadGraphScope.activeThreadRootId);
        }
        setActiveThreadRootId(threadRootId);
        markThreadVisited(threadRootId);
        setViewMode('branch');
        nodeSelection.clearSelection();
        dispatchFocus({
            messageId: focusMessageId,
            source: 'graph',
            metadata: { reason: 'focus-thread' },
        });
    }, [
        dispatchFocus,
        doneThreadRootIds,
        doneThreadsCollapsed,
        graphMessages,
        markThreadVisited,
        nodeSelection.clearSelection,
        saveViewportForActiveThread,
        selectedWorkspaceId,
        threadGraphScope.activeThreadRootId,
    ]);

	    const handleLeafNodeFocus = useCallback((leafNodeId: string) => {
        const targetThreadRootId = resolveLeafNodeFocusThreadRootId({
            leafNodeId,
            focusedThreadRootLookup,
        });
        const activeThreadRootId = threadGraphScope.activeThreadRootId;
        const shouldSwitchThread = Boolean(targetThreadRootId && targetThreadRootId !== activeThreadRootId);

        if (shouldSwitchThread && targetThreadRootId) {
            const switchStartedAt = performance.now();
            threadSwitchStartedAtRef.current = switchStartedAt;
            threadSwitchTargetRef.current = targetThreadRootId;
            recordPerfEvent('graph.thread-switch.start', {
                fromThreadRootId: activeThreadRootId,
                toThreadRootId: targetThreadRootId,
                reason: 'leaf-node-focus',
            }, { source: 'GraphView' });
            saveViewportForActiveThread();
            if (activeThreadRootId) {
                markThreadVisited(activeThreadRootId);
            }
            setActiveThreadRootId(targetThreadRootId);
            markThreadVisited(targetThreadRootId);
            setViewMode('branch');
            nodeSelection.clearSelection();
        }

        handleFocus(leafNodeId, {
            pointerDownAt: null,
            clickAt: performance.now(),
            metadata: {
                via: 'leaf-node-dropdown',
                action: 'focus-leaf-node',
                targetThreadRootId,
                switchedThread: shouldSwitchThread,
            },
        });
    }, [
        focusedThreadRootLookup,
        handleFocus,
        markThreadVisited,
        nodeSelection.clearSelection,
        saveViewportForActiveThread,
	        threadGraphScope.activeThreadRootId,
	    ]);

	    const handleHighlightFocus = useCallback((item: HighlightNavigationItem) => {
	        const targetThreadRootId = resolveLeafNodeFocusThreadRootId({
	            leafNodeId: item.messageId,
	            focusedThreadRootLookup,
	        });
	        const activeThreadRootId = threadGraphScope.activeThreadRootId;
	        const shouldSwitchThread = Boolean(targetThreadRootId && targetThreadRootId !== activeThreadRootId);

	        if (shouldSwitchThread && targetThreadRootId) {
	            saveViewportForActiveThread();
	            if (activeThreadRootId) {
	                markThreadVisited(activeThreadRootId);
	            }
	            setActiveThreadRootId(targetThreadRootId);
	            markThreadVisited(targetThreadRootId);
	            setViewMode('branch');
	            nodeSelection.clearSelection();
	        }

	        setActiveHighlightPreview(item);
	        handleFocus(item.messageId, {
	            pointerDownAt: null,
	            clickAt: performance.now(),
	            metadata: {
	                via: 'highlight-dropdown',
	                highlightId: item.id,
	                targetThreadRootId,
	                switchedThread: shouldSwitchThread,
	            },
	        });
	    }, [
	        focusedThreadRootLookup,
	        handleFocus,
	        markThreadVisited,
	        nodeSelection.clearSelection,
	        saveViewportForActiveThread,
	        threadGraphScope.activeThreadRootId,
	    ]);

	    const handleHighlightDelete = useCallback((item: HighlightNavigationItem) => {
	        if (!selectedWorkspaceId) return;
	        deleteHighlightMutation.mutate({
	            workspaceId: selectedWorkspaceId,
	            messageId: item.messageId,
	            highlightId: item.id,
	        });
	        if (activeHighlightPreview?.id === item.id) {
	            setActiveHighlightPreview(null);
	        }
	    }, [activeHighlightPreview?.id, deleteHighlightMutation, selectedWorkspaceId]);

    const handleThreadDoneChange = useCallback((threadRootId: string, done: boolean) => {
        const nextDoneThreadRootIds = new Set(doneThreadRootIds);
        if (done) {
            nextDoneThreadRootIds.add(threadRootId);
            if (!doneThreadRootIds.has(threadRootId)) {
                lastClosedThreadRootIdsRef.current = [
                    ...lastClosedThreadRootIdsRef.current.filter((id) => id !== threadRootId),
                    threadRootId,
                ];
            }
        } else {
            nextDoneThreadRootIds.delete(threadRootId);
            lastClosedThreadRootIdsRef.current = lastClosedThreadRootIdsRef.current.filter((id) => id !== threadRootId);
        }
        const nextThreadItems = threadIndexItems.map((thread) => (
            thread.threadRootId === threadRootId ? { ...thread, done } : thread
        ));
        const nextActiveThreadRootId = resolveActiveThreadAfterDoneChange({
            changedThreadRootId: threadRootId,
            done,
            activeThreadRootId,
            threadRootIds: threadRootIndex.threadRootIds,
            threadItems: nextThreadItems,
        });
        setDoneThreadRootIds(nextDoneThreadRootIds);
        if (nextActiveThreadRootId !== activeThreadRootId) {
            setActiveThreadRootId(nextActiveThreadRootId);
        }
        rememberGraphThreadState(selectedWorkspaceId, {
            activeThreadRootId: nextActiveThreadRootId,
            doneThreadRootIds: nextDoneThreadRootIds,
            doneThreadsCollapsed,
            threadBarCollapsed,
            lastVisitedAtByThreadRootId,
        });
    }, [
        activeThreadRootId,
        doneThreadRootIds,
        doneThreadsCollapsed,
        lastVisitedAtByThreadRootId,
        selectedWorkspaceId,
        threadBarCollapsed,
        threadIndexItems,
        threadRootIndex.threadRootIds,
    ]);

    const handleCloseCurrentThread = useCallback(() => {
        if (!activeThreadRootId || doneThreadRootIds.has(activeThreadRootId)) return;
        handleThreadDoneChange(activeThreadRootId, true);
    }, [activeThreadRootId, doneThreadRootIds, handleThreadDoneChange]);

    const handleReopenLastClosedThread = useCallback(() => {
        const availableThreadRootIds = new Set(threadRootIndex.threadRootIds);
        const lastClosedThreadRootIds = lastClosedThreadRootIdsRef.current.filter((threadRootId) => (
            availableThreadRootIds.has(threadRootId) && doneThreadRootIds.has(threadRootId)
        ));
        lastClosedThreadRootIdsRef.current = lastClosedThreadRootIds;
        const threadRootId = lastClosedThreadRootIds[lastClosedThreadRootIds.length - 1];
        if (!threadRootId) return;

        handleThreadDoneChange(threadRootId, false);
        handleFocusThread(threadRootId);
    }, [doneThreadRootIds, handleFocusThread, handleThreadDoneChange, threadRootIndex.threadRootIds]);

    const handleDoneThreadsCollapsedChange = useCallback((collapsed: boolean) => {
        setDoneThreadsCollapsed(collapsed);
        rememberGraphThreadState(selectedWorkspaceId, {
            activeThreadRootId,
            doneThreadRootIds,
            doneThreadsCollapsed: collapsed,
            threadBarCollapsed,
            lastVisitedAtByThreadRootId,
        });
    }, [activeThreadRootId, doneThreadRootIds, lastVisitedAtByThreadRootId, selectedWorkspaceId, threadBarCollapsed]);

    const handleThreadBarCollapsedChange = useCallback((collapsed: boolean) => {
        setThreadBarCollapsed(collapsed);
        rememberGraphThreadState(selectedWorkspaceId, {
            activeThreadRootId,
            doneThreadRootIds,
            doneThreadsCollapsed,
            threadBarCollapsed: collapsed,
            lastVisitedAtByThreadRootId,
        });
    }, [activeThreadRootId, doneThreadRootIds, doneThreadsCollapsed, lastVisitedAtByThreadRootId, selectedWorkspaceId]);

    const handleCreateThread = useCallback(async () => {
        if (!selectedWorkspaceId || createThreadDisabled) return;
        saveViewportForActiveThread();
        const thread = await createThreadSession.mutateAsync({
            workspaceId: selectedWorkspaceId,
            source: 'user',
            baseCommitSha: defaultNewThreadBaseCommitSha,
        });
        const threadRootId = thread.id;
        setActiveThreadRootId(threadRootId);
        markThreadVisited(threadRootId);
        setViewMode('branch');
        nodeSelection.clearSelection();
        dispatchFocus({
            messageId: null,
            source: 'graph',
            metadata: { reason: 'create-thread', threadRootId },
        });
        dispatchGraphComposerDockExpand();
        setThreadComposerTarget({
            workspaceId: selectedWorkspaceId,
            threadId: threadRootId,
            reason: 'create-thread',
            nonce: Date.now(),
        });
    }, [
        createThreadDisabled,
        createThreadSession,
        dispatchFocus,
        markThreadVisited,
        nodeSelection.clearSelection,
        saveViewportForActiveThread,
        defaultNewThreadBaseCommitSha,
        selectedWorkspaceId,
        setThreadComposerTarget,
    ]);

    const handleHideSubgraph = useCallback((messageId: string) => {
        setHiddenSubgraphRootIds((current) => {
            const next = new Set(current);
            next.add(messageId);
            return next;
        });
        if (subgraphRootNodeId === messageId) {
            setSubgraphRootNodeId(null);
        }
        nodeSelection.clearSelection();
        toast.success('Subgraph hidden', 'Use the hidden graph filter pill to restore it.');
    }, [nodeSelection.clearSelection, subgraphRootNodeId, toast]);

    const handleConvertSubgraphToThread = useCallback((messageId: string) => {
        const message = (messages as Message[]).find((candidate) => candidate.id === messageId) ?? null;
        if (!message || message.role !== 'user' || !message.parentId) {
            toast.error('Cannot convert subgraph', 'Only nested user nodes can become threads.');
            return;
        }

        setConvertedSubgraphThreadRootIds((current) => {
            if (current.has(messageId)) return current;
            const next = new Set(current);
            next.add(messageId);
            rememberConvertedSubgraphThreadRootIds(selectedWorkspaceId, next);
            return next;
        });
        setHiddenSubgraphRootIds((current) => {
            if (!current.has(messageId)) return current;
            const next = new Set(current);
            next.delete(messageId);
            return next;
        });
        if (subgraphRootNodeId === messageId) {
            setSubgraphRootNodeId(null);
        }
        setNodeContextMenu(null);
        nodeSelection.clearSelection();
        toast.success('Subgraph converted to thread');
    }, [messages, nodeSelection.clearSelection, selectedWorkspaceId, subgraphRootNodeId, toast]);

    const graphLayoutCacheScopeKey = getThreadScopeKey(selectedWorkspaceId, threadGraphScope.activeThreadRootId);
    const graphLayoutInsights = showInsightsInGraph ? insights : EMPTY_GRAPH_INSIGHTS;
    const { nodes: layoutNodes, edges: layoutEdges } = useGraphLayout({
        projection: workspaceProjection,
        messages: graphComputationMessages,
        attachedThreadMessages: graphMessages as Message[],
        summaries: scopedSummaries,
        measuredNodeHeights,
        layoutMode,
        laneStrategy,
        disabledSummaryIds: disabledSummaryIdsSet,
        focusedMessageId,
        contextPathMessageIds: contextPathMessageIdSet,
        composerBaseCommitSha,
        matchingMessageIds: graphFilterState.matchingMessageIds,
        filterActive: graphFilterState.filterActive,
        hasNodeTypeFilter: graphFilterState.hasNodeTypeFilter,
        keepAncestors: graphFilterState.keepAncestors,
        keepDescendants: graphFilterState.keepDescendants,
        constrainedCommitFiltering: Boolean(subgraphRootNodeId),
        pinnedCommitShas,
        hiddenThreadRootIds: hiddenThreadRootIdsForLayout,
        layoutCacheScopeKey: graphLayoutCacheScopeKey,
        visibleNodeSections,
        insights: graphLayoutInsights,
        showInsightsInGraph,
        workspaceRepoMap,
        branchPointersByNodeId,
        resetNonce: graphResetNonce,
        onToggleSummary: toggleSummaryDisabled,
        onToggleCollapse: handleToggleCollapse,
        onFocus: handleFocus,
        onOpenThread: handleFocusThread,
        onSelect: handleSelect,
        onMeasureNodeHeight: handleMeasureNodeHeight,
        onContextMenu: handleNodeContextMenu
    } as any);

    const subgraphStats = useMemo(() => {
        let nodes = 0;
        let commits = 0;
        for (const node of layoutNodes) {
            if (node.type === 'canonical_commit' || node.type === 'commit_message') {
                commits += 1;
                continue;
            }
            if (node.type === 'layout_derived_commit_group') {
                const shas = (node.data as any)?.group?.commitShas;
                commits += Array.isArray(shas) ? shas.length : 1;
                continue;
            }
            if (node.type === 'thread_link' || node.type === 'user_message' || node.type === 'assistant_message' || node.type === 'summary_block') {
                nodes += 1;
            }
        }
        return { nodes, commits };
    }, [layoutNodes]);

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
            queryStatus: messagesQuery.status,
            usingSnapshot: graphUsingSnapshot,
        }, { source: 'GraphView' });
    }, [
        branchPointers.length,
        graphUsingSnapshot,
        graphMessages.length,
        messagesQuery.status,
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
        const nodeById = new Map(layoutNodes.map((node) => [node.id, node]));
        const withEndpointDots = (edge: Edge, endpointDotVariant: EdgeEndpointDotVariant | null) => {
            if (!endpointDotVariant) return edge;
            return {
                ...edge,
                data: {
                    ...(edge.data ?? {}),
                    endpointDotVariant,
                },
            };
        };
        const getEndpointDotVariant = (edge: Edge, matchedPreview: boolean): EdgeEndpointDotVariant | null => (
            getGraphEdgeEndpointDotVariant({
                edgeLegendType: (edge.data as any)?.edgeLegendType as GraphEdgeLegendId | undefined,
                matchedContextPathPreview: previewEdgeType === 'context-path' && matchedPreview,
                isInterTurnEdge: isInterTurnEndpointEdge(nodeById.get(edge.source), nodeById.get(edge.target)),
            })
        );
        const visibleEdges = layoutEdges.filter((edge) => {
            const edgeLegendType = (edge.data as any)?.edgeLegendType as GraphEdgeLegendId | undefined;
            return edgeLegendType ? visibleEdgeTypes.has(edgeLegendType) : false;
        }).map((edge) => withEndpointDots(edge, getEndpointDotVariant(edge, false)));

        if (!previewEdgeType) return visibleEdges;

        const matchesPreview = (edge: any) => {
            if (previewEdgeType === 'context-path') return edge?.data?.isOnContextPath === true;
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
                const endpointDotVariant = getEndpointDotVariant(edge, matched);
                return {
                    ...edge,
                    data: {
                        ...(edge.data ?? {}),
                        ...(endpointDotVariant ? { endpointDotVariant } : {}),
                    },
                    animated: false,
                    style: {
                        ...edge.style,
                        stroke: matched ? '#f59e0b' : edge.style?.stroke,
                        strokeWidth: matched ? Math.max(Number(edge.style?.strokeWidth ?? 2), 4) : edge.style?.strokeWidth,
                        opacity: matched ? 1 : 0.18,
                    },
                    zIndex: matched ? 30 : -5,
                };
            });
    }, [layoutEdges, layoutNodes, previewEdgeType, visibleEdgeTypes]);

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
        setNodeContextMenu(null);
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
            messagesQuery.isSuccess ? 'messages-ready' : 'messages-pending',
            branchViewActivationNonce,
            focusNonce,
            focusedMessageId,
            viewMode,
            layoutMode,
            laneStrategy,
            layoutNodes.length,
            layoutEdges.length,
            graphFilterState.filterActive ? 'filter-active' : 'filter-inactive',
            graphFilterState.matchingMessageIds.size,
            graphFilterState.keepAncestors ? 'ancestors' : 'no-ancestors',
            graphFilterState.keepDescendants ? 'descendants' : 'no-descendants',
            subgraphRootNodeId ?? 'full-graph',
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
        selectedWorkspaceId,
        showInsightsInGraph,
        graphFilterState.filterActive,
        graphFilterState.keepAncestors,
        graphFilterState.keepDescendants,
        graphFilterState.matchingMessageIds,
        subgraphRootNodeId,
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
    const bulkDeleteThreadLabel = useMemo(() => {
        if (!bulkDeleteThreadRootId) return null;
        return threadIndexItems.find((item) => item.threadRootId === bulkDeleteThreadRootId)?.label ?? null;
    }, [bulkDeleteThreadRootId, threadIndexItems]);
    const bulkDeletePreview = useMemo(
        () => getDeleteBranchPreview(
            bulkDeleteIds,
            messageMap,
            removeCommitsFromGraph ? bulkDeleteAvailableCommitShas.length : 0,
            {
                threadLabel: bulkDeleteThreadLabel,
                extraCommitLabels: removeCommitsFromGraph
                    ? bulkDeleteAvailableCommitShas.map((sha) => sha.slice(0, 12))
                    : [],
            }
        ),
        [bulkDeleteAvailableCommitShas, bulkDeleteIds, bulkDeleteThreadLabel, messageMap, removeCommitsFromGraph]
    );

    useGraphViewHotkeys({
        hasSelection: nodeSelection.selectedNodeIds.size > 0,
        isComposerOpen: graphComposerDockState.isVisible && !graphComposerDockState.isCollapsed,
        closeComposer: dispatchGraphComposerDockCollapse,
        clearSelection: () => {
            setNodeContextMenu(null);
            nodeSelection.clearSelection();
            selectionAnchorIdRef.current = null;
        },
        navigate: handleDirectionalGraphNavigation,
        focusPrevious: () => {
            if (previousGraphNodeId) {
                handleFocusGraphNavigationNode(previousGraphNodeId, 'previous-node');
            }
        },
        focusNext: () => {
            if (nextGraphNodeId) {
                handleFocusGraphNavigationNode(nextGraphNodeId, 'next-node');
            }
        },
        focusLatest: () => {
            if (latestGraphNodeId) {
                handleFocusGraphNavigationNode(latestGraphNodeId, 'latest-node');
            }
        },
        closeThread: handleCloseCurrentThread,
        reopenLastClosedThread: handleReopenLastClosedThread,
        openSearch: () => {
            setIsSearchPanelOpen(true);
        },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // HANDLERS
    // ─────────────────────────────────────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleNodeClick = useCallback((...args: any[]) => {
        let messageId: string | null = null;
        let centerMessageId: string | null = null;
        let redirectedFromMessageId: string | null = null;
        let eventOrNull: React.MouseEvent | null = null;
        let nodeOrMessageId: Node<LlmNodeData | object> | string | undefined;

        if (args.length === 1 && typeof args[0] === 'string') {
            // List click
            nodeOrMessageId = args[0];
            messageId = args[0];
            centerMessageId = args[0];
        } else if (args.length === 2 && typeof args[1] === 'object' && args[1]?.id) {
            // React Flow click
            eventOrNull = args[0] as React.MouseEvent;
            nodeOrMessageId = args[1] as Node<LlmNodeData | object>;
            const node = nodeOrMessageId;
            if (runningCountRef.current === 0) {
                nodeLayoutDiagnosticRef.current(node.id, 'node-click');
            }
            const nodeData = node.data as any;
            if (node.type === 'user_message' || node.type === 'assistant_message' || node.type === 'commit_message' || node.type === 'summary_block') {
                const focusTarget = resolveReactFlowNodeClickFocusTarget({
                    nodeType: node.type,
                    entity: nodeData?.entity,
                    nodeId: node.id,
                });
                messageId = focusTarget.messageId;
                centerMessageId = focusTarget.centerMessageId;
                redirectedFromMessageId = focusTarget.redirectedFromMessageId;
            } else if (node.type === 'thread_origin') {
                const threadRootId = nodeData?.entity?.threadRootId ?? null;
                if (threadRootId && selectedWorkspaceId) {
                    setActiveThreadRootId(threadRootId);
                    markThreadVisited(threadRootId);
                    dispatchGraphComposerDockExpand();
                    setThreadComposerTarget({
                        workspaceId: selectedWorkspaceId,
                        threadId: threadRootId,
                        reason: 'thread-origin',
                        nonce: Date.now(),
                    });
                }
                return;
            } else if (node.type === 'thread_link') {
                const threadRootId = nodeData?.entity?.threadLinkRootId ?? nodeData?.entity?.threadRootId ?? null;
                if (threadRootId) handleFocusThread(threadRootId);
                return;
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
                if (viewMode === 'list') {
                    startTransition(() => {
                        dispatchFocus({ messageId, source: 'list' });
                    });
                } else {
                    handleFocus(messageId, {
                        pointerDownAt: null,
                        clickAt: performance.now(),
                        centerMessageId,
                        metadata: {
                            via: 'react-flow-node-click',
                            ...(redirectedFromMessageId ? { redirectedFromMessageId } : {}),
                        },
                    });
                }
            }
        }
    }, [
        dispatchFocus,
        handleFocus,
        handleFocusThread,
        markThreadVisited,
        onNodeClickOverride,
        selectedWorkspaceId,
        setThreadComposerTarget,
        viewMode,
    ]);

    const handlePaneClick = useCallback(() => {
        setNodeContextMenu(null);
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

    const refetchGraphData = useCallback(async () => {
        if (!selectedWorkspaceId) return;

        await Promise.all([
            scheduleMessagesRefreshWhenGraphIdle(queryClient, selectedWorkspaceId, {
                refetchActive: true,
                reason: 'graph-refresh',
            }),
            queryClient.invalidateQueries({ queryKey: ['graph-snapshot', selectedWorkspaceId] }),
            queryClient.invalidateQueries({ queryKey: ['local-commit-graph', selectedWorkspaceId] }),
            queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(selectedWorkspaceId) }),
            queryClient.invalidateQueries({ queryKey: branchKeys.workspace(selectedWorkspaceId) }),
        ]);

        await Promise.all([
            queryClient.refetchQueries({ queryKey: ['graph-snapshot', selectedWorkspaceId], type: 'active' }),
            queryClient.refetchQueries({ queryKey: ['local-commit-graph', selectedWorkspaceId], type: 'active' }),
            queryClient.refetchQueries({ queryKey: trackedRefKeys.workspace(selectedWorkspaceId), type: 'active' }),
            queryClient.refetchQueries({ queryKey: branchKeys.workspace(selectedWorkspaceId), type: 'active' }),
        ]);
    }, [queryClient, selectedWorkspaceId]);

    const refetchSummaries = useCallback(async () => {
        if (!selectedWorkspaceId) return;
        if (agentClient.hasRuntime()) return;

        await queryClient.invalidateQueries({ queryKey: ['summaries', selectedWorkspaceId] });
        await queryClient.refetchQueries({ queryKey: ['summaries', selectedWorkspaceId], type: 'active' });
    }, [queryClient, selectedWorkspaceId]);

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
        lastTrackedRefSyncSnapshotKeyRef.current = null;
    }, [selectedWorkspaceId, repoPath]);

    useEffect(() => {
        if (!trackedRefSyncEligible || isSyncing || trackedRefSyncInFlightRef.current) return;
        if (!pendingTrackedRefSyncKey) return;
        if (lastTrackedRefSyncSnapshotKeyRef.current === pendingTrackedRefSyncKey) return;

        trackedRefSyncInFlightRef.current = true;

        const runChangedRefSync = async () => {
            try {
                let syncResult = null;
                try {
                    syncResult = await runSync();
                } catch (error) {
                    console.error('[GraphView] Tracked ref sync failed:', error);
                    return;
                }

                lastTrackedRefSyncSnapshotKeyRef.current = pendingTrackedRefSyncKey;
                if (!syncResult?.didSync) return;

                await refetchGraphData();
                await refetchSummaries();
            } finally {
                trackedRefSyncInFlightRef.current = false;
            }
        };

        void runChangedRefSync();
    }, [
        trackedRefSyncEligible,
        isSyncing,
        pendingTrackedRefSyncKey,
        refetchGraphData,
        refetchSummaries,
        runSync,
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
            const message = messageMap.get(nodeId) ?? null;
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
            if (isNoAgentSessionFoundError(error)) {
                const message = messageMap.get(nodeId) ?? null;
                const marked = await markStaleLocalAgentNodeCancelled({
                    queryClient,
                    workspaceId: selectedWorkspaceId,
                    nodeId,
                    node: message,
                    reason: 'Run cancelled after the app restarted before the native agent session was created.',
                });
                if (marked) {
                    agentRunManager.dispatch(nodeId, {
                        type: 'terminal',
                        status: 'cancelled',
                        reason: 'cancelled',
                    }, {
                        workspaceId: selectedWorkspaceId,
                        role: 'assistant',
                    });
                    await scheduleMessagesRefreshWhenGraphIdle(queryClient, selectedWorkspaceId, { reason: 'cancel-stale-local-node' });
                    return;
                }
            }
            console.error('[GraphView] Failed to stop agent from list:', error);
            toast.error('Unable to stop agent', 'The stop request did not complete.');
        }
    }, [messageMap, messages, queryClient, selectedWorkspaceId, toast]);

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

    const openBulkDeleteDialog = useCallback((messageIds: Iterable<string>, commitShas: Iterable<string> = [], threadRootId: string | null = null) => {
        const rootIds = getBulkDeleteTargets(new Set(messageIds));
        const explicitCommitShas = Array.from(new Set(commitShas)).filter((sha) => sha && !deletedGraphCommitShas.has(sha));
        setBulkDeleteIds(rootIds);
        setBulkDeleteThreadRootId(threadRootId);
        setBulkDeleteExplicitCommitShas(explicitCommitShas);
        setRemoveCommitsFromGraph(rootIds.length === 0 && explicitCommitShas.length > 0);
        setBulkDeletePhase('idle');
        setIsBulkDeleteAlertOpen(true);
    }, [deletedGraphCommitShas, getBulkDeleteTargets]);

    const handleThreadDelete = useCallback(async (threadRootId: string) => {
        const threadMessageIds = threadRootIndex.messageIdsByThreadRootId.get(threadRootId);
        const deletePlan = resolveThreadDeletePlan({ threadRootId, threadMessageIds });
        if (deletePlan.kind === 'thread-session') {
            if (!selectedWorkspaceId) return;
            try {
                await deleteThreadSessionMutation.mutateAsync({
                    workspaceId: selectedWorkspaceId,
                    threadId: deletePlan.threadRootId,
                });
            } catch (error) {
                console.error('[GraphView] Thread delete failed:', error);
                toast.error('Delete failed', 'The empty thread could not be deleted.');
            }
            return;
        }
        openBulkDeleteDialog(deletePlan.messageIds, [], deletePlan.threadRootId);
    }, [deleteThreadSessionMutation, openBulkDeleteDialog, selectedWorkspaceId, threadRootIndex.messageIdsByThreadRootId, toast]);

    const threadNavigationModelSignature = useMemo(() => (
        [
            selectedWorkspaceId ?? 'none',
            doneThreadsCollapsed ? 'done-collapsed' : 'done-open',
            threadBarCollapsed ? 'thread-bar-collapsed' : 'thread-bar-open',
            createThreadDisabled ? 'create-disabled' : 'create-enabled',
            createThreadDisabledReason ?? '',
            ...threadIndexItems.map((thread) => [
                thread.threadRootId,
                thread.label,
                thread.fullLabel ?? '',
                thread.turnCount,
                thread.commitCount,
                thread.baseCommitSha ?? '',
                thread.updatedLabel,
                thread.runningCount,
                thread.done ? 'done' : 'open',
                thread.current ? 'current' : 'idle',
                thread.unreadCompletedLeafCount ?? 0,
                thread.initialPreviewNodeId ?? '',
                thread.draftPreviewText ?? '',
                ...(thread.previewNodeIds ?? []),
            ].join(':')),
        ].join('|')
    ), [
        createThreadDisabled,
        createThreadDisabledReason,
        doneThreadsCollapsed,
        messagesQuery.isSuccess,
        selectedWorkspaceId,
        threadBarCollapsed,
        threadIndexItems,
    ]);
    const lastPublishedThreadNavigationSignatureRef = useRef<string | null>(null);
    useEffect(() => {
        if (!onThreadNavigationModelChange) return;
        if (lastPublishedThreadNavigationSignatureRef.current === threadNavigationModelSignature) return;
        lastPublishedThreadNavigationSignatureRef.current = threadNavigationModelSignature;
        recordPerfEvent('query.workspace-switch.thread-navigation-ready', {
            elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
            workspaceId: selectedWorkspaceId,
            threadCount: threadIndexItems.length,
            messageCount: (graphMessages as Message[]).length,
            queryStatus: messagesQuery.status,
        }, { source: 'GraphView' });
        onThreadNavigationModelChange({
            workspaceId: selectedWorkspaceId,
            messagesReady: messagesQuery.isSuccess,
            messageIds: new Set((graphMessages as Message[]).map((message) => message.id)),
            threadItems: threadIndexItems,
            threadHoverProjectionInput,
            doneThreadsCollapsed,
            threadBarCollapsed,
            onThreadFocus: handleFocusThread,
            onThreadDoneChange: handleThreadDoneChange,
            onThreadDelete: handleThreadDelete,
            onDoneThreadsCollapsedChange: handleDoneThreadsCollapsedChange,
            onThreadBarCollapsedChange: handleThreadBarCollapsedChange,
            onCreateThread: handleCreateThread,
            createThreadDisabled,
            createThreadDisabledReason,
        });
    }, [
        createThreadDisabled,
        createThreadDisabledReason,
        doneThreadsCollapsed,
        handleCreateThread,
        handleDoneThreadsCollapsedChange,
        handleFocusThread,
        handleThreadBarCollapsedChange,
        handleThreadDelete,
        handleThreadDoneChange,
        onThreadNavigationModelChange,
        selectedWorkspaceId,
        graphMessages.length,
        messagesQuery.status,
        threadHoverProjectionInput,
        threadBarCollapsed,
        threadIndexItems,
        threadNavigationModelSignature,
    ]);

    useEffect(() => {
        return () => {
            onThreadNavigationModelChange?.(null);
        };
    }, [
        onThreadNavigationModelChange,
    ]);

    const resetBulkDeleteDialog = useCallback(() => {
        setIsBulkDeleteAlertOpen(false);
        setBulkDeleteIds([]);
        setBulkDeleteThreadRootId(null);
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
            if (bulkDeleteThreadRootId) {
                await deleteThreadSessionMutation.mutateAsync({
                    workspaceId: selectedWorkspaceId,
                    threadId: bulkDeleteThreadRootId,
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
    }, [bulkDeleteAvailableCommitShas, bulkDeleteIds, bulkDeleteThreadRootId, deleteMessageBranchMutation, deleteThreadSessionMutation, nodeSelection, removeCommitsFromGraph, resetBulkDeleteDialog, selectedWorkspaceId, toast]);

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
    const preparedGraphNodeCacheRef = useRef(new Map<string, {
        source: Node<any>;
        selected: boolean;
        attentionBadgeCount?: number;
        attentionBadgeItems?: AttentionBadgeItem[];
        controlledHoverCardKey?: string | null;
        prepared: Node<any>;
    }>());
    const graphNodeDetailCacheRef = useRef(new Map<string, {
        source: Node<any>;
        detailLevel: GraphNodeDetailLevel;
        prepared: Node<any>;
    }>());
    const baseBranchNodesForRender = useMemo(() => {
        const startedAt = performance.now();
        const nextCache = new Map<string, {
            source: Node<any>;
            selected: boolean;
            attentionBadgeCount?: number;
            attentionBadgeItems?: AttentionBadgeItem[];
            controlledHoverCardKey?: string | null;
            prepared: Node<any>;
        }>();
        let reusedCount = 0;
        const result = layoutNodes.map((node) => {
            const nodeFocusId = node.data?.entity?.focusMessageId ?? node.data?.entity?.messageId ?? null;
            const controlledHoverCardKey = activeHighlightPreview && nodeFocusId === activeHighlightPreview.messageId
                ? `highlight:${activeHighlightPreview.messageId}:${activeHighlightPreview.id}`
                : null;
            const selected = nodeSelection.selectedNodeIds.has(node.id)
                || (typeof nodeFocusId === 'string' && nodeSelection.selectedNodeIds.has(nodeFocusId));
            const entity = node.data?.entity as { kind?: string; messageId?: string | null } | undefined;
            const attentionBadgeItems = entity?.kind === 'assistant_message' && entity.messageId
                ? attentionByParentId.get(entity.messageId)
                : undefined;
            const attentionBadgeCount = attentionBadgeItems?.length;
            const cached = preparedGraphNodeCacheRef.current.get(node.id);
            if (
                cached?.source === node
                && cached.selected === selected
                && cached.attentionBadgeCount === attentionBadgeCount
                && cached.attentionBadgeItems === attentionBadgeItems
                && cached.controlledHoverCardKey === controlledHoverCardKey
            ) {
                nextCache.set(node.id, cached);
                reusedCount += 1;
                return cached.prepared;
            }
            let baseNode = Boolean(node.selected) === selected
                ? node
                : { ...node, selected };
            if (
                (baseNode.data as any)?.attentionBadgeCount !== attentionBadgeCount
                || (baseNode.data as any)?.attentionBadgeItems !== attentionBadgeItems
                || (baseNode.data as any)?.controlledHoverCardKey !== controlledHoverCardKey
            ) {
                baseNode = {
                    ...baseNode,
                    data: {
                        ...(baseNode.data ?? {}),
                        attentionBadgeCount,
                        attentionBadgeItems,
                        controlledHoverCardKey,
                        onControlledHoverCardDismiss: () => setActiveHighlightPreview(null),
                    },
                };
            }
            const prepared = withExplicitReactFlowNodeDimensions(baseNode);
            nextCache.set(node.id, { source: node, selected, attentionBadgeCount, attentionBadgeItems, controlledHoverCardKey, prepared });
            return prepared;
        });
        preparedGraphNodeCacheRef.current = nextCache;
        recordFundamentalCounter('graph.render.prepare-nodes', {
            nodeCount: layoutNodes.length,
            selectedCount: nodeSelection.selectedNodeIds.size,
            reusedCount,
            runningCount: runningCountRef.current,
            activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
        }, performance.now() - startedAt);
        return result;
    }, [activeHighlightPreview, activeSendFlowFocus?.workspaceId, attentionByParentId, layoutNodes, nodeSelection.selectedNodeIds, selectedWorkspaceId]);
    const branchNodesForRender = baseBranchNodesForRender;
    const graphEdgesForRender = previewEdges;
    const activeGraphRenderHold = runningCount > 0 || activeSendFlowFocus?.workspaceId === selectedWorkspaceId;
    const fullGraphViewportBounds = useMemo(
        () => buildFullGraphViewportBoundsModel(branchNodesForRender),
        [branchNodesForRender]
    );
    fullGraphViewportBoundsRef.current = fullGraphViewportBounds;
    const graphTranslateExtent = fullGraphViewportBounds?.translateExtent;
    const shouldShowThreadBands = !threadGraphScope.isThreadScoped && !activeGraphRenderHold;
    const threadBands = useMemo(() => {
        if (!shouldShowThreadBands) return [];
        const rects = getThreadDividerRectsFromNodes(branchNodesForRender, threadRootIndex.threadRootIdByMessageId);
        return buildThreadBands(rects, { padding: 260, horizontalPadding: 88, equalVerticalExtent: true });
    }, [branchNodesForRender, shouldShowThreadBands, threadRootIndex.threadRootIdByMessageId]);
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
            let resolvedIds = resolveAnchoredGraphWindowNodeIds(nodeIds, branchNodesForRender);
            for (const edge of graphEdgesForRender) {
                const relationship = (edge.data as any)?.relationship;
                const edgeRole = (edge.data as any)?.edgeRole;
                if (
                    relationship !== 'git-parent' &&
                    relationship !== 'base-used' &&
                    edgeRole !== 'commit-lineage' &&
                    edgeRole !== 'base'
                ) continue;
                if (nodeIds.has(edge.source) || nodeIds.has(edge.target)) {
                    resolvedIds.add(edge.source);
                    resolvedIds.add(edge.target);
                }
            }
            resolvedIds = resolveAnchoredGraphWindowNodeIds(resolvedIds, branchNodesForRender);

            const nodes = Array.from(resolvedIds)
                .map((id) => activeGraphWindowSpatialIndex.nodeById.get(id))
                .filter((node): node is Node<any> => Boolean(node));
            const resolvedNodeIds = new Set(nodes.map((node) => node.id));
            const edges = graphEdgesForRender.filter((edge) => resolvedNodeIds.has(edge.source) && resolvedNodeIds.has(edge.target));
            const nodeLayoutKey = nodes.map((node) => [
                node.id,
                Math.round(node.position?.x ?? 0),
                Math.round(node.position?.y ?? 0),
                numericDimension((node.style as any)?.width) ?? '',
                numericDimension((node.style as any)?.height) ?? '',
            ].join('@')).join('|');
            const key = `${reason}:${nodeLayoutKey}::${edges.map((edge) => edge.id).join('|')}`;
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
            edges: graphEdgesForRender,
            mode: 'full' as const,
        };
        activeRunGraphRenderRef.current = next;
        return next;
    }, [activeGraphWindowSpatialIndex, activeGraphWindowViewportVersion, activePinnedGraphNodeIds, branchNodesForRender, graphEdgesForRender, reactFlowInstance, shouldHoldGraphRenderForSendFlow]);

    const graphNodesForReactFlow = useMemo(() => {
        const startedAt = performance.now();
        const renderedNodeCount = graphRenderElements.nodes.length;
        const renderedNodeIds = graphRenderElements.mode === 'full'
            ? null
            : new Set(graphRenderElements.nodes.map((node) => node.id));
        const viewport = reactFlowInstance.getViewport();
        const viewportZoom = Math.max(viewport.zoom || 1, 0.0001);
        const viewportWidth = branchCanvasRef.current?.clientWidth || window.innerWidth || 1200;
        const viewportHeight = branchCanvasRef.current?.clientHeight || window.innerHeight || 800;
        const viewportLeft = -viewport.x / viewportZoom;
        const viewportTop = -viewport.y / viewportZoom;
        const viewportRect = {
            left: viewportLeft,
            right: viewportLeft + viewportWidth / viewportZoom,
            top: viewportTop,
            bottom: viewportTop + viewportHeight / viewportZoom,
        };
        const visibleDetailNodeIds = new Set(activeGraphWindowSpatialIndex
            .query(viewportRect)
            .filter((entry) => renderedNodeIds === null || renderedNodeIds.has(entry.id))
            .map((entry) => entry.id));
        const detailDensityNodeCount = getGraphNodeDetailDensityCount({
            renderedNodeCount,
            visibleNodeCount: visibleDetailNodeIds.size,
        });
        const nextCache = new Map<string, {
            source: Node<any>;
            detailLevel: GraphNodeDetailLevel;
            prepared: Node<any>;
        }>();
        let reusedCount = 0;
        let fullCount = 0;
        let compactCount = 0;
        let minimalCount = 0;
        const nodes = graphRenderElements.nodes.map((node) => {
            const data = node.data ?? {};
            const isAnchorNode = Boolean(data.isFocused || data.isSelected || node.selected || data.isComposerBaseCommit);
            const isInDetailViewport = isAnchorNode || visibleDetailNodeIds.has(node.id);
            const effectiveZoom = getGraphNodeDetailEffectiveZoom({
                bucket: graphDetailZoomBucket,
                isInDetailViewport,
            });
            const detailLevel = getGraphNodeDetailLevel({
                zoom: effectiveZoom,
                renderedNodeCount: detailDensityNodeCount,
                isFocused: Boolean(data.isFocused),
                isSelected: Boolean(data.isSelected || node.selected),
                isComposerBaseCommit: Boolean(data.isComposerBaseCommit),
            });

            if (detailLevel === 'minimal') minimalCount += 1;
            else if (detailLevel === 'compact') compactCount += 1;
            else fullCount += 1;

            const cached = graphNodeDetailCacheRef.current.get(node.id);
            if (cached?.source === node && cached.detailLevel === detailLevel) {
                nextCache.set(node.id, cached);
                reusedCount += 1;
                return cached.prepared;
            }

            const prepared = data.detailLevel === detailLevel
                ? node
                : {
                    ...node,
                    data: {
                        ...data,
                        detailLevel,
                    },
                };
            nextCache.set(node.id, { source: node, detailLevel, prepared });
            return prepared;
        });
        graphNodeDetailCacheRef.current = nextCache;
        recordFundamentalCounter('graph.render.detail-level', {
            mode: graphRenderElements.mode,
            zoomBucket: graphDetailZoomBucket,
            viewportZoom: Number(viewportZoom.toFixed(3)),
            nodeCount: renderedNodeCount,
            visibleDetailNodeCount: visibleDetailNodeIds.size,
            detailDensityNodeCount,
            fullCount,
            compactCount,
            minimalCount,
            reusedCount,
        }, performance.now() - startedAt);
        return nodes;
    }, [activeGraphWindowSpatialIndex, graphDetailViewportVersion, graphDetailZoomBucket, graphRenderElements.mode, graphRenderElements.nodes, reactFlowInstance]);
    useEffect(() => {
        if (!shouldRestoreViewportAfterGraphNodeCountChange({
            activeGraphRenderHold,
            graphRenderMode: graphRenderElements.mode,
            isViewportInteracting: isViewportInteractingRef.current,
        })) {
            return;
        }
        restoreViewportForActiveThread();
    }, [activeGraphRenderHold, graphNodesForReactFlow.length, graphRenderElements.mode, restoreViewportForActiveThread]);
    useEffect(() => {
        const startedAt = threadSwitchStartedAtRef.current;
        const targetThreadRootId = threadSwitchTargetRef.current;
        if (startedAt === null || !targetThreadRootId) return;
        if (targetThreadRootId !== threadGraphScope.activeThreadRootId) return;

        recordPerfEvent('graph.thread-switch.rendered', {
            threadRootId: targetThreadRootId,
            durationMs: Number((performance.now() - startedAt).toFixed(2)),
            renderedNodeCount: graphNodesForReactFlow.length,
            layoutNodeCount: layoutNodes.length,
            edgeCount: layoutEdges.length,
        }, { source: 'GraphView' });

        threadSwitchStartedAtRef.current = null;
        threadSwitchTargetRef.current = null;
    }, [graphNodesForReactFlow.length, layoutEdges.length, layoutNodes.length, threadGraphScope.activeThreadRootId]);
    const shouldLetReactFlowCullVisibleElements = useMemo(() => (
        !hasLayoutAnchoredGraphNodes(graphNodesForReactFlow)
    ), [graphNodesForReactFlow]);

    useEffect(() => {
        scheduleGraphDetailZoomBucketUpdate(180);
    }, [graphRenderElements.mode, graphRenderElements.nodes.length, scheduleGraphDetailZoomBucketUpdate]);

    useEffect(() => {
        const previous = previousGraphRenderRefsRef.current;
        recordFundamentalCounter('graph.render.refs', {
            mode: graphRenderElements.mode,
            nodeCount: graphNodesForReactFlow.length,
            edgeCount: graphRenderElements.edges.length,
            runningCount,
            activeSendFlow: activeSendFlowFocus?.workspaceId === selectedWorkspaceId,
            nodesRefChanged: previous.nodes !== graphNodesForReactFlow,
            edgesRefChanged: previous.edges !== graphRenderElements.edges,
            focusedMessageId,
            viewportInteracting: isViewportInteractingRef.current,
        });
        previousGraphRenderRefsRef.current = {
            nodes: graphNodesForReactFlow,
            edges: graphRenderElements.edges,
        };
    }, [
        activeSendFlowFocus?.workspaceId,
        focusedMessageId,
        graphRenderElements.edges,
        graphRenderElements.mode,
        graphNodesForReactFlow,
        runningCount,
        selectedWorkspaceId,
    ]);

    const graphInteractionContextValue = useMemo(() => ({
        selectedNodeIds: nodeSelection.selectedNodeIds,
        isSelectionGestureActive: nodeSelection.isSelectionGestureActive,
        isViewportInteracting: false,
    }), [nodeSelection.isSelectionGestureActive, nodeSelection.selectedNodeIds]);

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
        renderNodesRef: graphNodesForReactFlow,
        previewEdgesRef: graphRenderElements.edges,
        focusedMessageId,
        focusNonce,
        graphResetNonce,
        tagFilterKey: [
            graphFilterState.filterActive ? 1 : 0,
            graphFilterState.hasNodeTypeFilter ? 1 : 0,
            graphFilterState.matchingMessageIds.size,
            graphFilterState.keepAncestors ? 1 : 0,
            graphFilterState.keepDescendants ? 1 : 0,
            subgraphRootNodeId ?? 'full',
        ].join(':'),
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
                    : node.type === 'thread_link'
                        ? 64
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
        const connectedEdges = graphEdgesForRender
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
    }, [branchNodesForRender, graphEdgesForRender, reactFlowInstance]);

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
                measuredHeights: measuredHeights.size,
                running: runningCount,
            },
            filters: {
                active: graphFilterState.filterActive,
                activeFilterCount: tagFilter.activeFilterCount,
                matchingCount: graphFilterState.matchingMessageIds.size,
                keepAncestors: graphFilterState.keepAncestors,
                keepDescendants: graphFilterState.keepDescendants,
                subgraphRootNodeId,
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
        selectedWorkspaceId,
        summaries,
        summariesQuery.status,
        tagFilter.activeFilterCount,
        graphFilterState.filterActive,
        graphFilterState.keepAncestors,
        graphFilterState.keepDescendants,
        graphFilterState.matchingMessageIds,
        subgraphRootNodeId,
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
                        executionTimelineOpen={executionTimelineOpen}
                        onExecutionTimelineOpenChange={handleExecutionTimelineOpenChange}
                        renderExecutionTimelinePanel={(onClose) => (
                            <ExecutionTimelineDock
                                projection={executionTimelineProjection}
                                model={executionTimelineModel}
                                focusedMessageId={focusedMessageId}
                                selectedNodeIds={nodeSelection.selectedNodeIds}
                                currentThreadRootId={threadGraphScope.activeThreadRootId}
                                threadRootIdByMessageId={threadRootIndex.threadRootIdByMessageId}
                                onFocusMessage={(messageId) => {
                                    handleFocus(messageId, {
                                        pointerDownAt: null,
                                        clickAt: performance.now(),
                                        metadata: { via: 'execution-timeline' },
                                    });
                                }}
                                onSelectMessage={handleSelect}
                                onContextMenuMessage={handleNodeContextMenu}
                                onClose={onClose}
                            />
                        )}
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
                        selectedNodeTypes={tagFilter.selectedNodeTypes}
                        agentOperator={tagFilter.agentOperator}
                        onAgentOperatorChange={tagFilter.setAgentOperator}
                        onAgentFilterChange={tagFilter.handleAgentFilterChange}
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
                        insightInboxCount={attentionInboxCount}
                        insightsEnabled={insightsEnabled}
                        insightsVisible={insightsVisible}
                        showInsightsInGraph={showInsightsInGraph}
                        onToggleInsightsEnabled={toggleInsightsEnabled}
                        onToggleInsightsVisible={toggleInsightsVisible}
                        onToggleShowInsightsInGraph={toggleShowInsightsInGraph}
                        renderInsightPanel={(onClose) => (
                            <InsightPanel
                                insights={insights}
                                candidates={insightCandidates}
                                focusedMessageId={focusedMessageId}
                                onToggleVisibility={onClose}
                                onDismissInsight={(insightId) => {
                                    void insightControls.dismissInsight(insightId);
                                }}
                                onViewInsight={(insight) => {
                                    void insightControls.recordInsightFeedback(insight.id, 'seen', { source: 'view-source' });
                                    onClose();
                                    if (insight.parentNodeId) handleFocus(insight.parentNodeId);
                                }}
                                onPromoteToBranch={(insight) => {
                                    onClose();
                                    if (insight.parentNodeId) handleFocus(insight.parentNodeId);
                                }}
                                onViewSource={(parentNodeId) => {
                                    onClose();
                                    handleFocus(parentNodeId);
                                }}
                                onRecordFeedback={(insightId, action, context) => {
                                    void insightControls.recordInsightFeedback(insightId, action, context);
                                }}
                            />
                        )}
                        threadItems={threadIndexItems}
                        onThreadFocus={handleFocusThread}
                        onThreadDoneChange={handleThreadDoneChange}
                        doneThreadsCollapsed={doneThreadsCollapsed}
                        onDoneThreadsCollapsedChange={handleDoneThreadsCollapsedChange}
	                        leafNodes={leafNodeNavigationItems}
	                        allLeafNodes={allLeafNodeNavigationItems}
	                        onLeafNodeFocus={handleLeafNodeFocus}
	                        highlightItems={highlightNavigationItems}
	                        activeHighlightId={activeHighlightPreview?.id ?? null}
	                        onHighlightFocus={handleHighlightFocus}
	                        onHighlightDelete={handleHighlightDelete}
	                        mergeSourceCount={mergeSourceCount}
                        mergeRunIndicator={mergeRunIndicator}
                        mergeAttentionNonce={mergeAttentionNonce}
                        renderMergePanel={(onClose) => (
                            <React.Suspense fallback={<GraphMergePanelLoading />}>
                                <GraphMergePanel onClose={onClose} />
                            </React.Suspense>
                        )}
                    />
                    <TrackedBranchesPanel
                        workspaceId={selectedWorkspaceId}
                        repoPath={repoPath}
                    />
                </>
            )}

            {/* Content Area */}
            <div className="relative flex-1 overflow-hidden">
                <div className="relative h-full w-full">
                {hiddenGraphFilterCount > 0 ? (
                    <div className="absolute right-4 top-4 z-40 flex items-center gap-2 rounded-full border border-amber-300/80 bg-amber-50/[0.94] px-3 py-2 text-xs text-amber-900 shadow-sm backdrop-blur-md dark:border-amber-700/80 dark:bg-amber-950/[0.88] dark:text-amber-100">
                        <span className="font-semibold tabular-nums">
                            {hiddenGraphFilterCount} hidden {hiddenGraphFilterCount === 1 ? 'graph filter' : 'graph filters'}
                        </span>
                        <button
                            type="button"
                            onClick={() => {
                                setHiddenSubgraphRootIds(new Set());
                            }}
                            className="rounded-full bg-amber-100 px-2 py-1 font-medium text-amber-950 transition-colors hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-50 dark:hover:bg-amber-800"
                        >
                            Restore
                        </button>
                    </div>
                ) : null}
                {subgraphRootNodeId && subgraphRootMessage ? (
                    <div className="absolute left-4 top-4 z-40 flex max-w-[min(720px,calc(100%-2rem))] items-center gap-2 rounded-full border border-slate-200/80 bg-white/[0.92] px-3 py-2 text-xs text-slate-700 shadow-sm backdrop-blur-md dark:border-slate-700/80 dark:bg-slate-950/[0.88] dark:text-slate-200">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-950">
                            <GitBranch className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 truncate">
                            <span className="font-semibold text-slate-950 dark:text-slate-50">{subgraphFocusLabel}</span>
                            <span className="mx-1.5 text-slate-400">/</span>
                            <span title={subgraphRootLabel}>{subgraphRootLabel}</span>
                        </span>
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 font-medium tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            {subgraphStats.nodes} {subgraphStats.nodes === 1 ? 'node' : 'nodes'}, {subgraphStats.commits} {subgraphStats.commits === 1 ? 'commit' : 'commits'}
                        </span>
                        <button
                            type="button"
                            onClick={() => setSubgraphRootNodeId(null)}
                            className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                            aria-label="Exit subgraph view"
                            title="Exit subgraph view"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                ) : null}
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
                        <MessageHighlightActiveProvider activeHighlightId={activeHighlightPreview?.id ?? null}>
                            <GraphHoverProjectionContext.Provider
                                value={{
                                    messages: visibleGraphMessages as Message[],
                                    summaries: scopedSummaries as Summary[],
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
                                            nodes={graphNodesForReactFlow}
                                            edges={graphRenderElements.edges}
                                            nodeTypes={graphNodeTypes}
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
                                                const shouldStartViewportInteraction = shouldTreatGraphMoveAsViewportInteraction({
                                                    eventType: event?.type,
                                                    eventTargetIsNode: Boolean(pointerEventTargetIsNode),
                                                    programmaticFocusCenterActive: programmaticFocusCenterActiveRef.current,
                                                });
                                                if (!shouldStartViewportInteraction) {
                                                    recordPerfEvent('graph.viewport-move.start.ignored', {
                                                        reason: pointerEventTargetIsNode ? 'node-target' : 'focus-center',
                                                        eventType: event?.type ?? null,
                                                        targetDataId: target?.getAttribute('data-id') ?? null,
                                                        programmaticFocusCenterActive: programmaticFocusCenterActiveRef.current,
                                                    }, { source: 'GraphView' });
                                                    return;
                                                }
                                                const sourceLayer = event?.type === 'wheel'
                                                    ? (event.ctrlKey ? 'wheel-pinch' : 'wheel-pan')
                                                        : event?.type === 'touchstart'
                                                            ? 'touch-gesture'
                                                            : 'react-flow';
                                                dispatchGraphComposerDockCollapse();
                                                ensureViewportInteractionStarted(viewport, sourceLayer);
                                                if (graphRenderElements.mode === 'hold-visible') {
                                                    scheduleActiveGraphWindowUpdate('move-start', false);
                                                }
                                            }}
                                            onMove={(event, viewport) => {
                                                if (shouldClampViewportDuringMove({
                                                    eventType: event?.type,
                                                    isViewportInteracting: isViewportInteractingRef.current,
                                                })) {
                                                    const clampedViewport = clampViewportToGraphBounds(viewport);
                                                    if (
                                                        clampedViewport.x !== viewport.x ||
                                                        clampedViewport.y !== viewport.y ||
                                                        clampedViewport.zoom !== viewport.zoom
                                                    ) {
                                                        reactFlowInstance.setViewport(clampedViewport, { duration: 0 });
                                                    }
                                                }
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
                                                const clampedViewport = clampViewportToGraphBounds(viewport);
                                                if (
                                                    clampedViewport.x !== viewport.x ||
                                                    clampedViewport.y !== viewport.y ||
                                                    clampedViewport.zoom !== viewport.zoom
                                                ) {
                                                    reactFlowInstance.setViewport(clampedViewport, { duration: 0 });
                                                }
                                                stopViewportInteraction(clampedViewport);
                                                saveViewportForActiveThread(clampedViewport);
                                                scheduleGraphDetailZoomBucketUpdate(120);
                                                if (graphRenderElements.mode === 'hold-visible') {
                                                    scheduleActiveGraphWindowUpdate('move-end', false);
                                                }
                                            }}
                                            fitView={!sendFlowGraphDiagFlags.disableGraphAutoCenter && !focusedMessageId}
                                            fitViewOptions={{ padding: 0.28, duration: 400 }}
                                            onlyRenderVisibleElements={graphRenderElements.mode !== 'hold-visible' && !sendFlowGraphDiagFlags.disableOnlyRenderVisibleElements && shouldLetReactFlowCullVisibleElements}
                                            nodesDraggable={false}
                                            nodesConnectable={false}
                                            nodesFocusable={false}
                                            edgesFocusable={false}
                                            disableKeyboardA11y
                                            autoPanOnNodeFocus={false}
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
                                            translateExtent={graphTranslateExtent}
                                            className="agentree-react-flow-root"
                                            style={{ width: '100%', height: '100%' }}
                                        >
                                            <ThreadBandOverlay
                                                bands={threadBands}
                                                currentThreadRootId={currentThreadRootId}
                                                threadItems={threadIndexItems}
                                            />
                                            <Controls showInteractive={false}>
                                                <ControlButton
                                                    className="agentree-graph-node-nav-control"
                                                    aria-label="Previous node"
                                                    title="Previous node"
                                                    disabled={!previousGraphNodeId}
                                                    onClick={() => {
                                                        if (previousGraphNodeId) {
                                                            handleFocusGraphNavigationNode(previousGraphNodeId, 'previous-node');
                                                        }
                                                    }}
                                                >
                                                    <ChevronLeft size={14} strokeWidth={2.25} />
                                                </ControlButton>
                                                <ControlButton
                                                    className="agentree-graph-node-nav-control"
                                                    aria-label="Next node"
                                                    title="Next node"
                                                    disabled={!nextGraphNodeId}
                                                    onClick={() => {
                                                        if (nextGraphNodeId) {
                                                            handleFocusGraphNavigationNode(nextGraphNodeId, 'next-node');
                                                        }
                                                    }}
                                                >
                                                    <ChevronRight size={14} strokeWidth={2.25} />
                                                </ControlButton>
                                                <ControlButton
                                                    className="agentree-graph-node-nav-control"
                                                    aria-label="Latest node"
                                                    title="Latest node"
                                                    disabled={!canFocusLatestGraphNode}
                                                    onClick={() => {
                                                        if (latestGraphNodeId) {
                                                            handleFocusGraphNavigationNode(latestGraphNodeId, 'latest-node');
                                                        }
                                                    }}
                                                >
                                                    <ChevronsRight size={14} strokeWidth={2.25} />
                                                </ControlButton>
                                            </Controls>
                                        </ReactFlow>
                                    </Profiler>
                                )}
                            </div>
                            </GraphHoverProjectionContext.Provider>
                        </MessageHighlightActiveProvider>
                        </GraphInteractionContext.Provider>
                        {!sendFlowGraphDiagFlags.disableGraphSurface && (
                            <>
                                <MiniMapPanel
                                    graphNodes={branchNodesForRender}
                                    graphEdges={graphEdgesForRender}
                                    threadRootIdByMessageId={threadGraphScope.isThreadScoped ? new Map() : threadRootIndex.threadRootIdByMessageId}
                                />
	                                <GraphCanvasIndexPanel
	                                    isVisible={isIndexVisible}
	                                    onToggleVisible={setIsIndexVisible}
                                    onPreviewEdgeType={handlePreviewEdgeType}
                                    visibleEdgeTypes={visibleEdgeTypes}
                                    onToggleEdgeType={handleToggleEdgeType}
                                    visibleNodeSections={visibleNodeSections}
                                    onToggleNodeSection={handleToggleNodeSection}
                                    nodeSectionCounts={graphNodeSectionCounts}
	                                    messages={scopedGraphMessages as Message[]}
	                                    agentLabelsById={agentLabelsById}
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
                    <div className="h-full w-full bg-[hsl(var(--app-bg))]">
                        <ListView
                            projection={workspaceProjection}
                            focusedMessageId={focusedMessageId}
                            onNodeClick={handleNodeClick}
                            filterActive={graphFilterState.filterActive}
                            matchingMessageIds={graphFilterState.matchingMessageIds}
                            topOffset={controlsHeight}
                            onStopAgent={handleStopAgent}
                            selectedNodeIds={nodeSelection.selectedNodeIds}
                            onSelectionChange={nodeSelection.onSelectionChange}
                            onRequestDeleteMessages={(messageIds) => {
                                openBulkDeleteDialog(messageIds);
                            }}
                            onAddCommitsToMergePanel={handleAddCommitsToMergePanel}
                            onMarkThreadDone={(threadRootId) => handleThreadDoneChange(threadRootId, true)}
                        />
                    </div>
                )}
                </div>
            </div>

            <NodeContextMenu
                contextMenu={nodeContextMenu}
                projection={workspaceProjection}
                onClose={() => setNodeContextMenu(null)}
                onDeleteMessages={(messageIds) => {
                    openBulkDeleteDialog(messageIds);
                }}
                onDeleteTargets={({ messageIds, commitShas }) => {
                    openBulkDeleteDialog(messageIds, commitShas);
                }}
                onAddCommitsToMergePanel={handleAddCommitsToMergePanel}
                onAddCommitShasToMergePanel={handleAddCommitShasToMergePanel}
                onAddCommitToNode={setAddCommitTargetId}
                onFocusThread={handleFocusThread}
                onMarkThreadDone={(threadRootId) => handleThreadDoneChange(threadRootId, true)}
                onHideSubgraph={handleHideSubgraph}
                onViewSubgraph={handleViewSubgraph}
                onConvertSubgraphToThread={handleConvertSubgraphToThread}
                onShareNode={handleShareNode}
            />
            <AlertDialog
                open={pendingShareNodeId !== null}
                onOpenChange={(open) => {
                    if (!open && !isEnablingShare) setPendingShareNodeId(null);
                }}
            >
                <AlertDialogContent className="sm:max-w-[460px]">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Enable cloud sync to share?</AlertDialogTitle>
                        <AlertDialogDescription className="space-y-2">
                            <span className="block">
                                Agentree will upload this workspace's conversation graph and keep future changes synced.
                            </span>
                            <span className="block">
                                The shared link is unlisted, not private: anyone with the link can view the selected node and its descendants.
                            </span>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isEnablingShare}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={isEnablingShare}
                            onClick={(event) => {
                                event.preventDefault();
                                void confirmWorkspaceSyncAndShare();
                            }}
                        >
                            {isEnablingShare ? 'Syncing workspace…' : 'Enable sync & share'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
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
