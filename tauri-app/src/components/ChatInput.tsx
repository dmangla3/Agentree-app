import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '../../@/components/ui/button';
import { Send, X, Reply, FileText, FileTextIcon, GitBranchIcon, Loader2, ChevronDown, Bot, Check, Pencil, AtSign, RotateCcw, Plus, Minus, Search, GitCommitHorizontal, Shield } from 'lucide-react';
import { buildComposerDraftKey, useWorkspaceStore, AttachmentMetadata, Message, Workspace, CommitEntity } from '../stores/workspaceStore';
import { useAgentRunProjectionStore, type AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import { useProviderLimitsStore } from '../stores/providerLimitsStore';
import { useOrchestrationTemplateStore } from '../stores/orchestrationTemplateStore';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import { isLoginProfileActive, resolveLoginProfileSelection } from '../lib/loginProfiles';
import { isNoAgentSessionFoundError, markStaleLocalAgentNodeCancelled } from '../lib/localAgentRunTerminal';
import { useQueryClient } from '@tanstack/react-query';
import { UnifiedAgentModelSelector } from './UnifiedAgentModelSelector';
import { AttachmentPreview } from './AttachmentPreview';
import { Badge } from "../../@/components/ui/badge";
import { Alert, AlertDescription } from "../../@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../@/components/ui/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "../../@/components/ui/dropdown-menu";
import { useToast } from './Toast';
import { cn } from '../lib/utils';
import {
    getChatInputSurfaceClasses,
    getChatInputSurfaceLabel,
    type ChatInputSurface,
} from '../lib/chatInputSurface';
import axios from 'axios';
import { AGENTREE_DATA_PLANE_ENABLED, api } from '../lib/api';
import { getOptionalCloudAuthToken } from '../lib/authSession';
import { getMessageById, resolveNodeCommit } from '../lib/gitNodeUtils';
import {
    analyticsFailureCategory,
    bucketCharacterCount,
    bucketCount,
    track,
    trackAgentRunFailed,
    trackAgentRunStarted,
} from '../lib/analytics';
import { buildAgentRunContextManifest } from '../lib/agentRunLaunchContext';
import { ScrollArea } from "../../@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverAnchor, PopoverTrigger } from '../../@/components/ui/popover'; // Added Popover components
import { Checkbox } from '../../@/components/ui/checkbox';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../@/components/ui/hover-card';
import { useShallow } from 'zustand/react/shallow';
import { branchKeys } from '../hooks/useBranches';
import { primeHotSendMessageDeltaCursor } from '../hooks/useHotSendMessageDeltas';
import { isFirstClassCommitMessage } from '../lib/graph/turnUtils';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import { getMergeVisualParentEntries, isMergeResultNode } from '../lib/graph/lineage';
import { reconstructContext } from '../lib/contextUtils';
import { resolveLocalWorkspaceRepoPath } from '../lib/workspaceRepoPath';
import {
    resolveComposerTargetModeAfterSuccessfulSend,
    resolveSendParentMessageId,
    type ComposerTargetMode,
} from '../lib/composerSendParent';
import {
    buildComposerCommitPickerItems,
    buildComposerCommitPickerChipItems,
    resolveComposerDefaultBaseCommit,
    shortCommitSha,
    type ComposerBaseMessage,
    type ComposerCommitPickerCommit,
} from '../lib/composerBaseCommit';
import { buildLiveGitRefs, getComposerBaseSnapshotGitRefs } from '../lib/liveGitRefs';
import {
    createComposerSendStartGate,
    finishComposerSendStart,
    shouldShowComposerCancel,
    tryBeginComposerSendStart,
    type ActiveComposerSend,
} from '../lib/composerCancelState';
import { waitForOptimisticSendPaint } from '../lib/composerSendPaint';
import {
    buildRepoMentionSearchIndex,
    getMentionedRepoPathSet,
    getRepoMentionMatches,
    type RepoMentionFile,
} from '../lib/composerRepoMentions';
import { hasFreshContextBoundary } from '../lib/messageContext';
import { getLegacyThreadIdForMessage, getMessageThreadSessionId } from '../lib/threadSessions';
import {
    COMPOSER_PERMISSION_OPTIONS,
    DEFAULT_COMPOSER_PERMISSION_MODE,
    getComposerPermissionOption,
    type ComposerPermissionMode,
} from '../lib/composerPermissions';
import { parseRuntimeCliArgs } from '../lib/agentRuntimeArgs';
import { appendInputArtifactsToPrompt } from '../lib/artifacts';
import {
    scheduleMessagesRefreshWhenGraphIdle,
} from '../lib/graphInteractionGate';
import { isSteerableAssistantNode } from '../lib/agentRunSteering';
import { createSendFlowId, recordSendFlowEvent, recordSendFlowMark } from '../perf/sendFlow';
import { withRuntimeActivity } from '../perf/runtimeActivityContext';
import {
    clearAgentRunVisibilityTrace,
    registerAgentRunVisibilityTrace,
} from '../perf/agentRunVisibilityPerf';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { getEnabledTrackedGitRefs, useGitRefSnapshot } from '../hooks/useGitRefSnapshot';
import {
    materializePersistedOptimisticUserMessage,
    shouldClearPersistedOptimisticUserProjection,
} from '../agent-runs/agentRunOptimisticProjectionCleanup';
import {
    trackAgentRunLiveStreamMessage,
    untrackAgentRunLiveStreamNode,
} from '../agent-runs/agentRunLiveStreamCoordinator';
import { commands } from '../generated/tauri-bindings';
import { TemplateMentionTextarea } from './composer/TemplateMentionTextarea';


// --- Types ---
type AttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';
interface FileAttachment {
    id: string;
    file: File;
    status: AttachmentStatus;
    path?: string;
    publicUrl?: string | null;
    localPath?: string | null;
    sizeBytes?: number | null;
    width?: number | null;
    height?: number | null;
    error?: string;
    objectUrl?: string; // Local preview URL
}
interface UrlAttachment {
    id: string;
    url: string;
    status: 'attached';
}
type Attachment = FileAttachment | UrlAttachment | AttachmentMetadata;
type ContextMode = 'active' | 'none';
type ContextPolicy = 'continue' | 'fresh';
type PendingGeneratedCommitFocus = {
    flowId: string | null;
    workspaceId: string;
    targetMessageId: string;
    assistantMessageId: string;
    commitSha: string | null;
    allowedFocusIds: string[];
    queuedAt: number;
};

const getAttachmentId = (attachment: Attachment) => {
    if ('id' in attachment) return attachment.id;
    return attachment.path;
};

const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
        if (typeof reader.result === 'string') {
            resolve(reader.result);
        } else {
            reject(new Error('Could not read attachment as data URL.'));
        }
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read attachment.'));
    reader.readAsDataURL(file);
});

const getImageDimensions = (objectUrl: string | undefined): Promise<{ width: number; height: number } | null> => new Promise((resolve) => {
    if (!objectUrl) {
        resolve(null);
        return;
    }
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = objectUrl;
});

interface WorktreeRuntimeInfo {
    worktreePath: string;
    branchName: string;
    parentCommit: string;
    repoPath: string;
}

interface QueuedComposerSend {
    id: string;
    prompt: string;
    attachments: Attachment[];
    contextIds: string[];
    editDraftSource: Message | null;
    parentMessageId: string | null;
    draftTargetId: string | null;
    queuedAt: number;
}

interface ActiveFileMention {
    start: number;
    end: number;
    query: string;
}

// --- Constants ---
const STREAM_DEBUG_ENABLED = ['1', 'true', 'yes'].includes(String(import.meta.env.VITE_STREAM_DEBUG || '').toLowerCase());
const SEND_FLOW_DEBUG_ENABLED = ['1', 'true', 'yes'].includes(String(import.meta.env.VITE_SEND_FLOW_DEBUG || '').toLowerCase()) || STREAM_DEBUG_ENABLED;
const UI_DEBUG_PREFIX = '[UIFLOW]';
const UI_DEBUG_ENABLED = ['1', 'true', 'yes'].includes(String(import.meta.env.VITE_UI_FLOW_DEBUG || '').toLowerCase()) || STREAM_DEBUG_ENABLED;
const uiDebug = (message: string, details?: Record<string, unknown>) => {
    if (!UI_DEBUG_ENABLED) return;
    if (details) {
        console.log(`${UI_DEBUG_PREFIX} ${message}`, details);
        return;
    }
    console.log(`${UI_DEBUG_PREFIX} ${message}`);
};
const sendFlowDebug = (message: string, details?: Record<string, unknown>) => {
    if (!SEND_FLOW_DEBUG_ENABLED) return;
    if (details) {
        console.log(`[SEND_FLOW] ${message}`, details);
        return;
    }
    console.log(`[SEND_FLOW] ${message}`);
};

// --- Helpers ---
const truncateText = (text: string, maxLength: number = 50): string => { return text.length <= maxLength ? text : text.substring(0, maxLength).trim() + '...' };
const getActiveFileMention = (value: string, cursorPosition: number): ActiveFileMention | null => {
    const beforeCursor = value.slice(0, cursorPosition);
    const mentionMatch = beforeCursor.match(/(^|\s)@([^\s@]*)$/);

    if (!mentionMatch) return null;

    const query = mentionMatch[2] ?? '';
    return {
        start: beforeCursor.length - query.length - 1,
        end: cursorPosition,
        query,
    };
};
const normalizePreviewText = (value: string | null | undefined): string => (
    String(value || '').replace(/\s+/g, ' ').trim()
);
const isOpaqueIdentifier = (value: string): boolean => (
    /^[a-f0-9]{7,40}$/i.test(value) || /^[a-z0-9_-]{20,}$/i.test(value)
);
const getMessagePreviewText = (message: Message | null | undefined): string | null => {
    if (!message) return null;
    const meta = ((message.execution_data?.meta || {}) as Record<string, unknown>);
    const candidates = [
        message.content,
        message.aiLabel,
        typeof meta.commit_message === 'string' ? meta.commit_message : null,
        message.git_branch_name,
    ];

    for (const candidate of candidates) {
        const normalized = normalizePreviewText(candidate);
        if (normalized && !isOpaqueIdentifier(normalized)) return normalized;
    }

    return null;
};
const formatContextParentLabel = (message: Message | null | undefined, fallback: string = 'Parent'): string => (
    truncateText(getMessagePreviewText(message) || fallback, 42)
);
const formatCommitRelationLabel = (relation: string, isDefault: boolean): string => {
    if (isDefault) return 'Default';
    if (relation === 'earlier') return 'Earlier';
    if (relation === 'later') return 'Later';
    if (relation === 'ref') return 'Ref';
    return 'Commit';
};

const resolveConversationContextMessage = (
    startId: string | null | undefined,
    messageMap: Map<string, Message>
): Message | null => {
    let cursorId = startId ?? null;
    const visited = new Set<string>();

    while (cursorId && !visited.has(cursorId)) {
        visited.add(cursorId);
        const message = messageMap.get(cursorId);
        if (!message) return null;
        if (!isFirstClassCommitMessage(message, { messageMap })) {
            return message;
        }
        cursorId = message.parentId ?? null;
    }

    return null;
};

const resolveContextStartMessage = (
    endId: string | null | undefined,
    messages: Message[],
    messageMap: Map<string, Message>
): Message | null => {
    if (!endId) return null;
    const path = reconstructContext(endId, messages)
        .map((message) => resolveConversationContextMessage(message.id, messageMap))
        .filter((message): message is Message => Boolean(message));
    const contextMessages = path.filter((message, index) => (
        path.findIndex((candidate) => candidate.id === message.id) === index
    ));
    if (contextMessages.length === 0) return null;

    let latestFreshStart: Message | null = null;
    for (const message of contextMessages) {
        if (!hasFreshContextBoundary(message)) continue;
        if (message.role === 'assistant') {
            latestFreshStart = message.parentId ? messageMap.get(message.parentId) ?? message : message;
        } else {
            latestFreshStart = message;
        }
    }

    return latestFreshStart ?? contextMessages[0] ?? null;
};

import { useMessages, useSendMessage, useCommitDescendants, useCommitAncestors } from '../hooks/useMessages';
import { useCreateThreadSession } from '../hooks/useThreadSessions';
import { useWorkspaceMessages } from '../hooks/useLiveMessages';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, useLocalNodes, type LocalNodeMessage } from '../hooks/useLocalNodes';

import { useKnowledgeTree } from '../hooks/useKnowledge';
import { useAgents, findDefaultCodexAgentId } from '../hooks/useAgents';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useCommits } from '../hooks/useCommits';
import { useTrackedRefs } from '../hooks/useTrackedRefs';
import { agentClient } from '../lib/agentClient';
import { resolveComposerDefaultAgentId } from '../lib/composerModelDefaults';
import { AGENT_STATUS, isActiveAgentStatus, isTerminalAgentStatus } from '@shared/agentStatus';
import { createOptimisticAssistantMessage, createOptimisticNodePair, categorizeError, formatErrorMessage, isOptimisticId } from '../lib/optimisticMessages';
import { describeCheckoutFailure } from '../lib/checkoutFailure';
import {
    buildComposerAgentTurnTopology,
    buildComposerAgentRuns,
    normalizeComposerAgentRunCounts,
    updateComposerAgentRunCount,
    type ComposerAgentRunCounts,
} from '../lib/composerAgentRuns';
import { resolveNodeState } from '../lib/runStateResolver';

interface ChatInputProps {
    parentMessageIdOverride?: string | null;
    autoFocus?: boolean;
    onRequestClose?: () => void;
    onSendComplete?: () => void;
    surface?: ChatInputSurface;
}

interface ContextBadgeProps {
    fileId: string;
    fileName: string;
    onRemove: (id: string) => void;
}

const ContextBadge = React.memo(function ContextBadge({ fileId, fileName, onRemove }: ContextBadgeProps) {
    return (
        <Badge variant="outline" className="flex h-7 items-center gap-1.5 rounded-md border-[hsl(var(--app-border))] bg-[hsl(var(--app-bg-muted))] py-1 pl-2 pr-1 text-[11px] font-medium text-[hsl(var(--app-text-soft))] shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <FileText size={12} />
            <span className="max-w-[150px] truncate">{fileName}</span>
            <button onClick={() => onRemove(fileId)} className="ml-1 rounded-sm p-0.5 transition-colors hover:bg-[hsl(var(--app-border))]">
                <X size={12} />
            </button>
        </Badge>
    );
});

const areAgentRunCountsEqual = (left: ComposerAgentRunCounts, right: ComposerAgentRunCounts) => {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => left[key] === right[key]);
};

// --- Component ---
export function ChatInput({
    parentMessageIdOverride,
    autoFocus = false,
    onRequestClose,
    onSendComplete,
    surface = 'chat-panel',
}: ChatInputProps = {}) {
    const [prompt, setPrompt] = useState('');
    const promptRef = useRef('');
    const [promptHasContent, setPromptHasContent] = useState(false);
    const [editDraftSource, setEditDraftSource] = useState<Message | null>(null);
    // --- NEW: Knowledge Base Context State ---
    const { data: filesData } = useKnowledgeTree();
    const files = useMemo(() => filesData ?? [], [filesData]);
    const filesMap = useMemo(() => new Map(files.map(f => [f.id, f])), [files]);
    const [contextIds, setContextIds] = useState<string[]>([]);
    const [repoMentionFiles, setRepoMentionFiles] = useState<RepoMentionFile[]>([]);
    const orchestrationTemplates = useOrchestrationTemplateStore((state) => state.templates);
    const [selectedBaseCommit, setSelectedBaseCommit] = useState<CommitEntity | null>(null);
    const [baseCommitSearch, setBaseCommitSearch] = useState('');
    const [activeFileMention, setActiveFileMention] = useState<ActiveFileMention | null>(null);
    const [activeFileMentionIndex, setActiveFileMentionIndex] = useState(0);
    const [contextFetchError, _setContextFetchError] = useState<string | null>(null);
    const contextMode: ContextMode = 'active';
    const refreshLoginProfiles = useLoginProfilesStore((state) => state.refresh);

    const {
        selectedWorkspaceId,
        focusedMessageId,
        lastFocusSource,
        lastFocusMetadata,
        composerBaseCommitOverride,
        autoCheckoutOnAgentCommit,
        beginSendFlowFocus,
        advanceSendFlowFocus,
        endSendFlowFocus,
        dispatchFocus,
        setAutoCheckoutOnAgentCommit,
        selectedAgentId,
        setSelectedAgentId,
        setComposerContextPreview,
        setComposerBaseCommitOverride,
        composerDraftByWorkspace,
        setComposerDraft,
        clearComposerDraft,
    } = useWorkspaceStore(
        useShallow((state) => ({
            selectedWorkspaceId: state.selectedWorkspaceId,
            focusedMessageId: state.focusedMessageId,
            lastFocusSource: state.lastFocusSource,
            lastFocusMetadata: state.lastFocusMetadata,
            composerBaseCommitOverride: state.composerBaseCommitOverride,
            autoCheckoutOnAgentCommit: state.autoCheckoutOnAgentCommit,
            beginSendFlowFocus: state.beginSendFlowFocus,
            advanceSendFlowFocus: state.advanceSendFlowFocus,
            endSendFlowFocus: state.endSendFlowFocus,
            dispatchFocus: state.dispatchFocus,
            setAutoCheckoutOnAgentCommit: state.setAutoCheckoutOnAgentCommit,
            selectedAgentId: state.selectedAgentId,
            setSelectedAgentId: state.setSelectedAgentId,
            setComposerContextPreview: state.setComposerContextPreview,
            setComposerBaseCommitOverride: state.setComposerBaseCommitOverride,
            composerDraftByWorkspace: state.composerDraftByWorkspace,
            setComposerDraft: state.setComposerDraft,
            clearComposerDraft: state.clearComposerDraft,
        }))
    );

    useEffect(() => {
        void refreshLoginProfiles();
    }, [refreshLoginProfiles]);
    const surfaceClasses = getChatInputSurfaceClasses(surface);
    const surfaceLabel = getChatInputSurfaceLabel(surface);
    // Optimistic send setup creates projected-message inputs, but lifecycle
    // ownership starts as soon as they are seeded into AgentRunActor.
    const seedAgentRunProjection = useCallback((nodeId: string, message: AgentRunProjectedMessage | null) => {
        if (message) {
            agentRunManager.seed(message);
            return;
        }
        agentRunManager.cleanup(nodeId);
    }, []);
    const cleanupAgentRunProjection = useCallback((nodeId: string) => {
        agentRunManager.cleanup(nodeId);
    }, []);
    const replaceOptimisticNode = useCallback((optimisticId: string, realNode: Message) => {
        agentRunManager.replaceNode(optimisticId, realNode);
    }, []);
    const removeOptimisticNode = useCallback((nodeId: string) => {
        agentRunManager.cleanup(nodeId);
    }, []);
    const markNodeFailed = useCallback((nodeId: string, error: string) => {
        agentRunManager.dispatch(nodeId, { type: 'terminal', status: AGENT_STATUS.failed, reason: error });
    }, []);
    const setSetupProgress = useCallback((nodeId: string, progress: string) => {
        agentRunManager.dispatch(nodeId, { type: 'setup_progress', progress });
    }, []);
    const setNodeStatus = useCallback((nodeId: string, status: AgentRunProjectedMessage['_optimisticStatus']) => {
        if (status) {
            agentRunManager.dispatch(nodeId, { type: 'status', status: status as any });
        }
    }, []);
    const hasPendingOptimisticSend = useAgentRunProjectionStore((state) =>
        Object.values(state.projectionsById).some((msg) =>
            msg._optimistic === true && msg._optimisticStatus === 'pending'
        )
    );
    const { addToast } = useToast();
    const commitFocusHandledByFlowRef = useRef(new Set<string>());

    // Get workspaces to access folderPath for agent working directory
    const { data: workspacesData } = useWorkspaces();
    const workspaces = useMemo(
        () => (workspacesData ?? []) as Workspace[],
        [workspacesData]
    );
    const selectedWorkspace = useMemo(() =>
        workspaces.find((c: Workspace) => c.id === selectedWorkspaceId),
        [workspaces, selectedWorkspaceId]
    );
    const selectedWorkspaceRepoPath = useMemo(
        () => resolveLocalWorkspaceRepoPath(selectedWorkspace),
        [selectedWorkspace]
    );
    const localCommitChoicesQuery = useCommits({
        repoPath: selectedWorkspaceRepoPath,
        workspaceId: selectedWorkspaceId,
        limit: 160,
    });
    const trackedRefsQuery = useTrackedRefs(selectedWorkspaceId);
    const enabledTrackedGitRefs = useMemo(
        () => getEnabledTrackedGitRefs(trackedRefsQuery.data ?? []),
        [trackedRefsQuery.data]
    );
    const composerBaseSnapshotGitRefs = useMemo(
        () => getComposerBaseSnapshotGitRefs(enabledTrackedGitRefs),
        [enabledTrackedGitRefs]
    );
    const gitRefSnapshotQuery = useGitRefSnapshot(selectedWorkspaceRepoPath, composerBaseSnapshotGitRefs);
    const [contextPolicy, setContextPolicy] = useState<ContextPolicy>('continue');
    const [permissionMode, setPermissionMode] = useState<ComposerPermissionMode>(DEFAULT_COMPOSER_PERMISSION_MODE);
    const [composerTargetMode, setComposerTargetMode] = useState<ComposerTargetMode>('reply');
    const [sendPressFeedback, setSendPressFeedback] = useState(false);
    const sendPressFeedbackTimerRef = useRef<number | null>(null);
    const resetComposerTargetAfterSuccessfulSend = useCallback(() => {
        setComposerTargetMode((current) => resolveComposerTargetModeAfterSuccessfulSend(current));
    }, []);

    useEffect(() => {
        return () => {
            if (sendPressFeedbackTimerRef.current !== null) {
                window.clearTimeout(sendPressFeedbackTimerRef.current);
            }
        };
    }, []);

    const { data: messagesData } = useMessages(selectedWorkspaceId);
    const localNodesQuery = useLocalNodes(selectedWorkspaceId);
    const persistedMessages = useMemo(
        () => (messagesData ?? []) as Message[],
        [messagesData]
    );
    const messages = useWorkspaceMessages(selectedWorkspaceId, persistedMessages, localNodesQuery.data);
    const messageLookupMessages = messages;
    const { data: agentsData } = useAgents();
    const agents = useMemo(() => agentsData ?? [], [agentsData]);
    const autoSelectedAgentIdRef = useRef<string | null>(null);
    const manuallySelectedAgentIdRef = useRef<string | null>(null);
    const [selectedAgentRunCounts, setSelectedAgentRunCounts] = useState<ComposerAgentRunCounts>({});
    const normalizedSelectedAgentRunCounts = useMemo(
        () => normalizeComposerAgentRunCounts(agents, selectedAgentId, selectedAgentRunCounts),
        [agents, selectedAgentId, selectedAgentRunCounts]
    );
    const selectedAgent = agents.find(a => a.id === selectedAgentId);
    const selectedAgentRuns = useMemo(
        () => buildComposerAgentRuns(agents, normalizedSelectedAgentRunCounts),
        [agents, normalizedSelectedAgentRunCounts]
    );
    const selectedAgentRunItems = useMemo(() => (
        selectedAgentRuns
            .map((run) => ({
                ...run,
                agent: agents.find((agent) => agent.id === run.agentId) ?? null,
            }))
            .filter((run): run is typeof run & { agent: NonNullable<typeof run.agent> } => run.agent != null)
    ), [agents, selectedAgentRuns]);
    const selectedAgentRunChips = useMemo(() => (
        agents
            .map((agent) => ({
                agent,
                count: normalizedSelectedAgentRunCounts[agent.id] ?? 0,
            }))
            .filter((entry) => entry.count > 0)
    ), [agents, normalizedSelectedAgentRunCounts]);
    const selectedRunTotal = selectedAgentRuns.length;
    const sendMessageMutation = useSendMessage();
    const createThreadSession = useCreateThreadSession();
    // Track agent setup operations separately from message sending
    const agentSetupControllersRef = useRef<Map<string, AbortController>>(new Map());
    const mcpSetupStateRef = useRef<{
        authToken: string;
        workspaceId: string;
        configured: boolean;
        promise: Promise<boolean> | null;
    } | null>(null);

    // Determine if we're in a "sending" state (optimistic or actual)
    const isSendingMessage = sendMessageMutation.isPending || hasPendingOptimisticSend;
    const sendAcceptanceInFlightRef = useRef(false);
    const queuedComposerSendsRef = useRef<QueuedComposerSend[]>([]);
    const queuedReplayInFlightRef = useRef(false);
    const queuedReplayPendingSendRef = useRef<QueuedComposerSend | null>(null);
    const handleSendRef = useRef<(() => Promise<void>) | null>(null);
    const [isSendAcceptanceInFlight, setIsSendAcceptanceInFlight] = useState(false);
    const [queuedComposerSendCount, setQueuedComposerSendCount] = useState(0);
    const [queuedReplayVersion, setQueuedReplayVersion] = useState(0);
    const queryClient = useQueryClient();

    const focusedCommitSha = useMemo(() => {
        if (lastFocusSource !== 'graph') return null;
        const metadataCommitSha = typeof lastFocusMetadata?.commitSha === 'string'
            ? lastFocusMetadata.commitSha.trim()
            : '';
        if (!metadataCommitSha) return null;
        return !focusedMessageId || focusedMessageId === metadataCommitSha ? metadataCommitSha : null;
    }, [focusedMessageId, lastFocusMetadata, lastFocusSource]);
    const isNewThreadTarget = composerTargetMode === 'new-thread' && !editDraftSource;
    const replyCandidateMessageId = parentMessageIdOverride !== undefined
        ? parentMessageIdOverride
        : focusedCommitSha
            ? null
            : focusedMessageId;
    const parentMessageId = isNewThreadTarget ? null : replyCandidateMessageId;
    const replyParentMessageId = editDraftSource
        ? (editDraftSource.parentId ?? null)
        : parentMessageId;
    const isRootComposerTarget = !replyParentMessageId;
    const selectedNodeId = editDraftSource
        ? replyParentMessageId
        : parentMessageIdOverride !== undefined
            ? parentMessageIdOverride
            : focusedMessageId;
    const composerDraftTargetId = editDraftSource?.id ?? replyParentMessageId ?? selectedNodeId ?? null;
    const composerDraftKey = buildComposerDraftKey(selectedWorkspaceId, composerDraftTargetId);
    const composerDraft = composerDraftKey ? composerDraftByWorkspace[composerDraftKey] ?? '' : '';
    const selectedNodeMessage = useMemo(
        () => (selectedNodeId ? messageLookupMessages.find((m: Message) => m.id === selectedNodeId) || null : null),
        [messageLookupMessages, selectedNodeId]
    );
    const selectedProjection = useAgentRunProjectionStore(
        useShallow((state) => {
            if (!selectedNodeId) return null;
            const message = state.projectionsById[selectedNodeId];
            if (!message) return null;
            return {
                id: message.id,
                workspaceId: message.workspaceId,
                parentId: message.parentId,
                role: message.role,
                status: message.status,
                _optimisticStatus: message._optimisticStatus,
                _optimistic: message._optimistic,
            };
        })
    );
    const selectedResolvedState = useMemo(
        () => resolveNodeState(selectedNodeMessage, selectedProjection as any),
        [selectedNodeMessage, selectedProjection]
    );
    const workspaceProjectionIds = useAgentRunProjectionStore(
        useShallow((state) =>
            Object.values(state.projectionsById)
                .filter((message) => message.workspaceId === selectedWorkspaceId)
                .map((message) => message.id)
                .sort()
        )
    );
    const isInProgressStatus = useCallback((status: string | null | undefined) => (
        isActiveAgentStatus(status)
    ), []);
    const selectedNodeRole = selectedProjection?.role ?? selectedNodeMessage?.role ?? null;
    const isSelectedNodeRunning = useMemo(() => {
        if (!selectedNodeId) return false;
        if (selectedNodeRole !== 'assistant') return false;
        return isInProgressStatus(selectedResolvedState.status);
    }, [isInProgressStatus, selectedNodeId, selectedNodeRole, selectedResolvedState.status]);

    const [attachments, setAttachments] = useState<Attachment[]>([]);
    // Removed isModelDialogOpen
    const [_isWebSearchEnabled] = useState(false); // Kept state but removed UI toggle
    const [currentAbortController, setCurrentAbortController] = useState<AbortController | null>(null);
    const [activeComposerSend, setActiveComposerSend] = useState<ActiveComposerSend | null>(null);
    const composerSendStartGateRef = useRef(createComposerSendStartGate());
    const latencyTraceRef = useRef<Map<string, {
        traceId: string;
        nodeId: string | null;
        authToken: string | null;
        marks: Map<string, Record<string, any>>;
        emitted: Set<string>;
    }>>(new Map());
    const sendFlowByKeyRef = useRef<Map<string, string>>(new Map());
    const pendingGeneratedCommitFocusByTargetRef = useRef<Map<string, PendingGeneratedCommitFocus>>(new Map());
    const unregisterStreamHandler = useCallback((nodeId: string) => {
        untrackAgentRunLiveStreamNode(nodeId);
    }, []);
    const assignSendFlowKey = useCallback((key: string | null | undefined, flowId: string | null | undefined) => {
        if (!key || !flowId) return;
        sendFlowByKeyRef.current.set(key, flowId);
    }, []);
    const releaseSendFlowKey = useCallback((key: string | null | undefined) => {
        if (!key) return;
        sendFlowByKeyRef.current.delete(key);
        clearAgentRunVisibilityTrace(key);
    }, []);
    const getSendFlowIdForKey = useCallback((key: string | null | undefined) => {
        if (!key) return null;
        return sendFlowByKeyRef.current.get(key) ?? null;
    }, []);
    const canAutoAdvanceSendFocus = useCallback((
        flowId: string | null | undefined,
        allowedCurrentFocusIds: Array<string | null | undefined>,
        details: Record<string, unknown> = {}
    ) => {
        if (!flowId) return false;
        const focusState = useWorkspaceStore.getState();
        const activeFlow = focusState.activeSendFlowFocus;
        if (!activeFlow || activeFlow.flowId !== flowId || activeFlow.workspaceId !== focusState.selectedWorkspaceId) {
            recordSendFlowEvent('focus.auto-advance-skipped', {
                flowId,
                reason: 'inactive-flow',
                focusedMessageId: focusState.focusedMessageId,
                focusSource: focusState.lastFocusSource,
                ...details,
            }, { source: 'ChatInput' });
            return false;
        }

        const metadataFlowId = typeof focusState.lastFocusMetadata?.flowId === 'string'
            ? focusState.lastFocusMetadata.flowId
            : null;
        const userMovedFocusAfterSendStarted =
            (focusState.lastFocusSource === 'graph' || focusState.lastFocusSource === 'chat' || focusState.lastFocusSource === 'list') &&
            focusState.focusNonce !== activeFlow.ownerFocusNonce &&
            metadataFlowId !== flowId;
        if (userMovedFocusAfterSendStarted) {
            recordSendFlowEvent('focus.auto-advance-skipped', {
                flowId,
                reason: 'manual-focus',
                focusedMessageId: focusState.focusedMessageId,
                focusSource: focusState.lastFocusSource,
                focusNonce: focusState.focusNonce,
                ownerFocusNonce: activeFlow.ownerFocusNonce,
                ...details,
            }, { source: 'ChatInput' });
            return false;
        }

        const allowedFocusIds = new Set([
            activeFlow.preferredMessageId,
            ...activeFlow.guardedMessageIds,
            ...allowedCurrentFocusIds,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0));
        const currentFocusStillOwned =
            !focusState.focusedMessageId ||
            allowedFocusIds.has(focusState.focusedMessageId) ||
            metadataFlowId === flowId;
        if (!currentFocusStillOwned) {
            recordSendFlowEvent('focus.auto-advance-skipped', {
                flowId,
                reason: 'foreign-focus',
                focusedMessageId: focusState.focusedMessageId,
                focusSource: focusState.lastFocusSource,
                allowedFocusIds: Array.from(allowedFocusIds),
                ...details,
            }, { source: 'ChatInput' });
            return false;
        }

        return true;
    }, []);
    const dispatchSendFlowFocus = useCallback((params: {
        flowId: string | null | undefined;
        messageId: string;
        phase: string;
        allowedCurrentFocusIds?: Array<string | null | undefined>;
        metadata?: Record<string, unknown>;
    }) => {
        if (!canAutoAdvanceSendFocus(params.flowId, params.allowedCurrentFocusIds ?? [], {
            targetMessageId: params.messageId,
            phase: params.phase,
        })) {
            return false;
        }
        dispatchFocus({
            messageId: params.messageId,
            source: 'composer',
            metadata: {
                phase: params.phase,
                flowId: params.flowId,
                ...(params.metadata ?? {}),
            },
        });
        return true;
    }, [canAutoAdvanceSendFocus, dispatchFocus]);
    const queueGeneratedCommitFocus = useCallback((params: {
        workspaceId: string;
        assistantMessageId: string;
        targetMessageId: string;
        commitSha?: string | null;
        flowId?: string | null;
    }) => {
        const focusState = useWorkspaceStore.getState();
        const flowId = params.flowId ?? getSendFlowIdForKey(params.assistantMessageId);
        const activeFlow = flowId && focusState.activeSendFlowFocus?.flowId === flowId
            ? focusState.activeSendFlowFocus
            : null;
        const allowedFocusIds = new Set<string>([
            params.assistantMessageId,
            params.targetMessageId,
            ...(activeFlow?.guardedMessageIds ?? []),
        ]);
        pendingGeneratedCommitFocusByTargetRef.current.set(params.targetMessageId, {
            flowId,
            workspaceId: params.workspaceId,
            targetMessageId: params.targetMessageId,
            assistantMessageId: params.assistantMessageId,
            commitSha: params.commitSha ?? null,
            allowedFocusIds: Array.from(allowedFocusIds),
            queuedAt: Date.now(),
        });
    }, [getSendFlowIdForKey]);
    const finishSendFlowLifecycleFocus = useCallback((
        flowId: string | null | undefined,
        assistantMessageId: string,
        reason: string,
        extra: Record<string, unknown> = {}
    ) => {
        if (!flowId) {
            releaseSendFlowKey(assistantMessageId);
            return;
        }

        recordSendFlowEvent('cleanup.finished', {
            flowId,
            nodeId: assistantMessageId,
            reason,
            ...extra,
        }, { source: 'ChatInput' });
        endSendFlowFocus(flowId);
        commitFocusHandledByFlowRef.current.delete(flowId);
        releaseSendFlowKey(assistantMessageId);
    }, [endSendFlowFocus, releaseSendFlowKey]);
    const getAgentRunProjection = useCallback((nodeId: string) => {
        return useAgentRunProjectionStore.getState().projectionsById[nodeId] || null;
    }, []);
    const setAgentRunExecutionData = useCallback((nodeId: string, executionData: Record<string, any>) => {
        agentRunManager.dispatch(nodeId, { type: 'execution_data', patch: executionData });
    }, []);
    const mergeAgentRunExecutionData = useCallback((nodeId: string, patch: Record<string, any>) => {
        const current = getAgentRunProjection(nodeId);
        if (!current) return;
        const currentExecution = (current.execution_data || {}) as Record<string, any>;
        const nextExecution = {
            ...currentExecution,
            ...patch,
            ...((currentExecution.meta || patch.meta) ? {
                meta: {
                    ...(currentExecution.meta || {}),
                    ...(patch.meta || {}),
                },
            } : {}),
            ...((currentExecution.usage || patch.usage) ? {
                usage: {
                    ...(currentExecution.usage || {}),
                    ...(patch.usage || {}),
                },
            } : {}),
        };
        setAgentRunExecutionData(nodeId, nextExecution);
    }, [getAgentRunProjection, setAgentRunExecutionData]);
    const ensureLatencyTrace = useCallback((key: string, authToken?: string | null) => {
        let trace = latencyTraceRef.current.get(key);
        if (!trace) {
            trace = {
                traceId: crypto.randomUUID(),
                nodeId: null,
                authToken: authToken ?? null,
                marks: new Map(),
                emitted: new Set(),
            };
            latencyTraceRef.current.set(key, trace);
        } else if (authToken) {
            trace.authToken = authToken;
        }
        return trace;
    }, []);
    const recordLatencyMark = useCallback((
        key: string,
        name: string,
        options?: {
            authToken?: string | null;
            nodeId?: string | null;
            source?: string;
            detail?: Record<string, any>;
        }
    ) => {
        const trace = ensureLatencyTrace(key, options?.authToken);
        if (trace.marks.has(name)) return;
        if (options?.nodeId) {
            trace.nodeId = options.nodeId;
        }
        const traceEvent = {
            type: 'trace',
            trace_id: trace.traceId,
            name,
            source: options?.source || 'frontend',
            ts: Date.now(),
            ...(options?.detail ? { detail: options.detail } : {}),
        };
        trace.marks.set(name, traceEvent);
        if (options?.nodeId || trace.nodeId) {
            trace.emitted.add(name);
        }
        const flowId = getSendFlowIdForKey(key) || getSendFlowIdForKey(options?.nodeId ?? null) || null;
        if (flowId) {
            recordSendFlowMark(flowId, name, {
                nodeId: options?.nodeId ?? trace.nodeId ?? null,
                traceId: trace.traceId,
                detail: options?.detail ?? null,
            }, { source: options?.source || 'frontend' });
        }
    }, [ensureLatencyTrace, getSendFlowIdForKey]);
    const attachLatencyTraceToNode = useCallback((key: string, nodeId: string, authToken?: string | null) => {
        const trace = ensureLatencyTrace(key, authToken);
        const flowId = getSendFlowIdForKey(key);
        trace.nodeId = nodeId;
        if (authToken) {
            trace.authToken = authToken;
        }
        if (key !== nodeId) {
            latencyTraceRef.current.delete(key);
            latencyTraceRef.current.set(nodeId, trace);
        }
        if (flowId) {
            assignSendFlowKey(nodeId, flowId);
            registerAgentRunVisibilityTrace({
                nodeId,
                flowId,
                traceId: trace.traceId,
            });
        }
        for (const name of trace.marks.keys()) {
            trace.emitted.add(name);
        }
        return trace.traceId;
    }, [assignSendFlowKey, ensureLatencyTrace, getSendFlowIdForKey]);

    const worktreeInfoRef = useRef<Map<string, WorktreeRuntimeInfo | null>>(new Map());
    const autoCheckoutPendingRef = useRef<Set<string>>(new Set());
    const autoCheckoutHandledRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        autoCheckoutPendingRef.current.clear();
        autoCheckoutHandledRef.current.clear();
    }, [selectedWorkspaceId]);

    const checkoutAssistantCommit = useCallback(async (params: {
        assistantMessageId: string;
        commitSha: string;
        workspaceId: string;
        repoPath: string;
    }) => {
        if (autoCheckoutHandledRef.current.has(params.assistantMessageId)) return;
        autoCheckoutHandledRef.current.add(params.assistantMessageId);
        autoCheckoutPendingRef.current.delete(params.assistantMessageId);

        try {
            const checkedOutCommit = await agentClient.checkoutCommitDetached(params.repoPath, params.commitSha);
            void scheduleMessagesRefreshWhenGraphIdle(queryClient, params.workspaceId, {
                reason: 'agent-auto-checkout',
            });
            queryClient.invalidateQueries({ queryKey: branchKeys.workspace(params.workspaceId) });
            addToast({
                title: 'Auto Checkout Complete',
                description: `Detached HEAD at ${checkedOutCommit.slice(0, 7)}.`,
                variant: 'success',
            });
        } catch (error) {
            addToast({
                ...describeCheckoutFailure(error, 'auto'),
                duration: 9000,
            });
        }
    }, [addToast, queryClient]);

    const ensureMcpSetup = useCallback((authToken: string, workspaceId: string) => {
        const current = mcpSetupStateRef.current;
        if (current?.authToken === authToken && current.workspaceId === workspaceId) {
            if (current.configured) {
                return { promise: Promise.resolve(true), reused: 'configured' as const };
            }
            if (current.promise) {
                return { promise: current.promise, reused: 'in-flight' as const };
            }
        }

        const promise = Promise.all([
            agentClient.setMcpAuthToken(authToken),
            agentClient.setMcpWorkspaceId(workspaceId),
        ]).then(() => {
            const latest = mcpSetupStateRef.current;
            if (latest?.authToken === authToken && latest.workspaceId === workspaceId) {
                latest.configured = true;
                latest.promise = null;
            }
            return true;
        }).catch((err) => {
            const latest = mcpSetupStateRef.current;
            if (latest?.authToken === authToken && latest.workspaceId === workspaceId) {
                latest.configured = false;
                latest.promise = null;
            }
            console.warn('[AgentSetup] Failed to set MCP tokens:', err);
            return false;
        });

        mcpSetupStateRef.current = {
            authToken,
            workspaceId,
            configured: false,
            promise,
        };
        return { promise, reused: null };
    }, []);

    useEffect(() => {
        if (!selectedWorkspaceId || !agentClient.hasRuntime()) return;
        let cancelled = false;

        void (async () => {
            try {
                const token = await getOptionalCloudAuthToken();
                if (cancelled) return;
                await ensureMcpSetup(token, selectedWorkspaceId);
            } catch (error) {
                if (!cancelled) {
                    console.warn('[AgentSetup] Failed to sync MCP context:', error);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [ensureMcpSetup, selectedWorkspaceId]);

    const notifyAutoCheckoutDidNotSucceed = useCallback((description: string, variant: 'warning' | 'error' = 'warning') => {
        addToast({
            title: variant === 'warning' ? 'Auto Checkout Skipped' : 'Auto Checkout Failed',
            description,
            variant,
            duration: 9000,
        });
    }, [addToast]);

    useEffect(() => {
        const workspaceId = selectedWorkspaceId;
        if (!workspaceId) return;

        for (const assistantMessage of persistedMessages) {
            if (assistantMessage.role !== 'assistant') continue;
            const mappedFlowId = getSendFlowIdForKey(assistantMessage.id);
            const focusState = useWorkspaceStore.getState();
            const metadataFlowId = typeof focusState.lastFocusMetadata?.flowId === 'string'
                ? focusState.lastFocusMetadata.flowId
                : null;
            const isCurrentComposerAssistantFocus =
                focusState.focusedMessageId === assistantMessage.id &&
                focusState.lastFocusSource === 'composer' &&
                !!metadataFlowId;
            const flowId = mappedFlowId ?? (isCurrentComposerAssistantFocus ? metadataFlowId : null);
            if (flowId && commitFocusHandledByFlowRef.current.has(flowId)) continue;
            if (!flowId && !isCurrentComposerAssistantFocus) continue;

            const commitSha = getMessageOutputCommitSha(assistantMessage);
            if (!commitSha) continue;

            queueGeneratedCommitFocus({
                workspaceId,
                assistantMessageId: assistantMessage.id,
                targetMessageId: assistantMessage.id,
                commitSha,
                flowId,
            });
        }

        const now = Date.now();
        const messageById = new Map(persistedMessages.map((message) => [message.id, message]));
        for (const pending of pendingGeneratedCommitFocusByTargetRef.current.values()) {
            if (pending.workspaceId !== workspaceId) continue;
            const targetMessage = messageById.get(pending.targetMessageId);
            if (!targetMessage) {
                if (now - pending.queuedAt > 30_000) {
                    pendingGeneratedCommitFocusByTargetRef.current.delete(pending.targetMessageId);
                    recordSendFlowEvent('commit-focus.timeout', {
                        flowId: pending.flowId,
                        workspaceId,
                        assistantMessageId: pending.assistantMessageId,
                        generatedCommitMessageId: pending.targetMessageId,
                    }, { source: 'ChatInput' });
                    finishSendFlowLifecycleFocus(pending.flowId, pending.assistantMessageId, 'commit-focus-timeout', {
                        workspaceId,
                        generatedCommitMessageId: pending.targetMessageId,
                    });
                }
                continue;
            }

            const focusState = useWorkspaceStore.getState();
            const currentFocusId = focusState.focusedMessageId;
            const shouldSkipAutoCommitFocus = !canAutoAdvanceSendFocus(
                pending.flowId,
                pending.allowedFocusIds,
                {
                    phase: 'generated-commit',
                    targetMessageId: pending.targetMessageId,
                    assistantMessageId: pending.assistantMessageId,
                }
            );

            if (shouldSkipAutoCommitFocus) {
                pendingGeneratedCommitFocusByTargetRef.current.delete(pending.targetMessageId);
                if (pending.flowId) {
                    commitFocusHandledByFlowRef.current.add(pending.flowId);
                }
                recordSendFlowEvent('commit-focus.skipped', {
                    flowId: pending.flowId,
                    workspaceId,
                    assistantMessageId: pending.assistantMessageId,
                    generatedCommitMessageId: pending.targetMessageId,
                    focusedMessageId: currentFocusId,
                    focusSource: focusState.lastFocusSource,
                    allowedFocusIds: pending.allowedFocusIds,
                }, { source: 'ChatInput' });
                finishSendFlowLifecycleFocus(pending.flowId, pending.assistantMessageId, 'commit-focus-skipped', {
                    workspaceId,
                    generatedCommitMessageId: pending.targetMessageId,
                });
                continue;
            }

            pendingGeneratedCommitFocusByTargetRef.current.delete(pending.targetMessageId);
            if (pending.flowId) {
                commitFocusHandledByFlowRef.current.add(pending.flowId);
            }
            if (pending.flowId) {
                advanceSendFlowFocus({
                    flowId: pending.flowId,
                    preferredMessageId: pending.targetMessageId,
                    addGuardedMessageIds: [pending.targetMessageId],
                    phase: 'commit',
                });
            }
            dispatchSendFlowFocus({
                flowId: pending.flowId,
                messageId: pending.targetMessageId,
                phase: 'generated-commit',
                allowedCurrentFocusIds: pending.allowedFocusIds,
                metadata: {
                    reason: 'generated-commit',
                    assistantMessageId: pending.assistantMessageId,
                    commitSha: getMessageOutputCommitSha(targetMessage) ?? pending.commitSha,
                },
            });
            recordSendFlowEvent('commit-focus.applied', {
                flowId: pending.flowId,
                workspaceId,
                assistantMessageId: pending.assistantMessageId,
                generatedCommitMessageId: pending.targetMessageId,
            }, { source: 'ChatInput' });
            finishSendFlowLifecycleFocus(pending.flowId, pending.assistantMessageId, 'commit-focus-applied', {
                workspaceId,
                generatedCommitMessageId: pending.targetMessageId,
            });
        }
    }, [
        advanceSendFlowFocus,
        canAutoAdvanceSendFocus,
        dispatchFocus,
        dispatchSendFlowFocus,
        finishSendFlowLifecycleFocus,
        getSendFlowIdForKey,
        persistedMessages,
        queueGeneratedCommitFocus,
        selectedWorkspaceId,
    ]);

    useEffect(() => {
        const workspaceId = selectedWorkspaceId;
        if (!workspaceId) return;

        const repoPath = resolveLocalWorkspaceRepoPath(selectedWorkspace);
        if (!repoPath) return;

        const candidates = persistedMessages.filter((message) =>
            message.role === 'assistant' &&
            message.status === 'completed' &&
            autoCheckoutPendingRef.current.has(message.id) &&
            !autoCheckoutHandledRef.current.has(message.id)
        );
        if (candidates.length === 0) return;

        for (const message of candidates) {
            const meta = (((message.execution_data as any)?.meta || {}) as Record<string, any>);
            const commitSha = getMessageOutputCommitSha(message);
            if (!commitSha) {
                if (meta.commit_created === false) {
                    autoCheckoutPendingRef.current.delete(message.id);
                    autoCheckoutHandledRef.current.add(message.id);
                    notifyAutoCheckoutDidNotSucceed('The agent finished without creating a commit to check out.');
                }
                continue;
            }

            void checkoutAssistantCommit({
                assistantMessageId: message.id,
                commitSha,
                workspaceId,
                repoPath,
            });
        }
    }, [
        checkoutAssistantCommit,
        notifyAutoCheckoutDidNotSucceed,
        persistedMessages,
        selectedWorkspace?.folderPath,
        selectedWorkspace?.git_repo_path,
        selectedWorkspaceId,
    ]);

    useEffect(() => {
        for (const message of persistedMessages) {
            if (!autoCheckoutPendingRef.current.has(message.id)) continue;
            if (!isTerminalAgentStatus(message.status)) continue;
            if (message.status === AGENT_STATUS.completed) continue;
            autoCheckoutPendingRef.current.delete(message.id);
            autoCheckoutHandledRef.current.add(message.id);
            notifyAutoCheckoutDidNotSucceed(`The agent ended with status "${message.status}", so there was no completed commit to check out.`);
        }
    }, [notifyAutoCheckoutDidNotSucceed, persistedMessages]);

    const trackStreamForNode = useCallback(async (
        node: Message,
        options?: { authToken?: string; parentId?: string | null }
    ) => {
        const nodeId = node.id;
        const workspaceId = node.workspaceId;
        const parentId = options?.parentId ?? node.parentId ?? '';
        const authToken = options?.authToken ?? await getOptionalCloudAuthToken();
        const flowId = getSendFlowIdForKey(nodeId);
        if (flowId) {
            recordSendFlowEvent('stream.registered', {
                flowId,
                nodeId,
                workspaceId,
                parentId,
            }, { source: 'ChatInput' });
            registerAgentRunVisibilityTrace({ nodeId, flowId });
        }
        recordLatencyMark(nodeId, 'tauri_stream_registered', { authToken, nodeId });
        trackAgentRunLiveStreamMessage(node);
    }, [getSendFlowIdForKey, recordLatencyMark]);

    // --- NEW: State for Slash Command Popover ---
    const [isCommandPopoverOpen, setIsCommandPopoverOpen] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null); // Ref for the textarea

    const setComposerPrompt = useCallback((nextPrompt: string, draftTargetId = composerDraftTargetId) => {
        promptRef.current = nextPrompt;
        setPrompt(nextPrompt);
        setPromptHasContent(nextPrompt.trim().length > 0);
        setComposerDraft(selectedWorkspaceId, nextPrompt, draftTargetId);
        if (textareaRef.current && textareaRef.current.value !== nextPrompt) {
            textareaRef.current.value = nextPrompt;
        }
    }, [composerDraftTargetId, selectedWorkspaceId, setComposerDraft]);

    useEffect(() => {
        promptRef.current = composerDraft;
        setPrompt(composerDraft);
        setPromptHasContent(composerDraft.trim().length > 0);
        if (textareaRef.current && textareaRef.current.value !== composerDraft) {
            textareaRef.current.value = composerDraft;
        }
    }, [composerDraft]);

    const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
    const refreshProviderLimitsIfStale = useProviderLimitsStore((state) => state.refreshIfStale);
    const handleAgentPickerOpenChange = useCallback((open: boolean) => {
        setIsAgentPickerOpen(open);
        if (!open) return;
        const codexProfiles = useLoginProfilesStore
            .getState()
            .profiles
            .filter((profile) => profile.provider === 'codex' && isLoginProfileActive(profile));
        codexProfiles.forEach((profile) => {
            refreshProviderLimitsIfStale('codex', Date.now(), profile.id);
        });
    }, [refreshProviderLimitsIfStale]);

    useEffect(() => {
        if (!autoFocus) return;
        const timeoutId = window.setTimeout(() => textareaRef.current?.focus(), 0);
        return () => window.clearTimeout(timeoutId);
    }, [autoFocus]);



    // Ref to hold attachments state for cleanup function
    const attachmentsRef = useRef(attachments);
    useEffect(() => {
        attachmentsRef.current = attachments;
    }, [attachments]);


    const branchParentMessage = useMemo(
        () => messageLookupMessages.find((m: Message) => m.id === replyParentMessageId) ?? null,
        [messageLookupMessages, replyParentMessageId]
    );
    const baseSelectionContextKey = [
        selectedWorkspaceId ?? '',
        composerTargetMode,
        replyParentMessageId ?? '',
        focusedCommitSha ?? '',
    ].join(':');
    const baseSelectionContextKeyRef = useRef<string | null>(null);
    const composerBaseMessages = useMemo<ComposerBaseMessage[]>(() => (
        messageLookupMessages.map((message) => ({
            id: message.id,
            parentId: message.parentId ?? null,
            output_commit_sha: getMessageOutputCommitSha(message),
            base_commit_sha: message.base_commit_sha ?? null,
        }))
    ), [messageLookupMessages]);
    const liveGitRefs = useMemo(() => buildLiveGitRefs({
        refs: localCommitChoicesQuery.refs,
        trackedRefs: trackedRefsQuery.data ?? [],
        snapshot: gitRefSnapshotQuery.data,
    }), [gitRefSnapshotQuery.data, localCommitChoicesQuery.refs, trackedRefsQuery.data]);
    const commitPickerRefs = liveGitRefs.refs;
    const liveTrackedRefs = liveGitRefs.trackedRefs;
    const currentHeadSha = liveGitRefs.headSha;
    const defaultBaseResolution = useMemo(() => (
        focusedCommitSha
            ? {
                sha: focusedCommitSha,
                source: 'reply-parent-output' as const,
                selectedFromNodeId: null,
            }
            : resolveComposerDefaultBaseCommit({
                targetMode: isRootComposerTarget ? 'new-thread' : isNewThreadTarget ? 'new-thread' : 'reply',
                replyParentMessageId,
                selectedNodeId,
                messages: composerBaseMessages,
                refs: commitPickerRefs,
                trackedRefs: liveTrackedRefs,
                workspaceBaseCommitSha: selectedWorkspace?.base_commit_sha ?? null,
            })
    ), [
        composerBaseMessages,
        commitPickerRefs,
        focusedCommitSha,
        isNewThreadTarget,
        isRootComposerTarget,
        liveTrackedRefs,
        replyParentMessageId,
        selectedNodeId,
        selectedWorkspace?.base_commit_sha,
    ]);
    const defaultBaseCommitSha = defaultBaseResolution.sha;
    const baseCommitCandidatesQuery = useCommitDescendants(selectedWorkspaceId, defaultBaseCommitSha, {
        enabled: Boolean(selectedWorkspaceId && defaultBaseCommitSha),
        limit: 120,
    });
    const baseCommitAncestorsQuery = useCommitAncestors(selectedWorkspaceId, defaultBaseCommitSha, {
        enabled: Boolean(selectedWorkspaceId && defaultBaseCommitSha),
        limit: 120,
    });
    useEffect(() => {
        setSelectedBaseCommit(null);
        setBaseCommitSearch('');
    }, [defaultBaseCommitSha, replyParentMessageId, selectedWorkspaceId]);
    useEffect(() => {
        const previousBaseSelectionContextKey = baseSelectionContextKeyRef.current;
        baseSelectionContextKeyRef.current = baseSelectionContextKey;
        if (previousBaseSelectionContextKey === null || previousBaseSelectionContextKey === baseSelectionContextKey) return;

        setSelectedBaseCommit(null);
        setBaseCommitSearch('');
        setComposerBaseCommitOverride(null);
    }, [baseSelectionContextKey, setComposerBaseCommitOverride]);
    const composerOverrideCommitSha = composerBaseCommitOverride?.workspaceId === selectedWorkspaceId
        ? composerBaseCommitOverride.commitSha
        : null;
    const effectiveBaseCommitSha = composerOverrideCommitSha || selectedBaseCommit?.sha || defaultBaseCommitSha;
    const baseCommitCandidates = useMemo(() => {
        const seen = new Set<string>();
        return (baseCommitCandidatesQuery.data?.commits ?? []).filter((commit) => {
            if (!commit.sha || seen.has(commit.sha)) return false;
            seen.add(commit.sha);
            return commit.sha !== defaultBaseCommitSha;
        });
    }, [baseCommitCandidatesQuery.data?.commits, defaultBaseCommitSha]);
    const baseCommitAncestorCandidates = useMemo(() => {
        const seen = new Set<string>();
        return (baseCommitAncestorsQuery.data?.commits ?? []).filter((commit) => {
            if (!commit.sha || seen.has(commit.sha)) return false;
            seen.add(commit.sha);
            return commit.sha !== defaultBaseCommitSha;
        });
    }, [baseCommitAncestorsQuery.data?.commits, defaultBaseCommitSha]);
    const baseCommitPickerCommits = useMemo<ComposerCommitPickerCommit[]>(() => {
        const commitsBySha = new Map<string, ComposerCommitPickerCommit>();
        const upsertCommit = (commit: Partial<ComposerCommitPickerCommit> & { sha?: string | null }) => {
            const sha = commit.sha?.trim();
            if (!sha) return;
            const existing = commitsBySha.get(sha);
            commitsBySha.set(sha, {
                sha,
                subject: commit.subject ?? existing?.subject ?? null,
                parents: Array.isArray(commit.parents) ? commit.parents : existing?.parents ?? [],
                produced_by_node_id: commit.produced_by_node_id ?? existing?.produced_by_node_id ?? null,
                authored_at: commit.authored_at ?? existing?.authored_at ?? null,
                committed_at: commit.committed_at ?? existing?.committed_at ?? null,
            });
        };

        for (const commit of localCommitChoicesQuery.commits) {
            upsertCommit({
                sha: commit.sha,
                subject: commit.subject,
                parents: commit.parents,
                authored_at: commit.authored_at,
            });
        }
        for (const commit of baseCommitAncestorCandidates) {
            upsertCommit({
                sha: commit.sha,
                subject: commit.subject,
                produced_by_node_id: commit.produced_by_node_id ?? null,
                authored_at: commit.authored_at,
                committed_at: commit.committed_at,
            });
        }
        for (const commit of baseCommitCandidates) {
            upsertCommit({
                sha: commit.sha,
                subject: commit.subject,
                produced_by_node_id: commit.produced_by_node_id ?? null,
                authored_at: commit.authored_at,
                committed_at: commit.committed_at,
            });
        }
        if (currentHeadSha) {
            upsertCommit({
                sha: currentHeadSha,
                subject: 'HEAD',
            });
        }
        if (defaultBaseCommitSha) {
            const defaultBaseSubject = defaultBaseResolution.source === 'main-ref'
                ? 'main'
                : defaultBaseResolution.source === 'head-ref'
                    ? 'HEAD'
                    : branchParentMessage?.commit?.subject || branchParentMessage?.content || null;
            upsertCommit({
                sha: defaultBaseCommitSha,
                subject: defaultBaseSubject,
                produced_by_node_id: defaultBaseResolution.selectedFromNodeId,
            });
        }
        if (selectedBaseCommit) {
            upsertCommit({
                sha: selectedBaseCommit.sha,
                subject: selectedBaseCommit.subject,
                produced_by_node_id: selectedBaseCommit.produced_by_node_id ?? null,
            });
        }
        if (composerOverrideCommitSha) {
            upsertCommit({
                sha: composerOverrideCommitSha,
                subject: composerBaseCommitOverride?.label ?? null,
            });
        }

        return Array.from(commitsBySha.values());
    }, [
        baseCommitAncestorCandidates,
        baseCommitCandidates,
        branchParentMessage?.commit?.subject,
        branchParentMessage?.content,
        composerBaseCommitOverride?.label,
        composerOverrideCommitSha,
        currentHeadSha,
        defaultBaseCommitSha,
        defaultBaseResolution.selectedFromNodeId,
        defaultBaseResolution.source,
        localCommitChoicesQuery.commits,
        selectedBaseCommit,
    ]);
    const laterCommitShas = useMemo(
        () => new Set(baseCommitCandidates.map((commit) => commit.sha)),
        [baseCommitCandidates]
    );
    const earlierCommitShas = useMemo(
        () => new Set(baseCommitAncestorCandidates.map((commit) => commit.sha)),
        [baseCommitAncestorCandidates]
    );
    const baseCommitAllPickerItems = useMemo(() => buildComposerCommitPickerItems({
        defaultSha: defaultBaseCommitSha,
        effectiveSha: effectiveBaseCommitSha,
        commits: baseCommitPickerCommits,
        refs: commitPickerRefs,
        trackedRefs: liveTrackedRefs,
        laterCommitShas,
        earlierCommitShas,
    }), [
        baseCommitPickerCommits,
        commitPickerRefs,
        defaultBaseCommitSha,
        earlierCommitShas,
        effectiveBaseCommitSha,
        laterCommitShas,
        liveTrackedRefs,
    ]);
    const baseCommitPickerItems = useMemo(() => {
        const query = baseCommitSearch.trim().toLowerCase();
        if (!query) return baseCommitAllPickerItems;
        return baseCommitAllPickerItems.filter((item) => item.searchText.includes(query));
    }, [baseCommitAllPickerItems, baseCommitSearch]);
    const selectedBasePickerItem = useMemo(
        () => baseCommitAllPickerItems.find((item) => item.sha === effectiveBaseCommitSha) ?? null,
        [baseCommitAllPickerItems, effectiveBaseCommitSha]
    );
    const commitRecencyBySha = useMemo(() => {
        const recencyBySha = new Map<string, number>();
        for (const commit of baseCommitPickerCommits) {
            const sha = commit.sha.trim();
            if (!sha) continue;
            const timestamp = Date.parse(commit.committed_at || commit.authored_at || '');
            recencyBySha.set(sha, Number.isFinite(timestamp) ? timestamp : 0);
        }
        return recencyBySha;
    }, [baseCommitPickerCommits]);
    const baseCommitChipItems = useMemo(() => buildComposerCommitPickerChipItems({
        items: baseCommitAllPickerItems,
        refs: commitPickerRefs,
        trackedRefs: liveTrackedRefs,
        headSha: currentHeadSha,
        commitRecencyBySha,
        limit: 6,
    }), [
        baseCommitAllPickerItems,
        commitPickerRefs,
        commitRecencyBySha,
        currentHeadSha,
        liveTrackedRefs,
    ]);
    const isBaseCommitChoicesLoading = localCommitChoicesQuery.isLoading || baseCommitCandidatesQuery.isLoading || baseCommitAncestorsQuery.isLoading;
    const handleBaseCommitSelect = useCallback((item: typeof baseCommitPickerItems[number]) => {
        setComposerBaseCommitOverride(null);
        if (item.isDefault) {
            setSelectedBaseCommit(null);
            return;
        }

        setSelectedBaseCommit({
            sha: item.sha,
            subject: item.subject,
            produced_by_node_id: item.producedByNodeId,
        });
    }, [setComposerBaseCommitOverride]);
    const effectiveBaseCommitLabel = composerOverrideCommitSha
        ? (composerBaseCommitOverride?.label || composerOverrideCommitSha)
        : selectedBasePickerItem?.primaryLabel || selectedBaseCommit?.subject || selectedBaseCommit?.sha || defaultBaseCommitSha || 'No commit';
    const effectiveBaseSelectedFromNodeId = composerOverrideCommitSha
        ? null
        : selectedBaseCommit?.produced_by_node_id || selectedBasePickerItem?.producedByNodeId || defaultBaseResolution.selectedFromNodeId || null;
    const replyParentLabel = branchParentMessage?.content || '';
    const messageById = useMemo(
        () => new Map(messageLookupMessages.map((m: Message) => [m.id, m])),
        [messageLookupMessages]
    );
    const composerDefaultParentMessage = useMemo(() => {
        if (!branchParentMessage) return null;
        if (branchParentMessage.role === 'assistant') return branchParentMessage;
        return branchParentMessage.parentId ? messageById.get(branchParentMessage.parentId) ?? null : null;
    }, [branchParentMessage, messageById]);
    const resolvePersistedMessageId = useCallback((candidateId: string | null | undefined): string | null => {
        let cursorId = candidateId ?? null;
        if (!cursorId) return null;

        const projectionsById = useAgentRunProjectionStore.getState().projectionsById;
        const visited = new Set<string>();
        while (cursorId) {
            if (!isOptimisticId(cursorId)) return cursorId;
            if (visited.has(cursorId)) return null;
            visited.add(cursorId);

            const optimisticMessage: Pick<Message, 'parentId'> | undefined =
                (projectionsById[cursorId] as Pick<Message, 'parentId'> | undefined) ||
                (messageById.get(cursorId) as Pick<Message, 'parentId'> | undefined);
            cursorId = optimisticMessage?.parentId ?? null;
        }

        return null;
    }, [messageById]);
    const defaultContextParentMessage = useMemo(
        () => resolveConversationContextMessage(replyParentMessageId, messageById),
        [replyParentMessageId, messageById]
    );
    const mergeContextOptions = useMemo(() => {
        if (!branchParentMessage || !isMergeResultNode(branchParentMessage, messageById)) return [];
        const seen = new Set<string>();
        const options: Array<{ id: string; role: string; label: string }> = [];

        for (const entry of getMergeVisualParentEntries(branchParentMessage, messageById)) {
            const contextMessage = resolveConversationContextMessage(entry.id, messageById);
            if (!contextMessage || seen.has(contextMessage.id)) continue;
            seen.add(contextMessage.id);
            options.push({
                id: contextMessage.id,
                role: entry.role,
                label: getMessagePreviewText(contextMessage) || entry.label || `Parent ${entry.index + 1}`,
            });
        }

        return options;
    }, [branchParentMessage, messageById]);
    const [selectedMergeContextParentId, setSelectedMergeContextParentId] = useState<string | null>(null);
    useEffect(() => {
        if (mergeContextOptions.length === 0) {
            setSelectedMergeContextParentId(null);
            return;
        }
        setSelectedMergeContextParentId((current) => {
            if (current && mergeContextOptions.some((option) => option.id === current)) return current;
            return mergeContextOptions[0].id;
        });
    }, [mergeContextOptions]);
    const effectiveContextParentId = mergeContextOptions.length > 0
        ? selectedMergeContextParentId
        : defaultContextParentMessage?.id ?? null;
    const selectedMergeContextOption = useMemo(
        () => mergeContextOptions.find((option) => option.id === selectedMergeContextParentId) ?? null,
        [mergeContextOptions, selectedMergeContextParentId]
    );
    const effectiveContextParentMessage = useMemo(
        () => messageById.get(effectiveContextParentId || '') ?? null,
        [effectiveContextParentId, replyParentMessageId, messageById]
    );
    const contextStartOptions = useMemo(() => {
        if (!effectiveContextParentId || contextPolicy === 'fresh') return [];
        const seen = new Set<string>();
        return reconstructContext(effectiveContextParentId, messageLookupMessages)
            .map((message) => resolveConversationContextMessage(message.id, messageById))
            .filter((message): message is Message => Boolean(message))
            .filter((message) => {
                if (seen.has(message.id)) return false;
                seen.add(message.id);
                return true;
            })
            .map((message) => ({
                id: message.id,
                label: getMessagePreviewText(message) || `${message.role} message`,
                role: message.role,
                isFreshBoundary: hasFreshContextBoundary(message),
            }));
    }, [contextPolicy, effectiveContextParentId, messageById, messageLookupMessages]);
    const defaultContextStartMessage = useMemo(
        () => contextPolicy === 'fresh'
            ? null
            : resolveContextStartMessage(effectiveContextParentId, messageLookupMessages, messageById),
        [contextPolicy, effectiveContextParentId, messageById, messageLookupMessages]
    );
    const [selectedContextStartId, setSelectedContextStartId] = useState<string | null>(null);
    const effectiveContextStartId = contextPolicy === 'fresh'
        ? null
        : (
            selectedContextStartId && contextStartOptions.some((option) => option.id === selectedContextStartId)
                ? selectedContextStartId
                : defaultContextStartMessage?.id ?? null
        );
    const effectiveContextStartMessage = useMemo(
        () => messageById.get(effectiveContextStartId || '') ?? null,
        [effectiveContextStartId, messageById]
    );
    useEffect(() => {
        setComposerContextPreview({
            workspaceId: selectedWorkspaceId,
            parentId: replyParentMessageId,
            contextParentId: contextPolicy === 'fresh' ? null : effectiveContextParentId,
            contextPolicy,
            contextStartId: effectiveContextStartId,
            baseCommitSha: effectiveBaseCommitSha,
        });
        return () => setComposerContextPreview(null);
    }, [
        selectedWorkspaceId,
        replyParentMessageId,
        effectiveContextParentId,
        contextPolicy,
        effectiveContextStartId,
        effectiveBaseCommitSha,
        setComposerContextPreview,
    ]);
    const contextStartLabel = formatContextParentLabel(effectiveContextStartMessage, 'Root');
    const contextParentLabel = selectedMergeContextOption
        ? formatContextParentLabel(messageById.get(selectedMergeContextOption.id), selectedMergeContextOption.label)
        : formatContextParentLabel(effectiveContextParentMessage, 'No prior conversation');
    const contextControlLabel = contextPolicy === 'fresh'
        ? 'Fresh context'
        : contextParentLabel;
    const isParentContextInactive = branchParentMessage?.context_active === false;
    const parentStatus = resolveNodeState(branchParentMessage, null).status;
    const isParentIncomplete = !!replyParentMessageId &&
        branchParentMessage?.role === 'assistant' &&
        branchParentMessage?.parentId !== null &&
        !!parentStatus &&
        !isTerminalAgentStatus(parentStatus);
    const parentStatusLabel = parentStatus === AGENT_STATUS.pending
        ? 'Parent pending'
        : parentStatus === AGENT_STATUS.streaming
            ? 'Parent streaming'
            : parentStatus === AGENT_STATUS.running
                ? 'Parent running'
                : 'Parent still running';
    const showCancel = shouldShowComposerCancel({
        activeComposerSend,
        isNewThreadTarget,
        isSelectedNodeRunning,
    });
    const isSteeringRunningAssistant = isSteerableAssistantNode({
        nodeId: selectedNodeId,
        role: selectedNodeRole,
        status: selectedResolvedState.status,
    });
    const codeParentCommit = effectiveBaseCommitSha;
    const codeParentBranchNames = selectedBasePickerItem?.refNames ?? [];
    const codeParentUsesBranchName = codeParentBranchNames.length > 0;
    const codeParentDisplayLabel = codeParentUsesBranchName
        ? selectedBasePickerItem?.primaryLabel ?? codeParentBranchNames.join(', ')
        : shortCommitSha(codeParentCommit);
    const codeParentTooltipLabel = codeParentUsesBranchName && codeParentCommit
        ? `${codeParentDisplayLabel} (${shortCommitSha(codeParentCommit)})`
        : codeParentDisplayLabel;
    const codeParentTooltipNoun = codeParentBranchNames.length > 1
        ? 'branches'
        : codeParentUsesBranchName
            ? 'branch'
            : 'commit';
    const effectiveBaseDetailLabel = normalizePreviewText(effectiveBaseCommitLabel);
    const codeParentTooltipSuffix = effectiveBaseDetailLabel &&
        effectiveBaseDetailLabel !== codeParentCommit &&
        effectiveBaseDetailLabel !== codeParentDisplayLabel &&
        !codeParentBranchNames.includes(effectiveBaseDetailLabel)
        ? `: ${effectiveBaseDetailLabel}`
        : '';

    useEffect(() => {
        setContextPolicy(isNewThreadTarget ? 'fresh' : 'continue');
    }, [isNewThreadTarget, replyParentMessageId]);

    useEffect(() => {
        if (agents.length === 0) return;

        const selectedAgentStillExists = Boolean(selectedAgentId && agents.some((agent) => agent.id === selectedAgentId));
        const canAutoSelect = !selectedAgentStillExists
            || !selectedAgentId
            || selectedAgentId === autoSelectedAgentIdRef.current
            || (
                selectedAgentId === 'codex:gpt-5.4-mini:medium'
                && selectedAgentId !== manuallySelectedAgentIdRef.current
            );
        if (!canAutoSelect) return;

        const defaultAgentId = resolveComposerDefaultAgentId({
            agents,
            parentMessage: composerDefaultParentMessage,
        }) ?? findDefaultCodexAgentId(agents);
        if (defaultAgentId && defaultAgentId !== selectedAgentId) {
            manuallySelectedAgentIdRef.current = null;
            autoSelectedAgentIdRef.current = defaultAgentId;
            setSelectedAgentRunCounts({ [defaultAgentId]: 1 });
            setSelectedAgentId(defaultAgentId);
        } else if (defaultAgentId) {
            manuallySelectedAgentIdRef.current = null;
            autoSelectedAgentIdRef.current = defaultAgentId;
            setSelectedAgentRunCounts((current) => {
                const next = { [defaultAgentId]: 1 };
                return areAgentRunCountsEqual(current, next) ? current : next;
            });
        }
    }, [agents, composerDefaultParentMessage, selectedAgentId, setSelectedAgentId]);

    useEffect(() => {
        const normalized = normalizeComposerAgentRunCounts(agents, selectedAgentId, selectedAgentRunCounts);
        if (!areAgentRunCountsEqual(normalized, selectedAgentRunCounts)) {
            setSelectedAgentRunCounts(normalized);
        }
    }, [agents, selectedAgentId, selectedAgentRunCounts]);

    useEffect(() => {
        if (!selectedWorkspaceId) return;
        const projectionsById = useAgentRunProjectionStore.getState().projectionsById;
        for (const nodeId of workspaceProjectionIds) {
            const projection = projectionsById[nodeId];
            if (!projection) continue;
            if (projection.workspaceId !== selectedWorkspaceId) continue;
            const persisted = persistedMessages.find((message: Message) => message.id === nodeId);
            if (!persisted) continue;
            if (shouldClearPersistedOptimisticUserProjection(projection, persisted, selectedWorkspaceId)) {
                uiDebug(`persisted-user:clear-overlay node=${nodeId}`, {
                    nodeId,
                    contentLength: persisted.content?.length || 0,
                });
                cleanupAgentRunProjection(nodeId);
                releaseSendFlowKey(nodeId);
                unregisterStreamHandler(nodeId);
                continue;
            }
            if (!isTerminalAgentStatus(persisted.status)) continue;
            const expectedContentLength = projection._terminalContentLength ?? projection.content?.length ?? 0;
            if ((persisted.content?.length ?? 0) < expectedContentLength) continue;
            uiDebug(`persisted-terminal:clear-overlay node=${nodeId}`, {
                nodeId,
                persistedStatus: persisted.status,
                contentLength: persisted.content?.length || 0,
            });
            cleanupAgentRunProjection(nodeId);
            worktreeInfoRef.current.delete(nodeId);
            latencyTraceRef.current.delete(nodeId);
            releaseSendFlowKey(nodeId);
            unregisterStreamHandler(nodeId);
        }
    }, [cleanupAgentRunProjection, workspaceProjectionIds, persistedMessages, releaseSendFlowKey, selectedWorkspaceId, unregisterStreamHandler]);

    useEffect(() => {
        if (!selectedWorkspaceId || !agentClient.hasRuntime()) return;
        for (const message of persistedMessages) {
            if (message.workspaceId !== selectedWorkspaceId) continue;
            if (message.role !== 'assistant') continue;
            if (!isInProgressStatus(message.status)) continue;
            trackAgentRunLiveStreamMessage(message);
        }
    }, [isInProgressStatus, persistedMessages, selectedWorkspaceId]);

    const uploadFile = useCallback(async (attachmentId: string, file: File) => {
        if (!selectedWorkspaceId) {
            setAttachments((prev: Attachment[]) => prev.map((att: Attachment) => (
                getAttachmentId(att) === attachmentId && 'file' in att
                    ? { ...att, status: 'error', error: 'Select a workspace before attaching files.' }
                    : att
            )));
            return;
        }

        setAttachments((prev: Attachment[]) => prev.map((att: Attachment) => (
            getAttachmentId(att) === attachmentId && 'file' in att
                ? { ...att, status: 'uploading', error: undefined }
                : att
        )));

        let localPath: string | null = null;
        let sizeBytes: number | null = file.size || null;
        let remotePath: string | null = null;
        let publicUrl: string | null = null;

        try {
            const attachment = attachmentsRef.current.find((att: Attachment) => getAttachmentId(att) === attachmentId);
            const objectUrl = attachment && 'objectUrl' in attachment ? attachment.objectUrl : undefined;
            const [dataUrl, dimensions] = await Promise.all([
                fileToDataUrl(file),
                getImageDimensions(objectUrl),
            ]);
            const saved = await commands.saveComposerAttachment(
                selectedWorkspaceId,
                attachmentId,
                file.name,
                dataUrl,
            );
            localPath = saved.path;
            sizeBytes = saved.size_bytes ?? sizeBytes;

            if (AGENTREE_DATA_PLANE_ENABLED) {
                try {
                    const signedUpload = await api.post<{
                        signedUrl: string;
                        path: string;
                        publicUrl: string | null;
                    }>('/attachments/signed-url', {
                        filename: file.name,
                        contentType: file.type || 'application/octet-stream',
                    });
                    await axios.put(signedUpload.data.signedUrl, file, {
                        headers: {
                            'Content-Type': file.type || 'application/octet-stream',
                        },
                    });
                    remotePath = signedUpload.data.path;
                    publicUrl = signedUpload.data.publicUrl || null;
                    try {
                        const signedDownload = await api.get<{ signedUrl: string }>('/attachments/signed-download-url', {
                            params: { path: signedUpload.data.path },
                        });
                        publicUrl = signedDownload.data.signedUrl || publicUrl;
                    } catch (downloadError) {
                        console.warn('[ChatInput] Uploaded attachment but could not refresh signed download URL', downloadError);
                    }
                } catch (cloudError) {
                    console.warn('[ChatInput] Cloud attachment upload failed; keeping local cached attachment.', cloudError);
                }
            }

            setAttachments((prev: Attachment[]) => prev.map((att: Attachment) => (
                getAttachmentId(att) === attachmentId && 'file' in att
                    ? {
                        ...att,
                        status: 'uploaded',
                        path: remotePath || localPath || undefined,
                        publicUrl,
                        localPath,
                        sizeBytes,
                        width: dimensions?.width ?? null,
                        height: dimensions?.height ?? null,
                        error: undefined,
                    }
                    : att
            )));
            sendFlowDebug('Attachment cached for agent context', {
                filename: file.name,
                attachmentId,
                hasLocalPath: Boolean(localPath),
                hasRemotePath: Boolean(remotePath),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Upload failed';
            setAttachments((prev: Attachment[]) => prev.map((att: Attachment) => (
                getAttachmentId(att) === attachmentId && 'file' in att
                    ? { ...att, status: 'error', error: message }
                    : att
            )));
            addToast({
                title: 'Attachment upload failed',
                description: message,
                variant: 'error',
            });
        }
    }, [addToast, selectedWorkspaceId]);

    const addFileAttachment = useCallback((file: File) => {
        const newAttachmentId = `${file.name}-${file.lastModified}-${Math.random()}`;
        let objectUrl: string | undefined = undefined;

        if (file.type.startsWith('image/')) {
            try {
                objectUrl = URL.createObjectURL(file);
                sendFlowDebug('Created object URL for attachment preview', { filename: file.name });
            } catch (e) {
                console.error(`[ChatInput] Failed to create object URL for ${file.name}`, e);
            }
        }
        const newAttachment: FileAttachment = {
            id: newAttachmentId,
            file: file,
            status: 'pending',
            objectUrl: objectUrl, // Assign generated URL (or undefined)
        };
        setAttachments((prev: Attachment[]) => [...prev, newAttachment]);
        uploadFile(newAttachmentId, file);
    }, [uploadFile]);

    // --- Explicit Revocation on Remove ---
    const handleRemoveAttachment = useCallback((idToRemove: string) => {
        setAttachments((prev: Attachment[]) => {
            const attachmentToRemove = prev.find((att: Attachment) => getAttachmentId(att) === idToRemove);
            // Revoke object URL *before* removing from state
            if (attachmentToRemove && 'objectUrl' in attachmentToRemove && attachmentToRemove.objectUrl) {
                sendFlowDebug('Revoking object URL for removed attachment', { attachmentId: idToRemove });
                URL.revokeObjectURL(attachmentToRemove.objectUrl);
            }
            return prev.filter((att: Attachment) => getAttachmentId(att) !== idToRemove);
        });
    }, []);

    // --- Cleanup ALL Object URLs on UNMOUNT only ---
    useEffect(() => {
        // Runs only once when the component mounts
        return () => {
            // This cleanup function runs when the component unmounts
            console.log('[ChatInput] Unmounting, revoking any remaining object URLs...');
            // Access the latest state via the ref inside the cleanup function
            attachmentsRef.current.forEach((att: Attachment) => {
                if ('objectUrl' in att && att.objectUrl) {
                    console.log(`[ChatInput] Revoking on unmount: ${att.objectUrl}`);
                    URL.revokeObjectURL(att.objectUrl);
                }
            });
        };
    }, []); // Empty dependency array ensures cleanup runs only on unmount

    // --- Listen for follow-up question population events ---
    useEffect(() => {
        const handlePopulateChatInput = (event: CustomEvent<{ text: string }>) => {
            const { text } = event.detail;
            if (text && typeof text === 'string') {
                setComposerPrompt(text);
                setEditDraftSource(null);
                // Focus the textarea after setting the text
                setTimeout(() => {
                    textareaRef.current?.focus();
                }, 0);
            }
        };

        window.addEventListener('populateChatInput', handlePopulateChatInput as EventListener);

        return () => {
            window.removeEventListener('populateChatInput', handlePopulateChatInput as EventListener);
        };
    }, [setComposerPrompt]);

    useEffect(() => {
        const handleEditUserMessage = (event: CustomEvent<{ message?: Message }>) => {
            const sourceMessage = event.detail?.message;
            if (!sourceMessage || sourceMessage.role !== 'user') return;
            if (sourceMessage.workspaceId !== selectedWorkspaceId) return;

            setEditDraftSource(sourceMessage);
            setComposerPrompt(sourceMessage.content || '', sourceMessage.id);
            setAttachments(sourceMessage.attachments ? [...sourceMessage.attachments] : []);
            setContextIds([]);
            dispatchFocus({
                messageId: sourceMessage.id,
                source: 'chat',
                metadata: { reason: 'edit-user-message' },
            });
            setTimeout(() => textareaRef.current?.focus(), 0);
        };

        window.addEventListener('editUserMessage', handleEditUserMessage as EventListener);

        return () => {
            window.removeEventListener('editUserMessage', handleEditUserMessage as EventListener);
        };
    }, [dispatchFocus, selectedWorkspaceId, setComposerPrompt]);


    const handlePaste = useCallback(async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const items = event.clipboardData.items;
        let imageFile: File | null = null;

        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
                imageFile = items[i].getAsFile();
                if (imageFile) {
                    event.preventDefault();
                    sendFlowDebug('Image paste detected, preventing default');
                    break;
                }
            }
        }

        if (imageFile) {
            console.log('[ChatInput] Processing pasted image:', imageFile.name, imageFile.type);
            addFileAttachment(imageFile);
        }
    }, [addFileAttachment]);

    useEffect(() => {
    }, []);

    const repoMentionSearchIndex = useMemo(
        () => buildRepoMentionSearchIndex(repoMentionFiles),
        [repoMentionFiles]
    );
    const repoMentionFilePathSet = useMemo(
        () => new Set(repoMentionFiles.map((file) => file.path)),
        [repoMentionFiles]
    );
    const repoMentionPathSet = useMemo(
        () => getMentionedRepoPathSet(prompt, repoMentionFilePathSet),
        [prompt, repoMentionFilePathSet]
    );

    useEffect(() => {
        let cancelled = false;

        const loadRepoFiles = async () => {
            if (!selectedWorkspaceRepoPath) {
                setRepoMentionFiles([]);
                return;
            }

            try {
                const currentBranchRef = await agentClient.resolveCurrentBranchRef(selectedWorkspaceRepoPath).catch(() => null);
                const resolvedCommit = currentBranchRef
                    ? await agentClient.resolveRefTip(selectedWorkspaceRepoPath, currentBranchRef).catch(() => null)
                    : null;
                const fallbackCommit = selectedWorkspace?.base_commit_sha?.trim() || null;
                const commit = resolvedCommit || fallbackCommit;

                if (!commit) {
                    if (!cancelled) {
                        setRepoMentionFiles([]);
                    }
                    return;
                }

                const repoPaths = await agentClient.listFilesAtCommit(selectedWorkspaceRepoPath, commit);
                if (cancelled) return;

                setRepoMentionFiles(repoPaths.map((path) => ({
                    path,
                    name: path.split('/').pop() || path,
                })));
            } catch (error) {
                if (cancelled) return;
                console.warn('[ChatInput] Failed to load repo mention files:', error);
                setRepoMentionFiles([]);
            }
        };

        void loadRepoFiles();

        return () => {
            cancelled = true;
        };
    }, [selectedWorkspace?.base_commit_sha, selectedWorkspaceRepoPath]);

    const activeMentionFiles = useMemo(() => {
        if (!activeFileMention) return [];

        return getRepoMentionMatches(repoMentionSearchIndex, activeFileMention.query, 8);
    }, [activeFileMention, repoMentionSearchIndex]);

    useEffect(() => {
        setActiveFileMentionIndex(0);
    }, [activeFileMention?.query]);

    useEffect(() => {
        if (!selectedWorkspaceId) {
            setActiveFileMention(null);
        }
    }, [selectedWorkspaceId]);

    const syncActiveFileMention = useCallback((value: string, cursorPosition: number | null | undefined) => {
        if (!selectedWorkspaceId || cursorPosition == null) {
            setActiveFileMention(null);
            return;
        }
        setActiveFileMention(getActiveFileMention(value, cursorPosition));
    }, [selectedWorkspaceId]);

    const handleRemoveContext = useCallback((id: string) => {
        setContextIds((prev: string[]) => prev.filter((cid: string) => cid !== id));
    }, []);

    const handleAgentSelect = (agentId: string) => {
        autoSelectedAgentIdRef.current = null;
        manuallySelectedAgentIdRef.current = agentId;
        setSelectedAgentId(agentId);
        setTimeout(() => textareaRef.current?.focus(), 0);
    };

    const handleAgentRunCountChange = useCallback((agentId: string, count: number) => {
        autoSelectedAgentIdRef.current = null;
        manuallySelectedAgentIdRef.current = agentId;
        const updated = updateComposerAgentRunCount(normalizedSelectedAgentRunCounts, agentId, count);
        const normalized = normalizeComposerAgentRunCounts(agents, agentId, updated);
        const nextSelectedAgentId = normalized[agentId] > 0
            ? agentId
            : Object.keys(normalized)[0] ?? agentId;

        setSelectedAgentRunCounts(normalized);
        setSelectedAgentId(nextSelectedAgentId);
    }, [agents, normalizedSelectedAgentRunCounts, setSelectedAgentId]);

    const renderAgentModelSelector = () => {
        const selectorLabel = selectedRunTotal > 1
            ? `${selectedRunTotal} runs`
            : selectedAgent?.name || 'Choose model';

        return (
            <Popover open={isAgentPickerOpen} onOpenChange={handleAgentPickerOpenChange}>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        disabled={isSendingMessage || !selectedWorkspaceId}
                        className={cn(
                            "flex h-7 max-w-[200px] flex-shrink-0 items-center gap-1.5 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong))] pl-1.5 pr-2 text-left shadow-[0_1px_2px_rgba(22,26,32,0.05)] transition-all",
                            "hover:border-[hsl(var(--app-border-strong))] hover:bg-background",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1",
                            "disabled:cursor-not-allowed disabled:opacity-50"
                        )}
                        aria-label="Select model"
                    >
                        <div className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-[hsl(var(--app-warning)/0.14)] text-[hsl(var(--app-warning))] shadow-[inset_0_0_0_1px_rgba(182,120,41,0.16)]">
                            <Bot className="h-3 w-3" />
                        </div>
                        <span className="max-w-[140px] truncate text-[11.5px] font-semibold text-foreground">
                            {selectorLabel}
                        </span>
                        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                    </button>
                </PopoverTrigger>
                <PopoverContent
                    disableAnimation
                    className={cn(composerPopupLayerClass, "w-[620px] p-0")}
                    side="top"
                    align="start"
                    sideOffset={8}
                >
                    <div className="h-[390px]">
                        <UnifiedAgentModelSelector
                            onSelectAgent={handleAgentSelect}
                            selectedAgentId={selectedAgentId}
                            agentRunCounts={normalizedSelectedAgentRunCounts}
                            onAgentRunCountChange={handleAgentRunCountChange}
                        />
                    </div>
                </PopoverContent>
            </Popover>
        );
    };

    const handleFileMentionSelect = useCallback((file: RepoMentionFile) => {
        if (!activeFileMention) {
            return;
        }

        const mentionLabel = file.path;
        const currentPrompt = promptRef.current;
        const nextPrompt = `${currentPrompt.slice(0, activeFileMention.start)}@${mentionLabel} ${currentPrompt.slice(activeFileMention.end)}`;
        const nextCursor = activeFileMention.start + mentionLabel.length + 2;

        setComposerPrompt(nextPrompt);
        setActiveFileMention(null);

        window.setTimeout(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
        }, 80);
    }, [activeFileMention, setComposerPrompt]);

    const handlePromptSelectionChange = useCallback((event: React.SyntheticEvent<HTMLTextAreaElement>) => {
        syncActiveFileMention(event.currentTarget.value, event.currentTarget.selectionStart);
    }, [syncActiveFileMention]);

    const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newPrompt = e.target.value;
        setComposerPrompt(newPrompt);

        const nextHasContent = newPrompt.trim().length > 0;
        if (nextHasContent !== promptHasContent) {
            setPromptHasContent(nextHasContent);
        }

        const nextMention = selectedWorkspaceId
            ? getActiveFileMention(newPrompt, e.target.selectionStart ?? newPrompt.length)
            : null;
        const currentMentionKey = activeFileMention
            ? `${activeFileMention.start}:${activeFileMention.end}:${activeFileMention.query}`
            : '';
        const nextMentionKey = nextMention
            ? `${nextMention.start}:${nextMention.end}:${nextMention.query}`
            : '';
        if (currentMentionKey !== nextMentionKey) {
            setActiveFileMention(nextMention);
        }

        if (nextMention) {
            setIsCommandPopoverOpen(false);
        } else if (newPrompt.endsWith('/')) {
            setIsCommandPopoverOpen(true);
        } else if (isCommandPopoverOpen && !newPrompt.includes('/')) {
            setIsCommandPopoverOpen(false);
        }
    };

    const resolveWorkspaceWorkspace = useCallback(async () => {
        const attachedRepoPath = resolveLocalWorkspaceRepoPath(selectedWorkspace);
        const workspaceBaseCommit = selectedWorkspace?.base_commit_sha?.trim() || null;

        if (attachedRepoPath) {
            return {
                repoPath: attachedRepoPath,
                baseCommitSha: workspaceBaseCommit,
            };
        }

        throw new Error('This workspace is not connected to a local folder on this machine. Reconnect repository.');
    }, [selectedWorkspace]);

    // ============================================================================
    // OPTIMISTIC MESSAGE SENDING WITH PARALLEL AGENT SETUP
    // ============================================================================

    /**
     * Main send handler with optimistic UI and parallel agent setup
     * 
     * FLOW:
     * 1. Validate inputs (< 10ms)
     * 2. Create optimistic messages immediately (< 50ms)
     * 3. Clear input immediately
     * 4. Send API request in background
     * 5. If agent selected, start setup in parallel
     * 6. Start streaming immediately
     * 7. Reconcile optimistic with real response
     * 
     * ERROR HANDLING:
     * - Network errors: Show toast, remove optimistic messages after delay
     * - 409 conflicts: Show toast, remove optimistic immediately
     * - Agent setup errors: Show toast, mark node failed
     * - Cancelled: Remove optimistic immediately
     */
    const handleSend = useCallback(async () => {
        try {
        const currentPrompt = promptRef.current;
        const hasLocalAgentRuntime = agentClient.hasRuntime();
        sendFlowDebug('handleSend invoked', {
            selectedWorkspaceId,
            focusedMessageId,
            selectedAgentId,
            promptLength: currentPrompt.trim().length,
            attachmentCount: attachments.length,
            contextEntryCount: contextIds.length,
            isParentIncomplete,
            hasLocalAgentRuntime,
        });
        if (isSteeringRunningAssistant && selectedNodeId) {
            if (attachments.length > 0 || contextIds.length > 0) {
                addToast({
                    title: 'Steering supports text only',
                    description: 'Send a short text intervention to the running agent.',
                    variant: 'error',
                });
                return;
            }
            const steerContent = currentPrompt.trim();
            if (!steerContent) return;
            await commands.steerAgentRun(selectedNodeId, steerContent, crypto.randomUUID());
            setComposerPrompt('');
            setTimeout(() => textareaRef.current?.focus(), 0);
            return;
        }
        // --- 1. VALIDATION ---
        const filesInProgress = attachments.some((att: Attachment) =>
            'status' in att && (att.status === 'pending' || att.status === 'uploading')
        );
        if (filesInProgress) {
            console.warn('[SEND_FLOW] BLOCKED at filesInProgress guard');
            alert("Please wait for file uploads to complete.");
            return;
        }
        if (isParentIncomplete) {
            console.warn('[SEND_FLOW] BLOCKED at isParentIncomplete guard');
            addToast({
                title: 'Parent still running',
                description: 'Wait for the parent response to complete before branching.',
                variant: 'error',
            });
            return;
        }
        if (!currentPrompt.trim() && attachments.length === 0 && contextIds.length === 0) return;

        const hasWorkspaceRepo = !!(selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath);
        if (!hasWorkspaceRepo) {
            console.warn('[SEND_FLOW] BLOCKED at hasWorkspaceRepo guard', {
                selectedWorkspaceId,
                hasGitRepoPath: Boolean(selectedWorkspace?.git_repo_path),
                hasFolderPath: Boolean(selectedWorkspace?.folderPath),
            });
            addToast({
                title: 'Workspace required',
                description: 'Attach a project repository before sending messages.',
                variant: 'error',
            });
            return;
        }
        const agentRunItemsForSend = selectedAgentRunItems.length > 0
            ? selectedAgentRunItems
            : (selectedAgent ? [{
                agentId: selectedAgent.id,
                agentName: selectedAgent.name,
                ordinal: 1,
                totalForAgent: 1,
                agent: selectedAgent,
            }] : []);
        const primaryAgentRun = agentRunItemsForSend[0] ?? null;
        const primarySelectedAgent = primaryAgentRun?.agent ?? null;

        if (!primarySelectedAgent || agentRunItemsForSend.length === 0) {
            console.warn('[SEND_FLOW] BLOCKED at selectedAgent guard', {
                selectedAgentId: selectedAgentId || '(none)',
                selectedAgentFound: Boolean(selectedAgent),
                loadedAgentIds: agents.map(a => a.id),
            });
            addToast({
                title: 'Model required',
                description: 'Select a Claude or Codex model before sending.',
                variant: 'error',
            });
            return;
        }
        if (sendAcceptanceInFlightRef.current && !queuedReplayInFlightRef.current) {
            const queuedSend: QueuedComposerSend = {
                id: `queued-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                prompt: currentPrompt,
                attachments: [...attachments],
                contextIds: [...contextIds],
                editDraftSource,
                parentMessageId: resolvePersistedMessageId(replyParentMessageId) ?? replyParentMessageId ?? null,
                draftTargetId: composerDraftTargetId,
                queuedAt: Date.now(),
            };
            queuedComposerSendsRef.current.push(queuedSend);
            setQueuedComposerSendCount(queuedComposerSendsRef.current.length);
            setComposerPrompt('');
            clearComposerDraft(selectedWorkspaceId, composerDraftTargetId);
            setAttachments([]);
            setContextIds([]);
            setEditDraftSource(null);
            recordSendFlowEvent('queue.enqueued', {
                workspaceId: selectedWorkspaceId,
                queuedSendId: queuedSend.id,
                queueDepth: queuedComposerSendsRef.current.length,
                parentId: queuedSend.parentMessageId,
                promptLength: queuedSend.prompt.trim().length,
            }, { source: 'ChatInput' });
            return;
        }
        if (!tryBeginComposerSendStart(composerSendStartGateRef.current)) {
            sendFlowDebug('Ignoring duplicate send while composer send is arming');
            return;
        }

        const flowId = createSendFlowId();
        const controller = new AbortController();
        flushSync(() => {
            setCurrentAbortController(controller);
            setActiveComposerSend({
                flowId,
                nodeIds: [],
                preferredNodeId: null,
                workspaceId: selectedWorkspaceId,
            });
            setComposerPrompt('');
            clearComposerDraft(selectedWorkspaceId, composerDraftTargetId);
            setAttachments([]);
            setContextIds([]);
            setEditDraftSource(null);
        });
        recordSendFlowEvent('cancel.affordance-armed', {
            flowId,
            workspaceId: selectedWorkspaceId,
            phase: 'pre-optimistic',
        }, { source: 'ChatInput' });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (controller.signal.aborted) {
            setCurrentAbortController(null);
            setActiveComposerSend(null);
            finishComposerSendStart(composerSendStartGateRef.current);
            recordSendFlowEvent('lifecycle.cancelled', {
                flowId,
                workspaceId: selectedWorkspaceId,
                errorType: 'CANCELLED',
                errorMessage: 'Request was cancelled before optimistic nodes were created.',
            }, { source: 'ChatInput' });
            return;
        }

        const agentTypesForReadiness = Array.from(new Set(
            agentRunItemsForSend
                .map((run) => run.agent.type)
                .filter((type): type is 'codex' | 'claude' => type === 'codex' || type === 'claude')
        ));
        const loginProfilesAtSend = useLoginProfilesStore.getState().profiles;
        const loginReadinessFailures = hasLocalAgentRuntime
            ? agentTypesForReadiness.map((agentType) => {
                const label = agentType === 'codex' ? 'Codex' : 'Claude';
                const selection = resolveLoginProfileSelection({
                    profiles: loginProfilesAtSend,
                    provider: agentType,
                    agentName: label,
                });
                if (selection.isReady) return null;
                return {
                    agentType,
                    status: selection.selectedProfile?.status ?? 'auth_missing',
                    message: selection.selectedProfile?.statusMessage || selection.failureMessage || `${label} needs a ready login profile before it can run.`,
                };
            }).filter((failure): failure is { agentType: 'codex' | 'claude'; status: string; message: string } => failure != null)
            : [];

        // --- 2. PREPARE DATA ---
        const structuredAttachments: AttachmentMetadata[] = attachments
            .map((att: Attachment): AttachmentMetadata | null => {
                if ('file' in att && att.status === 'uploaded' && att.path) {
                    return {
                        path: att.path,
                        publicUrl: att.publicUrl || null,
                        filename: att.file.name,
                        contentType: att.file.type,
                        localPath: att.localPath || null,
                        sizeBytes: att.sizeBytes ?? null,
                        width: att.width ?? null,
                        height: att.height ?? null,
                    };
                }
                if ('path' in att && 'filename' in att) {
                    return {
                        path: att.path,
                        publicUrl: att.publicUrl || null,
                        filename: att.filename,
                        contentType: att.contentType,
                        localPath: att.localPath || null,
                        sizeBytes: att.sizeBytes ?? null,
                        width: att.width ?? null,
                        height: att.height ?? null,
                    };
                }
                return null;
            })
            .filter((att: AttachmentMetadata | null): att is AttachmentMetadata => !!att);

        const shouldUseAgent = true;
        sendFlowDebug('validation complete', {
            hasLocalAgentRuntime,
            selectedAgentType: primarySelectedAgent?.type ?? null,
            selectedRunCount: agentRunItemsForSend.length,
        });
        const getSelectedLlmModel = (agent: typeof primarySelectedAgent) =>
            agent?.model_config?.model ||
            parseRuntimeCliArgs(agent?.cliArgs).model ||
            null;
        const getSelectedReasoningEffort = (agent: typeof primarySelectedAgent) =>
            agent?.model_config?.reasoningEffort ||
            parseRuntimeCliArgs(agent?.cliArgs).reasoningEffort ||
            null;
        const selectedLlmModel = getSelectedLlmModel(primarySelectedAgent);

        const focusStateAtSendStart = useWorkspaceStore.getState();
        const savedEditDraftSource = editDraftSource;
        const sendParentMessageId = resolveSendParentMessageId({
            hasEditDraftSource: Boolean(savedEditDraftSource),
            editDraftSourceParentId: savedEditDraftSource?.parentId ?? null,
            parentMessageIdOverride,
            forceRootParent: isNewThreadTarget,
            focusSnapshot: {
                focusedMessageId: focusStateAtSendStart.focusedMessageId,
                lastFocusSource: focusStateAtSendStart.lastFocusSource,
                lastFocusMetadata: focusStateAtSendStart.lastFocusMetadata as Record<string, unknown> | null,
            },
            resolvePersistedMessageId,
        });
        const resolvedParentMessage = sendParentMessageId ? messageById.get(sendParentMessageId) ?? null : null;

        const sendContextPolicy: ContextPolicy = isNewThreadTarget ? 'fresh' : contextPolicy;
        const effectiveContextMode: ContextMode = sendContextPolicy === 'fresh' ? 'none' : contextMode;
        const defaultSendContextParentMessage = resolveConversationContextMessage(sendParentMessageId, messageById);
        const rawSendContextParentId = mergeContextOptions.length > 0
            ? selectedMergeContextParentId
            : defaultSendContextParentMessage?.id ?? null;
        const sendContextParentId = resolvePersistedMessageId(
            sendContextPolicy === 'fresh' ? null : rawSendContextParentId
        );
        const sendContextStartId = resolvePersistedMessageId(
            sendContextPolicy === 'fresh'
                ? null
                : sendContextParentId === effectiveContextParentId
                    ? effectiveContextStartId || null
                    : resolveContextStartMessage(sendContextParentId, messageLookupMessages, messageById)?.id ?? null
        );
        let sendThreadId: string | null = null;
        if (sendParentMessageId) {
            const parentThreadMessage = messageById.get(sendParentMessageId) ?? null;
            sendThreadId = getMessageThreadSessionId(parentThreadMessage)
                ?? (parentThreadMessage ? getLegacyThreadIdForMessage(parentThreadMessage, messageById) : null);
        } else if (savedEditDraftSource) {
            sendThreadId = getMessageThreadSessionId(savedEditDraftSource)
                ?? getLegacyThreadIdForMessage(savedEditDraftSource, messageById);
        }
        if (!sendThreadId && selectedWorkspaceId) {
            const thread = await createThreadSession.mutateAsync({
                workspaceId: selectedWorkspaceId,
                source: 'user',
                baseCommitSha: effectiveBaseCommitSha || selectedWorkspace?.base_commit_sha || null,
            });
            sendThreadId = thread.id;
        }
        const sendThreadOriginId = sendThreadId;
        // --- 3. CREATE OPTIMISTIC MESSAGES (IMMEDIATE UI UPDATE) ---
        const parentPathIds = resolvedParentMessage?.path_ids || [];
        const parentDepth = resolvedParentMessage?.depth ?? -1;

        const composerTurnTopology = buildComposerAgentTurnTopology(agentRunItemsForSend, sendParentMessageId);
        const shouldCreateSiblingTurns = hasLocalAgentRuntime && composerTurnTopology.length > 1;
        const optimisticTurns = (shouldCreateSiblingTurns ? composerTurnTopology : composerTurnTopology.slice(0, 1)).map((run) => {
            const pair = createOptimisticNodePair(
                {
                    id: hasLocalAgentRuntime ? crypto.randomUUID() : undefined,
                    workspaceId: selectedWorkspaceId!,
                    parentId: run.userParentId,
                    content: currentPrompt.trim(),
                    attachments: structuredAttachments,
                    pathIds: parentPathIds,
                    depth: parentDepth + 1,
                    role: 'user',
                },
                {
                    id: hasLocalAgentRuntime ? crypto.randomUUID() : undefined,
                    llmModel: getSelectedLlmModel(run.agent),
                    llmProvider: run.agent.type || null,
                    reasoningEffort: getSelectedReasoningEffort(run.agent),
                    agentId: run.agentId,
                    status: 'pending',
                }
            );

            return {
                ...run,
                userMessage: pair.userMessage,
                userMessageId: pair.userMessageId,
                assistantMessage: pair.assistantMessage,
                assistantMessageId: pair.assistantMessageId,
            };
        });
        const optimisticPair = {
            userMessage: optimisticTurns[0].userMessage,
            assistantMessage: optimisticTurns[0].assistantMessage,
            userMessageId: optimisticTurns[0].userMessageId,
            assistantMessageId: optimisticTurns[0].assistantMessageId,
        };
        const assistantRunMessages = shouldCreateSiblingTurns
            ? optimisticTurns
            : agentRunItemsForSend.map((run, index) => {
                if (index === 0) {
                    return {
                        ...run,
                        userMessage: optimisticPair.userMessage,
                        userMessageId: optimisticPair.userMessageId,
                        assistantMessage: optimisticPair.assistantMessage,
                        assistantMessageId: optimisticPair.assistantMessageId,
                    };
                }

                const assistantMessage = createOptimisticAssistantMessage(
                    {
                        id: hasLocalAgentRuntime ? crypto.randomUUID() : undefined,
                        workspaceId: selectedWorkspaceId!,
                        parentId: optimisticPair.userMessageId,
                        content: '',
                        attachments: [],
                        pathIds: optimisticPair.userMessage.path_ids ?? [optimisticPair.userMessageId],
                        depth: optimisticPair.userMessage.depth ?? parentDepth + 1,
                        role: 'assistant',
                        llmModel: getSelectedLlmModel(run.agent),
                        llmProvider: run.agent.type || null,
                        reasoningEffort: getSelectedReasoningEffort(run.agent),
                        agentId: run.agentId,
                        status: 'pending',
                    },
                    optimisticPair.userMessageId
                );

                return {
                    ...run,
                    userMessage: optimisticPair.userMessage,
                    userMessageId: optimisticPair.userMessageId,
                    assistantMessage,
                    assistantMessageId: assistantMessage.id,
                };
            });
        const optimisticUserMessageIds = Array.from(new Set(assistantRunMessages.map((run) => run.userMessageId)));
        const optimisticUserMessages = Array.from(
            new Map(assistantRunMessages.map((run) => [run.userMessageId, run.userMessage])).values()
        );
        const optimisticAssistantMessageIds = assistantRunMessages
            .map((run) => run.assistantMessageId)
            .filter((id): id is string => Boolean(id));
        sendFlowDebug('optimistic pair created', {
            userMessageId: optimisticPair.userMessageId,
            assistantMessageId: optimisticPair.assistantMessageId ?? null,
            assistantRunCount: assistantRunMessages.length,
        });

        const operationKey = optimisticPair.assistantMessageId || optimisticPair.userMessageId;
        sendAcceptanceInFlightRef.current = true;
        setIsSendAcceptanceInFlight(true);
        finishComposerSendStart(composerSendStartGateRef.current);
        assignSendFlowKey(operationKey, flowId);
        optimisticUserMessageIds.forEach((userMessageId) => assignSendFlowKey(userMessageId, flowId));
        optimisticAssistantMessageIds.forEach((assistantMessageId) => assignSendFlowKey(assistantMessageId, flowId));
        const savedPrompt = currentPrompt;
        const savedAttachments = [...attachments];
        const savedContextIds = [...contextIds];
        const shouldAutoCheckout = autoCheckoutOnAgentCommit;
        const optimisticNodeIds = [
            ...optimisticUserMessageIds,
            ...optimisticAssistantMessageIds,
        ];
        const sendFlowFocusGuardIds = [
            focusStateAtSendStart.focusedMessageId,
            sendParentMessageId,
            ...optimisticNodeIds,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0);
        const releaseSendAcceptance = (reason: string) => {
            if (!sendAcceptanceInFlightRef.current) return;
            sendAcceptanceInFlightRef.current = false;
            setIsSendAcceptanceInFlight(false);
            setActiveComposerSend((current) => current?.flowId === flowId ? null : current);
            setCurrentAbortController((current) => current === controller ? null : current);
            recordSendFlowEvent('queue.acceptance-released', {
                flowId,
                workspaceId: selectedWorkspaceId,
                operationKey,
                reason,
                queueDepth: queuedComposerSendsRef.current.length,
            }, { source: 'ChatInput' });
        };

        if (sendThreadId) {
            for (const userMessage of optimisticUserMessages) {
                userMessage.threadId = sendThreadId;
                userMessage.thread_id = sendThreadId;
                userMessage.execution_data = {
                    ...(userMessage.execution_data || {}),
                    meta: {
                        ...(((userMessage.execution_data as any)?.meta) || {}),
                        thread_origin_id: sendThreadId,
                    },
                };
            }
            for (const run of assistantRunMessages) {
                if (!run.assistantMessage) continue;
                run.assistantMessage.threadId = sendThreadId;
                run.assistantMessage.thread_id = sendThreadId;
            }
        }

        if (sendContextPolicy === 'fresh' || sendContextParentId) {
            for (const userMessage of optimisticUserMessages) {
                userMessage.execution_data = {
                    meta: {
                        ...(((userMessage.execution_data as any)?.meta) || {}),
                        context_policy: sendContextPolicy,
                        context_boundary_from_node_id: sendContextPolicy === 'fresh' ? sendParentMessageId : null,
                        context_parent_node_id: sendContextPolicy === 'fresh' ? null : sendContextParentId,
                        context_base_node_id: sendParentMessageId,
                    },
                    context_profile: {
                        context_parent_node_id: sendContextPolicy === 'fresh' ? null : sendContextParentId,
                        base_node_id: sendParentMessageId,
                        inherited_from_node_id: sendContextPolicy === 'fresh' ? null : sendParentMessageId,
                    },
                };
            }
            for (const run of assistantRunMessages) {
                if (!run.assistantMessage) continue;
                run.assistantMessage.execution_data = {
                    ...(run.assistantMessage.execution_data || {}),
                    meta: {
                        ...(((run.assistantMessage.execution_data as any)?.meta) || {}),
                        context_policy: sendContextPolicy,
                        context_boundary_from_node_id: sendContextPolicy === 'fresh' ? sendParentMessageId : null,
                        context_parent_node_id: sendContextPolicy === 'fresh' ? null : sendContextParentId,
                        context_base_node_id: sendParentMessageId,
                    },
                    context_profile: {
                        context_parent_node_id: sendContextPolicy === 'fresh' ? null : sendContextParentId,
                        base_node_id: sendParentMessageId,
                        inherited_from_node_id: sendContextPolicy === 'fresh' ? null : run.userMessageId,
                    },
                };
            }
        }
        for (const run of assistantRunMessages) {
            if (!run.assistantMessage) continue;
            run.assistantMessage.base_commit_sha = effectiveBaseCommitSha || null;
            run.assistantMessage.base_selected_from_node_id = effectiveBaseSelectedFromNodeId;
        }

        // Enter the bounded graph send mode before optimistic nodes are added.
        // React batches this with the optimistic UI updates below, so the first
        // render sees both the active send guard and the new nodes.
        beginSendFlowFocus({
            flowId,
            workspaceId: selectedWorkspaceId!,
            preferredMessageId: optimisticPair.assistantMessageId ?? optimisticPair.userMessageId,
            guardedMessageIds: sendFlowFocusGuardIds,
            ownerFocusNonce: focusStateAtSendStart.focusNonce,
            phase: 'optimistic-user',
        });
        setActiveComposerSend({
            flowId,
            nodeIds: optimisticNodeIds,
            preferredNodeId: optimisticPair.assistantMessageId ?? optimisticPair.userMessageId,
            workspaceId: selectedWorkspaceId,
        });
        for (const userMessage of optimisticUserMessages) {
            seedAgentRunProjection(userMessage.id, userMessage);
        }
        for (const run of assistantRunMessages) {
            if (!run.assistantMessage || !run.assistantMessageId) continue;
            seedAgentRunProjection(run.assistantMessageId, run.assistantMessage);
        }
        setComposerPrompt('');
        clearComposerDraft(selectedWorkspaceId, composerDraftTargetId);
        setAttachments([]);
        setContextIds([]);
        setEditDraftSource(null);
        setCurrentAbortController(controller);
        track('Agent Message Submitted', {
            ...(primarySelectedAgent?.type ? { agent_provider: primarySelectedAgent.type } : {}),
            agent_run_count_bucket: bucketCount(agentRunItemsForSend.length),
            prompt_chars_bucket: bucketCharacterCount(savedPrompt.trim().length),
            attachment_count_bucket: bucketCount(savedAttachments.length),
            context_entry_count_bucket: bucketCount(savedContextIds.length),
            has_parent: Boolean(sendParentMessageId),
            edit_and_run: Boolean(savedEditDraftSource),
        });
        recordSendFlowEvent('flow.started', {
            flowId,
            workspaceId: selectedWorkspaceId,
            useAgent: true,
            promptLength: savedPrompt.trim().length,
            attachmentCount: savedAttachments.length,
            contextEntryCount: savedContextIds.length,
            optimisticUserMessageId: optimisticPair.userMessageId,
            optimisticUserMessageIds,
            optimisticAssistantMessageId: optimisticPair.assistantMessageId || null,
            optimisticAssistantMessageIds,
        }, { source: 'ChatInput' });
        sendFlowDebug('optimistic pair stored');

        for (const userMessageId of optimisticUserMessageIds) {
            recordSendFlowEvent('optimistic.user-created', {
                flowId,
                workspaceId: selectedWorkspaceId,
                messageId: userMessageId,
                parentId: sendParentMessageId,
            }, { source: 'ChatInput' });
        }
        for (const run of assistantRunMessages) {
            if (!run.assistantMessageId) continue;
            recordSendFlowEvent('optimistic.assistant-created', {
                flowId,
                workspaceId: selectedWorkspaceId,
                messageId: run.assistantMessageId,
                parentId: run.userMessageId,
            }, { source: 'ChatInput' });
        }
        const cleanupOptimisticPair = (delayMs: number, finalStatus: string) => {
            window.setTimeout(() => {
                optimisticUserMessageIds.forEach((userMessageId) => {
                    removeOptimisticNode(userMessageId);
                    releaseSendFlowKey(userMessageId);
                });
                optimisticAssistantMessageIds.forEach((assistantMessageId) => {
                    removeOptimisticNode(assistantMessageId);
                    releaseSendFlowKey(assistantMessageId);
                });
                releaseSendFlowKey(operationKey);
                recordSendFlowEvent('cleanup.finished', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    nodeId: optimisticAssistantMessageIds[0] || optimisticPair.userMessageId,
                    finalStatus,
                }, { source: 'ChatInput' });
            }, delayMs);
        };

        // Track this operation
        agentSetupControllersRef.current.set(operationKey, controller);
        recordLatencyMark(operationKey, 'send_clicked', {
            source: 'frontend',
            detail: {
                agentType: primarySelectedAgent?.type || null,
                workspaceId: selectedWorkspaceId,
            },
        });

        try {
            // Let React and the WebView paint the optimistic message and cleared
            // composer before native persistence/worktree setup can occupy a frame.
            await waitForOptimisticSendPaint();
            if (controller.signal.aborted) {
                throw Object.assign(new Error('Request was cancelled'), { name: 'CanceledError' });
            }
            if (shouldUseAgent) {
                for (const run of assistantRunMessages) {
                    if (!run.assistantMessageId) continue;
                    setNodeStatus(run.assistantMessageId, 'initializing');
                    setSetupProgress(run.assistantMessageId, 'Initializing agent...');
                }
            }
            dispatchSendFlowFocus({
                flowId,
                messageId: optimisticPair.userMessageId,
                phase: 'optimistic-user',
                allowedCurrentFocusIds: [focusStateAtSendStart.focusedMessageId, sendParentMessageId],
            });

            if (loginReadinessFailures.length > 0) {
                const blockedReadiness = loginReadinessFailures[0];
                console.warn('[SEND_FLOW] BLOCKED at login profile guard (not ready)');
                const label = blockedReadiness.agentType === 'codex' ? 'Codex' : 'Claude';
                addToast({
                    title: blockedReadiness.status === 'keychain_unavailable' ? `${label} login unavailable to Agentree` : `${label} login setup required`,
                    description: blockedReadiness.message,
                    variant: 'error',
                    persistent: true,
                });
                markNodeFailed(optimisticPair.userMessageId, blockedReadiness.message);
                optimisticUserMessageIds
                    .filter((userMessageId) => userMessageId !== optimisticPair.userMessageId)
                    .forEach((userMessageId) => markNodeFailed(userMessageId, blockedReadiness.message));
                optimisticAssistantMessageIds.forEach((assistantMessageId) => {
                    markNodeFailed(assistantMessageId, blockedReadiness.message);
                });
                recordSendFlowEvent('lifecycle.failed', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    operationKey,
                    errorType: 'LOGIN_PROFILE_NOT_READY',
                    errorMessage: blockedReadiness.message,
                }, { source: 'ChatInput' });
                endSendFlowFocus(flowId);
                commitFocusHandledByFlowRef.current.delete(flowId);
                latencyTraceRef.current.delete(operationKey);
                cleanupOptimisticPair(3000, 'login-profile-not-ready');
                return;
            }

            if (hasLocalAgentRuntime && optimisticAssistantMessageIds.length > 0) {
                sendFlowDebug('Persisting local-first composer messages');
                setSetupProgress(optimisticPair.userMessageId, 'Starting locally...');
                const assistantMessages = assistantRunMessages
                    .map((run) => run.assistantMessage)
                    .filter((message): message is Message => Boolean(message));
                const persistedUserMessages = optimisticUserMessages.map(materializePersistedOptimisticUserMessage);
                const localFirstMessages = [
                    ...persistedUserMessages,
                    ...assistantMessages,
                ];
                // Persist before any asynchronous launch preflight so an app crash or
                // validation failure cannot discard the accepted user prompt.
                await Promise.all([
                    ...persistedUserMessages.map((userMessage) => (
                        agentClient.upsertLocalNode(selectedWorkspaceId!, userMessage.id, userMessage)
                    )),
                    ...assistantMessages.map((assistantMessage) => (
                        agentClient.upsertLocalNode(selectedWorkspaceId!, assistantMessage.id, assistantMessage)
                    )),
                ]);
                queryClient.setQueryData<Message[]>(['messages', selectedWorkspaceId], (current) => {
                    const existing = current ?? [];
                    const ids = new Set([...optimisticUserMessageIds, ...optimisticAssistantMessageIds]);
                    return [
                        ...existing.filter((message) => !ids.has(message.id)),
                        ...persistedUserMessages,
                        ...assistantMessages,
                    ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
                });
                queryClient.setQueryData<LocalNodeMessage[]>(
                    localNodeKeys.workspace(selectedWorkspaceId!),
                    (current) => upsertMessagesIntoLocalNodeCache(current, selectedWorkspaceId!, localFirstMessages, {
                        syncStatus: 'local_only',
                        finalizedAt: Math.floor(Date.now() / 1000),
                    })
                );
                void queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(selectedWorkspaceId!) });
                recordSendFlowEvent('local-first.persisted', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    userMessageId: optimisticPair.userMessageId,
                    userMessageIds: optimisticUserMessageIds,
                    assistantMessageId: optimisticPair.assistantMessageId,
                    assistantMessageIds: optimisticAssistantMessageIds,
                }, { source: 'ChatInput' });
                releaseSendAcceptance('local-first-persisted');

                const token = await getOptionalCloudAuthToken();
                optimisticAssistantMessageIds.forEach((assistantMessageId) => {
                    attachLatencyTraceToNode(operationKey, assistantMessageId, token);
                    recordLatencyMark(assistantMessageId, 'assistant_node_created', {
                        authToken: token,
                        nodeId: assistantMessageId,
                        detail: { local_first: true },
                    });
                });
                dispatchSendFlowFocus({
                    flowId,
                    messageId: optimisticAssistantMessageIds[0],
                    phase: 'real-assistant',
                    allowedCurrentFocusIds: [
                        optimisticPair.userMessageId,
                        ...optimisticAssistantMessageIds,
                        sendParentMessageId,
                    ],
                });
                advanceSendFlowFocus({
                    flowId,
                    preferredMessageId: optimisticAssistantMessageIds[0],
                    addGuardedMessageIds: [optimisticPair.userMessageId, ...optimisticAssistantMessageIds],
                    phase: 'real-assistant',
                });
                assistantMessages.forEach((assistantMessage) => {
                    const run = assistantRunMessages.find((candidate) => candidate.assistantMessageId === assistantMessage.id);
                    trackStreamForNode(assistantMessage, {
                        authToken: token,
                        parentId: run?.userMessageId ?? optimisticPair.userMessageId,
                    }).catch(err => {
                        console.warn('[SEND_FLOW] Streaming error:', err);
                    });
                });

                for (const run of assistantRunMessages) {
                    if (!run.assistantMessage || !run.assistantMessageId) continue;
                    if (shouldAutoCheckout) {
                        autoCheckoutPendingRef.current.add(run.assistantMessageId);
                    }
                    runAgentSetupInBackground({
                        nodeId: run.assistantMessageId,
                        userMsg: run.userMessage,
                        assistantMsg: run.assistantMessage as Message,
                        prompt: savedPrompt.trim(),
                        attachments: structuredAttachments,
                        authToken: token,
                        autoCheckout: shouldAutoCheckout,
                        contextPolicy: sendContextPolicy,
                        parentMessageId: run.userMessageId,
                        baseMessageId: sendParentMessageId,
                        threadId: sendThreadId,
                        contextParentMessageId: sendContextParentId,
                        contextStartMessageId: sendContextStartId,
                    }).catch(err => {
                        console.error('[SEND_FLOW] Background agent setup error:', err);
                    });
                }
                resetComposerTargetAfterSuccessfulSend();
                onSendComplete?.();
                return;
            }

            // --- 5. SEND API REQUEST ---
            sendFlowDebug('Sending API request');
            setSetupProgress(optimisticPair.userMessageId, 'Sending...');
            recordLatencyMark(operationKey, 'send_request_started', {
                source: 'frontend',
                detail: {
                    useAgent: true,
                    contextEntries: savedContextIds.length,
                    attachmentCount: structuredAttachments.length,
                },
            });
            recordSendFlowEvent('api.request-start', {
                flowId,
                workspaceId: selectedWorkspaceId,
                operationKey,
                parentId: sendParentMessageId,
                contextParentId: sendContextParentId,
            }, { source: 'ChatInput' });

            const response = await sendMessageMutation.mutateAsync({
                workspaceId: selectedWorkspaceId!,
                prompt: savedPrompt.trim(),
                parentId: sendParentMessageId,
                attachments: structuredAttachments,
                contextIds: savedContextIds,
                contextMode: effectiveContextMode,
                contextPolicy: sendContextPolicy,
                useAgent: true,
                agentId: primarySelectedAgent.id,
                agentProvider: primarySelectedAgent?.type || null,
                llmModel: selectedLlmModel,
                contextParentId: sendContextParentId,
                threadId: sendThreadId,
                threadOriginId: sendThreadOriginId,
                perfFlowId: flowId,
                signal: controller.signal,
            });
            recordLatencyMark(operationKey, 'send_response_received', {
                source: 'frontend',
                detail: {
                    hasAssistant: Boolean(response?.assistantMessages?.[0]),
                    debugProfileMs: response?.debug_profile_ms ?? null,
                },
            });
            recordSendFlowEvent('api.response-received', {
                flowId,
                workspaceId: selectedWorkspaceId,
                operationKey,
                userMessageId: response?.userMessage?.id ?? null,
                assistantMessageId: response?.assistantMessages?.[0]?.id ?? null,
                hasAssistant: Boolean(response?.assistantMessages?.[0]),
                debugProfileMs: response?.debug_profile_ms ?? null,
            }, { source: 'ChatInput' });
            releaseSendAcceptance('api-response-received');
            if (selectedWorkspaceId && Number.isFinite(Number(response?.messageDeltaCursor))) {
                primeHotSendMessageDeltaCursor(selectedWorkspaceId, Number(response.messageDeltaCursor));
            }

            // --- 6. REPLACE OPTIMISTIC WITH REAL MESSAGES ---
            // IMPORTANT: Replace optimistic nodes BEFORE updating focus
            // This ensures the real IDs are in messagesForRender when focus effect runs
            if (response?.userMessage) {
                sendFlowDebug('Replacing user optimistic node', {
                    fromNodeId: optimisticPair.userMessageId,
                    toNodeId: response.userMessage.id,
                });
                replaceOptimisticNode(optimisticPair.userMessageId, response.userMessage);
                sendFlowDebug('Updating focus to real user', { messageId: response.userMessage.id });
                dispatchSendFlowFocus({
                    flowId,
                    messageId: response.userMessage.id,
                    phase: 'real-user',
                    allowedCurrentFocusIds: [
                        optimisticPair.userMessageId,
                        optimisticPair.assistantMessageId,
                        sendParentMessageId,
                    ],
                });
                advanceSendFlowFocus({
                    flowId,
                    preferredMessageId: response.userMessage.id,
                    addGuardedMessageIds: [response.userMessage.id],
                    phase: 'real-user',
                });
                assignSendFlowKey(response.userMessage.id, flowId);
                recordSendFlowEvent('user.persisted', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    messageId: response.userMessage.id,
                    optimisticMessageId: optimisticPair.userMessageId,
                }, { source: 'ChatInput' });
            }

            let realAssistantId: string | null = null;
            if (response?.assistantMessages?.[0]) {
                const realAssistant = response.assistantMessages[0];
                const assistantId = realAssistant.id;
                realAssistantId = assistantId;

                sendFlowDebug('Real assistant ID', { assistantId });

                if (optimisticPair.assistantMessageId) {
                    sendFlowDebug('Replacing assistant optimistic node', {
                        fromNodeId: optimisticPair.assistantMessageId,
                        toNodeId: assistantId,
                    });
                    replaceOptimisticNode(optimisticPair.assistantMessageId, realAssistant);
                }
                assignSendFlowKey(assistantId, flowId);
                recordSendFlowEvent('assistant.persisted', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    messageId: assistantId,
                    optimisticMessageId: optimisticPair.assistantMessageId || null,
                }, { source: 'ChatInput' });

                sendFlowDebug('Updating focus to real assistant', { messageId: assistantId });
                dispatchSendFlowFocus({
                    flowId,
                    messageId: assistantId,
                    phase: 'real-assistant',
                    allowedCurrentFocusIds: [
                        response?.userMessage?.id,
                        optimisticPair.userMessageId,
                        optimisticPair.assistantMessageId,
                        sendParentMessageId,
                    ],
                });
                advanceSendFlowFocus({
                    flowId,
                    preferredMessageId: assistantId,
                    addGuardedMessageIds: [assistantId],
                    phase: 'real-assistant',
                });

                const token = await getOptionalCloudAuthToken();
                attachLatencyTraceToNode(operationKey, realAssistant.id, token);
                recordLatencyMark(realAssistant.id, 'assistant_node_created', {
                    authToken: token,
                    nodeId: realAssistant.id,
                    detail: {
                        optimistic_node_id: optimisticPair.assistantMessageId || null,
                    },
                });
                if (!hasLocalAgentRuntime) {
                    const runtimeUnavailableContent = 'Local agent runtime is unavailable in browser preview.';
                    const patchedAssistantResponse = await api.patch(`/messages/${assistantId}`, {
                        content: runtimeUnavailableContent,
                        status: 'failed',
                        execution_data: {
                            ...(realAssistant.execution_data || {}),
                            meta: {
                                ...(((realAssistant.execution_data || {}) as any)?.meta || {}),
                                browser_preview_runtime_unavailable: true,
                                terminal_reason: 'missing_tauri_runtime',
                            },
                        },
                    });
                    replaceOptimisticNode(assistantId, patchedAssistantResponse.data);
                    markNodeFailed(assistantId, runtimeUnavailableContent);
                    recordSendFlowEvent('lifecycle.failed', {
                        flowId,
                        workspaceId: selectedWorkspaceId,
                        operationKey,
                        errorType: 'MISSING_TAURI_RUNTIME',
                        message: runtimeUnavailableContent,
                    }, { source: 'ChatInput' });
                    endSendFlowFocus(flowId);
                    resetComposerTargetAfterSuccessfulSend();
                    onSendComplete?.();
                    return;
                }
                trackStreamForNode(realAssistant, {
                    authToken: token,
                    parentId: response.userMessage!.id,
                }).catch(err => {
                    console.warn('[SEND_FLOW] Streaming error:', err);
                });

                // --- 7. PARALLEL AGENT SETUP (if applicable) ---
                if (primarySelectedAgent && realAssistantId) {
                    if (shouldAutoCheckout) {
                        autoCheckoutPendingRef.current.add(realAssistantId);
                    }
                    // Run agent setup in parallel (don't block UI)
                    runAgentSetupInBackground({
                        nodeId: realAssistantId,
                        userMsg: response.userMessage!,
                        assistantMsg: realAssistant,
                        prompt: savedPrompt.trim(),
                        attachments: structuredAttachments,
                        authToken: token,
                        autoCheckout: shouldAutoCheckout,
                        contextPolicy: sendContextPolicy,
                        parentMessageId: response.userMessage!.id,
                        baseMessageId: sendParentMessageId,
                        threadId: sendThreadId,
                        contextParentMessageId: sendContextParentId,
                        contextStartMessageId: sendContextStartId,
                    }).catch(err => {
                        console.error('[SEND_FLOW] Background agent setup error:', err);
                    });
                }
            }

            resetComposerTargetAfterSuccessfulSend();
            onSendComplete?.();

        } catch (err: unknown) {
            // --- ERROR HANDLING WITH ROLLBACK ---
            const categorizedError = categorizeError(err);

            console.error('[OptimisticSend] Error:', categorizedError);
            recordSendFlowEvent(categorizedError.type === 'CANCELLED' ? 'lifecycle.cancelled' : 'lifecycle.failed', {
                flowId,
                workspaceId: selectedWorkspaceId,
                operationKey,
                errorType: categorizedError.type,
                errorMessage: categorizedError.message,
            }, { source: 'ChatInput' });
            endSendFlowFocus(flowId);
            commitFocusHandledByFlowRef.current.delete(flowId);
            latencyTraceRef.current.delete(operationKey);
            releaseSendFlowKey(operationKey);

            // Mark optimistic nodes as failed
            markNodeFailed(optimisticPair.userMessageId, formatErrorMessage(categorizedError));
            optimisticUserMessageIds
                .filter((userMessageId) => userMessageId !== optimisticPair.userMessageId)
                .forEach((userMessageId) => markNodeFailed(userMessageId, formatErrorMessage(categorizedError)));
            optimisticAssistantMessageIds.forEach((assistantMessageId) => {
                markNodeFailed(assistantMessageId, formatErrorMessage(categorizedError));
            });

            // Handle based on error type
            if (categorizedError.type === 'CANCELLED') {
                // User cancelled - remove immediately
                optimisticUserMessageIds.forEach((userMessageId) => removeOptimisticNode(userMessageId));
                optimisticAssistantMessageIds.forEach((assistantMessageId) => removeOptimisticNode(assistantMessageId));
                recordSendFlowEvent('cleanup.finished', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    nodeId: optimisticAssistantMessageIds[0] || optimisticPair.userMessageId,
                    finalStatus: 'cancelled',
                }, { source: 'ChatInput' });
                optimisticUserMessageIds.forEach((userMessageId) => releaseSendFlowKey(userMessageId));
                optimisticAssistantMessageIds.forEach((assistantMessageId) => releaseSendFlowKey(assistantMessageId));
            } else if (categorizedError.type === 'CONFLICT_ERROR') {
                // 409 - parent still running
                addToast({
                    title: 'Parent still running',
                    description: categorizedError.message,
                    variant: 'error',
                });
                // Remove optimistic nodes after showing error
                setTimeout(() => {
                    optimisticUserMessageIds.forEach((userMessageId) => removeOptimisticNode(userMessageId));
                    optimisticAssistantMessageIds.forEach((assistantMessageId) => removeOptimisticNode(assistantMessageId));
                    recordSendFlowEvent('cleanup.finished', {
                        flowId,
                        workspaceId: selectedWorkspaceId,
                        nodeId: optimisticAssistantMessageIds[0] || optimisticPair.userMessageId,
                        finalStatus: 'conflict-error',
                    }, { source: 'ChatInput' });
                    optimisticUserMessageIds.forEach((userMessageId) => releaseSendFlowKey(userMessageId));
                    optimisticAssistantMessageIds.forEach((assistantMessageId) => releaseSendFlowKey(assistantMessageId));
                }, 3000);
            } else {
                // Other errors - show toast and keep failed node visible briefly
                addToast({
                    title: 'Message Failed',
                    description: formatErrorMessage(categorizedError),
                    variant: 'error',
                });

                // Remove failed nodes after delay
                setTimeout(() => {
                    optimisticUserMessageIds.forEach((userMessageId) => removeOptimisticNode(userMessageId));
                    optimisticAssistantMessageIds.forEach((assistantMessageId) => removeOptimisticNode(assistantMessageId));
                    recordSendFlowEvent('cleanup.finished', {
                        flowId,
                        workspaceId: selectedWorkspaceId,
                        nodeId: optimisticAssistantMessageIds[0] || optimisticPair.userMessageId,
                        finalStatus: categorizedError.type,
                    }, { source: 'ChatInput' });
                    optimisticUserMessageIds.forEach((userMessageId) => releaseSendFlowKey(userMessageId));
                    optimisticAssistantMessageIds.forEach((assistantMessageId) => releaseSendFlowKey(assistantMessageId));
                }, 5000);
            }

            // Restore input on error
            setComposerPrompt(savedPrompt);
            setAttachments(savedAttachments);
            setContextIds(savedContextIds);
            setEditDraftSource(savedEditDraftSource);
        } finally {
            releaseSendAcceptance('finally');
            setCurrentAbortController(null);
            setActiveComposerSend((current) => current?.flowId === flowId ? null : current);
            agentSetupControllersRef.current.delete(operationKey);
        }
        } catch (sendError) {
            finishComposerSendStart(composerSendStartGateRef.current);
            console.error('[SEND_FLOW] Uncaught error in handleSend:', sendError);
            addToast({
                title: 'Send Error',
                description: sendError instanceof Error ? sendError.message : 'An unexpected error occurred while sending.',
                variant: 'error',
            });
        }
    }, [
        attachments,
        setComposerPrompt,
        clearComposerDraft,
        createThreadSession,
        sendMessageMutation,
        parentMessageId,
        editDraftSource,
        contextIds,
        autoCheckoutOnAgentCommit,
        selectedWorkspaceId,
        composerDraftTargetId,
        selectedWorkspace,
        effectiveContextParentId,
        effectiveContextStartId,
        contextPolicy,
        branchParentMessage,
        effectiveBaseCommitSha,
        effectiveBaseSelectedFromNodeId,
        selectedAgentId,
        selectedAgent,
        selectedAgentRunItems,
        isNewThreadTarget,
        isSteeringRunningAssistant,
        selectedNodeId,
        isParentIncomplete,
        contextMode,
        messageLookupMessages,
        messageById,
        resolvePersistedMessageId,
        dispatchFocus,
        dispatchSendFlowFocus,
        seedAgentRunProjection,
        replaceOptimisticNode,
        removeOptimisticNode,
        markNodeFailed,
        setSetupProgress,
        setNodeStatus,
        getAgentRunProjection,
        addToast,
        assignSendFlowKey,
        beginSendFlowFocus,
        advanceSendFlowFocus,
        attachLatencyTraceToNode,
        endSendFlowFocus,
        releaseSendFlowKey,
        queryClient,
        recordLatencyMark,
        onSendComplete,
        resetComposerTargetAfterSuccessfulSend,
        resolveWorkspaceWorkspace,
        trackStreamForNode,
    ]);

    useEffect(() => {
        handleSendRef.current = handleSend;
    }, [handleSend]);

    useEffect(() => {
        if (isSendAcceptanceInFlight || queuedReplayInFlightRef.current || queuedComposerSendsRef.current.length === 0) {
            return;
        }
        const queuedSend = queuedComposerSendsRef.current.shift();
        if (!queuedSend) return;
        queuedReplayInFlightRef.current = true;
        queuedReplayPendingSendRef.current = queuedSend;
        setQueuedComposerSendCount(queuedComposerSendsRef.current.length);
        setEditDraftSource(queuedSend.editDraftSource);
        setComposerPrompt(queuedSend.prompt, queuedSend.draftTargetId);
        setAttachments(queuedSend.attachments);
        setContextIds(queuedSend.contextIds);
        if (queuedSend.parentMessageId) {
            dispatchFocus({
                messageId: queuedSend.parentMessageId,
                source: 'composer',
                metadata: {
                    reason: 'queued-send-replay',
                    queuedSendId: queuedSend.id,
                    queuedAt: queuedSend.queuedAt,
                },
            });
        }
        recordSendFlowEvent('queue.dequeued', {
            workspaceId: selectedWorkspaceId,
            queuedSendId: queuedSend.id,
            queueDepth: queuedComposerSendsRef.current.length,
            parentId: queuedSend.parentMessageId,
            promptLength: queuedSend.prompt.trim().length,
        }, { source: 'ChatInput' });
        setQueuedReplayVersion((version) => version + 1);
    }, [dispatchFocus, isSendAcceptanceInFlight, queuedComposerSendCount, queuedReplayVersion, selectedWorkspaceId, setComposerPrompt]);

    useEffect(() => {
        const queuedSend = queuedReplayPendingSendRef.current;
        if (!queuedSend || isSendAcceptanceInFlight || !queuedReplayInFlightRef.current) {
            return;
        }
        const replayStateReady =
            promptRef.current === queuedSend.prompt &&
            attachments === queuedSend.attachments &&
            contextIds === queuedSend.contextIds &&
            editDraftSource === queuedSend.editDraftSource &&
            (parentMessageIdOverride !== undefined || !queuedSend.parentMessageId || focusedMessageId === queuedSend.parentMessageId);

        if (!replayStateReady) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            const pendingQueuedSend = queuedReplayPendingSendRef.current;
            recordSendFlowEvent('queue.replay-submit', {
                workspaceId: selectedWorkspaceId,
                queuedSendId: pendingQueuedSend?.id ?? null,
                parentId: pendingQueuedSend?.parentMessageId ?? null,
                promptLength: pendingQueuedSend?.prompt.trim().length ?? null,
            }, { source: 'ChatInput' });
            void handleSendRef.current?.().finally(() => {
                if (queuedReplayPendingSendRef.current?.id === pendingQueuedSend?.id) {
                    queuedReplayPendingSendRef.current = null;
                }
                queuedReplayInFlightRef.current = false;
                if (!sendAcceptanceInFlightRef.current && queuedComposerSendsRef.current.length > 0) {
                    setQueuedComposerSendCount(queuedComposerSendsRef.current.length);
                    setQueuedReplayVersion((version) => version + 1);
                }
            });
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [
        attachments,
        contextIds,
        editDraftSource,
        focusedMessageId,
        isSendAcceptanceInFlight,
        parentMessageIdOverride,
        queuedReplayVersion,
        selectedWorkspaceId,
    ]);

    /**
     * Run agent setup in background without blocking UI
     */
    interface AgentSetupParams {
        nodeId: string;
        userMsg: Message;
        assistantMsg: Message;
        prompt: string;
        attachments?: AttachmentMetadata[];
        authToken: string;
        autoCheckout: boolean;
        contextPolicy: ContextPolicy;
        parentMessageId: string;
        baseMessageId: string | null;
        threadId: string | null;
        contextParentMessageId: string | null;
        contextStartMessageId: string | null;
    }

    const runAgentSetupInBackground = async (params: AgentSetupParams): Promise<void> => {
        const { nodeId, userMsg, assistantMsg, prompt, attachments: inputAttachments, authToken, autoCheckout, contextPolicy, baseMessageId, threadId, contextParentMessageId, contextStartMessageId } = params;
        const agentPrompt = appendInputArtifactsToPrompt(prompt, inputAttachments);
        const isCodexAgent = selectedAgent?.type === 'codex';
        const runId = crypto.randomUUID();

        const setupController = new AbortController();
        agentSetupControllersRef.current.set(`setup-${nodeId}`, setupController);

        try {
            setNodeStatus(nodeId, 'initializing');
            setSetupProgress(nodeId, 'Initializing agent...');
            recordLatencyMark(nodeId, 'agent_setup_started', { authToken, nodeId });

            // Set MCP tokens
            setSetupProgress(nodeId, 'Setting up MCP...');
            recordLatencyMark(nodeId, 'mcp_setup_started', { authToken, nodeId });
            const mcpSetupFlowId = getSendFlowIdForKey(nodeId);
            const { promise: rawMcpSetupPromise, reused: mcpSetupReused } = ensureMcpSetup(authToken, assistantMsg.workspaceId);
            const mcpSetupPromise = withRuntimeActivity({
                category: 'host',
                name: 'agent-setup.mcp-setup',
                details: {
                    flowId: mcpSetupFlowId,
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    reused: mcpSetupReused,
                },
            }, () => rawMcpSetupPromise);
            if (mcpSetupReused) {
                recordSendFlowEvent('agent-setup.mcp-setup.reused', {
                    flowId: mcpSetupFlowId,
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    state: mcpSetupReused,
                }, { source: 'ChatInput' });
            }
            void mcpSetupPromise.then((finished) => {
                if (finished) {
                    recordLatencyMark(nodeId, 'mcp_setup_finished', { authToken, nodeId });
                }
            });

            setSetupProgress(nodeId, 'Preparing worktree...');
            recordLatencyMark(nodeId, 'worktree_create_started', { authToken, nodeId });
            recordSendFlowEvent('agent-setup.worktree-create.requested', {
                flowId: getSendFlowIdForKey(nodeId),
                workspaceId: assistantMsg.workspaceId,
                nodeId,
            }, { source: 'ChatInput' });

            const { repoPath } = await withRuntimeActivity({
                category: 'host',
                name: 'agent-setup.workspace-resolve',
                details: {
                    flowId: getSendFlowIdForKey(nodeId),
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                },
            }, () => resolveWorkspaceWorkspace());
            const baseMessage = getMessageById(messageLookupMessages, baseMessageId);
            const contextParentMessage = getMessageById(messageLookupMessages, contextParentMessageId) || baseMessage;
            const parentCommit = effectiveBaseCommitSha || resolveNodeCommit(baseMessage, messageLookupMessages, null);
            if (!parentCommit) {
                throw new Error('Could not resolve a git base commit from the focused node. Focus a commit or a node with commit ancestry and try again.');
            }

            const mcpSetupReady = await Promise.race([
                mcpSetupPromise,
                new Promise<'timeout'>((resolve) => window.setTimeout(() => resolve('timeout'), 750)),
            ]);
            if (mcpSetupReady === 'timeout') {
                recordSendFlowEvent('agent-setup.mcp-setup.deferred', {
                    flowId: getSendFlowIdForKey(nodeId),
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    timeoutMs: 750,
                }, { source: 'ChatInput' });
                void mcpSetupPromise.then((finished) => {
                    recordSendFlowEvent('agent-setup.mcp-setup.deferred-finished', {
                        flowId: getSendFlowIdForKey(nodeId),
                        workspaceId: assistantMsg.workspaceId,
                        nodeId,
                        success: finished,
                    }, { source: 'ChatInput' });
                });
            }
            const plannedBranchName = `agentree/${nodeId}`;

            setSetupProgress(nodeId, isCodexAgent ? 'Starting Codex...' : 'Starting agent...');

            const cliArgsStr = selectedAgent?.cliArgs || '--permission-mode plan';
            const parsedCliArgs = parseRuntimeCliArgs(cliArgsStr);
            const resolvedRunMode = permissionMode;
            const resolvedModel = selectedAgent?.model_config?.model || parsedCliArgs.model || null;
            const resolvedReasoningEffort = selectedAgent?.model_config?.reasoningEffort || parsedCliArgs.reasoningEffort || null;
            const selectedProvider = selectedAgent?.type === 'claude' || selectedAgent?.type === 'codex'
                ? selectedAgent.type
                : null;
            const loginProfileSelection = resolveLoginProfileSelection({
                profiles: useLoginProfilesStore.getState().profiles,
                provider: selectedProvider,
                agentName: selectedAgent?.name ?? selectedProvider,
            });
            const selectedLoginProfile = loginProfileSelection.selectedProfile;
            if (!loginProfileSelection.isReady) {
                addToast({
                    title: 'Login profile inactive',
                    description: loginProfileSelection.failureMessage ?? `${selectedAgent?.name ?? selectedProvider} needs a ready login profile before it can run.`,
                    variant: 'error',
                });
                return;
            }
            const contextManifest = buildAgentRunContextManifest({
                messages: messageLookupMessages,
                contextParentMessageId: contextParentMessage?.id ?? null,
                contextPolicy,
                contextStartMessageId,
            });

            const traceId = attachLatencyTraceToNode(nodeId, nodeId, authToken);
            const startExecutionData = {
                ...((getAgentRunProjection(nodeId)?.execution_data || {}) as Record<string, any>),
                current_run_id: runId,
                workspace_id: assistantMsg.workspaceId,
                parentId: assistantMsg.parentId ?? null,
                started_at: new Date().toISOString(),
                meta: {
                    ...(((getAgentRunProjection(nodeId)?.execution_data || {}) as any)?.meta || {}),
                },
            };
            startExecutionData.meta = {
                ...(startExecutionData.meta || {}),
                git_worktree_path: null,
                git_branch_name: plannedBranchName,
                base_commit_sha: parentCommit,
                auto_checkout_requested: autoCheckout,
                composer_permission_mode: permissionMode,
                ...(selectedProvider
                    ? {
                        provider: selectedProvider,
                        llmModel: resolvedModel,
                        provider_run_mode: resolvedRunMode,
                        provider_model: resolvedModel,
                        provider_reasoning_effort: resolvedReasoningEffort,
                        login_profile_id: selectedLoginProfile?.id ?? null,
                        login_profile_name: selectedLoginProfile?.displayName ?? null,
                        login_profile_provider: selectedLoginProfile?.provider ?? null,
                        login_profile_auth_type: selectedLoginProfile?.authType ?? null,
                        login_profile_redacted_hint: selectedLoginProfile?.redactedHint ?? null,
                    }
                    : {}),
            };

            mergeAgentRunExecutionData(nodeId, startExecutionData);
            recordSendFlowEvent('agent-setup.spawn.requested', {
                flowId: getSendFlowIdForKey(nodeId),
                workspaceId: assistantMsg.workspaceId,
                nodeId,
                repoPath,
                worktreePath: null,
                runId,
            }, { source: 'ChatInput' });
            const launchAgentRequest = {
                requestId: `composer:${nodeId}`,
                runId,
                userNodeId: userMsg.id,
                assistantNodeId: nodeId,
                workspaceId: assistantMsg.workspaceId,
                threadId,
                parentNodeId: userMsg.parentId ?? null,
                contextParentNodeId: contextParentMessage?.id ?? null,
                baseNodeId: baseMessageId,
                baseCommit: parentCommit,
                userPrompt: agentPrompt,
                agentType: selectedAgent!.type,
                model: resolvedModel,
                reasoningEffort: resolvedReasoningEffort,
                permissionMode,
                loginProfileId: selectedLoginProfile?.id ?? null,
                agentId: selectedAgentId,
                agentName: selectedAgent?.name ?? null,
                agentCliArgs: cliArgsStr,
                agentPromptFlag: selectedAgent?.promptFlag ?? null,
                authToken,
                traceId,
                contextPolicy,
                contextMode: contextPolicy === 'fresh' ? 'none' as const : contextMode,
                contextManifest: contextManifest as unknown as Record<string, unknown>,
                modelCapabilities: (selectedAgent?.model_config?.capabilities ?? {}) as unknown as Record<string, unknown>,
                threadTitleMode: !baseMessageId && threadId ? 'first_thread_message' as const : 'none' as const,
                userNode: userMsg as unknown as Record<string, unknown>,
                assistantNode: {
                    ...assistantMsg,
                    execution_data: startExecutionData,
                } as unknown as Record<string, unknown>,
            };
            const spawnFlowId = getSendFlowIdForKey(nodeId);
            void withRuntimeActivity({
                category: 'host',
                name: 'agent-setup.worktree-spawn',
                details: {
                    flowId: spawnFlowId,
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    runId,
                    agentType: selectedAgent!.type,
                    provider: selectedProvider,
                },
            }, () => agentClient.launchAgentMessage(launchAgentRequest)).then((startRunResponse) => {
                const nativeContext = startRunResponse.launchContext;
                trackAgentRunStarted({
                    ...(selectedAgent?.type ? { agent_provider: selectedAgent.type } : {}),
                    provider_thread_strategy: nativeContext.providerThreadStrategyRequested,
                    branch_from_interior: nativeContext.isBranchFromInterior,
                    auto_checkout_requested: autoCheckout,
                    explicit_context_chars_bucket: bucketCharacterCount(nativeContext.agentreeContextAvailableChars),
                    injected_context_chars_bucket: bucketCharacterCount(nativeContext.agentreeContextInjectedChars),
                    provider_context_routing_mode: nativeContext.providerContextRoutingMode,
                });
                mergeAgentRunExecutionData(nodeId, {
                    meta: {
                        provider_thread_strategy: nativeContext.providerThreadStrategy,
                        provider_thread_strategy_requested: nativeContext.providerThreadStrategyRequested,
                        provider_context_routing_mode: nativeContext.providerContextRoutingMode,
                        provider_context_routing_reason: nativeContext.providerContextRoutingReason,
                        provider_parent_provider: nativeContext.parentProvider ?? null,
                        provider_parent_thread_id_available: nativeContext.parentProviderThreadId ?? null,
                        provider_parent_turn_id_available: nativeContext.parentProviderTurnId ?? null,
                        provider_parent_lineage_id_available: nativeContext.parentProviderLineageId ?? null,
                        agentree_context_available_chars: nativeContext.agentreeContextAvailableChars,
                        agentree_context_injected_chars: nativeContext.agentreeContextInjectedChars,
                    },
                });
                recordLatencyMark(nodeId, 'worktree_create_finished', {
                    authToken,
                    nodeId,
                    detail: {
                        worktree_path: startRunResponse.worktreePath,
                        branch_name: startRunResponse.branchName,
                    },
                });
                if (startRunResponse.worktreePath && startRunResponse.branchName) {
                    worktreeInfoRef.current.set(nodeId, {
                        worktreePath: startRunResponse.worktreePath,
                        branchName: startRunResponse.branchName,
                        parentCommit,
                        repoPath,
                    });
                }
                recordSendFlowEvent('agent-setup.worktree-runtime-info-set', {
                    flowId: spawnFlowId,
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    repoPath,
                    worktreePath: startRunResponse.worktreePath,
                    branchName: startRunResponse.branchName,
                }, { source: 'ChatInput' });
                mergeAgentRunExecutionData(nodeId, {
                    meta: {
                        git_worktree_path: startRunResponse.worktreePath,
                        git_branch_name: startRunResponse.branchName,
                        base_commit_sha: parentCommit,
                    },
                });
                recordSendFlowEvent('agent-setup.spawn.returned', {
                    flowId: spawnFlowId,
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    repoPath,
                    worktreePath: startRunResponse.worktreePath,
                    branchName: startRunResponse.branchName,
                    pid: startRunResponse.pid,
                    runId,
                }, { source: 'ChatInput' });
                recordLatencyMark(nodeId, 'spawn_returned', { authToken, nodeId });
                track('Agent Spawn Succeeded', {
                    ...(selectedAgent?.type ? { agent_provider: selectedAgent.type } : {}),
                });
                sendFlowDebug('Agent spawned successfully', { nodeId });
            }).catch((error) => {
                const errorMessage = error instanceof Error ? error.message : String(error || 'Agent setup failed');
                recordSendFlowEvent('agent-setup.spawn.failed', {
                    flowId: spawnFlowId,
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    runId,
                    errorMessage,
                }, { source: 'ChatInput' });
                trackAgentRunFailed({
                    ...(selectedAgent?.type ? { agent_provider: selectedAgent.type } : {}),
                    error_phase: 'spawn',
                    failure_category: analyticsFailureCategory(error),
                });
                markNodeFailed(nodeId, errorMessage);
            });
            if (isCodexAgent) {
                setSetupProgress(nodeId, 'Waiting for first response...');
            }

            setNodeStatus(nodeId, 'running');
            if (!isCodexAgent) {
                setSetupProgress(nodeId, 'Running...');
            }
            track('Agent Spawn Dispatched', {
                ...(selectedAgent?.type ? { agent_provider: selectedAgent.type } : {}),
            });
            sendFlowDebug('Agent spawn dispatched', { nodeId });

        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response?.data?.error || error.message || 'Agent setup failed')
                : error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : 'Agent setup failed';
            const axiosStatus = axios.isAxiosError(error) ? error.response?.status ?? null : null;
            const axiosResponse = axios.isAxiosError(error) ? error.response?.data ?? null : null;
            const setupFlowId = getSendFlowIdForKey(nodeId);
            console.error('[AgentSetup] Failed:', {
                nodeId,
                runId,
                errorMessage,
                errorName: error instanceof Error ? error.name : null,
                axiosStatus,
                axiosResponse,
            }, error);
            if (setupFlowId) {
                recordSendFlowEvent('agent-setup.failed', {
                    flowId: setupFlowId,
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    runId,
                    errorMessage,
                    errorName: error instanceof Error ? error.name : null,
                    axiosStatus,
                    axiosResponse,
                }, { source: 'ChatInput' });
                recordSendFlowEvent('lifecycle.failed', {
                    flowId: setupFlowId,
                    workspaceId: assistantMsg.workspaceId,
                    nodeId,
                    runId,
                    errorType: 'AGENT_SETUP_FAILED',
                    errorMessage,
                }, { source: 'ChatInput' });
                endSendFlowFocus(setupFlowId);
            }
            trackAgentRunFailed({
                ...(selectedAgent?.type ? { agent_provider: selectedAgent.type } : {}),
                error_phase: 'setup',
                failure_category: analyticsFailureCategory(error),
            });
            markNodeFailed(nodeId, errorMessage);

            recordSendFlowEvent('agent-setup.native-owned-failure', {
                flowId: setupFlowId,
                workspaceId: assistantMsg.workspaceId,
                nodeId,
                runId,
                errorMessage,
            }, { source: 'ChatInput' });

            throw error;
        } finally {
            agentSetupControllersRef.current.delete(`setup-${nodeId}`);
        }
    };

    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (activeFileMention) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (activeMentionFiles.length > 0) {
                    setActiveFileMentionIndex((prev) => (prev + 1) % activeMentionFiles.length);
                }
                return;
            }

            if (event.key === 'ArrowUp') {
                event.preventDefault();
                if (activeMentionFiles.length > 0) {
                    setActiveFileMentionIndex((prev) => (prev - 1 + activeMentionFiles.length) % activeMentionFiles.length);
                }
                return;
            }

            if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                event.preventDefault();
                const selectedFile = activeMentionFiles[activeFileMentionIndex] ?? null;
                if (selectedFile) {
                    handleFileMentionSelect(selectedFile);
                }
                return;
            }

            if (event.key === 'Escape') {
                setActiveFileMention(null);
                event.preventDefault();
                event.stopPropagation();
                return;
            }
        }

        if (event.key === 'Escape' && isCommandPopoverOpen) {
            setIsCommandPopoverOpen(false);
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (event.key === 'Escape' && !isCommandPopoverOpen && !promptRef.current.trim() && attachments.length === 0 && contextIds.length === 0) {
            onRequestClose?.();
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (event.key === 'Enter' && !event.shiftKey && !isCommandPopoverOpen) {
            event.preventDefault();
            handleSend();
        }
    }, [activeFileMention, activeFileMentionIndex, activeMentionFiles, attachments.length, contextIds.length, handleFileMentionSelect, handleSend, isCommandPopoverOpen, onRequestClose]);


    const handleCancel = useCallback(async () => {
        // Cancel main send operation
        if (currentAbortController) {
            sendFlowDebug('Cancelling send request');
            currentAbortController.abort();
            setCurrentAbortController(null);
            setActiveComposerSend(null);
        }

        // Cancel any pending agent setup operations
        for (const [key, controller] of agentSetupControllersRef.current) {
            sendFlowDebug('Cancelling agent setup', { key });
            controller.abort();
        }
        agentSetupControllersRef.current.clear();

        const targetNodeId = selectedProjection?.id || selectedNodeMessage?.id || null;
        const targetWorkspaceId = selectedProjection?.workspaceId || selectedNodeMessage?.workspaceId || selectedWorkspaceId;

        if (targetNodeId) {
            const projectionsById = useAgentRunProjectionStore.getState().projectionsById;
            const optimisticNodeIdsToRemove = new Set<string>();
            const targetProjection = projectionsById[targetNodeId] || null;
            const selectedParentId = targetProjection?.parentId || selectedNodeMessage?.parentId || null;

            if (targetProjection?._optimistic) {
                optimisticNodeIdsToRemove.add(targetNodeId);
            }
            if (selectedParentId && projectionsById[selectedParentId]?._optimistic) {
                optimisticNodeIdsToRemove.add(selectedParentId);
            }

            for (const msg of Object.values(projectionsById)) {
                if (!msg._optimistic) continue;
                if (msg.parentId === targetNodeId) {
                    optimisticNodeIdsToRemove.add(msg.id);
                }
            }

            for (const optimisticNodeId of optimisticNodeIdsToRemove) {
                sendFlowDebug('Removing optimistic node', { nodeId: optimisticNodeId });
                removeOptimisticNode(optimisticNodeId);
            }
        }

        if (targetNodeId && targetWorkspaceId) {
            const projectionsById = useAgentRunProjectionStore.getState().projectionsById;
            const targetProjection = projectionsById[targetNodeId] || null;
            const targetMessage = messages.find((msg: Message) => msg.id === targetNodeId) || null;
            const targetStatus = resolveNodeState(targetMessage, targetProjection).status;
            const isRunning = isInProgressStatus(targetStatus);
                if (isRunning) {
                    sendFlowDebug('Cancelling agent execution', { nodeId: targetNodeId });
                    unregisterStreamHandler(targetNodeId);
                    agentRunManager.dispatch(targetNodeId, {
                        type: 'cancel',
                        reason: 'cancelled',
                    }, {
                        workspaceId: targetWorkspaceId,
                        parentId: targetProjection?.parentId ?? targetMessage?.parentId ?? null,
                        role: 'assistant',
                        agentId: targetProjection?.agent_id ?? targetMessage?.agent_id ?? null,
                        content: targetProjection?.content ?? targetMessage?.content ?? '',
                        executionData: (targetProjection?.execution_data || targetMessage?.execution_data || {}) as Record<string, any>,
                    });
                    const runtimeState = await agentClient.getAgentRunState(targetNodeId).catch(() => null);
                    const runtimeRunning = runtimeState?.running ?? false;
                if (!runtimeRunning) {
                    recordSendFlowEvent('cancel.native-owned-not-running', {
                        workspaceId: targetWorkspaceId,
                        nodeId: targetNodeId,
                        nativeStatus: typeof runtimeState?.ledger?.status === 'string' ? runtimeState.ledger.status : null,
                        nativePhase: typeof runtimeState?.ledger?.phase === 'string' ? runtimeState.ledger.phase : null,
                    }, { source: 'ChatInput' });
                    const nativeStatus = typeof runtimeState?.ledger?.status === 'string' ? runtimeState.ledger.status : null;
                    if (!nativeStatus || !isTerminalAgentStatus(nativeStatus)) {
                        const marked = await markStaleLocalAgentNodeCancelled({
                            queryClient,
                            workspaceId: targetWorkspaceId,
                            nodeId: targetNodeId,
                            node: targetMessage ?? targetProjection ?? null,
                            reason: 'Run cancelled after the app restarted before the native agent session was created.',
                        });
                        if (marked) {
                            void scheduleMessagesRefreshWhenGraphIdle(queryClient, targetWorkspaceId, { reason: 'cancel-stale-local-node' });
                        }
                    }
                    return;
                }
                let stopFailed = false;
                try {
                    await agentClient.stopAgent(targetNodeId);
                } catch (err) {
                    if (isNoAgentSessionFoundError(err)) {
                        const marked = await markStaleLocalAgentNodeCancelled({
                            queryClient,
                            workspaceId: targetWorkspaceId,
                            nodeId: targetNodeId,
                            node: targetMessage ?? targetProjection ?? null,
                            reason: 'Run cancelled after the app restarted before the native agent session was created.',
                        });
                        if (marked) {
                            void scheduleMessagesRefreshWhenGraphIdle(queryClient, targetWorkspaceId, { reason: 'cancel-stale-local-node' });
                            return;
                        }
                    }
                    stopFailed = true;
                    console.warn('[ChatInput] Failed to stop agent process:', err);
                }
                if (stopFailed) {
                    recordSendFlowEvent('cancel.native-stop-failed', {
                        workspaceId: targetWorkspaceId,
                        nodeId: targetNodeId,
                    }, { source: 'ChatInput' });
                    return;
                }
                worktreeInfoRef.current.delete(targetNodeId);
                latencyTraceRef.current.delete(targetNodeId);
                void scheduleMessagesRefreshWhenGraphIdle(queryClient, targetWorkspaceId, { reason: 'cancel-agent' });
            }
        }
    }, [cleanupAgentRunProjection, currentAbortController, isInProgressStatus, messages, queryClient, removeOptimisticNode, selectedWorkspaceId, selectedNodeMessage, selectedProjection, seedAgentRunProjection, unregisterStreamHandler]);




    // --- NEW: Slash Command Logic ---
    // (Merged into handlePromptChange above)

    const handleCommandSelect = (commandType: 'message' | 'branch') => {
        setComposerPrompt(promptRef.current.slice(0, -1) + `/insert ${commandType}:`); // Replace "/" with command stub
        setIsCommandPopoverOpen(false);
        // Focus textarea and place cursor at the end
        setTimeout(() => {
            textareaRef.current?.focus();
            if (textareaRef.current) {
                textareaRef.current.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
            }
        }, 0);
    };

    const handleCancelEditDraft = useCallback(() => {
        setEditDraftSource(null);
        setComposerPrompt('');
        setAttachments([]);
        setContextIds([]);
        setTimeout(() => textareaRef.current?.focus(), 0);
    }, [setComposerPrompt]);


    // --- Existing Render Logic ---
    const totalAttachments = attachments.length;
    const triggerSendPressFeedback = () => {
        setSendPressFeedback(true);
        if (sendPressFeedbackTimerRef.current !== null) {
            window.clearTimeout(sendPressFeedbackTimerRef.current);
        }
        sendPressFeedbackTimerRef.current = window.setTimeout(() => {
            sendPressFeedbackTimerRef.current = null;
            setSendPressFeedback(false);
        }, 260);
    };
    const composerControlClass = "flex min-h-8 min-w-[154px] max-w-full items-center gap-1.5 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong))] px-2 py-0.5 text-left shadow-[0_1px_2px_rgba(22,26,32,0.05),0_10px_24px_-21px_rgba(22,26,32,0.5)] transition-[background-color,border-color,box-shadow,transform] duration-150 hover:border-[hsl(var(--app-border-strong))] hover:bg-background hover:shadow-[0_2px_5px_rgba(22,26,32,0.07),0_16px_30px_-25px_rgba(22,26,32,0.58)] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50";
    const composerControlIconClass = "flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[hsl(var(--app-bg-muted))] text-[hsl(var(--app-text-soft))] shadow-[inset_0_0_0_1px_rgba(24,28,36,0.04)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]";
    const composerEyebrowClass = "text-[8px] font-semibold uppercase leading-none tracking-[0.11em] text-muted-foreground/72";
    const composerValueClass = "truncate text-[11px] font-semibold leading-tight text-foreground";
    const composerPopupLayerClass = "z-[90]";
    const selectedPermissionOption = getComposerPermissionOption(permissionMode);
    const replyParentDisplayLabel = replyParentLabel || selectedNodeMessage?.content || replyParentMessageId || 'Selected node';
    const replyTargetControlLabel = isNewThreadTarget ? 'New thread' : replyParentDisplayLabel;
    const replyTargetEyebrow = isNewThreadTarget ? 'Target' : 'Reply to';
    const canReplyToSelectedNode = Boolean(replyCandidateMessageId || selectedNodeMessage?.id);
    const trimmedPrompt = prompt.trim();
    const showPrimaryCancel = showCancel && !isSteeringRunningAssistant;
    const cancelActionLabel = 'Cancel';
    const cancelActionAriaLabel = 'Cancel running agent';
    const isPrimaryActionDisabled = isSteeringRunningAssistant
        ? !trimmedPrompt || !selectedWorkspaceId
        : isParentIncomplete || (!promptHasContent && totalAttachments === 0 && contextIds.length === 0) || !selectedWorkspaceId;
    const sendButtonLabel = isSteeringRunningAssistant ? 'Steer' : editDraftSource ? 'Edit and run' : 'Send';
    const primaryActionLabel = isSteeringRunningAssistant
        ? sendButtonLabel
        : (isSendAcceptanceInFlight ? (queuedComposerSendCount > 0 ? `Queue ${queuedComposerSendCount + 1}` : 'Queue') : sendButtonLabel);
    const handlePrimaryAction = showPrimaryCancel
        ? handleCancel
        : handleSend;

    // --- Render ---
    return (
        <div
            className={cn('flex flex-col gap-1.5', surfaceClasses.root)}
            data-chat-input-surface={surface}
            aria-label={surfaceLabel}
        >
            {contextFetchError && (
                <Alert variant="destructive">
                    <AlertDescription>{contextFetchError}</AlertDescription>
                </Alert>
            )}
            {editDraftSource && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 shadow-sm dark:border-amber-800 dark:bg-amber-900/25 dark:text-amber-200">
                    <div className="flex min-w-0 items-center gap-2">
                        <Pencil className="h-3.5 w-3.5 shrink-0" />
                        <span className="shrink-0 font-semibold">Editing</span>
                        <span className="truncate text-amber-800/80 dark:text-amber-200/75">
                            {truncateText(editDraftSource.content, 80)}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={handleCancelEditDraft}
                        className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors hover:bg-amber-100 dark:hover:bg-amber-800/40"
                    >
                        <X className="h-3 w-3" />
                        Cancel edit
                    </button>
                </div>
            )}
            <div className={cn(
                "relative flex w-full flex-col border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel)/0.95)] shadow-[0_18px_48px_-36px_rgba(24,28,36,0.62),0_1px_0_rgba(255,255,255,0.72)_inset] backdrop-blur-xl transition-all duration-200 dark:shadow-[0_18px_48px_-34px_rgba(0,0,0,0.82),0_1px_0_rgba(255,255,255,0.05)_inset]",
                "focus-within:border-[hsl(var(--app-border-strong))] focus-within:bg-[hsl(var(--app-panel-strong))] focus-within:shadow-[0_22px_58px_-34px_rgba(24,28,36,0.72),0_0_0_3px_rgba(85,112,175,0.09),0_1px_0_rgba(255,255,255,0.78)_inset] dark:focus-within:shadow-[0_22px_58px_-34px_rgba(0,0,0,0.86),0_0_0_3px_rgba(126,160,230,0.11),0_1px_0_rgba(255,255,255,0.06)_inset]",
                surfaceClasses.shell,
                activeFileMention ? "overflow-visible" : "overflow-hidden"
            )}>
                {/* Run context summary */}
                <div className={cn("border-b border-[hsl(var(--app-border)/0.70)] bg-[hsl(var(--app-bg-elevated)/0.74)] px-2.5 py-1.5", (!branchParentMessage && !selectedWorkspaceId) && "hidden")}>
                    <div className="custom-scrollbar flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    className={cn(
                                        composerControlClass,
                                        "flex-[1_1_180px]",
                                        isNewThreadTarget && "border-[hsl(var(--app-accent)/0.45)]"
                                    )}
                                    aria-label="Select reply target"
                                >
                                    <div className={composerControlIconClass}>
                                        {isNewThreadTarget ? <Plus className="h-3 w-3" /> : <Reply className="h-3 w-3" />}
                                    </div>
                                    <div className="min-w-0">
                                        <div className={composerEyebrowClass}>{replyTargetEyebrow}</div>
                                        <div className={composerValueClass}>
                                            {truncateText(replyTargetControlLabel, 64)}
                                        </div>
                                    </div>
                                    <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-foreground/70" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="start"
                                side="top"
                                sideOffset={6}
                                collisionPadding={12}
                                className={cn(composerPopupLayerClass, "w-[min(18rem,calc(100vw-1.5rem))] rounded-lg border border-border/70 bg-popover/95 p-1 shadow-[0_16px_42px_-20px_rgba(15,23,42,0.50),0_6px_18px_-14px_rgba(15,23,42,0.38)] backdrop-blur-xl")}
                            >
                                <DropdownMenuLabel className="px-1.5 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Reply target</DropdownMenuLabel>
                                <DropdownMenuItem
                                    disabled={!canReplyToSelectedNode}
                                    onClick={() => {
                                        setComposerTargetMode('reply');
                                        setContextPolicy('continue');
                                    }}
                                    className="min-h-10 gap-2 rounded-md"
                                >
                                    <Reply className="h-3.5 w-3.5" />
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium">Reply to selected node</div>
                                        <div className="truncate text-[11px] text-muted-foreground">
                                            {canReplyToSelectedNode ? truncateText(replyParentDisplayLabel, 56) : 'Select a message node first'}
                                        </div>
                                    </div>
                                    {!isNewThreadTarget && <Check className="ml-auto h-3.5 w-3.5" />}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            type="button"
                                            className={cn(composerControlClass, "flex-[0_1_174px]")}
                                            aria-label="Select code base commit"
                                            disabled={!defaultBaseCommitSha}
                                        >
                                            <div className={composerControlIconClass}>
                                                <GitBranchIcon className="h-3 w-3" />
                                            </div>
                                            <div className="min-w-0">
                                                <div className={composerEyebrowClass}>Code base</div>
                                                <div className={cn(
                                                    "truncate text-[11px] font-semibold leading-tight text-foreground",
                                                    !codeParentUsesBranchName && "font-mono"
                                                )}>
                                                    {codeParentDisplayLabel}
                                                </div>
                                            </div>
                                            <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-foreground/70" />
                                        </button>
                                    </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" align="start" className={cn(composerPopupLayerClass, "max-w-72")}>
                                    <div>Run starts from {codeParentTooltipNoun} {codeParentTooltipLabel}{codeParentTooltipSuffix}.</div>
                                    <div className="mt-1 text-muted-foreground">Changing the base can make the graph harder to follow.</div>
                                </TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent
                                align="start"
                                side="top"
                                sideOffset={6}
                                collisionPadding={12}
                                className={cn(composerPopupLayerClass, "w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-0 shadow-[0_18px_48px_-24px_rgba(15,23,42,0.55),0_8px_20px_-16px_rgba(15,23,42,0.40)] backdrop-blur-xl dark:shadow-[0_18px_48px_-24px_rgba(0,0,0,0.82),0_8px_20px_-16px_rgba(0,0,0,0.66)]")}
                            >
                                <div className="border-b border-border/60 p-2.5">
                                    <DropdownMenuLabel className="px-0 pb-2 pt-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Run from code base</DropdownMenuLabel>
                                    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                                        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                        <input
                                            value={baseCommitSearch}
                                            onChange={(event) => setBaseCommitSearch(event.target.value)}
                                            onKeyDown={(event) => event.stopPropagation()}
                                            placeholder="Search branches, commits, SHA"
                                            className="h-6 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
                                        />
                                        {isBaseCommitChoicesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
                                    </div>
                                    {baseCommitChipItems.length > 0 ? (
                                        <div className="mt-2 flex max-h-14 flex-wrap gap-1.5 overflow-hidden">
                                            {baseCommitChipItems.map((chip) => (
                                                <button
                                                    key={`chip-${chip.key}`}
                                                    type="button"
                                                    onClick={() => handleBaseCommitSelect(chip.item)}
                                                    className={cn(
                                                        "max-w-[10rem] truncate rounded-full border px-2 py-1 text-[10px] font-medium transition-colors active:scale-[0.98]",
                                                        chip.item.selected
                                                            ? "border-[hsl(var(--app-accent)/0.42)] bg-[hsl(var(--app-accent)/0.10)] text-foreground"
                                                            : "border-border/70 bg-background/60 text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                                                    )}
                                                    title={`${chip.label} ${chip.item.sha}`.trim()}
                                                >
                                                    {chip.label}
                                                </button>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="max-h-[min(19rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto p-1.5">
                                    {baseCommitPickerItems.length > 0 ? (
                                        baseCommitPickerItems.map((item) => (
                                            <DropdownMenuItem
                                                key={item.sha}
                                                onClick={() => handleBaseCommitSelect(item)}
                                                className="min-h-11 gap-2 rounded-lg px-2 py-1.5"
                                                title={`${item.sha} ${item.subject}`.trim()}
                                            >
                                                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground">
                                                    {item.selected ? <Check className="h-3.5 w-3.5 text-foreground" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex min-w-0 items-center gap-1.5">
                                                        <span className="truncate text-[12px] font-semibold leading-tight text-foreground">{item.primaryLabel}</span>
                                                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                                                            {formatCommitRelationLabel(item.relation, item.isDefault)}
                                                        </span>
                                                    </div>
                                                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                                                        <span className="truncate text-[10px] leading-tight text-muted-foreground">{item.secondaryLabel}</span>
                                                        <span className="shrink-0 font-mono text-[10px] leading-tight text-muted-foreground/80">{shortCommitSha(item.sha)}</span>
                                                    </div>
                                                </div>
                                            </DropdownMenuItem>
                                        ))
                                    ) : (
                                        <DropdownMenuItem disabled className="min-h-10 rounded-lg px-2 py-1.5 text-xs text-muted-foreground">
                                            {isBaseCommitChoicesLoading ? 'Loading code bases...' : 'No matching code base'}
                                        </DropdownMenuItem>
                                    )}
                                </div>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            type="button"
                                            className={cn(
                                                composerControlClass,
                                                "flex-[1_1_204px]",
                                                contextPolicy === 'fresh' && "border-[hsl(var(--app-accent)/0.45)]"
                                            )}
                                            aria-label="Select context"
                                        >
                                            <div className={composerControlIconClass}>
                                                {contextPolicy === 'fresh' ? <RotateCcw className="h-3 w-3" /> : <GitBranchIcon className="h-3 w-3" />}
                                            </div>
                                            <div className="min-w-0">
                                                <div className={composerEyebrowClass}>AI context</div>
                                                <div className={composerValueClass}>
                                                    {contextControlLabel}
                                                </div>
                                            </div>
                                            <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-foreground/70" />
                                        </button>
                                    </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" align="start" className={cn(composerPopupLayerClass, "max-w-72")}>
                                    {contextPolicy === 'fresh'
                                        ? 'Start without inherited conversation context.'
                                        : `Context starts at ${contextStartLabel} and ends at ${contextParentLabel}.`}
                                </TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent
                                align="end"
                                sideOffset={8}
                                className={cn(composerPopupLayerClass, "max-h-[calc(100vh-8rem)] w-80 overflow-y-auto rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_18px_48px_-18px_rgba(15,23,42,0.45),0_8px_20px_-12px_rgba(15,23,42,0.35)] backdrop-blur-xl dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.75),0_8px_20px_-12px_rgba(0,0,0,0.6)]")}
                            >
                                <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">End context</DropdownMenuLabel>
                                {mergeContextOptions.length > 0 ? (
                                    mergeContextOptions.map((option) => {
                                        const selected = contextPolicy === 'continue' && option.id === selectedMergeContextParentId;
                                        return (
                                            <DropdownMenuItem
                                                key={option.id}
                                                disabled={isNewThreadTarget}
                                                onClick={() => {
                                                    setContextPolicy('continue');
                                                    setSelectedMergeContextParentId(option.id);
                                                }}
                                                className="min-h-11 gap-2 rounded-lg"
                                                title={option.label}
                                            >
                                                <GitBranchIcon className="h-3.5 w-3.5" />
                                                <div className="min-w-0">
                                                    <div className="truncate text-sm font-medium">{truncateText(option.label, 52)}</div>
                                                    <div className="truncate text-[11px] text-muted-foreground">{option.role}</div>
                                                </div>
                                                {selected && <Check className="ml-auto h-3.5 w-3.5" />}
                                            </DropdownMenuItem>
                                        );
                                    })
                                ) : (
                                    <DropdownMenuItem
                                        disabled={isNewThreadTarget}
                                        onClick={() => setContextPolicy('continue')}
                                        className="min-h-11 gap-2 rounded-lg"
                                        title={getMessagePreviewText(effectiveContextParentMessage) || 'Use inferred conversation context'}
                                    >
                                        <GitBranchIcon className="h-3.5 w-3.5" />
                                        <div className="min-w-0">
                                            <div className="truncate text-sm font-medium">
                                                {formatContextParentLabel(effectiveContextParentMessage, 'No prior conversation')}
                                            </div>
                                            <div className="truncate text-[11px] text-muted-foreground">Inferred from reply</div>
                                        </div>
                                        {contextPolicy === 'continue' && <Check className="ml-auto h-3.5 w-3.5" />}
                                    </DropdownMenuItem>
                                )}
                                {!isNewThreadTarget && contextPolicy === 'continue' && contextStartOptions.length > 0 && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Start context</DropdownMenuLabel>
                                        {contextStartOptions.map((option) => {
                                            const selected = option.id === effectiveContextStartId;
                                            return (
                                                <DropdownMenuItem
                                                    key={`start:${option.id}`}
                                                    onClick={() => {
                                                        setContextPolicy('continue');
                                                        setSelectedContextStartId(option.id);
                                                    }}
                                                    className="min-h-11 gap-2 rounded-lg"
                                                    title={option.label}
                                                >
                                                    {option.isFreshBoundary ? <RotateCcw className="h-3.5 w-3.5" /> : <GitBranchIcon className="h-3.5 w-3.5" />}
                                                    <div className="min-w-0">
                                                        <div className="truncate text-sm font-medium">{truncateText(option.label, 52)}</div>
                                                        <div className="truncate text-[11px] text-muted-foreground">
                                                            {option.isFreshBoundary ? 'Fresh boundary' : option.id === defaultContextStartMessage?.id ? 'Inferred start' : option.role}
                                                        </div>
                                                    </div>
                                                    {selected && <Check className="ml-auto h-3.5 w-3.5" />}
                                                </DropdownMenuItem>
                                            );
                                        })}
                                    </>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onClick={() => setContextPolicy('fresh')}
                                    className="min-h-11 gap-2 rounded-lg"
                                >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium">Fresh context</div>
                                        <div className="truncate text-[11px] text-muted-foreground">Start without inherited conversation context</div>
                                    </div>
                                    {contextPolicy === 'fresh' && <Check className="ml-auto h-3.5 w-3.5" />}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    className={cn(
                                        composerControlClass,
                                        "flex-[0_1_178px]",
                                        permissionMode === 'full-access' && "border-[hsl(var(--app-warning)/0.36)]"
                                    )}
                                    aria-label="Select permissions"
                                    title={selectedPermissionOption.description}
                                >
                                    <div className={composerControlIconClass}>
                                        <Shield className="h-3 w-3" />
                                    </div>
                                    <div className="min-w-0">
                                        <div className={composerEyebrowClass}>Permissions</div>
                                        <div className={composerValueClass}>
                                            {selectedPermissionOption.label}
                                        </div>
                                    </div>
                                    <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-foreground/70" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="end"
                                side="top"
                                sideOffset={8}
                                className={cn(composerPopupLayerClass, "w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_18px_48px_-18px_rgba(15,23,42,0.45),0_8px_20px_-12px_rgba(15,23,42,0.35)] backdrop-blur-xl dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.75),0_8px_20px_-12px_rgba(0,0,0,0.6)]")}
                            >
                                <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Permissions</DropdownMenuLabel>
                                {COMPOSER_PERMISSION_OPTIONS.map((option) => (
                                    <DropdownMenuItem
                                        key={option.id}
                                        onClick={() => setPermissionMode(option.id)}
                                        className="min-h-11 gap-2 rounded-lg"
                                    >
                                        {permissionMode === option.id ? <Check className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}
                                        <div className="min-w-0">
                                            <div className="truncate text-sm font-medium">{option.label}</div>
                                            <div className="truncate text-[11px] text-muted-foreground">{option.description}</div>
                                        </div>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>

                        {isParentContextInactive && (
                            <span className="flex min-h-8 items-center rounded-md bg-amber-50 px-2 text-[10.5px] font-semibold text-amber-700 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.25)] dark:bg-amber-950/30 dark:text-amber-300">
                                Parent context disabled
                            </span>
                        )}
                    </div>
                </div>

                {/* Context Chips Area */}
                {contextIds.length > 0 && (
                    <div className="px-2.5 pt-1.5 pb-0">
                        <ScrollArea className="w-full whitespace-nowrap custom-scrollbar pb-1">
                            <div className="flex gap-1.5 pt-1 pb-1">
                                {contextIds.map(id => {
                                    const file = filesMap.get(id);
                                    if (!file) return null;
                                    return (
                                        <ContextBadge
                                            key={id}
                                            fileId={id}
                                            fileName={file.name}
                                            onRemove={handleRemoveContext}
                                        />
                                    );
                                })}
                            </div>
                        </ScrollArea>
                    </div>
                )}

                {/* Attachment Preview Area */}
                {attachments.length > 0 && (
                    <div className="px-2.5 pb-1">
                        <ScrollArea className="w-full whitespace-nowrap custom-scrollbar pb-1">
                            <div className="flex gap-2 py-1">
                                {attachments.map((att) => (
                                    <AttachmentPreview
                                        key={getAttachmentId(att)}
                                        attachment={att}
                                        onRemove={handleRemoveAttachment}
                                        className="flex-shrink-0"
                                    />
                                ))}
                            </div>
                        </ScrollArea>
                    </div>
                )}

                {/* Input Area - Clean modern style */}
                <Popover open={isCommandPopoverOpen} onOpenChange={setIsCommandPopoverOpen}>
                    <PopoverAnchor asChild>
                        <div className="relative flex w-full flex-1 border-t border-[hsl(var(--app-border)/0.45)] bg-background/35">
                            {activeFileMention && (
                                <div className={cn(composerPopupLayerClass, "absolute inset-x-2 bottom-[calc(100%+8px)] overflow-hidden rounded-xl border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong)/0.97)] shadow-[0_20px_60px_-28px_rgba(15,23,42,0.45)] backdrop-blur-xl")}>
                                    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2 text-[11px] font-semibold text-foreground">
                                                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                                                    <AtSign className="h-3 w-3" />
                                                </span>
                                                Reference files
                                            </div>
                                            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                                Search by file name or path. Enter to attach, Esc to dismiss.
                                            </p>
                                        </div>
                                        {activeFileMention.query && (
                                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                                {activeFileMention.query}
                                            </span>
                                        )}
                                    </div>
                                    <div className="max-h-72 overflow-y-auto p-2">
                                        {activeMentionFiles.length === 0 ? (
                                            <div className="rounded-xl border border-dashed border-border/70 px-3 py-6 text-center text-[12px] text-muted-foreground">
                                                No files match this query.
                                            </div>
                                        ) : (
                                            <div className="space-y-1">
                                                {activeMentionFiles.map((file, index) => {
                                                    const isHighlighted = index === activeFileMentionIndex;
                                                    const isSelected = repoMentionPathSet.has(file.path);

                                                    return (
                                                        <button
                                                            key={file.path}
                                                            type="button"
                                                            onMouseDown={(event) => event.preventDefault()}
                                                            onClick={() => handleFileMentionSelect(file)}
                                                            className={cn(
                                                                "flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors",
                                                                isHighlighted
                                                                    ? "bg-[hsl(var(--app-accent-soft))] text-foreground shadow-sm"
                                                                    : "hover:bg-muted/60"
                                                            )}
                                                        >
                                                            <span className="min-w-0">
                                                                <span className="flex items-center gap-2 text-sm font-medium">
                                                                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--app-accent))]" />
                                                                    <span className="truncate">{file.name}</span>
                                                                </span>
                                                                <span className="mt-1 block truncate pl-6 text-[11px] text-muted-foreground">
                                                                    {file.path}
                                                                </span>
                                                            </span>
                                                            <span className="shrink-0 pt-0.5">
                                                                {isSelected ? (
                                                                    <Badge variant="secondary" className="rounded-full px-2 py-0 text-[10px]">
                                                                        Added
                                                                    </Badge>
                                                                ) : (
                                                                    <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                                                        Enter
                                                                    </span>
                                                                )}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                            <TemplateMentionTextarea
                                ref={textareaRef}
                                templates={orchestrationTemplates}
                                highlightValue={prompt}
                                data-testid="chat-composer-textarea"
                                defaultValue=""
                                onChange={handlePromptChange}
                                onSelect={handlePromptSelectionChange}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                disabled={!selectedWorkspaceId}
                                placeholder="Ask anything... Type @ to reference files"
                                className={cn(
                                    "min-h-0 w-full flex-1 resize-none rounded-none border-0 px-3.5 py-2.5",
                                    surfaceClasses.textarea,
                                    "bg-transparent",
                                    "text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground/55 focus:outline-none focus:ring-0 shadow-none",
                                    "disabled:opacity-50 disabled:cursor-not-allowed"
                                )}
                                minRows={1}
                                maxRows={6}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck={false}
                            />
                        </div>
                    </PopoverAnchor>
                    <PopoverContent
                        className={cn(composerPopupLayerClass, "w-60 p-1")}
                        onOpenAutoFocus={(e) => e.preventDefault()}
                        onCloseAutoFocus={(e) => e.preventDefault()}
                        side="top"
                        align="start"
                        sideOffset={5}
                    >
                        <div className="flex flex-col space-y-1">
                            <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">Insert Content</p>
                            <Button
                                variant="ghost"
                                className="w-full justify-start h-8 px-2"
                                onClick={() => handleCommandSelect('message')}
                            >
                                <FileTextIcon className="mr-2 h-4 w-4" />
                                Insert Message Content
                            </Button>
                            <Button
                                variant="ghost"
                                className="w-full justify-start h-8 px-2"
                                onClick={() => handleCommandSelect('branch')}
                            >
                                <GitBranchIcon className="mr-2 h-4 w-4" />
                                Insert Branch Content
                            </Button>
                        </div>
                    </PopoverContent>
                </Popover>

                <div className="flex items-center justify-between gap-2.5 border-t border-[hsl(var(--app-border)/0.55)] bg-[hsl(var(--app-bg-elevated)/0.58)] px-2.5 py-1">
                    {/* Left Actions */}
                    <div className="flex min-w-0 items-center gap-1.5">
                        {/* Model Selector - Modern chip style */}
                        {renderAgentModelSelector()}

                        {selectedAgentRunChips.length > 0 ? (
                            <div className="hidden min-w-0 items-center gap-1 sm:flex">
                                {selectedAgentRunChips.slice(0, 3).map(({ agent, count }) => {
                                    const canRemove = selectedRunTotal > count;
                                    const canDecrement = count > 1 || selectedRunTotal > 1;
                                    return (
                                        <div
                                            key={agent.id}
                                            className="group/chip flex h-6 min-w-0 items-center gap-0.5 rounded-md bg-[hsl(var(--app-panel-strong))] pl-1.5 pr-0.5 text-[10.5px] font-semibold text-foreground shadow-[0_1px_2px_rgba(22,26,32,0.06),inset_0_0_0_1px_hsl(var(--app-border)/0.76)] transition-[background-color,box-shadow] duration-150 hover:bg-background hover:shadow-[0_4px_16px_-12px_rgba(15,23,42,0.65),inset_0_0_0_1px_hsl(var(--app-border-strong)/0.8)]"
                                        >
                                            <span className="max-w-[104px] truncate">{agent.name}</span>
                                            <span className="rounded bg-muted/60 px-1 text-[9.5px] tabular-nums text-muted-foreground">
                                                {count}x
                                            </span>
                                            <div className="ml-0.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100">
                                                <button
                                                    type="button"
                                                    onClick={() => handleAgentRunCountChange(agent.id, 0)}
                                                    disabled={!canRemove}
                                                    className="flex h-4 w-4 items-center justify-center rounded bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.75)] transition-[background-color,color,transform,opacity] duration-150 hover:bg-red-50 hover:text-red-600 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                                                    aria-label={`Remove ${agent.name}`}
                                                >
                                                    <X className="h-2.5 w-2.5" strokeWidth={2.5} />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleAgentRunCountChange(agent.id, count - 1)}
                                                    disabled={!canDecrement}
                                                    className="flex h-4 w-4 items-center justify-center rounded bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.75)] transition-[background-color,color,transform,opacity] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35"
                                                    aria-label={`Decrease ${agent.name}`}
                                                >
                                                    <Minus className="h-2.5 w-2.5" strokeWidth={2.5} />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleAgentRunCountChange(agent.id, count + 1)}
                                                    className="flex h-4 w-4 items-center justify-center rounded bg-emerald-600 text-white shadow-[0_6px_16px_-10px_rgba(16,185,129,0.7)] transition-[background-color,transform] duration-150 hover:bg-emerald-700 active:scale-[0.96]"
                                                    aria-label={`Increase ${agent.name}`}
                                                >
                                                    <Plus className="h-2.5 w-2.5" strokeWidth={2.6} />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                                {selectedAgentRunChips.length > 3 ? (
                                    <span className="rounded bg-muted/55 px-1.5 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
                                        +{selectedAgentRunChips.length - 3}
                                    </span>
                                ) : null}
                            </div>
                        ) : null}

                    </div>

                    {/* Right Actions */}
                    <div className="flex items-center gap-2">
                        <HoverCard openDelay={500}>
                            <HoverCardTrigger asChild>
                                <label
                                    className={cn(
                                        "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1",
                                        "text-[11px] font-semibold text-muted-foreground transition-colors",
                                        selectedWorkspaceId ? "hover:border-[hsl(var(--app-border))] hover:bg-background/70 hover:text-foreground" : "opacity-50"
                                    )}
                                >
                                    <Checkbox
                                        checked={autoCheckoutOnAgentCommit}
                                        indicatorMode="check"
                                        onCheckedChange={(checked) => setAutoCheckoutOnAgentCommit(checked === true)}
                                        disabled={isSendingMessage || !selectedWorkspaceId}
                                        aria-label="Auto checkout generated commit"
                                    />
                                    <span className="whitespace-nowrap">Auto checkout</span>
                                </label>
                            </HoverCardTrigger>
                            <HoverCardContent className={cn(composerPopupLayerClass, "w-64 rounded-xl border border-border/70 bg-popover px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-lg")}>
                                Automatically checks out the agent&apos;s new commit in detached HEAD after the run finishes. Skips checkout if your repo has uncommitted changes.
                            </HoverCardContent>
                        </HoverCard>

                        {/* Send Button - Modern gradient style */}
                        <button
                            type="button"
                            data-testid="chat-send-button"
                            onMouseDown={() => {
                                if (!showPrimaryCancel) triggerSendPressFeedback();
                            }}
                            onClick={handlePrimaryAction}
                            disabled={showPrimaryCancel ? false : isPrimaryActionDisabled}
                            className={cn(
                                "flex-shrink-0 flex items-center justify-center gap-1.5",
                                "h-7 px-3 rounded-md",
                                "text-xs font-semibold",
                                "relative overflow-hidden transition-all duration-200 active:scale-95",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1",
                                showPrimaryCancel
                                    ? "bg-destructive text-destructive-foreground shadow-[0_10px_26px_-18px_hsl(var(--destructive))] hover:bg-destructive/90"
                                    : "bg-[hsl(var(--app-accent))] text-white shadow-[0_14px_34px_-20px_hsl(var(--app-accent)/0.65)] hover:brightness-105 dark:text-white",
                                sendPressFeedback && !showPrimaryCancel && "scale-95 ring-2 ring-primary/40 ring-offset-2",
                                "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:opacity-40 disabled:hover:shadow-none"
                            )}
                            aria-label={showPrimaryCancel ? cancelActionAriaLabel : primaryActionLabel}
                            title={isParentIncomplete ? parentStatusLabel : undefined}
                        >
                            {showPrimaryCancel ? (
                                <>
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    <span>{cancelActionLabel}</span>
                                </>
                            ) : (
                                <>
                                    {sendPressFeedback && (
                                        <span className="pointer-events-none absolute inset-0 animate-ping rounded-md bg-white/25 dark:bg-black/15" />
                                    )}
                                    {editDraftSource ? (
                                        <Pencil className="h-3 w-3" />
                                    ) : (
                                        <Send className="h-3 w-3" />
                                    )}
                                    <span>{primaryActionLabel}</span>
                                </>
                            )}
                        </button>
                        {isSteeringRunningAssistant && showCancel ? (
                            <button
                                type="button"
                                onClick={handleCancel}
                                className={cn(
                                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                                    "border border-[hsl(var(--app-border))] bg-background text-muted-foreground",
                                    "transition-[background-color,color,transform] duration-150 hover:bg-destructive hover:text-destructive-foreground active:scale-95",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1"
                                )}
                                aria-label={cancelActionAriaLabel}
                                title={cancelActionLabel}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
