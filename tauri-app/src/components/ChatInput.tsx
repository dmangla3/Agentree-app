import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { Button } from '../../@/components/ui/button';
import { Send, X, Reply, FileText, FileTextIcon, GitBranchIcon, Loader2, ChevronDown, ChevronRight, Layers3, Bot, Clipboard, Check, Pencil, AtSign, RotateCcw, Plus } from 'lucide-react';
import { useWorkspaceStore, AttachmentMetadata, Message, Workspace, Scope, CommitEntity } from '../stores/workspaceStore';
import { useAgentRunProjectionStore, type AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import { useQueryClient } from '@tanstack/react-query';
import { UnifiedAgentModelSelector } from './UnifiedAgentModelSelector';
import { AttachmentPreview } from './AttachmentPreview';
import { Badge } from "../../@/components/ui/badge";
import { Input } from "../../@/components/ui/input";
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
import axios from 'axios';
import { api } from '../lib/api';
import { getAccessToken } from '../lib/authSession';
import { getMessageById, resolveNodeCommit } from '../lib/gitNodeUtils';
import { track, trackAgentRunCompleted, trackAgentRunFailed, trackAgentRunStarted } from '../lib/analytics';
import {
    buildCrossProviderContinuationPacket,
    resolveProviderContextRouting,
    resolveProviderContinuation,
    type RuntimeProvider,
} from '../lib/providerContinuation';
import { ScrollArea } from "../../@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverAnchor, PopoverTrigger } from '../../@/components/ui/popover'; // Added Popover components
import { Checkbox } from '../../@/components/ui/checkbox';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../@/components/ui/hover-card';
import { useShallow } from 'zustand/react/shallow';
import { branchKeys } from '../hooks/useBranches';
import { catchUpHotSendMessageDeltas, primeHotSendMessageDeltaCursor, useHotSendMessageDeltas } from '../hooks/useHotSendMessageDeltas';
import { isFirstClassCommitMessage } from '../lib/graph/turnUtils';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import { getMergeVisualParentEntries, isMergeResultNode } from '../lib/graph/lineage';
import { reconstructContext } from '../lib/contextUtils';
import { hasFreshContextBoundary } from '../lib/messageContext';
import {
    scheduleMessagesRefreshWhenGraphIdle,
} from '../lib/graphInteractionGate';
import { createSendFlowId, recordSendFlowEvent, recordSendFlowMark } from '../perf/sendFlow';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { normalizeAgentAdapterEventForRun } from '../agent-runs/agentRunEventNormalizer';


// --- Types ---
type AttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';
interface FileAttachment {
    id: string;
    file: File;
    status: AttachmentStatus;
    path?: string;
    publicUrl?: string | null;
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

const REQUIRED_PROTOCOL_FALLBACK_NATIVE_EXIT_TERMINAL_EVENT = 'required-protocol:native-exit-terminal-event';

const getAttachmentId = (attachment: Attachment) => {
    if ('id' in attachment) return attachment.id;
    return attachment.path;
};

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
    queuedAt: number;
}

interface ActiveFileMention {
    start: number;
    end: number;
    query: string;
}

interface RepoMentionFile {
    path: string;
    name: string;
}

// --- Constants ---
const STREAM_LOG_PREFIX = '[RCSTRM]';
const STREAM_DEBUG_ENABLED = ['1', 'true', 'yes'].includes(String(import.meta.env.VITE_STREAM_DEBUG || '').toLowerCase());
const SEND_FLOW_DEBUG_ENABLED = ['1', 'true', 'yes'].includes(String(import.meta.env.VITE_SEND_FLOW_DEBUG || '').toLowerCase()) || STREAM_DEBUG_ENABLED;
const streamDebug = (message: string, details?: Record<string, unknown>) => {
    if (!STREAM_DEBUG_ENABLED) return;
    if (details) {
        console.log(`${STREAM_LOG_PREFIX} ${message}`, details);
        return;
    }
    console.log(`${STREAM_LOG_PREFIX} ${message}`);
};
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
const extractRepoMentionPaths = (value: string): string[] => {
    const matches = value.match(/(^|\s)@([^\s@]+)/g) ?? [];
    return matches.map((match) => match.trim().slice(1));
};
const collapseFuzzyText = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const AUTO_SCOPE_NAME_PATTERN = /^Untitled scope \d+$/i;
const isAutoScopeName = (value: string): boolean => AUTO_SCOPE_NAME_PATTERN.test(value.trim());
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
const formatCommitLabel = (commitSha: string | null | undefined): string => (
    commitSha ? commitSha.slice(0, 8) : 'No commit'
);
const formatCommitSubject = (commit: CommitEntity | null | undefined): string => (
    truncateText(normalizePreviewText(commit?.subject) || 'Untitled commit', 58)
);

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

const DEFAULT_CODEX_AUTH_COMMAND = `CODEX_HOME=/Users/example/.codex codex -c 'cli_auth_credentials_store="file"' login --device-auth`;
const DEPENDENCY_GUARD_INSTRUCTION = 'Dependency rule: some dependency and build directories in this worktree are symlinked and must be treated as read-only. Do not install, remove, upgrade, rebuild, or delete project dependencies or write build output into those symlinked directories. If you need to build, test, or install dependencies in a way that would write there, avoid doing it yourself and explicitly tell the user what needs to be run so they can do it outside the agent worktree.';
const EMPTY_COMPOSER_CONTEXT_MANIFEST = buildComposerContextManifest([], new Set<string>());

const extractRecommendedCommand = (message: string) => {
    const commandMatch = message.match(/Run `([^`]+)`/i);
    if (commandMatch?.[1]) return commandMatch[1].trim();
    return null;
};

const getCodexAuthToastDetails = (message: string) => {
    const normalized = message.toLowerCase();
    const isAuthError =
        normalized.includes('codex auth file not found') ||
        normalized.includes('codex is not authenticated') ||
        normalized.includes('token_expired') ||
        normalized.includes('authentication token is expired') ||
        normalized.includes('401 unauthorized') ||
        normalized.includes('codex authentication is missing') ||
        normalized.includes('auth.json is missing') ||
        normalized.includes('device-auth');

    if (!isAuthError) return null;

    return {
        title: 'Codex login required',
        description: normalized.includes('app sandbox')
            ? 'Agentree could not access your Codex login from the app sandbox. Run this command in Terminal, then retry.'
            : 'Agentree could not use your current Codex login. Run this command in Terminal, then retry.',
        command: extractRecommendedCommand(message) || DEFAULT_CODEX_AUTH_COMMAND,
    };
};

function CopyToastCommand({ command }: { command: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            console.error('Failed to copy command:', error);
        }
    }, [command]);

    return (
        <div className="mt-2 rounded-md border border-border/70 bg-background/80 p-2">
            <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] text-foreground">
                    {command}
                </code>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCopy}
                    className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                >
                    {copied ? <Check size={12} /> : <Clipboard size={12} />}
                    {copied ? 'Copied' : 'Copy'}
                </Button>
            </div>
        </div>
    );
}

const hasConversationChild = (
    messageId: string | null | undefined,
    messages: Message[],
    messageMap: Map<string, Message>
): boolean => {
    if (!messageId) return false;
    return messages.some((message) => {
        if (message.parentId !== messageId) return false;
        return !isFirstClassCommitMessage(message, { messageMap });
    });
};
const parseCliArgs = (cliArgs: string | null | undefined) => {
    const tokens = String(cliArgs || '').split(/\s+/).filter(Boolean);
    let model: string | null = null;
    let permissionMode: string | null = null;
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        const next = tokens[i + 1];
        if (token === '--model' && next) {
            model = next;
            i += 1;
        } else if (token === '--permission-mode' && next) {
            permissionMode = next;
            i += 1;
        }
    }
    return { model, permissionMode };
};

const deriveIncrementalText = (previousText: string, nextText: string) => {
    const previous = typeof previousText === 'string' ? previousText : '';
    const next = typeof nextText === 'string' ? nextText : '';
    if (!next) return '';
    if (!previous) return next;
    if (next === previous) return '';
    if (next.startsWith(previous)) return next.slice(previous.length);
    if (previous.startsWith(next)) return '';
    const maxOverlap = Math.min(previous.length, next.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
        if (previous.endsWith(next.slice(0, overlap))) {
            return next.slice(overlap);
        }
    }
    return previous.includes(next) ? '' : next;
};

import { useMessages, useSendMessage, useCommitDescendants, useCommitAncestors } from '../hooks/useMessages';
import { useWorkspaceMessages } from '../hooks/useLiveMessages';
import { localNodeKeys, useLocalNodes } from '../hooks/useLocalNodes';

import { useKnowledgeTree } from '../hooks/useKnowledge';
import { useAgents, findDefaultCodexAgentId } from '../hooks/useAgents';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useScopes } from '../hooks/useScopes';
import { agentClient } from '../lib/agentClient';
import { buildComposerContextManifest, buildComposerContextSelection, type ComposerContextManifest } from '../lib/composerContext';
import { AGENT_STATUS, TERMINAL_STATUSES } from '@shared/agentStatus';
import type { TerminalStatus } from '@shared/agentStatus';
import { createOptimisticNodePair, categorizeError, formatErrorMessage, isOptimisticId } from '../lib/optimisticMessages';
import { getFuzzyMatchScore } from '../lib/fuzzySearch';
import { useProviderLimitsStore } from '../stores/providerLimitsStore';
import { resolveNodeState } from '../lib/runStateResolver';

interface ChatInputProps {
    parentMessageIdOverride?: string | null;
    autoFocus?: boolean;
    onRequestClose?: () => void;
    onSendComplete?: () => void;
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

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutId: number | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId !== null) {
            window.clearTimeout(timeoutId);
        }
    }
};

// --- Component ---
export function ChatInput({
    parentMessageIdOverride,
    autoFocus = false,
    onRequestClose,
    onSendComplete,
}: ChatInputProps = {}) {
    const [prompt, setPrompt] = useState('');
    const [editDraftSource, setEditDraftSource] = useState<Message | null>(null);
    // --- NEW: Knowledge Base Context State ---
    const { data: filesData } = useKnowledgeTree();
    const files = useMemo(() => filesData ?? [], [filesData]);
    const filesMap = useMemo(() => new Map(files.map(f => [f.id, f])), [files]);
    const [contextIds, setContextIds] = useState<string[]>([]);
    const [repoMentionFiles, setRepoMentionFiles] = useState<RepoMentionFile[]>([]);
    const [repoMentionCommit, setRepoMentionCommit] = useState<string | null>(null);
    const [selectedBaseCommit, setSelectedBaseCommit] = useState<CommitEntity | null>(null);
    const [isEarlierCommitsOpen, setIsEarlierCommitsOpen] = useState(false);
    const [activeFileMention, setActiveFileMention] = useState<ActiveFileMention | null>(null);
    const [activeFileMentionIndex, setActiveFileMentionIndex] = useState(0);
    const [contextFetchError, _setContextFetchError] = useState<string | null>(null);
    const contextMode: ContextMode = 'active';

    const {
        selectedWorkspaceId,
        focusedMessageId,
        lastFocusSource,
        lastFocusMetadata,
        composerBaseCommitOverride,
        activeScopeId,
        autoCheckoutOnAgentCommit,
        beginSendFlowFocus,
        advanceSendFlowFocus,
        endSendFlowFocus,
        dispatchFocus,
        setActiveScopeId,
        setAutoCheckoutOnAgentCommit,
        selectedAgentId,
        setSelectedAgentId,
        setComposerContextPreview,
        setComposerBaseCommitOverride,
    } = useWorkspaceStore(
        useShallow((state) => ({
            selectedWorkspaceId: state.selectedWorkspaceId,
            focusedMessageId: state.focusedMessageId,
            lastFocusSource: state.lastFocusSource,
            lastFocusMetadata: state.lastFocusMetadata,
            composerBaseCommitOverride: state.composerBaseCommitOverride,
            activeScopeId: state.activeScopeId,
            autoCheckoutOnAgentCommit: state.autoCheckoutOnAgentCommit,
            beginSendFlowFocus: state.beginSendFlowFocus,
            advanceSendFlowFocus: state.advanceSendFlowFocus,
            endSendFlowFocus: state.endSendFlowFocus,
            dispatchFocus: state.dispatchFocus,
            setActiveScopeId: state.setActiveScopeId,
            setAutoCheckoutOnAgentCommit: state.setAutoCheckoutOnAgentCommit,
            selectedAgentId: state.selectedAgentId,
            setSelectedAgentId: state.setSelectedAgentId,
            setComposerContextPreview: state.setComposerContextPreview,
            setComposerBaseCommitOverride: state.setComposerBaseCommitOverride,
        }))
    );
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
    const clearAllAgentRunActors = useCallback(() => {
        agentRunManager.clearAll();
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
    const codexAuthToastShownRef = useRef(false);
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
        () => selectedWorkspace?.git_repo_path?.trim() || selectedWorkspace?.folderPath?.trim() || null,
        [selectedWorkspace?.folderPath, selectedWorkspace?.git_repo_path]
    );
    const scopesQuery = useScopes(selectedWorkspaceId);
    const scopes = useMemo(() => (scopesQuery.data?.scopes ?? []) as Scope[], [scopesQuery.data?.scopes]);
    const [selectedScopeIdOverride, setSelectedScopeIdOverride] = useState<string | null>(null);
    const [isCreatingNewScope, setIsCreatingNewScope] = useState(false);
    const [isNewScopeEditorOpen, setIsNewScopeEditorOpen] = useState(false);
    const [newScopeName, setNewScopeName] = useState('');
    const [contextPolicy, setContextPolicy] = useState<ContextPolicy>('continue');
    const [sendPressFeedback, setSendPressFeedback] = useState(false);
    const sendPressFeedbackTimerRef = useRef<number | null>(null);

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
    const selectedAgent = agents.find(a => a.id === selectedAgentId);
    const sendMessageMutation = useSendMessage();
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
    useHotSendMessageDeltas(selectedWorkspaceId);

    const patchPersistedMessageLocally = useCallback((workspaceId: string, messageId: string, updates: Partial<Message>) => {
        const queryKey = ['messages', workspaceId];
        const currentMessages = queryClient.getQueryData<Message[]>(queryKey);
        const current = currentMessages?.find((message) => message.id === messageId);
        if (!current) return;
        const next = { ...current, ...updates, workspaceId, id: messageId };
        queryClient.setQueryData<Message[]>(queryKey, (messages) => (
            messages?.map((message) => (
                message.id === messageId ? { ...message, ...next } : message
            )) ?? messages
        ));
        void agentClient
            .upsertLocalNode(workspaceId, messageId, next)
            .finally(() => {
                queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
                queryClient.invalidateQueries({ queryKey: ['messages', workspaceId], refetchType: 'active' });
            });
    }, [queryClient]);

    const focusedCommitSha = useMemo(() => {
        if (lastFocusSource !== 'graph') return null;
        const metadataCommitSha = typeof lastFocusMetadata?.commitSha === 'string'
            ? lastFocusMetadata.commitSha.trim()
            : '';
        if (!metadataCommitSha) return null;
        return !focusedMessageId || focusedMessageId === metadataCommitSha ? metadataCommitSha : null;
    }, [focusedMessageId, lastFocusMetadata, lastFocusSource]);
    const parentMessageId = parentMessageIdOverride !== undefined
        ? parentMessageIdOverride
        : focusedCommitSha
            ? null
            : focusedMessageId;
    const replyParentMessageId = editDraftSource
        ? (editDraftSource.parentId ?? null)
        : parentMessageId;
    const selectedNodeId = editDraftSource
        ? replyParentMessageId
        : parentMessageIdOverride !== undefined
            ? parentMessageIdOverride
            : focusedMessageId;
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
        status === 'pending' ||
        status === 'creating' ||
        status === 'initializing' ||
        status === AGENT_STATUS.running ||
        status === AGENT_STATUS.streaming
    ), []);
    const isSelectedNodeRunning = useMemo(() => {
        if (!selectedNodeId) return false;
        return isInProgressStatus(selectedResolvedState.status);
    }, [isInProgressStatus, selectedNodeId, selectedResolvedState.status]);

    const [attachments, setAttachments] = useState<Attachment[]>([]);
    // Removed isModelDialogOpen
    const [_isWebSearchEnabled] = useState(false); // Kept state but removed UI toggle
    const [currentAbortController, setCurrentAbortController] = useState<AbortController | null>(null);
    const [, setActiveComposerSend] = useState<{ flowId: string; nodeIds: string[] } | null>(null);
    const streamHandlerMapRef = useRef<Map<string, (event: Record<string, any>) => void>>(new Map());
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
        streamHandlerMapRef.current.delete(nodeId);
    }, []);
    const clearAllStreamHandlers = useCallback(() => {
        streamHandlerMapRef.current.clear();
    }, []);
    const assignSendFlowKey = useCallback((key: string | null | undefined, flowId: string | null | undefined) => {
        if (!key || !flowId) return;
        sendFlowByKeyRef.current.set(key, flowId);
    }, []);
    const releaseSendFlowKey = useCallback((key: string | null | undefined) => {
        if (!key) return;
        sendFlowByKeyRef.current.delete(key);
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
            (focusState.lastFocusSource === 'graph' || focusState.lastFocusSource === 'chat' || focusState.lastFocusSource === 'timeline') &&
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
    const hasPendingCommitFocusForFlow = useCallback((flowId: string | null | undefined) => {
        if (!flowId) return false;
        for (const pending of pendingGeneratedCommitFocusByTargetRef.current.values()) {
            if (pending.flowId === flowId) return true;
        }
        return false;
    }, []);
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
        }
        for (const name of trace.marks.keys()) {
            trace.emitted.add(name);
        }
        return trace.traceId;
    }, [assignSendFlowKey, ensureLatencyTrace, getSendFlowIdForKey]);

    const extractMessageText = useCallback((payload: any): string => {
        if (!payload) return '';
        if (typeof payload.content === 'string') return payload.content;
        if (typeof payload.message === 'string') return payload.message;
        if (typeof payload.text === 'string') return payload.text;
        if (payload.message?.content && Array.isArray(payload.message.content)) {
            return payload.message.content
                .map((block: any) => {
                    if (!block) return '';
                    if (typeof block.text === 'string') return block.text;
                    if (typeof block.content === 'string') return block.content;
                    return '';
                })
                .join('');
        }
        if (Array.isArray(payload.content)) {
            return payload.content
                .map((block: any) => {
                    if (!block) return '';
                    if (typeof block === 'string') return block;
                    if (typeof block.text === 'string') return block.text;
                    if (typeof block.content === 'string') return block.content;
                    return '';
                })
                .join('');
        }
        return '';
    }, []);

    const maybeShowCodexAuthToast = useCallback((message: string) => {
        if (codexAuthToastShownRef.current) return;
        if (!message) return;
        const details = getCodexAuthToastDetails(message);
        if (!details) return;
        codexAuthToastShownRef.current = true;
        addToast({
            title: details.title,
            description: details.description,
            variant: 'error',
            persistent: true,
            action: {
                component: <CopyToastCommand command={details.command} />,
            },
        });
    }, [addToast]);

    const updateAgentRunUsage = useCallback((usage: any, nodeId: string, parentId: string, workspaceId: string, agentId?: string | null) => {
        if (!usage) return;
        agentRunManager.dispatch(nodeId, { type: 'usage', usage }, {
            workspaceId,
            parentId,
            role: 'assistant',
            agentId: agentId || null,
            executionData: { timeline: [] },
        });
    }, []);

    const applyStreamingAssistantText = useCallback((
        nextContent: string,
        options: {
            nodeId: string;
            parentId: string;
            workspaceId: string;
            agentId?: string | null;
            appendedText?: string;
            timestamp?: number;
            streamSeq?: number | null;
        }
    ) => {
        agentRunManager.dispatch(options.nodeId, {
            type: 'content',
            content: nextContent,
            appendedText: options.appendedText || '',
            timestamp: options.timestamp ?? Date.now(),
            streamSeq: options.streamSeq ?? null,
        }, {
            workspaceId: options.workspaceId,
            parentId: options.parentId,
            role: 'assistant',
            agentId: options.agentId || null,
            content: nextContent,
            executionData: { timeline: [] },
        });
    }, []);

    const mergeStreamingOutput = useCallback((currentOutput: string, nextText: string) => {
        const incoming = typeof nextText === 'string' ? nextText : '';
        if (!incoming) return currentOutput;
        if (!currentOutput) return incoming;
        if (incoming.startsWith(currentOutput)) return incoming;
        if (currentOutput.startsWith(incoming)) return currentOutput;
        if (currentOutput.endsWith(incoming)) return currentOutput;
        return `${currentOutput}${incoming}`;
    }, []);

    const addTimelineEvent = useCallback((event: any, nodeId: string, parentId: string, content: string, workspaceId: string, agentId?: string | null) => {
        agentRunManager.dispatch(nodeId, { type: 'timeline_event', event }, {
            workspaceId,
            parentId,
            role: 'assistant',
            agentId: agentId || null,
            content,
            executionData: { timeline: [] },
        });
    }, []);

    const processAgentEvent = useCallback((data: any, currentOutput: string, nodeId: string, parentId: string, workspaceId: string, agentId: string | null | undefined) => {
        const maybePromoteLiveActivity = (text: string | null) => {
            if ((currentOutput || '').trim().length > 0) return;
            const normalized = (text || '').replace(/\s+/g, ' ').trim();
            if (!normalized) return;
            setSetupProgress(nodeId, normalized.slice(0, 140));
        };

        const mergeProviderMeta = (meta: Record<string, any>) => {
            mergeAgentRunExecutionData(nodeId, { meta });
            const providerFromMeta = typeof meta.provider === 'string' ? meta.provider : null;
            const providerFromAgent = agents.find((agent) => agent.id === agentId)?.type ?? null;
            const provider = (providerFromMeta || providerFromAgent) as RuntimeProvider | null;
            if (provider === 'claude' || provider === 'codex') {
                useProviderLimitsStore.getState().upsertFromMeta(provider, meta);
            }
        };

        if (data.type === 'provider_meta' && data.meta && typeof data.meta === 'object') {
            mergeProviderMeta(data.meta);
        } else if (data.type === 'thinking') {
            maybePromoteLiveActivity(data.thinking || data.content || null);
            const thinkingEvent = { type: 'thinking', timestamp: Date.now(), content: data.thinking || data.content };
            addTimelineEvent(thinkingEvent, nodeId, parentId, currentOutput, workspaceId, agentId);
        } else if (data.type === 'tool_use') {
            maybePromoteLiveActivity(`Running ${data.name || data.toolName || data.tool_name || 'tool'}...`);
            if (data.tool_input?.description) {
                addTimelineEvent({ type: 'thinking', timestamp: Date.now(), content: data.tool_input.description }, nodeId, parentId, currentOutput, workspaceId, agentId);
            }
            addTimelineEvent({
                type: 'tool_use',
                timestamp: Date.now(),
                toolName: data.name,
                toolInput: data.tool_input ?? data.input,
                toolUseId: data.id || data.tool_use_id,
                commandActions: data.commandActions ?? data.command_actions ?? data.provider_item?.commandActions ?? data.provider_item?.command_actions,
                providerItem: data.provider_item ?? data.providerItem,
                provider_item_id: data.provider_item_id ?? data.id ?? data.tool_use_id,
            }, nodeId, parentId, currentOutput, workspaceId, agentId);
        } else if (data.type === 'tool_result') {
            maybePromoteLiveActivity(`Finished ${data.toolName || data.tool_name || data.name || 'tool'}`);
            addTimelineEvent({
                type: 'tool_result',
                timestamp: Date.now(),
                toolName: data.toolName || data.tool_name || data.name || 'unknown',
                toolOutput: data.content || data.tool_output || data.output,
                isError: data.is_error,
                toolUseId: data.tool_use_id || data.id
            }, nodeId, parentId, currentOutput, workspaceId, agentId);
        } else if (data.type === 'stop' || data.type === 'provider_stop' || data.type === 'result') {
            // Inner stop/result events are emitted on stdout by wrappers.
            // Do not teardown here; wait for top-level exit/stop event so git finalization always runs.
            addTimelineEvent(
                {
                    type: 'thinking',
                    timestamp: Date.now(),
                    content: '[Agent run completed, finalizing changes…]'
                },
                nodeId,
                parentId,
                currentOutput,
                workspaceId,
                agentId
            );
        } else if (data.type === 'message') {
            const current = getAgentRunProjection(nodeId);
            const currentContent = typeof current?.content === 'string' ? current.content : '';
            const appended = deriveIncrementalText(currentContent, currentOutput);
            applyStreamingAssistantText(currentOutput, {
                nodeId,
                parentId,
                workspaceId,
                agentId,
                appendedText: appended,
                timestamp: Date.now(),
            });
        } else if (data.type === 'error') {
            const errorText = typeof data.data === 'string' ? data.data : (typeof data.content === 'string' ? data.content : '');
            if (errorText) {
                addTimelineEvent({ type: 'error', timestamp: Date.now(), content: errorText }, nodeId, parentId, currentOutput, workspaceId, agentId);
            }
        } else if (data.type === 'stderr') {
            const warningText = typeof data.data === 'string' ? data.data : (typeof data.content === 'string' ? data.content : '');
            if (warningText) {
                addTimelineEvent({ type: 'error', timestamp: Date.now(), content: warningText }, nodeId, parentId, currentOutput, workspaceId, agentId);
            }
        }
    }, [addTimelineEvent, agents, applyStreamingAssistantText, getAgentRunProjection, mergeAgentRunExecutionData, setSetupProgress]);

    useEffect(() => {
        return () => {
            clearAllStreamHandlers();
            clearAllAgentRunActors();
        };
    }, [clearAllStreamHandlers, clearAllAgentRunActors]);

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        let cancelled = false;

        void agentClient.onEvent(({ nodeId, event }) => {
            if (!nodeId || !event) return;
            const handler = streamHandlerMapRef.current.get(nodeId);
            if (handler) {
                handler(event);
            }
        }).then((nextUnlisten) => {
            if (cancelled) {
                nextUnlisten();
                return;
            }
            unlisten = nextUnlisten;
        }).catch((error) => {
            console.error('[ChatInput] Failed to subscribe to Tauri agent stream:', error);
        });

        return () => {
            cancelled = true;
            if (unlisten) {
                unlisten();
            }
        };
    }, []);

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
            const message = error instanceof Error ? error.message : 'Auto checkout failed.';
            addToast({
                title: message.includes('uncommitted changes') ? 'Auto Checkout Skipped' : 'Auto Checkout Failed',
                description: message,
                variant: message.includes('uncommitted changes') ? 'warning' : 'error',
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

        const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath || null;
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
            if (!message.status || !TERMINAL_STATUSES.includes(message.status as TerminalStatus)) continue;
            if (message.status === AGENT_STATUS.completed) continue;
            autoCheckoutPendingRef.current.delete(message.id);
            autoCheckoutHandledRef.current.add(message.id);
            notifyAutoCheckoutDidNotSucceed(`The agent ended with status "${message.status}", so there was no completed commit to check out.`);
        }
    }, [notifyAutoCheckoutDidNotSucceed, persistedMessages]);

    const startStreamForNode = useCallback(async (
        node: Message,
        options?: { waitForReady?: boolean; authToken?: string; parentId?: string | null }
    ) => {
        const nodeId = node.id;
        const workspaceId = node.workspaceId;
        const parentId = options?.parentId ?? node.parentId ?? '';
        const authToken = options?.authToken ?? await getAccessToken();
        const flowId = getSendFlowIdForKey(nodeId);
        if (flowId) {
            recordSendFlowEvent('stream.registered', {
                flowId,
                nodeId,
                workspaceId,
                parentId,
            }, { source: 'ChatInput' });
        }
        recordLatencyMark(nodeId, 'tauri_stream_registered', { authToken, nodeId });

        streamDebug(`tauri_stream_register node=${nodeId}`);
        const streamStartedAt = performance.now();
        unregisterStreamHandler(nodeId);
        let output = node.content || '';
        let terminalFinalized = false;
        let pendingContentFlushTimer: number | null = null;
        let pendingContentFlushAgentId: string | null | undefined = node.agent_id;
        let pendingContentFlushTimestamp: number | undefined = undefined;
        let latestStreamSeq: number | null = null;
        const nodeExecution = (node.execution_data || {}) as Record<string, any>;
        let latestAgentEventSeq: number | null = (() => {
            const actorSeq = agentRunManager.snapshot(nodeId)?.lastSeq;
            if (typeof actorSeq === 'number') return actorSeq;
            return typeof nodeExecution.last_agent_event_seq === 'number'
                ? nodeExecution.last_agent_event_seq
                : null;
        })();
        let lastPersistedAgentEventSeq: number | null = latestAgentEventSeq;
        let lastAgentEventSeqPersistedAt = 0;
        let markedRunning = false;
        const markRunningOnce = () => {
            if (markedRunning) return;
            markedRunning = true;
            setNodeStatus(nodeId, 'running');
        };
        const persistLatestAgentEventSeq = (force = false) => {
            if (typeof latestAgentEventSeq !== 'number') return;
            if (!force) {
                const now = Date.now();
                if (latestAgentEventSeq === lastPersistedAgentEventSeq) return;
                if (now - lastAgentEventSeqPersistedAt < 1000) return;
                lastAgentEventSeqPersistedAt = now;
            }
            lastPersistedAgentEventSeq = latestAgentEventSeq;
            mergeAgentRunExecutionData(nodeId, { last_agent_event_seq: latestAgentEventSeq });
        };

        const flushBufferedAssistantText = (options?: {
            force?: boolean;
            agentId?: string | null;
            timestamp?: number;
        }) => {
            if (options?.agentId !== undefined) {
                pendingContentFlushAgentId = options.agentId;
            }
            if (options?.timestamp !== undefined) {
                pendingContentFlushTimestamp = options.timestamp;
            }

            if (options?.force && pendingContentFlushTimer !== null) {
                window.clearTimeout(pendingContentFlushTimer);
                pendingContentFlushTimer = null;
            }

            const current = getAgentRunProjection(nodeId);
            const currentContent = typeof current?.content === 'string' ? current.content : '';
            if (currentContent === output) return;

            const appended = deriveIncrementalText(currentContent, output);
            applyStreamingAssistantText(output, {
                nodeId,
                parentId,
                workspaceId,
                agentId: pendingContentFlushAgentId,
                appendedText: appended,
                timestamp: pendingContentFlushTimestamp ?? Date.now(),
                streamSeq: latestStreamSeq,
            });
            if (options?.force) {
                uiDebug(`flush node=${nodeId}`, {
                    nodeId,
                    contentLength: output.length,
                    appendedLength: appended.length,
                    elapsedMs: Math.round(performance.now() - streamStartedAt),
                });
            }
        };

        const scheduleBufferedAssistantTextFlush = (options?: {
            force?: boolean;
            agentId?: string | null;
            timestamp?: number;
        }) => {
            if (options?.force) {
                flushBufferedAssistantText(options);
                return;
            }

            if (options?.agentId !== undefined) {
                pendingContentFlushAgentId = options.agentId;
            }
            if (options?.timestamp !== undefined) {
                pendingContentFlushTimestamp = options.timestamp;
            }
            if (pendingContentFlushTimer !== null) return;

            pendingContentFlushTimer = window.setTimeout(() => {
                pendingContentFlushTimer = null;
                flushBufferedAssistantText();
            }, 32);
        };

        const finalizeAgentRunMessage = (
            finalStatus: string = AGENT_STATUS.completed,
            options?: { clearOverlay?: boolean }
        ) => {
            const shouldClearOverlay = options?.clearOverlay ?? false;
            const isFirstTerminalFinalize = !terminalFinalized;
            if (terminalFinalized && !shouldClearOverlay) return;
            if (!terminalFinalized) {
                terminalFinalized = true;
            }
            uiDebug(`finalize:start node=${nodeId}`, {
                nodeId,
                finalStatus,
                elapsedMs: Math.round(performance.now() - streamStartedAt),
                bufferedOutputLength: output.length,
                currentProjectionLength: getAgentRunProjection(nodeId)?.content?.length || 0,
            });
            flushBufferedAssistantText({ force: true });
            const currentProjection = getAgentRunProjection(nodeId);
            const finalContent = (() => {
                const bufferedOutput = typeof output === 'string' ? output : '';
                const streamedContent = currentProjection?.content || '';
                if (!streamedContent) return bufferedOutput;
                if (!bufferedOutput) return streamedContent;
                if (bufferedOutput.startsWith(streamedContent)) return bufferedOutput;
                if (streamedContent.startsWith(bufferedOutput)) return streamedContent;
                return streamedContent.length >= bufferedOutput.length ? streamedContent : bufferedOutput;
            })();
            streamDebug(`finalize node=${nodeId} status=${finalStatus}`, {
                nodeId,
                finalStatus,
                bufferedOutputLength: output.length,
                streamedContentLength: currentProjection?.content?.length || 0,
                stream_seq: (currentProjection as any)?.execution_data?.last_stream_seq ?? null,
            });
            const finalExecutionData = {
                ...(currentProjection?.execution_data || {}),
                ...(typeof latestAgentEventSeq === 'number' ? { last_agent_event_seq: latestAgentEventSeq } : {}),
                ...(typeof latestStreamSeq === 'number' ? { last_stream_seq: latestStreamSeq } : {}),
                last_terminal_status: finalStatus,
            };
            agentRunManager.dispatch(nodeId, {
                type: 'execution_data',
                patch: finalExecutionData,
            }, {
                workspaceId,
                parentId,
                role: 'assistant',
                agentId: currentProjection?.agent_id || node.agent_id || null,
                content: finalContent,
                executionData: finalExecutionData,
            });
            agentRunManager.dispatch(nodeId, {
                type: 'terminal',
                status: finalStatus as any,
                content: finalContent,
                reason: finalStatus,
                holdMs: 3000,
            }, {
                workspaceId,
                parentId,
                role: 'assistant',
                agentId: currentProjection?.agent_id || node.agent_id || null,
                content: finalContent,
                executionData: finalExecutionData,
            });
            patchPersistedMessageLocally(workspaceId, nodeId, {
                content: finalContent,
                status: finalStatus as any,
                execution_data: finalExecutionData,
                updatedAt: new Date().toISOString(),
            });
            uiDebug(`finalize:overlay-updated node=${nodeId}`, {
                nodeId,
                finalStatus,
                finalContentLength: finalContent.length,
                elapsedMs: Math.round(performance.now() - streamStartedAt),
            });
            if (isFirstTerminalFinalize) {
                if (flowId) {
                    const lifecycleSuffix = finalStatus === AGENT_STATUS.completed
                        ? 'lifecycle.completed'
                        : finalStatus === AGENT_STATUS.cancelled
                            ? 'lifecycle.cancelled'
                            : 'lifecycle.failed';
                    recordSendFlowEvent(lifecycleSuffix, {
                        flowId,
                        nodeId,
                        workspaceId,
                        parentId,
                        finalStatus,
                        elapsedMs: Math.round(performance.now() - streamStartedAt),
                        finalContentLength: finalContent.length,
                    }, { source: 'ChatInput' });
                }
                const finalEventProperties = {
                    workspace_id: workspaceId,
                    node_id: nodeId,
                    parent_id: parentId || null,
                    agent_id: currentProjection?.agent_id || node.agent_id || null,
                    final_status: finalStatus,
                    elapsed_ms: Math.round(performance.now() - streamStartedAt),
                    final_content_chars: finalContent.length,
                };
                if (finalStatus === AGENT_STATUS.completed) {
                    trackAgentRunCompleted(finalEventProperties);
                } else {
                    trackAgentRunFailed(finalEventProperties);
                }
                if (!shouldClearOverlay) {
                    window.setTimeout(() => {
                        finalizeAgentRunMessage(finalStatus, { clearOverlay: true });
                    }, 3000);
                }
            }
            if (shouldClearOverlay) {
                if (pendingContentFlushTimer !== null) {
                    window.clearTimeout(pendingContentFlushTimer);
                    pendingContentFlushTimer = null;
                }
                agentRunManager.cleanup(nodeId);
                worktreeInfoRef.current.delete(nodeId);
                latencyTraceRef.current.delete(nodeId);
                if (flowId) {
                    if (hasPendingCommitFocusForFlow(flowId)) {
                        recordSendFlowEvent('cleanup.focus-end-deferred', {
                            flowId,
                            nodeId,
                            workspaceId,
                            finalStatus,
                        }, { source: 'ChatInput' });
                    } else {
                        finishSendFlowLifecycleFocus(flowId, nodeId, 'terminal-cleanup', {
                            workspaceId,
                            finalStatus,
                        });
                    }
                } else {
                    releaseSendFlowKey(nodeId);
                }
                uiDebug(`finalize:overlay-cleared node=${nodeId}`, {
                    nodeId,
                    elapsedMs: Math.round(performance.now() - streamStartedAt),
                });
            }
        };

        // Future: add observer-driven backend fanout as a secondary stream path.
        streamHandlerMapRef.current.set(nodeId, (data: any) => {
            try {
                agentRunManager.dispatch(nodeId, normalizeAgentAdapterEventForRun(data), {
                    workspaceId,
                    parentId,
                    role: 'assistant',
                    agentId: data.agent_id ?? node.agent_id ?? null,
                    content: output,
                    executionData: (node.execution_data || {}) as Record<string, any>,
                });
                if (typeof data.seq === 'number') {
                    if (latestAgentEventSeq !== null && data.seq <= latestAgentEventSeq) {
                        return;
                    }
                    latestAgentEventSeq = data.seq;
                    persistLatestAgentEventSeq();
                }
                if (typeof data.stream_seq === 'number') {
                    latestStreamSeq = data.stream_seq;
                }
                recordLatencyMark(nodeId, 'first_tauri_event_received', { authToken, nodeId });
                markRunningOnce();

                if (
                    data.type !== 'stdout' &&
                    data.type !== 'stderr' &&
                    data.type !== 'exit' &&
                    data.type !== 'stop' &&
                    data.type !== 'provider_stop'
                ) {
                    if (data.type === 'message_delta' && typeof data.delta === 'string') {
                        output = `${output}${data.delta}`;
                        recordLatencyMark(nodeId, 'first_assistant_delta', {
                            authToken,
                            nodeId,
                            detail: { transport: 'tauri_message_delta' },
                        });
                        if (output.trim().length > 0) {
                            recordLatencyMark(nodeId, 'first_visible_text_rendered', {
                                authToken,
                                nodeId,
                                detail: { transport: 'tauri_message_delta' },
                            });
                        }
                        scheduleBufferedAssistantTextFlush({
                            agentId: data.agent_id,
                            timestamp: data.timestamp,
                        });
                    } else if (data.type === 'message_completed' && typeof data.content === 'string') {
                        const nextOutput = mergeStreamingOutput(output, data.content);
                        output = nextOutput;
                        scheduleBufferedAssistantTextFlush({
                            force: true,
                            agentId: data.agent_id,
                            timestamp: data.timestamp,
                        });
                    } else if (data.type === 'message' && typeof data.content === 'string') {
                        const nextOutput = mergeStreamingOutput(output, data.content);
                        output = nextOutput;
                        if (output.trim().length > 0) {
                            recordLatencyMark(nodeId, 'first_visible_text_rendered', {
                                authToken,
                                nodeId,
                                detail: { transport: 'tauri_message' },
                            });
                        }
                        scheduleBufferedAssistantTextFlush({
                            force: true,
                            agentId: data.agent_id,
                            timestamp: data.timestamp,
                        });
                    } else if (data.type === 'usage' && data.usage) {
                        updateAgentRunUsage(data.usage, nodeId, parentId, workspaceId, data.agent_id);
                    } else if (data.type === 'codex_event' && data.usage) {
                        updateAgentRunUsage(data.usage, nodeId, parentId, workspaceId, data.agent_id);
                    } else if (data.type === 'provider_meta' || data.type === 'thinking' || data.type === 'tool_use' || data.type === 'tool_result' || data.type === 'error') {
                        if (data.type === 'error' && typeof data.content === 'string') {
                            maybeShowCodexAuthToast(data.content);
                        }
                        processAgentEvent(data, output, nodeId, parentId, workspaceId, data.agent_id);
                    }
                    return;
                }

                if (data.type === 'stdout') {
                    try {
                        const innerData = JSON.parse(data.data);
                        if (innerData?.type === 'message') {
                            maybeShowCodexAuthToast(extractMessageText(innerData));
                        }
                        if (innerData.type === 'message_delta' && typeof innerData.delta === 'string') {
                            output = `${output}${innerData.delta}`;
                            recordLatencyMark(nodeId, 'first_assistant_delta', {
                                authToken,
                                nodeId,
                                detail: { transport: 'tauri_stdout_message_delta' },
                            });
                            if (output.trim().length > 0) {
                                recordLatencyMark(nodeId, 'first_visible_text_rendered', {
                                    authToken,
                                    nodeId,
                                    detail: { transport: 'tauri_stdout_message_delta' },
                                });
                            }
                            scheduleBufferedAssistantTextFlush({
                                agentId: data.agent_id,
                                timestamp: innerData.timestamp ?? data.timestamp,
                            });
                            return;
                        }
                        if (innerData.type === 'message_completed' && typeof innerData.content === 'string') {
                            const nextOutput = mergeStreamingOutput(output, innerData.content);
                            output = nextOutput;
                            scheduleBufferedAssistantTextFlush({
                                force: true,
                                agentId: data.agent_id,
                                timestamp: innerData.timestamp ?? data.timestamp,
                            });
                            return;
                        }
                        if (innerData.type === 'assistant' && innerData.message?.content) {
                            const blocks = Array.isArray(innerData.message.content) ? innerData.message.content : [];
                            for (const block of blocks) {
                                if (!block) continue;
                                if (block.type === 'text') {
                                    const nextOutput = mergeStreamingOutput(output, block.text || '');
                                    output = nextOutput;
                                    scheduleBufferedAssistantTextFlush({
                                        agentId: data.agent_id,
                                        timestamp: innerData.timestamp ?? data.timestamp,
                                    });
                                } else if (block.type === 'tool_use') {
                                    processAgentEvent({
                                        type: 'tool_use',
                                        id: block.id,
                                        name: block.name,
                                        tool_input: block.input,
                                        commandActions: (block as any).commandActions ?? (block as any).command_actions,
                                        provider_item: (block as any).provider_item,
                                        provider_item_id: (block as any).provider_item_id,
                                    }, output, nodeId, parentId, workspaceId, data.agent_id);
                                } else if (block.type === 'tool_result') {
                                    processAgentEvent({ type: 'tool_result', toolName: block.name, tool_output: block.content ?? block.output, is_error: block.is_error }, output, nodeId, parentId, workspaceId, data.agent_id);
                                } else if (block.type === 'thinking') {
                                    processAgentEvent({ type: 'thinking', thinking: block.thinking || block.text || block.content }, output, nodeId, parentId, workspaceId, data.agent_id);
                                }
                            }
                            if (innerData.message?.usage) {
                                updateAgentRunUsage(innerData.message.usage, nodeId, parentId, workspaceId, data.agent_id);
                            }
                            if (blocks.some((b: any) => b?.type === 'text') && output.trim().length > 0) {
                                recordLatencyMark(nodeId, 'first_visible_text_rendered', {
                                    authToken,
                                    nodeId,
                                    detail: { transport: 'tauri_stdout_assistant_block' },
                                });
                            }
                            return;
                        }
                        if (innerData.type === 'user' && innerData.message?.content) {
                            const blocks = Array.isArray(innerData.message.content) ? innerData.message.content : [];
                            for (const block of blocks) {
                                if (!block) continue;
                                if (block.type === 'tool_result') {
                                    processAgentEvent({ type: 'tool_result', toolName: block.name, tool_output: block.content ?? block.output, is_error: block.is_error, tool_use_id: block.tool_use_id }, output, nodeId, parentId, workspaceId, data.agent_id);
                                }
                            }
                            return;
                        }
                        if (innerData.type === 'usage' && innerData.usage) {
                            updateAgentRunUsage(innerData.usage, nodeId, parentId, workspaceId, data.agent_id);
                            return;
                        }
                        if (innerData.type === 'result' && innerData.usage) {
                            updateAgentRunUsage(innerData.usage, nodeId, parentId, workspaceId, data.agent_id);
                        }
                        if (innerData.type === 'message') {
                            const inferredRole = innerData.role || innerData.message?.role || (innerData.payload?.item?.type === 'agent_message' ? 'assistant' : null);
                            if (inferredRole === 'assistant' || inferredRole == null) {
                                const nextOutput = mergeStreamingOutput(output, extractMessageText(innerData));
                                output = nextOutput;
                                scheduleBufferedAssistantTextFlush({
                                    force: true,
                                    agentId: data.agent_id,
                                    timestamp: innerData.timestamp ?? data.timestamp,
                                });
                            }
                            if (output.trim().length > 0) {
                                recordLatencyMark(nodeId, 'first_visible_text_rendered', {
                                    authToken,
                                    nodeId,
                                    detail: { transport: 'tauri_stdout_message' },
                                });
                            }
                        }
                        if (innerData.type === 'result' || innerData.type === 'stop' || innerData.type === 'provider_stop') {
                            streamDebug(`stdout_inner_terminal node=${nodeId}`, { type: innerData.type, stream_seq: data.stream_seq ?? null });
                        }
                        processAgentEvent(innerData, output, nodeId, parentId, workspaceId, data.agent_id);
                    } catch (_e) {
                        if (typeof data.data === 'string') {
                            maybeShowCodexAuthToast(data.data);
                            processAgentEvent({ type: 'error', content: data.data }, output, nodeId, parentId, workspaceId, data.agent_id);
                        }
                    }
                } else if (data.type === 'stderr') {
                    if (typeof data.data === 'string') {
                        maybeShowCodexAuthToast(data.data);
                        processAgentEvent({ type: 'error', content: data.data }, output, nodeId, parentId, workspaceId, data.agent_id);
                    }
                } else if (data.type === 'finalize_ack') {
                    const currentRunId = String((((getAgentRunProjection(nodeId)?.execution_data || {}) as any)?.current_run_id || nodeId));
                    if (typeof data.run_id === 'string' && data.run_id !== currentRunId) {
                        return;
                    }

                    const finalizedOutputCommitSha = typeof data.output_commit_sha === 'string' && data.output_commit_sha
                        ? data.output_commit_sha
                        : typeof data.outputCommitSha === 'string' && data.outputCommitSha
                            ? data.outputCommitSha
                            : typeof data.commit_sha === 'string' && data.commit_sha
                                ? data.commit_sha
                                : null;
                    const currentProjection = getAgentRunProjection(nodeId);
                    const currentMeta = (((currentProjection?.execution_data || {}) as any)?.meta || {}) as Record<string, any>;
                    agentRunManager.dispatch(nodeId, {
                        type: 'finalize_ack',
                        commitCreated: data.commit_created !== false,
                        meta: {
                            ...currentMeta,
                            ...(finalizedOutputCommitSha
                                ? { output_commit_sha: finalizedOutputCommitSha }
                                : {}),
                            ...(data.commit_created === false ? { commit_created: false } : {}),
                        },
                    }, {
                        workspaceId,
                        parentId,
                        role: 'assistant',
                        agentId: currentProjection?.agent_id || node.agent_id || null,
                        content: output,
                        executionData: (currentProjection?.execution_data || node.execution_data || {}) as Record<string, any>,
                    });

                    uiDebug(`finalize-ack:refetch node=${nodeId}`, {
                        nodeId,
                        persisted: data.persisted,
                        commitSha: finalizedOutputCommitSha,
                        elapsedMs: Math.round(performance.now() - streamStartedAt),
                    });
                    if (finalizedOutputCommitSha) {
                        queryClient.setQueryData<Message[]>(['messages', workspaceId], (current) => {
                            if (!current) return current;
                            let changed = false;
                            const next = current.map((message) => {
                                if (message.id !== nodeId) return message;
                                changed = true;
                                const executionData = (message.execution_data || {}) as Record<string, any>;
                                const meta = (executionData.meta || {}) as Record<string, any>;
                                return {
                                    ...message,
                                    output_commit_sha: finalizedOutputCommitSha,
                                    execution_data: {
                                        ...executionData,
                                        meta: {
                                            ...meta,
                                            output_commit_sha: finalizedOutputCommitSha,
                                            commit_created: true,
                                        },
                                    },
                                };
                            });
                            return changed ? next : current;
                        });
                    }
                    void queryClient.invalidateQueries({
                        queryKey: localNodeKeys.workspace(workspaceId),
                    });
                    void scheduleMessagesRefreshWhenGraphIdle(queryClient, workspaceId, {
                        reason: 'agent-finalize-ack',
                    });
                    if (finalizedOutputCommitSha) {
                        void queryClient.invalidateQueries({
                            queryKey: ['local-commit-graph', workspaceId],
                            refetchType: 'active',
                        });
                        void queryClient.invalidateQueries({
                            queryKey: ['local-commits', workspaceId],
                            refetchType: 'active',
                        });
                        void catchUpHotSendMessageDeltas(queryClient, workspaceId);
                        const flowId = getSendFlowIdForKey(nodeId);
                        if (flowId) {
                            advanceSendFlowFocus({
                                flowId,
                                preferredMessageId: nodeId,
                                addGuardedMessageIds: [nodeId],
                                phase: 'commit',
                            });
                        }
                        queueGeneratedCommitFocus({
                            workspaceId,
                            assistantMessageId: nodeId,
                            targetMessageId: nodeId,
                            commitSha: finalizedOutputCommitSha,
                            flowId,
                        });
                    }
                    if (!terminalFinalized) {
                        const ackStatus = typeof data.status === 'string' ? data.status : AGENT_STATUS.completed;
                        finalizeAgentRunMessage(ackStatus);
                    }
                } else if (data.type === 'finalize_progress') {
                    const progressText = typeof data.message === 'string' && data.message.trim()
                        ? data.message.trim()
                        : 'Generating commit...';
                    agentRunManager.dispatch(nodeId, {
                        type: 'finalize_progress',
                        progress: progressText,
                        phase: typeof data.phase === 'string' ? data.phase : null,
                    }, {
                        workspaceId,
                        parentId,
                        role: 'assistant',
                        agentId: data.agent_id ?? node.agent_id ?? null,
                        content: output,
                        executionData: (getAgentRunProjection(nodeId)?.execution_data || node.execution_data || {}) as Record<string, any>,
                    });
                } else if (data.type === 'stop' || data.type === 'provider_stop') {
                    const providerTerminalStatus = typeof data.provider_status === 'string'
                        ? data.provider_status
                        : typeof data.status === 'string'
                            ? data.status
                            : AGENT_STATUS.completed;
                    const providerStopReason = typeof data.provider_stop_reason === 'string'
                        ? data.provider_stop_reason
                        : typeof data.stop_reason === 'string'
                            ? data.stop_reason
                            : null;
                    uiDebug(`stop:received node=${nodeId}`, {
                        nodeId,
                        providerStatus: providerTerminalStatus,
                        providerStopReason,
                        finalContentLength: typeof data.final_content === 'string' ? data.final_content.length : 0,
                        outputLength: output.length,
                        elapsedMs: Math.round(performance.now() - streamStartedAt),
                    });
                    if (typeof data.final_content === 'string' && data.final_content.length > 0) {
                        const nextOutput = mergeStreamingOutput(output, data.final_content);
                        output = nextOutput;
                        scheduleBufferedAssistantTextFlush({
                            force: true,
                            agentId: data.agent_id,
                            timestamp: data.timestamp,
                        });
                    } else {
                        flushBufferedAssistantText({ force: true, agentId: data.agent_id, timestamp: data.timestamp });
                    }
                    if (data.usage) {
                        updateAgentRunUsage(data.usage, nodeId, parentId, workspaceId, data.agent_id);
                    }
                    streamDebug(`terminal_stop node=${nodeId}`, {
                        providerStatus: providerTerminalStatus,
                        providerStopReason,
                        stream_seq: data.stream_seq ?? null,
                        output_len: output.length,
                    });
                    const projectionSnapshot = getAgentRunProjection(nodeId);
                    let executionDataSnapshot = {
                        ...((projectionSnapshot?.execution_data || {}) as Record<string, any>),
                        ...(typeof latestStreamSeq === 'number' ? { last_stream_seq: latestStreamSeq } : {}),
                        ...(typeof latestAgentEventSeq === 'number' ? { last_agent_event_seq: latestAgentEventSeq } : {}),
                        provider_terminal_status: providerTerminalStatus,
                        ...(providerStopReason
                            ? { provider_stop_reason: providerStopReason }
                            : {}),
                        meta: {
                            ...(((projectionSnapshot?.execution_data || {}) as any)?.meta || {}),
                            ...(data.provider_thread_id ? { provider_thread_id: data.provider_thread_id } : {}),
                            ...(data.provider_turn_id ? { provider_turn_id: data.provider_turn_id } : {}),
                        },
                    };
                    mergeAgentRunExecutionData(nodeId, executionDataSnapshot);
                    patchPersistedMessageLocally(workspaceId, nodeId, {
                        content: output,
                        execution_data: executionDataSnapshot,
                        promptTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? null,
                        completionTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? null,
                        totalTokens: data.usage?.total_tokens ?? null,
                        updatedAt: new Date().toISOString(),
                    });

                    agentRunManager.dispatch(nodeId, {
                        type: 'finalize_progress',
                        progress: providerTerminalStatus === AGENT_STATUS.completed
                            ? 'Finalizing changes...'
                            : 'Finalizing run...',
                        phase: 'provider_done',
                    }, {
                        workspaceId,
                        parentId,
                        role: 'assistant',
                        agentId: data.agent_id ?? node.agent_id ?? null,
                        content: output,
                        executionData: executionDataSnapshot,
                    });
                } else if (data.type === 'exit') {
                    streamDebug(`terminal_exit node=${nodeId}`, {
                        stream_seq: data.stream_seq ?? null,
                        output_len: output.length,
                    });
                    const exitStatus = typeof data.status === 'string'
                        ? data.status
                        : (getAgentRunProjection(nodeId)?._optimisticStatus === AGENT_STATUS.cancelled ? AGENT_STATUS.cancelled : AGENT_STATUS.failed);
                    if (!terminalFinalized) {
                        streamDebug(`exit_terminal_finalize node=${nodeId}`, {
                            fallback: REQUIRED_PROTOCOL_FALLBACK_NATIVE_EXIT_TERMINAL_EVENT,
                        });
                        persistLatestAgentEventSeq(true);
                        finalizeAgentRunMessage(exitStatus);
                    }
                    unregisterStreamHandler(nodeId);
                }
            } catch (err) {
                console.error('Tauri Agent Stream Parse Error:', err);
            }
        });

        const resolveRunIdForReplay = async () => {
            const projectionExecution = (getAgentRunProjection(nodeId)?.execution_data || {}) as Record<string, any>;
            const localRunId = projectionExecution.current_run_id || nodeExecution.current_run_id;
            if (typeof localRunId === 'string' && localRunId) return localRunId;
            const nativeState = await agentClient.getAgentRunState(nodeId).catch(() => null);
            const nativeRunId = nativeState?.ledger?.runId ?? nativeState?.ledger?.run_id;
            return typeof nativeRunId === 'string' && nativeRunId ? nativeRunId : null;
        };

        void (async () => {
            const runId = await resolveRunIdForReplay();
            if (!runId) return;
            const afterSeq = latestAgentEventSeq ?? 0;
            const replayedEvents = await agentClient.replayAgentRunEvents(runId, afterSeq).catch((error) => {
                console.warn('[ChatInput] Failed to replay native agent events:', { nodeId, runId, error });
                return [];
            });
            if (replayedEvents.length === 0) return;
            for (const row of replayedEvents) {
                const handler = streamHandlerMapRef.current.get(nodeId);
                if (!handler) return;
                let event: Record<string, any> | null = null;
                try {
                    event = JSON.parse(row.payload);
                } catch (_err) {
                    event = {
                        type: row.eventType || 'agent:lifecycle',
                        data: row.payload,
                    };
                }
                handler({
                    ...event,
                    run_id: (event as any)?.run_id ?? row.runId,
                    nodeId: (event as any)?.nodeId ?? row.assistantNodeId,
                    seq: row.seq,
                    timestamp: (event as any)?.timestamp ?? row.timestamp,
                    status: (event as any)?.status ?? row.status,
                    phase: (event as any)?.phase ?? row.phase,
                });
            }
        })();
    }, [
        cleanupAgentRunProjection,
        advanceSendFlowFocus,
        extractMessageText,
        finishSendFlowLifecycleFocus,
        getAgentRunProjection,
        getSendFlowIdForKey,
        hasPendingCommitFocusForFlow,
        maybeShowCodexAuthToast,
        mergeStreamingOutput,
        patchPersistedMessageLocally,
        processAgentEvent,
        queueGeneratedCommitFocus,
        queryClient,
        recordLatencyMark,
        releaseSendFlowKey,
        seedAgentRunProjection,
        applyStreamingAssistantText,
        mergeAgentRunExecutionData,
        unregisterStreamHandler,
        updateAgentRunUsage,
        dispatchFocus,
        setNodeStatus,
        setSetupProgress,
    ]);

    // --- NEW: State for Slash Command Popover ---
    const [isCommandPopoverOpen, setIsCommandPopoverOpen] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null); // Ref for the textarea

    const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);

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
    const defaultBaseCommitSha = useMemo(() => (
        focusedCommitSha
            ? focusedCommitSha
            : resolveNodeCommit(branchParentMessage ?? selectedNodeMessage, messageLookupMessages, selectedWorkspace?.base_commit_sha ?? null)
    ), [branchParentMessage, focusedCommitSha, messageLookupMessages, selectedNodeMessage, selectedWorkspace?.base_commit_sha]);
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
        setIsEarlierCommitsOpen(false);
    }, [defaultBaseCommitSha, replyParentMessageId, selectedWorkspaceId]);
    const composerOverrideCommitSha = composerBaseCommitOverride?.workspaceId === selectedWorkspaceId
        ? composerBaseCommitOverride.commitSha
        : null;
    const effectiveBaseCommitSha = composerOverrideCommitSha || selectedBaseCommit?.sha || defaultBaseCommitSha;
    const effectiveBaseCommitLabel = composerOverrideCommitSha
        ? (composerBaseCommitOverride?.label || composerOverrideCommitSha)
        : selectedBaseCommit?.subject || selectedBaseCommit?.sha || defaultBaseCommitSha || 'No commit';
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
    const replyParentLabel = branchParentMessage?.content || '';
    const messageById = useMemo(
        () => new Map(messageLookupMessages.map((m: Message) => [m.id, m])),
        [messageLookupMessages]
    );
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
    const branchParentScopeId = branchParentMessage?.scope_id || null;
    const isParentContextInactive = branchParentMessage?.context_active === false;
    const parentStatus = resolveNodeState(branchParentMessage, null).status;
    const isParentIncomplete = !!replyParentMessageId &&
        branchParentMessage?.role === 'assistant' &&
        branchParentMessage?.parentId !== null &&
        !!parentStatus &&
        !TERMINAL_STATUSES.includes(parentStatus as TerminalStatus);
    const parentStatusLabel = parentStatus === AGENT_STATUS.pending
        ? 'Parent pending'
        : parentStatus === AGENT_STATUS.streaming
            ? 'Parent streaming'
            : parentStatus === AGENT_STATUS.running
                ? 'Parent running'
                : 'Parent still running';
    const showCancel = isSelectedNodeRunning;
    const nextUntitledScopeName = useMemo(() => {
        const existingNames = new Set(
            scopes
                .map((scope) => scope.name?.trim().toLowerCase())
                .filter((name): name is string => Boolean(name))
        );

        let index = 1;
        while (existingNames.has(`untitled scope ${index}`)) {
            index += 1;
        }

        return `Untitled scope ${index}`;
    }, [scopes]);
    const effectiveScopeModeForReply = useMemo<'inherit' | 'existing' | 'new'>(() => {
        if (isCreatingNewScope) {
            return 'new';
        }
        if (selectedScopeIdOverride) {
            return 'existing';
        }
        return 'inherit';
    }, [isCreatingNewScope, selectedScopeIdOverride]);
    const effectiveScopeIdForReply = useMemo<string | null>(() => {
        if (effectiveScopeModeForReply === 'new') {
            return null;
        }
        if (selectedScopeIdOverride) {
            return selectedScopeIdOverride;
        }
        if (replyParentMessageId) return branchParentScopeId;
        return activeScopeId || null;
    }, [activeScopeId, branchParentScopeId, effectiveScopeModeForReply, replyParentMessageId, selectedScopeIdOverride]);
    const effectiveScope = useMemo(
        () => effectiveScopeIdForReply ? scopes.find((scope) => scope.id === effectiveScopeIdForReply) ?? null : null,
        [effectiveScopeIdForReply, scopes]
    );
    const pendingNewScopeName = newScopeName.trim() || nextUntitledScopeName;
    const effectiveScopeLabel = isCreatingNewScope
        ? pendingNewScopeName
        : (effectiveScope?.name || 'Default');
    const codeParentCommit = effectiveBaseCommitSha;

    useEffect(() => {
        if (!selectedWorkspaceId) return;
        const serverActiveScopeId = scopesQuery.data?.activeScopeId ?? null;
        if ((serverActiveScopeId ?? null) === (activeScopeId ?? null)) return;
        setActiveScopeId(serverActiveScopeId);
    }, [selectedWorkspaceId, scopesQuery.data?.activeScopeId, activeScopeId, setActiveScopeId]);

    useEffect(() => {
        setSelectedScopeIdOverride(null);
        setIsCreatingNewScope(false);
        setIsNewScopeEditorOpen(false);
        setNewScopeName('');
        setContextPolicy('continue');
    }, [replyParentMessageId]);

    const handleCreateScopeFromComposer = useCallback(() => {
        setIsCreatingNewScope(true);
        setIsNewScopeEditorOpen(true);
        setSelectedScopeIdOverride(null);
        setNewScopeName((current) => {
            const trimmed = current.trim();
            if (trimmed && !isAutoScopeName(trimmed)) return current;
            return nextUntitledScopeName;
        });
    }, [nextUntitledScopeName]);
    const handleSaveNewScopeName = useCallback(() => {
        setNewScopeName((current) => {
            const trimmed = current.trim();
            return trimmed || nextUntitledScopeName;
        });
        setIsCreatingNewScope(true);
        setSelectedScopeIdOverride(null);
        setIsNewScopeEditorOpen(false);
    }, [nextUntitledScopeName]);
    const handleCancelNewScopeName = useCallback(() => {
        setIsCreatingNewScope(false);
        setIsNewScopeEditorOpen(false);
        setNewScopeName('');
    }, []);

    useEffect(() => {
        if (agents.length === 0) return;
        if (selectedAgentId && agents.some((agent) => agent.id === selectedAgentId)) return;

        const defaultAgentId = findDefaultCodexAgentId(agents);
        if (defaultAgentId) {
            setSelectedAgentId(defaultAgentId);
        }
    }, [agents, selectedAgentId, setSelectedAgentId]);

    useEffect(() => {
        if (!selectedWorkspaceId) return;
        const projectionsById = useAgentRunProjectionStore.getState().projectionsById;
        for (const nodeId of workspaceProjectionIds) {
            const projection = projectionsById[nodeId];
            if (!projection) continue;
            if (projection.workspaceId !== selectedWorkspaceId) continue;
            const persisted = persistedMessages.find((message: Message) => message.id === nodeId);
            if (!persisted) continue;
            if (!persisted.status || !TERMINAL_STATUSES.includes(persisted.status as TerminalStatus)) continue;
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
            if (streamHandlerMapRef.current.has(message.id)) continue;
            void startStreamForNode(message, {
                waitForReady: false,
                parentId: message.parentId ?? null,
            }).catch((error) => {
                console.warn('[ChatInput] Failed to hydrate active native run stream:', {
                    nodeId: message.id,
                    error,
                });
            });
        }
    }, [isInProgressStatus, persistedMessages, selectedWorkspaceId, startStreamForNode]);

    const uploadFile = useCallback(async (attachmentId: string, file: File) => {
        sendFlowDebug('Upload starting', { filename: file.name, attachmentId });
        try {
            setAttachments((prev: Attachment[]) => prev.map((att: Attachment) => getAttachmentId(att) === attachmentId ? { ...att, status: 'uploading' } as FileAttachment : att));

            const signedUrlResponse = await api.post<{ signedUrl: string; path: string; publicUrl: string | null }>(
                '/attachments/signed-url',
                { filename: file.name, contentType: file.type }
            );
            const { signedUrl, path, publicUrl } = signedUrlResponse.data;
            if (!signedUrl || !path) throw new Error('Missing signed URL or path from backend response.');

            const uploadResponse = await fetch(signedUrl, {
                method: 'PUT',
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file,
            });
            if (!uploadResponse.ok) {
                let errorBody = `Upload failed with status ${uploadResponse.status}`;
                try { const responseJson = await uploadResponse.json(); errorBody = `Upload failed: ${responseJson.message || responseJson.error || uploadResponse.statusText}`; } catch { /* ignore */ }
                throw new Error(errorBody);
            }
            sendFlowDebug('Upload success', { filename: file.name, path });
            setAttachments((prev: Attachment[]) => prev.map((att: Attachment) => {
                if (getAttachmentId(att) === attachmentId && 'file' in att) {
                    return { ...att, status: 'uploaded', path: path, publicUrl: publicUrl };
                }
                return att;
            }));
        } catch (error: unknown) {
            console.error(`[Upload] Failed for ${file.name}:`, error);
            const errorMessage = error instanceof Error ? error.message : 'Upload failed';
            setAttachments((prev: Attachment[]) => prev.map((att: Attachment) => getAttachmentId(att) === attachmentId ? { ...att, status: 'error', error: errorMessage } as FileAttachment : att));
        }
    }, []);

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
                setPrompt(text);
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
    }, []);

    useEffect(() => {
        const handleEditUserMessage = (event: CustomEvent<{ message?: Message }>) => {
            const sourceMessage = event.detail?.message;
            if (!sourceMessage || sourceMessage.role !== 'user') return;
            if (sourceMessage.workspaceId !== selectedWorkspaceId) return;

            setEditDraftSource(sourceMessage);
            setPrompt(sourceMessage.content || '');
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
    }, [dispatchFocus, selectedWorkspaceId]);


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

    const repoMentionPathSet = useMemo(
        () => new Set(extractRepoMentionPaths(prompt).filter((path) => repoMentionFiles.some((file) => file.path === path))),
        [prompt, repoMentionFiles]
    );
    const rankRepoMentionFile = useCallback((query: string, file: RepoMentionFile): number | null => {
        const normalizedQuery = query.trim().toLowerCase();
        const collapsedQuery = collapseFuzzyText(normalizedQuery);
        if (!collapsedQuery) return 0;

        const normalizedPath = file.path.toLowerCase();
        const normalizedName = file.name.toLowerCase();
        const collapsedPath = collapseFuzzyText(normalizedPath);
        const collapsedName = collapseFuzzyText(normalizedName);
        const pathSegments = normalizedPath
            .split('/')
            .map((segment) => collapseFuzzyText(segment))
            .filter(Boolean);
        const basenameTokens = normalizedName
            .split(/[^a-z0-9]+/)
            .map((segment) => collapseFuzzyText(segment))
            .filter(Boolean);

        const candidateScores = [
            getFuzzyMatchScore(normalizedQuery, normalizedName),
            getFuzzyMatchScore(normalizedQuery, normalizedPath),
            getFuzzyMatchScore(collapsedQuery, collapsedName),
            getFuzzyMatchScore(collapsedQuery, collapsedPath),
        ].filter((score): score is number => score !== null);

        if (candidateScores.length === 0) return null;

        let score = Math.min(...candidateScores.map((value, index) => {
            if (index === 0) return value - 40;
            if (index === 2) return value - 25;
            if (index === 3) return value - 10;
            return value;
        }));

        if (normalizedName.startsWith(normalizedQuery) || collapsedName.startsWith(collapsedQuery)) {
            score -= 60;
        }
        if (pathSegments.some((segment) => segment.startsWith(collapsedQuery))) {
            score -= 35;
        }
        if (basenameTokens.some((token) => token.startsWith(collapsedQuery))) {
            score -= 45;
        }

        for (let splitIndex = 2; splitIndex <= collapsedQuery.length - 2; splitIndex += 1) {
            const left = collapsedQuery.slice(0, splitIndex);
            const right = collapsedQuery.slice(splitIndex);
            if (
                pathSegments.some((segment) => segment.startsWith(left)) &&
                basenameTokens.some((token) => token.startsWith(right))
            ) {
                score -= 80;
                break;
            }
        }

        return score;
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadRepoFiles = async () => {
            if (!selectedWorkspaceRepoPath) {
                setRepoMentionFiles([]);
                setRepoMentionCommit(null);
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
                        setRepoMentionCommit(null);
                    }
                    return;
                }

                const repoPaths = await agentClient.listFilesAtCommit(selectedWorkspaceRepoPath, commit);
                if (cancelled) return;

                setRepoMentionCommit(commit);
                setRepoMentionFiles(repoPaths.map((path) => ({
                    path,
                    name: path.split('/').pop() || path,
                })));
            } catch (error) {
                if (cancelled) return;
                console.warn('[ChatInput] Failed to load repo mention files:', error);
                setRepoMentionFiles([]);
                setRepoMentionCommit(null);
            }
        };

        void loadRepoFiles();

        return () => {
            cancelled = true;
        };
    }, [selectedWorkspace?.base_commit_sha, selectedWorkspaceRepoPath]);

    const activeMentionFiles = useMemo(() => {
        if (!activeFileMention) return [];

        const query = activeFileMention.query.trim();
        const matches = query
            ? repoMentionFiles
                .map((file) => {
                    const score = rankRepoMentionFile(query, file);
                    return score === null ? null : { file, score };
                })
                .filter((entry): entry is { file: RepoMentionFile; score: number } => entry !== null)
                .sort((left, right) => left.score - right.score || left.file.path.localeCompare(right.file.path))
                .map((entry) => entry.file)
            : [...repoMentionFiles].sort((left, right) => (
                left.path.localeCompare(right.path)
            ));

        return matches.slice(0, 8);
    }, [activeFileMention, rankRepoMentionFile, repoMentionFiles]);

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
        setSelectedAgentId(agentId);
        setIsAgentPickerOpen(false);
        setTimeout(() => textareaRef.current?.focus(), 0);
    };

    const handleFileMentionSelect = useCallback((file: RepoMentionFile) => {
        if (!activeFileMention) {
            return;
        }

        const mentionLabel = file.path;
        const nextPrompt = `${prompt.slice(0, activeFileMention.start)}@${mentionLabel} ${prompt.slice(activeFileMention.end)}`;
        const nextCursor = activeFileMention.start + mentionLabel.length + 2;

        setPrompt(nextPrompt);
        setActiveFileMention(null);

        window.setTimeout(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
        }, 80);
    }, [activeFileMention, prompt]);

    const handlePromptSelectionChange = useCallback((event: React.SyntheticEvent<HTMLTextAreaElement>) => {
        syncActiveFileMention(event.currentTarget.value, event.currentTarget.selectionStart);
    }, [syncActiveFileMention]);

    const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newPrompt = e.target.value;
        setPrompt(newPrompt);

        const nextMention = selectedWorkspaceId
            ? getActiveFileMention(newPrompt, e.target.selectionStart ?? newPrompt.length)
            : null;
        setActiveFileMention(nextMention);

        if (nextMention) {
            setIsCommandPopoverOpen(false);
        } else if (newPrompt.endsWith('/')) {
            setIsCommandPopoverOpen(true);
        } else if (isCommandPopoverOpen && !newPrompt.includes('/')) {
            setIsCommandPopoverOpen(false);
        }
    };

    const expandRepoMentionContext = useCallback(async (rawPrompt: string) => {
        if (!selectedWorkspaceRepoPath || !repoMentionCommit) return rawPrompt;

        const mentionedPaths = Array.from(
            new Set(
                extractRepoMentionPaths(rawPrompt).filter((path) => repoMentionFiles.some((file) => file.path === path))
            )
        );

        if (mentionedPaths.length === 0) return rawPrompt;

        const limitedPaths = mentionedPaths.slice(0, 8);
        const fileBlocks = await Promise.all(limitedPaths.map(async (filePath) => {
            const content = await agentClient.showFileAtCommit(selectedWorkspaceRepoPath, repoMentionCommit, filePath);
            return `Path: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
        }));

        return `${rawPrompt}\n\n[REPO FILE CONTEXT]\n${fileBlocks.join('\n\n')}`.trim();
    }, [repoMentionCommit, repoMentionFiles, selectedWorkspaceRepoPath]);

    const resolveWorkspaceWorkspace = useCallback(async () => {
        const attachedRepoPath = selectedWorkspace?.git_repo_path?.trim() || null;
        const fallbackFolderPath = selectedWorkspace?.folderPath?.trim() || null;
        const workspaceBaseCommit = selectedWorkspace?.base_commit_sha?.trim() || null;

        if (attachedRepoPath) {
            return {
                repoPath: attachedRepoPath,
                baseCommitSha: workspaceBaseCommit,
            };
        }

        if (!fallbackFolderPath) {
            throw new Error('No project repository is attached to this workspace.');
        }

        const workspace = await agentClient.attachWorkspace(fallbackFolderPath);
        if (workspace.needs_git_init) {
            throw new Error('This workspace is attached to a folder that is not a Git repository. Reattach a Git repo before sending.');
        }

        const resolvedBaseCommit = workspaceBaseCommit || workspace.base_commit || null;
        if (!resolvedBaseCommit) {
            throw new Error('Workspace is missing a base commit. Reattach the repository.');
        }

        return {
            repoPath: workspace.repo_path,
            baseCommitSha: resolvedBaseCommit,
        };
    }, [selectedWorkspace?.base_commit_sha, selectedWorkspace?.folderPath, selectedWorkspace?.git_repo_path]);

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
        const hasLocalAgentRuntime = agentClient.hasRuntime();
        sendFlowDebug('handleSend invoked', {
            selectedWorkspaceId,
            focusedMessageId,
            selectedAgentId,
            promptLength: prompt.trim().length,
            attachmentCount: attachments.length,
            contextEntryCount: contextIds.length,
            isParentIncomplete,
            hasLocalAgentRuntime,
        });
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
        if (!prompt.trim() && attachments.length === 0 && contextIds.length === 0) return;

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
        if (!selectedAgentId || !selectedAgent) {
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
                prompt,
                attachments: [...attachments],
                contextIds: [...contextIds],
                editDraftSource,
                parentMessageId: resolvePersistedMessageId(replyParentMessageId) ?? replyParentMessageId ?? null,
                queuedAt: Date.now(),
            };
            queuedComposerSendsRef.current.push(queuedSend);
            setQueuedComposerSendCount(queuedComposerSendsRef.current.length);
            setPrompt('');
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
        const runtimeReadinessPromise = hasLocalAgentRuntime && (selectedAgent.type === 'codex' || selectedAgent.type === 'claude')
            ? withTimeout(
                Promise.resolve().then(() => agentClient.checkRuntimeReadiness(selectedAgent.type)),
                2000,
                'Agent runtime readiness check timed out.'
            )
            : null;

        // --- 2. PREPARE DATA ---
        const structuredAttachments: AttachmentMetadata[] = attachments
            .map((att: Attachment) => {
                if ('file' in att && att.status === 'uploaded' && att.path) {
                    return {
                        path: att.path,
                        publicUrl: att.publicUrl || null,
                        filename: att.file.name,
                        contentType: att.file.type,
                    };
                }
                if ('path' in att && 'filename' in att) {
                    return {
                        path: att.path,
                        publicUrl: att.publicUrl || null,
                        filename: att.filename,
                        contentType: att.contentType,
                    };
                }
                return null;
            })
            .filter((att: AttachmentMetadata | null): att is AttachmentMetadata => !!att);

        const shouldUseAgent = true;
        sendFlowDebug('validation complete', {
            hasLocalAgentRuntime,
            selectedAgentType: selectedAgent?.type ?? null,
        });
        const selectedAgentModelId =
            (selectedAgent as any)?.model_config?.model ||
            parseCliArgs(selectedAgent?.cliArgs).model ||
            null;

        const savedEditDraftSource = editDraftSource;
        const rawSendParentMessageId = replyParentMessageId;
        const sendParentMessageId = resolvePersistedMessageId(rawSendParentMessageId);
        const resolvedParentMessage = sendParentMessageId ? messageById.get(sendParentMessageId) ?? null : null;

        const effectiveScopeMode = effectiveScopeModeForReply;
        const trimmedNewScopeName = newScopeName.trim();
        const effectiveNewScopeName = effectiveScopeMode === 'new'
            ? (trimmedNewScopeName && !isAutoScopeName(trimmedNewScopeName) ? trimmedNewScopeName : null)
            : null;
        const effectiveContextMode: ContextMode = contextPolicy === 'fresh' ? 'none' : contextMode;
        const sendContextParentId = resolvePersistedMessageId(effectiveContextParentId || null);
        const sendContextStartId = resolvePersistedMessageId(effectiveContextStartId || null);
        const sendScopeParentId = effectiveScopeMode === 'inherit'
            ? sendParentMessageId
            : null;

        // --- 3. CREATE OPTIMISTIC MESSAGES (IMMEDIATE UI UPDATE) ---
        const parentPathIds = resolvedParentMessage?.path_ids || [];
        const parentDepth = resolvedParentMessage?.depth ?? -1;
        const parentScopeId = resolvedParentMessage?.scope_id || branchParentScopeId;

        // New scopes do not have a persisted ID until the server creates them.
        const replyScopeId = effectiveScopeMode === 'new'
            ? null
            : (effectiveScopeIdForReply || parentScopeId || null);

        const optimisticPair = createOptimisticNodePair(
            {
                id: hasLocalAgentRuntime ? crypto.randomUUID() : undefined,
                workspaceId: selectedWorkspaceId!,
                parentId: sendParentMessageId,
                content: prompt.trim(),
                attachments: structuredAttachments,
                scopeId: replyScopeId,
                pathIds: parentPathIds,
                depth: parentDepth + 1,
                role: 'user',
            },
            {
                id: hasLocalAgentRuntime ? crypto.randomUUID() : undefined,
                llmModel: selectedAgentModelId,
                llmProvider: selectedAgent?.type || null,
                agentId: selectedAgentId || null,
                status: 'pending',
            }
        );
        sendFlowDebug('optimistic pair created', {
            userMessageId: optimisticPair.userMessageId,
            assistantMessageId: optimisticPair.assistantMessageId ?? null,
        });

        const operationKey = optimisticPair.assistantMessageId || optimisticPair.userMessageId;
        const flowId = createSendFlowId();
        sendAcceptanceInFlightRef.current = true;
        setIsSendAcceptanceInFlight(true);
        assignSendFlowKey(operationKey, flowId);
        assignSendFlowKey(optimisticPair.userMessageId, flowId);
        if (optimisticPair.assistantMessageId) {
            assignSendFlowKey(optimisticPair.assistantMessageId, flowId);
        }
        const savedPrompt = prompt;
        const savedAttachments = [...attachments];
        const savedContextIds = [...contextIds];
        const shouldAutoCheckout = autoCheckoutOnAgentCommit;
        const focusStateAtSendStart = useWorkspaceStore.getState();
        const optimisticNodeIds = [
            optimisticPair.userMessageId,
            ...(optimisticPair.assistantMessageId ? [optimisticPair.assistantMessageId] : []),
        ];
        const sendFlowFocusGuardIds = [
            focusStateAtSendStart.focusedMessageId,
            sendParentMessageId,
            ...optimisticNodeIds,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0);
        const controller = new AbortController();
        const releaseSendAcceptance = (reason: string) => {
            if (!sendAcceptanceInFlightRef.current) return;
            sendAcceptanceInFlightRef.current = false;
            setIsSendAcceptanceInFlight(false);
            recordSendFlowEvent('queue.acceptance-released', {
                flowId,
                workspaceId: selectedWorkspaceId,
                operationKey,
                reason,
                queueDepth: queuedComposerSendsRef.current.length,
            }, { source: 'ChatInput' });
        };

        if (contextPolicy === 'fresh' || sendContextParentId) {
            optimisticPair.userMessage.execution_data = {
                meta: {
                    context_policy: contextPolicy,
                    context_boundary_from_node_id: contextPolicy === 'fresh' ? sendParentMessageId : null,
                    context_parent_node_id: contextPolicy === 'fresh' ? null : sendContextParentId,
                    context_base_node_id: sendParentMessageId,
                },
                context_profile: {
                    context_parent_node_id: contextPolicy === 'fresh' ? null : sendContextParentId,
                    base_node_id: sendParentMessageId,
                    inherited_from_node_id: contextPolicy === 'fresh' ? null : sendParentMessageId,
                },
            };
            if (optimisticPair.assistantMessage) {
                optimisticPair.assistantMessage.execution_data = {
                    ...(optimisticPair.assistantMessage.execution_data || {}),
                    meta: {
                        ...(((optimisticPair.assistantMessage.execution_data as any)?.meta) || {}),
                        context_policy: contextPolicy,
                        context_boundary_from_node_id: contextPolicy === 'fresh' ? sendParentMessageId : null,
                        context_parent_node_id: contextPolicy === 'fresh' ? null : sendContextParentId,
                        context_base_node_id: sendParentMessageId,
                    },
                    context_profile: {
                        context_parent_node_id: contextPolicy === 'fresh' ? null : sendContextParentId,
                        base_node_id: sendParentMessageId,
                        inherited_from_node_id: contextPolicy === 'fresh' ? null : optimisticPair.userMessageId,
                    },
                };
            }
        }
        if (optimisticPair.assistantMessage) {
            optimisticPair.assistantMessage.base_commit_sha = effectiveBaseCommitSha || null;
            optimisticPair.assistantMessage.base_selected_from_node_id = selectedBaseCommit?.produced_by_node_id || null;
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
        setActiveComposerSend({ flowId, nodeIds: optimisticNodeIds });
        seedAgentRunProjection(optimisticPair.userMessageId, optimisticPair.userMessage);
        if (optimisticPair.assistantMessage) {
            seedAgentRunProjection(optimisticPair.assistantMessageId!, optimisticPair.assistantMessage);
        }
        if (shouldUseAgent && optimisticPair.assistantMessageId) {
            setNodeStatus(optimisticPair.assistantMessageId, 'initializing');
            setSetupProgress(optimisticPair.assistantMessageId, 'Initializing agent...');
        }
        setPrompt('');
        setAttachments([]);
        setContextIds([]);
        setEditDraftSource(null);
        dispatchSendFlowFocus({
            flowId,
            messageId: optimisticPair.userMessageId,
            phase: 'optimistic-user',
            allowedCurrentFocusIds: [focusStateAtSendStart.focusedMessageId, sendParentMessageId],
        });
        setCurrentAbortController(controller);
        track('Agent Message Submitted', {
            workspace_id: selectedWorkspaceId,
            agent_id: selectedAgentId,
            agent_provider: selectedAgent?.type ?? null,
            agent_model: selectedAgentModelId,
            prompt_chars: savedPrompt.trim().length,
            attachment_count: savedAttachments.length,
            context_entry_count: savedContextIds.length,
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
            optimisticAssistantMessageId: optimisticPair.assistantMessageId || null,
        }, { source: 'ChatInput' });
        sendFlowDebug('optimistic pair stored');

        recordSendFlowEvent('optimistic.user-created', {
            flowId,
            workspaceId: selectedWorkspaceId,
            messageId: optimisticPair.userMessageId,
            parentId: sendParentMessageId,
        }, { source: 'ChatInput' });
        if (optimisticPair.assistantMessageId) {
            recordSendFlowEvent('optimistic.assistant-created', {
                flowId,
                workspaceId: selectedWorkspaceId,
                messageId: optimisticPair.assistantMessageId,
                parentId: optimisticPair.userMessageId,
            }, { source: 'ChatInput' });
        }
        const cleanupOptimisticPair = (delayMs: number, finalStatus: string) => {
            window.setTimeout(() => {
                removeOptimisticNode(optimisticPair.userMessageId);
                releaseSendFlowKey(optimisticPair.userMessageId);
                if (optimisticPair.assistantMessageId) {
                    removeOptimisticNode(optimisticPair.assistantMessageId);
                    releaseSendFlowKey(optimisticPair.assistantMessageId);
                }
                releaseSendFlowKey(operationKey);
                recordSendFlowEvent('cleanup.finished', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    nodeId: optimisticPair.assistantMessageId || optimisticPair.userMessageId,
                    finalStatus,
                }, { source: 'ChatInput' });
            }, delayMs);
        };

        // Track this operation
        agentSetupControllersRef.current.set(operationKey, controller);
        recordLatencyMark(operationKey, 'send_clicked', {
            source: 'frontend',
            detail: {
                agentType: selectedAgent?.type || null,
                workspaceId: selectedWorkspaceId,
            },
        });

        try {
            // Let the browser paint the optimistic message and cancel affordance
            // before starting readiness/API work on the same click.
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            if (controller.signal.aborted) {
                throw Object.assign(new Error('Request was cancelled'), { name: 'CanceledError' });
            }

            if (runtimeReadinessPromise) {
                try {
                    const readiness = await runtimeReadinessPromise;
                    if (readiness.status !== 'ready') {
                        console.warn('[SEND_FLOW] BLOCKED at readiness guard (not ready)');
                        const label = selectedAgent.type === 'codex' ? 'Codex' : 'Claude Code';
                        addToast({
                            title: readiness.status === 'keychain_unavailable' ? `${label} login unavailable to Agentree` : `${label} setup required`,
                            description: readiness.recommendedCommand
                                ? `${readiness.message} Run: ${readiness.recommendedCommand}`
                                : readiness.message,
                            variant: 'error',
                            persistent: true,
                        });
                        markNodeFailed(optimisticPair.userMessageId, readiness.message);
                        if (optimisticPair.assistantMessageId) {
                            markNodeFailed(optimisticPair.assistantMessageId, readiness.message);
                        }
                        recordSendFlowEvent('lifecycle.failed', {
                            flowId,
                            workspaceId: selectedWorkspaceId,
                            operationKey,
                            errorType: 'RUNTIME_NOT_READY',
                            errorMessage: readiness.message,
                        }, { source: 'ChatInput' });
                        endSendFlowFocus(flowId);
                        commitFocusHandledByFlowRef.current.delete(flowId);
                        latencyTraceRef.current.delete(operationKey);
                        cleanupOptimisticPair(3000, 'runtime-not-ready');
                        return;
                    }
                } catch (error) {
                    if (!agentClient.hasRuntime()) {
                        console.warn('[SEND_FLOW] Skipping local runtime readiness check in browser preview:', error);
                    } else if (error instanceof Error && error.message.includes('readiness check timed out')) {
                        console.warn('[SEND_FLOW] Runtime readiness check timed out; continuing with send:', error);
                    } else {
                        addToast({
                            title: 'Agent setup check failed',
                            description: error instanceof Error ? error.message : `Agentree could not verify ${selectedAgent.type} before sending.`,
                            variant: 'error',
                        });
                        const errorMessage = error instanceof Error ? error.message : 'Agent setup check failed';
                        markNodeFailed(optimisticPair.userMessageId, errorMessage);
                        if (optimisticPair.assistantMessageId) {
                            markNodeFailed(optimisticPair.assistantMessageId, errorMessage);
                        }
                        recordSendFlowEvent('lifecycle.failed', {
                            flowId,
                            workspaceId: selectedWorkspaceId,
                            operationKey,
                            errorType: 'RUNTIME_READINESS_FAILED',
                            errorMessage,
                        }, { source: 'ChatInput' });
                        endSendFlowFocus(flowId);
                        commitFocusHandledByFlowRef.current.delete(flowId);
                        latencyTraceRef.current.delete(operationKey);
                        cleanupOptimisticPair(3000, 'runtime-readiness-failed');
                        return;
                    }
                }
            }

            if (hasLocalAgentRuntime && optimisticPair.assistantMessage) {
                sendFlowDebug('Persisting local-first message pair');
                setSetupProgress(optimisticPair.userMessageId, 'Starting locally...');
                await Promise.all([
                    agentClient.upsertLocalNode(selectedWorkspaceId!, optimisticPair.userMessageId, optimisticPair.userMessage),
                    agentClient.upsertLocalNode(selectedWorkspaceId!, optimisticPair.assistantMessageId!, optimisticPair.assistantMessage),
                ]);
                queryClient.setQueryData<Message[]>(['messages', selectedWorkspaceId], (current) => {
                    const existing = current ?? [];
                    const ids = new Set([optimisticPair.userMessageId, optimisticPair.assistantMessageId!]);
                    return [
                        ...existing.filter((message) => !ids.has(message.id)),
                        optimisticPair.userMessage as Message,
                        optimisticPair.assistantMessage as Message,
                    ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
                });
                void queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(selectedWorkspaceId!) });
                recordSendFlowEvent('local-first.persisted', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    userMessageId: optimisticPair.userMessageId,
                    assistantMessageId: optimisticPair.assistantMessageId,
                }, { source: 'ChatInput' });
                releaseSendAcceptance('local-first-persisted');

                const token = await getAccessToken();
                attachLatencyTraceToNode(operationKey, optimisticPair.assistantMessageId!, token);
                recordLatencyMark(optimisticPair.assistantMessageId!, 'assistant_node_created', {
                    authToken: token,
                    nodeId: optimisticPair.assistantMessageId!,
                    detail: { local_first: true },
                });
                dispatchSendFlowFocus({
                    flowId,
                    messageId: optimisticPair.assistantMessageId!,
                    phase: 'real-assistant',
                    allowedCurrentFocusIds: [
                        optimisticPair.userMessageId,
                        optimisticPair.assistantMessageId,
                        sendParentMessageId,
                    ],
                });
                advanceSendFlowFocus({
                    flowId,
                    preferredMessageId: optimisticPair.assistantMessageId!,
                    addGuardedMessageIds: [optimisticPair.userMessageId, optimisticPair.assistantMessageId!],
                    phase: 'real-assistant',
                });
                startStreamForNode(optimisticPair.assistantMessage as Message, {
                    waitForReady: false,
                    authToken: token,
                    parentId: optimisticPair.userMessageId,
                }).catch(err => {
                    console.warn('[SEND_FLOW] Streaming error:', err);
                });

                if (selectedAgentId && selectedAgent) {
                    let expandedPromptForAgent = savedPrompt.trim();
                    try {
                        expandedPromptForAgent = await expandRepoMentionContext(savedPrompt.trim());
                    } catch (error) {
                        console.warn('[ChatInput] Failed to expand repo mention context:', error);
                    }
                    if (shouldAutoCheckout) {
                        autoCheckoutPendingRef.current.add(optimisticPair.assistantMessageId!);
                    }
                    runAgentSetupInBackground({
                        nodeId: optimisticPair.assistantMessageId!,
                        assistantMsg: optimisticPair.assistantMessage as Message,
                        prompt: expandedPromptForAgent,
                        authToken: token,
                        autoCheckout: shouldAutoCheckout,
                        scopeMode: effectiveScopeMode,
                        contextPolicy,
                        parentMessageId: optimisticPair.userMessageId,
                        baseMessageId: sendParentMessageId,
                        contextParentMessageId: sendContextParentId,
                        contextStartMessageId: sendContextStartId,
                    }).catch(err => {
                        console.error('[SEND_FLOW] Background agent setup error:', err);
                    });
                }
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
                scopeParentId: sendScopeParentId,
            }, { source: 'ChatInput' });

            const response = await sendMessageMutation.mutateAsync({
                workspaceId: selectedWorkspaceId!,
                prompt: savedPrompt.trim(),
                parentId: sendParentMessageId,
                attachments: structuredAttachments,
                contextIds: savedContextIds,
                contextMode: effectiveContextMode,
                contextPolicy,
                useAgent: true,
                agentId: selectedAgentId,
                agentProvider: selectedAgent?.type || null,
                agentModel: selectedAgentModelId,
                activeScopeId: activeScopeId || null,
                scopeId: effectiveScopeMode === 'existing' ? effectiveScopeIdForReply : null,
                scopeMode: effectiveScopeMode,
                contextParentId: sendContextParentId,
                scopeParentId: sendScopeParentId,
                newScopeName: effectiveNewScopeName,
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

                const token = await getAccessToken();
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
                    onSendComplete?.();
                    return;
                }
                startStreamForNode(realAssistant, {
                    waitForReady: false,
                    authToken: token,
                    parentId: response.userMessage!.id,
                }).catch(err => {
                    console.warn('[SEND_FLOW] Streaming error:', err);
                });

                // --- 7. PARALLEL AGENT SETUP (if applicable) ---
                if (selectedAgentId && selectedAgent && realAssistantId) {
                    let expandedPromptForAgent = savedPrompt.trim();
                    try {
                        expandedPromptForAgent = await expandRepoMentionContext(savedPrompt.trim());
                    } catch (error) {
                        console.warn('[ChatInput] Failed to expand repo mention context:', error);
                    }
                    if (shouldAutoCheckout) {
                        autoCheckoutPendingRef.current.add(realAssistantId);
                    }
                    // Run agent setup in parallel (don't block UI)
                    runAgentSetupInBackground({
                        nodeId: realAssistantId,
                        assistantMsg: realAssistant,
                        prompt: expandedPromptForAgent,
                        authToken: token,
                        autoCheckout: shouldAutoCheckout,
                        scopeMode: effectiveScopeMode,
                        contextPolicy,
                        parentMessageId: response.userMessage!.id,
                        baseMessageId: sendParentMessageId,
                        contextParentMessageId: sendContextParentId,
                        contextStartMessageId: sendContextStartId,
                    }).catch(err => {
                        console.error('[SEND_FLOW] Background agent setup error:', err);
                    });
                }
            }

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
            if (optimisticPair.assistantMessageId) {
                markNodeFailed(optimisticPair.assistantMessageId, formatErrorMessage(categorizedError));
            }

            // Handle based on error type
            if (categorizedError.type === 'CANCELLED') {
                // User cancelled - remove immediately
                removeOptimisticNode(optimisticPair.userMessageId);
                if (optimisticPair.assistantMessageId) {
                    removeOptimisticNode(optimisticPair.assistantMessageId);
                }
                recordSendFlowEvent('cleanup.finished', {
                    flowId,
                    workspaceId: selectedWorkspaceId,
                    nodeId: optimisticPair.assistantMessageId || optimisticPair.userMessageId,
                    finalStatus: 'cancelled',
                }, { source: 'ChatInput' });
                releaseSendFlowKey(optimisticPair.userMessageId);
                if (optimisticPair.assistantMessageId) {
                    releaseSendFlowKey(optimisticPair.assistantMessageId);
                }
            } else if (categorizedError.type === 'CONFLICT_ERROR') {
                // 409 - parent still running
                addToast({
                    title: 'Parent still running',
                    description: categorizedError.message,
                    variant: 'error',
                });
                // Remove optimistic nodes after showing error
                setTimeout(() => {
                    removeOptimisticNode(optimisticPair.userMessageId);
                    if (optimisticPair.assistantMessageId) {
                        removeOptimisticNode(optimisticPair.assistantMessageId);
                    }
                    recordSendFlowEvent('cleanup.finished', {
                        flowId,
                        workspaceId: selectedWorkspaceId,
                        nodeId: optimisticPair.assistantMessageId || optimisticPair.userMessageId,
                        finalStatus: 'conflict-error',
                    }, { source: 'ChatInput' });
                    releaseSendFlowKey(optimisticPair.userMessageId);
                    if (optimisticPair.assistantMessageId) {
                        releaseSendFlowKey(optimisticPair.assistantMessageId);
                    }
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
                    removeOptimisticNode(optimisticPair.userMessageId);
                    if (optimisticPair.assistantMessageId) {
                        removeOptimisticNode(optimisticPair.assistantMessageId);
                    }
                    recordSendFlowEvent('cleanup.finished', {
                        flowId,
                        workspaceId: selectedWorkspaceId,
                        nodeId: optimisticPair.assistantMessageId || optimisticPair.userMessageId,
                        finalStatus: categorizedError.type,
                    }, { source: 'ChatInput' });
                    releaseSendFlowKey(optimisticPair.userMessageId);
                    if (optimisticPair.assistantMessageId) {
                        releaseSendFlowKey(optimisticPair.assistantMessageId);
                    }
                }, 5000);
            }

            // Restore input on error
            setPrompt(savedPrompt);
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
            console.error('[SEND_FLOW] Uncaught error in handleSend:', sendError);
            addToast({
                title: 'Send Error',
                description: sendError instanceof Error ? sendError.message : 'An unexpected error occurred while sending.',
                variant: 'error',
            });
        }
    }, [
        attachments,
        prompt,
        sendMessageMutation,
        parentMessageId,
        editDraftSource,
        contextIds,
        autoCheckoutOnAgentCommit,
        selectedWorkspaceId,
        selectedWorkspace,
        activeScopeId,
        branchParentScopeId,
        effectiveContextParentId,
        effectiveContextStartId,
        effectiveScopeIdForReply,
        effectiveScopeModeForReply,
        selectedScopeIdOverride,
        contextPolicy,
        newScopeName,
        nextUntitledScopeName,
        branchParentMessage,
        effectiveBaseCommitSha,
        selectedBaseCommit,
        selectedAgentId,
        selectedAgent,
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
        applyStreamingAssistantText,
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
        resolveWorkspaceWorkspace,
        expandRepoMentionContext,
        startStreamForNode,
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
        setPrompt(queuedSend.prompt);
        setAttachments(queuedSend.attachments);
        setContextIds(queuedSend.contextIds);
        setEditDraftSource(queuedSend.editDraftSource);
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
    }, [dispatchFocus, isSendAcceptanceInFlight, queuedComposerSendCount, queuedReplayVersion, selectedWorkspaceId]);

    useEffect(() => {
        const queuedSend = queuedReplayPendingSendRef.current;
        if (!queuedSend || isSendAcceptanceInFlight || !queuedReplayInFlightRef.current) {
            return;
        }
        const replayStateReady =
            prompt === queuedSend.prompt &&
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
        prompt,
        queuedReplayVersion,
        selectedWorkspaceId,
    ]);

    /**
     * Run agent setup in background without blocking UI
     */
    interface AgentSetupParams {
        nodeId: string;
        assistantMsg: Message;
        prompt: string;
        authToken: string;
        autoCheckout: boolean;
        scopeMode: string;
        contextPolicy: ContextPolicy;
        parentMessageId: string;
        baseMessageId: string | null;
        contextParentMessageId: string | null;
        contextStartMessageId: string | null;
    }

    const runAgentSetupInBackground = async (params: AgentSetupParams): Promise<void> => {
        const { nodeId, assistantMsg, prompt, authToken, autoCheckout, scopeMode, contextPolicy, baseMessageId, contextParentMessageId, contextStartMessageId } = params;
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
            const { promise: mcpSetupPromise, reused: mcpSetupReused } = ensureMcpSetup(authToken, assistantMsg.workspaceId);
            if (mcpSetupReused) {
                recordSendFlowEvent('agent-setup.mcp-setup.reused', {
                    flowId: getSendFlowIdForKey(nodeId),
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

            const { repoPath } = await resolveWorkspaceWorkspace();
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

            // Prepare CLI args
            const cliArgsStr = selectedAgent?.cliArgs || '--permission-mode plan';
            let cliArgs = cliArgsStr.split(/\s+/).filter(arg => arg.length > 0);
            let agentSessionId: string | null = null;
            const parsedCliArgs = parseCliArgs(cliArgsStr);
            const resolvedRunMode = parsedCliArgs.permissionMode === 'plan' ? 'plan' : 'default';
            const resolvedModel = (selectedAgent as any)?.model_config?.model || parsedCliArgs.model || null;
            if (selectedAgent?.type === 'claude') {
                agentSessionId = crypto.randomUUID();
                const cleaned: string[] = [];
                for (let i = 0; i < cliArgs.length; i++) {
                    const arg = cliArgs[i];
                    if (arg === '--permission-mode') {
                        const mode = cliArgs[i + 1];
                        if (mode === 'plan') {
                            cleaned.push(arg, 'auto');
                            i += 1;
                            continue;
                        }
                    }
                    if (arg === '--output-format' || arg === '--session-id') {
                        i += 1;
                        continue;
                    }
                    if (arg === '-p' || arg === '--print' || arg === '--verbose' || arg === '--no-session-persistence') {
                        continue;
                    }
                    cleaned.push(arg);
                }
                cliArgs = cleaned;
                if (!cliArgs.includes('--permission-mode')) {
                    cliArgs.push('--permission-mode', 'auto');
                }
                if (!cliArgs.includes('--mcp-config')) {
                    const mcpConfig = JSON.stringify({
                        mcpServers: {
                            agentree: {
                                type: 'http',
                                url: 'http://127.0.0.1:61337/mcp',
                            },
                        },
                    });
                    cliArgs.push('--mcp-config', mcpConfig, '--strict-mcp-config');
                }
                cliArgs.push('--session-id', agentSessionId);
                cliArgs.push('--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence');
            }

            const promptFlag = selectedAgent?.type === 'codex' ? null : selectedAgent?.promptFlag;
            const providerParentMessage = contextParentMessage;
            const parentExecutionMeta = (providerParentMessage?.execution_data as any)?.meta || {};
            const selectedProvider = selectedAgent?.type === 'claude' || selectedAgent?.type === 'codex'
                ? selectedAgent.type as RuntimeProvider
                : null;
            const parentHasChildren = hasConversationChild(providerParentMessage?.id ?? baseMessageId, messageLookupMessages, messageById);
            const isBranchFromInterior = !!parentHasChildren;
            const providerContinuation = selectedProvider
                ? resolveProviderContinuation({
                    selectedProvider,
                    parentMeta: parentExecutionMeta,
                    isBranchFromInterior,
                })
                : null;
            const hasPotentialAgentreeContext = contextPolicy !== 'fresh' && Boolean(providerParentMessage?.id);
            const providerRouting = resolveProviderContextRouting({
                continuation: providerContinuation,
                scopeMode,
                contextMode: contextPolicy === 'fresh' ? 'none' : contextMode,
                contextPolicy,
                hasSelectedAgentreeContext: hasPotentialAgentreeContext,
            });
            const providerThreadStrategy = providerRouting.providerThreadStrategy;
            const providerThreadStrategyRequested = providerRouting.providerThreadStrategyRequested;
            const parentProviderThreadId = providerContinuation?.sourceThreadId ?? null;
            const parentProviderTurnId = providerContinuation?.sourceTurnId ?? null;
            const parentProviderLineageId = providerContinuation?.sourceLineageId ?? null;
            const parentProviderUserTurnCount = providerContinuation?.sourceUserTurnCount ?? null;
            const sourceProviderThreadIdForSpawn = providerThreadStrategy === 'fresh_thread'
                ? null
                : providerContinuation?.sourceThreadId ?? null;
            let selectedComposerContextManifest: ComposerContextManifest = EMPTY_COMPOSER_CONTEXT_MANIFEST;
            const getSelectedComposerContextManifest = () => {
                if (selectedComposerContextManifest !== EMPTY_COMPOSER_CONTEXT_MANIFEST) {
                    return selectedComposerContextManifest;
                }
                if (!providerParentMessage?.id || contextPolicy === 'fresh') {
                    return selectedComposerContextManifest;
                }
                const selection = buildComposerContextSelection(
                    providerParentMessage.id,
                    messageLookupMessages,
                    null,
                    null,
                    'continue',
                    contextStartMessageId
                );
                selectedComposerContextManifest = buildComposerContextManifest(
                    selection.turns,
                    new Set(selection.defaultSelectedIds)
                );
                return selectedComposerContextManifest;
            };
            if (providerRouting.shouldBuildCrossProviderPacket || providerRouting.shouldInjectAgentreeContext) {
                selectedComposerContextManifest = getSelectedComposerContextManifest();
            }
            const explicitAgentreeContext = selectedComposerContextManifest.contextText.trim();
            const shouldInjectAgentreeContext = providerRouting.shouldInjectAgentreeContext && explicitAgentreeContext.length > 0;
            const continuationPacket = providerRouting.shouldBuildCrossProviderPacket && providerContinuation && selectedProvider
                ? buildCrossProviderContinuationPacket({
                    selectedProvider,
                    parentProvider: providerContinuation.parentProvider,
                    parentNodeId: providerParentMessage?.id ?? null,
                    baseNodeId: baseMessageId,
                    gitParentCommit: parentCommit,
                    gitBranchName: plannedBranchName,
                    gitWorktreePath: null,
                    manifest: selectedComposerContextManifest,
                    parentMeta: parentExecutionMeta,
                })
                : null;

            // Prepare prompt with context
            let effectivePrompt = prompt;
            if (providerRouting.promptContextMode === 'cross_provider_packet' && continuationPacket) {
                effectivePrompt = `${continuationPacket.text}\n\n[User Request]\n${prompt}`;
            } else if (providerRouting.promptContextMode === 'agentree_context' && shouldInjectAgentreeContext) {
                effectivePrompt = `Context (selected workspace history):\n${explicitAgentreeContext}\n\nUser:\n${prompt}`;
            }
            effectivePrompt = `${DEPENDENCY_GUARD_INSTRUCTION}\n\n${effectivePrompt}`;

            const providerInternalArgs = (selectedProvider
                ? [
                    '--provider-thread-strategy',
                    providerThreadStrategy,
                    ...((sourceProviderThreadIdForSpawn && providerThreadStrategy === 'resume') ? ['--provider-thread-id', sourceProviderThreadIdForSpawn] : []),
                    ...((sourceProviderThreadIdForSpawn && providerThreadStrategy !== 'resume') ? ['--source-provider-thread-id', sourceProviderThreadIdForSpawn] : []),
                    ...((parentProviderLineageId && providerThreadStrategy !== 'fresh_thread') ? ['--source-provider-lineage-id', parentProviderLineageId] : []),
                    ...((providerThreadStrategy === 'fork_then_rollback' && parentProviderUserTurnCount != null)
                        ? ['--target-provider-user-turn-count', String(parentProviderUserTurnCount)]
                        : []),
                    ...((providerThreadStrategy === 'fork' && parentProviderTurnId)
                        ? ['--target-provider-turn-id', parentProviderTurnId]
                        : []),
                    ...(baseMessageId ? ['--target-node-id', baseMessageId] : []),
                    '--node-id',
                    nodeId,
                ]
                : []);
            const spawnArgs = promptFlag
                ? [...cliArgs, ...providerInternalArgs, promptFlag, effectivePrompt]
                : [...cliArgs, ...providerInternalArgs, effectivePrompt];

            const agentreeContextAvailableChars = explicitAgentreeContext.length;
            const agentreeContextInjectedChars = shouldInjectAgentreeContext
                ? agentreeContextAvailableChars
                : 0;
            const continuationPacketChars = continuationPacket?.text.length ?? 0;
            const sourceProviderLineageIdForSpawn = providerThreadStrategy === 'fresh_thread'
                ? null
                : parentProviderLineageId;
            const sourceProviderTurnIdForSpawn = providerThreadStrategy === 'fresh_thread'
                ? null
                : parentProviderTurnId;

            const traceId = attachLatencyTraceToNode(nodeId, nodeId, authToken);
            trackAgentRunStarted({
                workspace_id: assistantMsg.workspaceId,
                node_id: nodeId,
                agent_id: selectedAgentId,
                agent_provider: selectedAgent?.type ?? null,
                agent_model: resolvedModel,
                provider_thread_strategy: providerThreadStrategyRequested,
                branch_from_interior: isBranchFromInterior,
                auto_checkout_requested: autoCheckout,
                explicit_context_chars: agentreeContextAvailableChars,
                injected_context_chars: agentreeContextInjectedChars,
                provider_context_routing_mode: providerRouting.promptContextMode,
            });
            recordLatencyMark(nodeId, 'spawn_requested', {
                authToken,
                nodeId,
                detail: {
                    explicit_context_chars: agentreeContextAvailableChars,
                    injected_context_chars: agentreeContextInjectedChars,
                    provider_thread_resume_enabled: providerThreadStrategy === 'resume',
                    provider_thread_strategy: providerThreadStrategy,
                    provider_thread_strategy_requested: providerThreadStrategyRequested,
                    provider_cross_provider_fresh_thread: providerRouting.promptContextMode === 'cross_provider_packet',
                    provider_context_routing_mode: providerRouting.promptContextMode,
                    provider_context_routing_reason: providerRouting.reason,
                    parent_provider: providerContinuation?.parentProvider ?? null,
                    selected_provider: selectedProvider,
                    parent_provider_thread_id: parentProviderThreadId,
                    parent_provider_turn_id: parentProviderTurnId,
                    parent_provider_lineage_id: parentProviderLineageId,
                    parent_provider_user_turn_count: parentProviderUserTurnCount,
                    branch_from_interior: isBranchFromInterior,
                },
            });
            const startExecutionData = {
                ...((getAgentRunProjection(nodeId)?.execution_data || {}) as Record<string, any>),
                current_run_id: runId,
                workspace_id: assistantMsg.workspaceId,
                parentId: assistantMsg.parentId ?? null,
                started_at: new Date().toISOString(),
                meta: {
                    ...(((getAgentRunProjection(nodeId)?.execution_data || {}) as any)?.meta || {}),
                    ...(agentSessionId ? {
                        agent_session_id: agentSessionId,
                        agent_session_provider: 'claude',
                    } : {}),
                },
            };
            startExecutionData.meta = {
                ...(startExecutionData.meta || {}),
                git_worktree_path: null,
                git_branch_name: plannedBranchName,
                base_commit_sha: parentCommit,
                auto_checkout_requested: autoCheckout,
                context_cache_experiment: 'context_manifest_v1',
                agentree_context_chars: agentreeContextAvailableChars,
                agentree_context_available_chars: agentreeContextAvailableChars,
                agentree_context_available_estimated_tokens: Math.ceil(agentreeContextAvailableChars / 4),
                agentree_context_estimated_tokens: Math.ceil(agentreeContextAvailableChars / 4),
                agentree_context_injected_chars: agentreeContextInjectedChars,
                agentree_context_injected_estimated_tokens: Math.ceil(agentreeContextInjectedChars / 4),
                agentree_context_injected: shouldInjectAgentreeContext,
                agentree_context_manifest_version: selectedComposerContextManifest.version,
                agentree_context_manifest_hash: selectedComposerContextManifest.manifestHash,
                agentree_context_stable_prefix_hash: selectedComposerContextManifest.stablePrefixHash,
                agentree_context_volatile_tail_hash: selectedComposerContextManifest.volatileTailHash,
                agentree_context_stable_prefix_chars: selectedComposerContextManifest.stablePrefixText.length,
                agentree_context_stable_prefix_estimated_tokens: Math.ceil(selectedComposerContextManifest.stablePrefixText.length / 4),
                agentree_context_volatile_tail_chars: selectedComposerContextManifest.volatileTailText.length,
                agentree_context_volatile_tail_estimated_tokens: Math.ceil(selectedComposerContextManifest.volatileTailText.length / 4),
                agentree_context_block_count: selectedComposerContextManifest.blocks.length,
                agentree_context_stable_block_count: selectedComposerContextManifest.stableBlocks.length,
                agentree_context_volatile_block_count: selectedComposerContextManifest.volatileBlocks.length,
                provider_thread_resume_enabled: providerThreadStrategy === 'resume',
                provider_parent_provider: providerContinuation?.parentProvider ?? null,
                provider_selected_provider: selectedProvider,
                provider_cross_provider_fresh_thread: providerRouting.promptContextMode === 'cross_provider_packet',
                provider_context_routing_mode: providerRouting.promptContextMode,
                provider_context_routing_reason: providerRouting.reason,
                provider_continuation_packet_chars: continuationPacketChars,
                provider_continuation_packet_version: continuationPacket?.version ?? null,
                provider_continuation_packet_hash: continuationPacket?.hash ?? null,
                provider_thread_strategy_requested: providerThreadStrategyRequested,
                provider_thread_id: sourceProviderThreadIdForSpawn,
                provider_source_thread_id: sourceProviderThreadIdForSpawn,
                provider_source_turn_id: sourceProviderTurnIdForSpawn,
                provider_parent_thread_id_available: parentProviderThreadId,
                provider_parent_turn_id_available: parentProviderTurnId,
                provider_parent_lineage_id_available: parentProviderLineageId,
                provider_lineage_id: sourceProviderLineageIdForSpawn,
                provider_target_user_turn_count: providerThreadStrategy === 'fork_then_rollback' ? parentProviderUserTurnCount : null,
                provider_target_turn_id: providerThreadStrategy === 'fork' ? parentProviderTurnId : null,
                provider_thread_strategy: providerThreadStrategy,
                ...(selectedProvider
                    ? {
                        provider: selectedProvider,
                        provider_run_mode: resolvedRunMode,
                        provider_model: resolvedModel,
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
            const startAgentRunIntent = {
                runId,
                assistantNodeId: nodeId,
                workspaceId: assistantMsg.workspaceId,
                repoPath,
                parentCommit,
                agentType: selectedAgent!.type,
                args: spawnArgs,
                authToken,
                traceId,
                runContext: {
                    runId,
                    executionData: startExecutionData,
                    gitBranchName: plannedBranchName,
                    repoPath,
                    parentCommit,
                    authorName: selectedAgent?.name ?? null,
                    promptFallback: prompt,
                },
            };
            const spawnFlowId = getSendFlowIdForKey(nodeId);
            void agentClient.startAgentRun(startAgentRunIntent).then((startRunResponse) => {
                recordLatencyMark(nodeId, 'worktree_create_finished', {
                    authToken,
                    nodeId,
                    detail: {
                        worktree_path: startRunResponse.worktreePath,
                        branch_name: startRunResponse.branchName,
                    },
                });
                worktreeInfoRef.current.set(nodeId, {
                    worktreePath: startRunResponse.worktreePath,
                    branchName: startRunResponse.branchName,
                    parentCommit,
                    repoPath,
                });
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
                    workspace_id: assistantMsg.workspaceId,
                    node_id: nodeId,
                    agent_id: selectedAgentId,
                    agent_provider: selectedAgent?.type ?? null,
                    agent_model: resolvedModel,
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
                    workspace_id: assistantMsg.workspaceId,
                    node_id: nodeId,
                    agent_id: selectedAgentId,
                    agent_provider: selectedAgent?.type ?? null,
                    error_phase: 'spawn',
                    error_name: error instanceof Error ? error.name : 'unknown',
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
                workspace_id: assistantMsg.workspaceId,
                node_id: nodeId,
                agent_id: selectedAgentId,
                agent_provider: selectedAgent?.type ?? null,
                agent_model: resolvedModel,
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
                workspace_id: assistantMsg.workspaceId,
                node_id: nodeId,
                agent_id: selectedAgentId,
                agent_provider: selectedAgent?.type ?? null,
                error_phase: 'setup',
                error_name: error instanceof Error ? error.name : 'unknown',
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

        if (event.key === 'Escape' && !isCommandPopoverOpen && !prompt.trim() && attachments.length === 0 && contextIds.length === 0) {
            onRequestClose?.();
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (event.key === 'Enter' && !event.shiftKey && !isCommandPopoverOpen) {
            event.preventDefault();
            handleSend();
        }
    }, [activeFileMention, activeFileMentionIndex, activeMentionFiles, attachments.length, contextIds.length, handleFileMentionSelect, handleSend, isCommandPopoverOpen, onRequestClose, prompt]);


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
                    return;
                }
                let stopFailed = false;
                try {
                    await agentClient.stopAgent(targetNodeId);
                } catch (err) {
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
        setPrompt((prev: string) => prev.slice(0, -1) + `/insert ${commandType}:`); // Replace "/" with command stub
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
        setPrompt('');
        setAttachments([]);
        setContextIds([]);
        setTimeout(() => textareaRef.current?.focus(), 0);
    }, []);


    // --- Existing Render Logic ---
    const totalAttachments = attachments.length;
    const sendButtonLabel = editDraftSource ? 'Edit and run' : 'Send';
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
    const composerMetaClass = "flex min-h-8 min-w-[138px] max-w-full items-center gap-1.5 rounded-md bg-[hsl(var(--app-bg-muted))] px-2 py-0.5 text-[hsl(var(--app-text-soft))] shadow-[inset_0_1px_0_rgba(255,255,255,0.54),inset_0_0_0_1px_rgba(25,28,33,0.032)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_0_0_1px_rgba(255,255,255,0.035)]";
    const composerControlClass = "flex min-h-8 min-w-[154px] max-w-full items-center gap-1.5 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong))] px-2 py-0.5 text-left shadow-[0_1px_2px_rgba(22,26,32,0.05),0_10px_24px_-21px_rgba(22,26,32,0.5)] transition-[background-color,border-color,box-shadow,transform] duration-150 hover:border-[hsl(var(--app-border-strong))] hover:bg-background hover:shadow-[0_2px_5px_rgba(22,26,32,0.07),0_16px_30px_-25px_rgba(22,26,32,0.58)] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50";
    const composerIconClass = "flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[hsl(var(--app-panel))] text-[hsl(var(--app-text-soft))] shadow-[inset_0_0_0_1px_rgba(24,28,36,0.04)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]";
    const composerControlIconClass = "flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[hsl(var(--app-bg-muted))] text-[hsl(var(--app-text-soft))] shadow-[inset_0_0_0_1px_rgba(24,28,36,0.04)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]";
    const composerEyebrowClass = "text-[8px] font-semibold uppercase leading-none tracking-[0.11em] text-muted-foreground/72";
    const composerValueClass = "truncate text-[11px] font-semibold leading-tight text-foreground";
    const hasReplyParent = Boolean(replyParentMessageId);
    const replyParentDisplayLabel = replyParentLabel || selectedNodeMessage?.content || replyParentMessageId || 'Selected node';

    // --- Render ---
    return (
        <div className="flex w-full max-w-full flex-col gap-1.5">
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
                "relative flex w-full flex-col rounded-[18px] border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel)/0.95)] shadow-[0_18px_48px_-36px_rgba(24,28,36,0.62),0_1px_0_rgba(255,255,255,0.72)_inset] backdrop-blur-xl transition-all duration-200 dark:shadow-[0_18px_48px_-34px_rgba(0,0,0,0.82),0_1px_0_rgba(255,255,255,0.05)_inset]",
                "focus-within:border-[hsl(var(--app-border-strong))] focus-within:bg-[hsl(var(--app-panel-strong))] focus-within:shadow-[0_22px_58px_-34px_rgba(24,28,36,0.72),0_0_0_3px_rgba(85,112,175,0.09),0_1px_0_rgba(255,255,255,0.78)_inset] dark:focus-within:shadow-[0_22px_58px_-34px_rgba(0,0,0,0.86),0_0_0_3px_rgba(126,160,230,0.11),0_1px_0_rgba(255,255,255,0.06)_inset]",
                activeFileMention ? "overflow-visible" : "overflow-hidden"
            )}>
                {/* Run context summary */}
                <div className={cn("border-b border-[hsl(var(--app-border)/0.70)] bg-[hsl(var(--app-bg-elevated)/0.74)] px-2.5 py-1.5", (!branchParentMessage && !selectedWorkspaceId) && "hidden")}>
                    <div className="custom-scrollbar flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5">
                        <div className={cn(composerMetaClass, "flex-[1_1_180px]", !hasReplyParent && "invisible")}>
                            <div className={composerIconClass}>
                                <Reply className="h-2.5 w-2.5" />
                            </div>
                            <div className="min-w-0">
                                <div className={composerEyebrowClass}>Reply to</div>
                                <div className="truncate text-[11px] font-semibold leading-tight text-[hsl(var(--app-text-soft))]">
                                    {truncateText(replyParentDisplayLabel, 64)}
                                </div>
                            </div>
                        </div>

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
                                                <div className="truncate font-mono text-[11px] font-semibold leading-tight text-foreground">
                                                    {formatCommitLabel(codeParentCommit)}
                                                </div>
                                            </div>
                                            <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-foreground/70" />
                                        </button>
                                    </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" align="start" className="max-w-72">
                                    <div>Run starts from commit {formatCommitLabel(codeParentCommit)}{effectiveBaseCommitLabel !== codeParentCommit ? `: ${effectiveBaseCommitLabel}` : ''}.</div>
                                    <div className="mt-1 text-muted-foreground">Changing the base can make the graph harder to follow.</div>
                                </TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent
                                align="start"
                                side="top"
                                sideOffset={6}
                                collisionPadding={12}
                                className="max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-border/70 bg-popover/95 p-1 shadow-[0_16px_42px_-20px_rgba(15,23,42,0.50),0_6px_18px_-14px_rgba(15,23,42,0.38)] backdrop-blur-xl dark:shadow-[0_16px_42px_-20px_rgba(0,0,0,0.78),0_6px_18px_-14px_rgba(0,0,0,0.62)]"
                            >
                                <DropdownMenuLabel className="px-1.5 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Run from commit</DropdownMenuLabel>
                                <DropdownMenuItem
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        setIsEarlierCommitsOpen((value) => !value);
                                    }}
                                    className="min-h-7 gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground"
                                >
                                    {isEarlierCommitsOpen ? (
                                        <ChevronDown className="h-3 w-3" />
                                    ) : (
                                        <ChevronRight className="h-3 w-3" />
                                    )}
                                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">
                                        Earlier commits{baseCommitAncestorCandidates.length > 0 ? ` (${baseCommitAncestorCandidates.length})` : ''}
                                    </span>
                                </DropdownMenuItem>
                                {isEarlierCommitsOpen ? (
                                    baseCommitAncestorsQuery.isLoading ? (
                                        <DropdownMenuItem disabled className="min-h-7 gap-1.5 rounded-md px-1.5 py-1 text-xs">
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                            Loading earlier commits...
                                        </DropdownMenuItem>
                                    ) : baseCommitAncestorCandidates.length > 0 ? (
                                        baseCommitAncestorCandidates.map((commit) => {
                                            const selected = effectiveBaseCommitSha === commit.sha;
                                            return (
                                                <DropdownMenuItem
                                                    key={`ancestor-${commit.sha}`}
                                                    onClick={() => {
                                                        setComposerBaseCommitOverride(null);
                                                        setSelectedBaseCommit(commit);
                                                    }}
                                                    className="min-h-8 gap-1.5 rounded-md px-1.5 py-1"
                                                    title={`${commit.sha} ${commit.subject ?? ''}`.trim()}
                                                >
                                                    <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                                                        {selected ? <Check className="h-3 w-3" /> : null}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="truncate text-[11px] font-medium leading-tight">{formatCommitSubject(commit)}</div>
                                                        <div className="truncate font-mono text-[10px] leading-tight text-muted-foreground">{formatCommitLabel(commit.sha)}</div>
                                                    </div>
                                                </DropdownMenuItem>
                                            );
                                        })
                                    ) : (
                                        <DropdownMenuItem disabled className="min-h-7 rounded-md px-1.5 py-1 text-xs text-muted-foreground">
                                            No ancestor commits available
                                        </DropdownMenuItem>
                                    )
                                ) : null}
                                <DropdownMenuSeparator className="my-0.5" />
                                <DropdownMenuItem
                                    onClick={() => {
                                        setComposerBaseCommitOverride(null);
                                        setSelectedBaseCommit(null);
                                    }}
                                    className="min-h-8 gap-1.5 rounded-md px-1.5 py-1"
                                >
                                    <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                                        {!selectedBaseCommit && !composerOverrideCommitSha ? <Check className="h-3 w-3" /> : null}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-[11px] font-medium leading-tight">Focused node base</div>
                                        <div className="truncate font-mono text-[10px] leading-tight text-muted-foreground">{formatCommitLabel(defaultBaseCommitSha)}</div>
                                    </div>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator className="my-0.5" />
                                <DropdownMenuLabel className="px-1.5 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Later commits</DropdownMenuLabel>
                                {baseCommitCandidatesQuery.isLoading ? (
                                    <DropdownMenuItem disabled className="min-h-7 gap-1.5 rounded-md px-1.5 py-1 text-xs">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Loading commits...
                                    </DropdownMenuItem>
                                ) : baseCommitCandidates.length > 0 ? (
                                    baseCommitCandidates.map((commit) => {
                                        const selected = effectiveBaseCommitSha === commit.sha;
                                        return (
                                            <DropdownMenuItem
                                                key={commit.sha}
                                                onClick={() => {
                                                    setComposerBaseCommitOverride(null);
                                                    setSelectedBaseCommit(commit);
                                                }}
                                                className="min-h-8 gap-1.5 rounded-md px-1.5 py-1"
                                                title={`${commit.sha} ${commit.subject ?? ''}`.trim()}
                                            >
                                                <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                                                    {selected ? <Check className="h-3 w-3" /> : null}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-[11px] font-medium leading-tight">{formatCommitSubject(commit)}</div>
                                                    <div className="truncate font-mono text-[10px] leading-tight text-muted-foreground">{formatCommitLabel(commit.sha)}</div>
                                                </div>
                                            </DropdownMenuItem>
                                        );
                                    })
                                ) : (
                                    <DropdownMenuItem disabled className="min-h-7 rounded-md px-1.5 py-1 text-xs text-muted-foreground">
                                        No descendant commits available
                                    </DropdownMenuItem>
                                )}
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
                                <TooltipContent side="bottom" align="start" className="max-w-72">
                                    {contextPolicy === 'fresh'
                                        ? 'Start without inherited conversation context. The node still belongs to the selected scope.'
                                        : `Context starts at ${contextStartLabel} and ends at ${contextParentLabel}.`}
                                </TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent
                                align="end"
                                sideOffset={8}
                                className="max-h-[calc(100vh-8rem)] w-80 overflow-y-auto rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_18px_48px_-18px_rgba(15,23,42,0.45),0_8px_20px_-12px_rgba(15,23,42,0.35)] backdrop-blur-xl dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.75),0_8px_20px_-12px_rgba(0,0,0,0.6)]"
                            >
                                <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">End context</DropdownMenuLabel>
                                {mergeContextOptions.length > 0 ? (
                                    mergeContextOptions.map((option) => {
                                        const selected = contextPolicy === 'continue' && option.id === selectedMergeContextParentId;
                                        return (
                                            <DropdownMenuItem
                                                key={option.id}
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
                                {contextPolicy === 'continue' && contextStartOptions.length > 0 && (
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
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            type="button"
                                            className={cn(composerControlClass, "flex-[0_1_162px]")}
                                            aria-label="Select scope"
                                        >
                                            <div className={composerControlIconClass}>
                                                <Layers3 className="h-3 w-3" />
                                            </div>
                                            <div className="min-w-0">
                                                <div className={composerEyebrowClass}>Scope</div>
                                                <div className={composerValueClass}>{effectiveScopeLabel}</div>
                                            </div>
                                            <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-foreground/70" />
                                        </button>
                                    </DropdownMenuTrigger>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" align="start" className="max-w-72">
                                    Select the workstream this node belongs to. Scope does not affect AI context.
                                </TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent
                                align="end"
                                sideOffset={8}
                                collisionPadding={12}
                                className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_18px_48px_-18px_rgba(15,23,42,0.45),0_8px_20px_-12px_rgba(15,23,42,0.35)] backdrop-blur-xl dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.75),0_8px_20px_-12px_rgba(0,0,0,0.6)]"
                            >
                                <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Scopes</DropdownMenuLabel>
                                {scopes.length === 0 ? (
                                    <DropdownMenuItem
                                        onClick={() => {
                                            setIsCreatingNewScope(false);
                                            setIsNewScopeEditorOpen(false);
                                            setSelectedScopeIdOverride(null);
                                            setNewScopeName('');
                                        }}
                                        className="min-h-9 gap-2 rounded-lg"
                                    >
                                        <span className="h-2.5 w-2.5 rounded-full bg-slate-400" />
                                        <span className="truncate">Default</span>
                                        {!isCreatingNewScope && !selectedScopeIdOverride && <Check className="ml-auto h-3.5 w-3.5" />}
                                    </DropdownMenuItem>
                                ) : scopes.map((scope) => {
                                    const selected = !isCreatingNewScope && effectiveScopeIdForReply === scope.id;
                                    return (
                                        <DropdownMenuItem
                                            key={scope.id}
                                            onClick={() => {
                                                setIsCreatingNewScope(false);
                                                setIsNewScopeEditorOpen(false);
                                                setSelectedScopeIdOverride(scope.id);
                                                setNewScopeName('');
                                            }}
                                            className="min-h-9 gap-2 rounded-lg"
                                        >
                                            <span
                                                className="h-2.5 w-2.5 rounded-full bg-slate-400"
                                                style={scope.color ? { backgroundColor: scope.color } : undefined}
                                            />
                                            <span className="truncate">{scope.name}</span>
                                            {selected && <Check className="ml-auto h-3.5 w-3.5" />}
                                        </DropdownMenuItem>
                                    );
                                })}
                                {isCreatingNewScope && !isNewScopeEditorOpen && (
                                    <DropdownMenuItem
                                        onClick={() => setIsNewScopeEditorOpen(true)}
                                        className="min-h-10 gap-2 rounded-lg bg-emerald-500/10 text-emerald-800 focus:bg-emerald-500/15 dark:text-emerald-300"
                                    >
                                        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm font-medium">{pendingNewScopeName}</div>
                                            <div className="truncate text-[10px] text-emerald-700/75 dark:text-emerald-300/75">Will be created when sent</div>
                                        </div>
                                        <Check className="ml-auto h-3.5 w-3.5 shrink-0" />
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        handleCreateScopeFromComposer();
                                    }}
                                    className="min-h-9 gap-2 rounded-lg"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    {isCreatingNewScope ? 'Edit new scope' : 'Create scope'}
                                </DropdownMenuItem>
                                {isCreatingNewScope && isNewScopeEditorOpen && (
                                    <div
                                        className="mt-1 rounded-lg bg-[hsl(var(--app-panel-strong))] p-2 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.35),0_8px_22px_-18px_rgba(16,185,129,0.55)]"
                                        onKeyDown={(event) => {
                                            event.stopPropagation();
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                handleSaveNewScopeName();
                                            }
                                            if (event.key === 'Escape') {
                                                event.preventDefault();
                                                handleCancelNewScopeName();
                                            }
                                        }}
                                    >
                                        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
                                            <Pencil className="h-3 w-3" />
                                            New scope
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <Input
                                                value={newScopeName}
                                                onChange={(event) => setNewScopeName(event.target.value)}
                                                placeholder={nextUntitledScopeName}
                                                className="h-8 min-w-0 flex-1 rounded-md border-border/60 bg-background/80 px-2 text-xs font-medium shadow-none focus-visible:ring-2 focus-visible:ring-emerald-500/35"
                                                aria-label="Scope name"
                                                autoFocus
                                            />
                                            <button
                                                type="button"
                                                className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-md bg-emerald-600 px-2.5 text-xs font-semibold text-white shadow-[0_8px_18px_-12px_rgba(16,185,129,0.85)] transition-colors hover:bg-emerald-700 active:scale-[0.96]"
                                                onClick={handleSaveNewScopeName}
                                            >
                                                <Check className="h-3.5 w-3.5" />
                                                Save
                                            </button>
                                            <button
                                                type="button"
                                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.96]"
                                                aria-label="Cancel new scope"
                                                onClick={handleCancelNewScopeName}
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                )}
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
                                <div className="absolute inset-x-2 bottom-[calc(100%+8px)] z-20 overflow-hidden rounded-xl border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong)/0.97)] shadow-[0_20px_60px_-28px_rgba(15,23,42,0.45)] backdrop-blur-xl">
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
                            <TextareaAutosize
                                ref={textareaRef}
                                data-testid="chat-composer-textarea"
                                value={prompt}
                                onChange={handlePromptChange}
                                onSelect={handlePromptSelectionChange}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                disabled={!selectedWorkspaceId}
                                placeholder="Ask anything... Type @ to reference files"
                                className={cn(
                                    "min-h-0 w-full flex-1 resize-none rounded-none border-0 px-3.5 py-2.5 max-h-[172px]",
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
                        className="w-60 p-1"
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

                {/* Bottom Action Bar */}
                <div className="flex items-center justify-between gap-2.5 border-t border-[hsl(var(--app-border)/0.55)] bg-[hsl(var(--app-bg-elevated)/0.58)] px-2.5 py-1">
                    {/* Left Actions */}
                    <div className="flex items-center gap-1.5">
                        {/* Model Selector - Modern chip style */}
                        <Popover open={isAgentPickerOpen} onOpenChange={setIsAgentPickerOpen}>
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
                                        {selectedAgent?.name || 'Choose model'}
                                    </span>
                                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                                </button>
                            </PopoverTrigger>
                            <PopoverContent
                                className="w-[304px] p-0 data-[state=open]:animate-none data-[state=closed]:animate-none data-[state=open]:fade-in-100 data-[state=closed]:fade-out-100 data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100"
                                side="top"
                                align="start"
                                sideOffset={8}
                            >
                                <div className="h-[360px]">
                                    <UnifiedAgentModelSelector
                                        onSelectAgent={handleAgentSelect}
                                        selectedAgentId={selectedAgentId}
                                    />
                                </div>
                            </PopoverContent>
                        </Popover>

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
                            <HoverCardContent className="w-64 rounded-xl border border-border/70 bg-popover px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-lg">
                                Automatically checks out the agent&apos;s new commit in detached HEAD after the run finishes. Skips checkout if your repo has uncommitted changes.
                            </HoverCardContent>
                        </HoverCard>

                        {/* Send Button - Modern gradient style */}
                        <button
                            type="button"
                            data-testid="chat-send-button"
                            onMouseDown={() => {
                                if (!showCancel) triggerSendPressFeedback();
                            }}
                            onClick={showCancel ? handleCancel : handleSend}
                            disabled={showCancel ? false : isParentIncomplete || (!prompt.trim() && totalAttachments === 0 && contextIds.length === 0) || !selectedWorkspaceId}
                            className={cn(
                                "flex-shrink-0 flex items-center justify-center gap-1.5",
                                "h-7 px-3 rounded-md",
                                "text-xs font-semibold",
                                "relative overflow-hidden transition-all duration-200 active:scale-95",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1",
                                showCancel
                                    ? "bg-destructive text-destructive-foreground shadow-[0_10px_26px_-18px_hsl(var(--destructive))] hover:bg-destructive/90"
                                    : "bg-[hsl(var(--app-accent))] text-white shadow-[0_14px_34px_-20px_hsl(var(--app-accent)/0.65)] hover:brightness-105 dark:text-white",
                                sendPressFeedback && !showCancel && "scale-95 ring-2 ring-primary/40 ring-offset-2",
                                "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:opacity-40 disabled:hover:shadow-none"
                            )}
                            aria-label={showCancel ? "Cancel sending message" : sendButtonLabel}
                            title={showCancel && isParentIncomplete ? parentStatusLabel : undefined}
                        >
                            {showCancel ? (
                                <>
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    <span>Cancel</span>
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
                                    <span>{isSendAcceptanceInFlight ? (queuedComposerSendCount > 0 ? `Queue ${queuedComposerSendCount + 1}` : 'Queue') : sendButtonLabel}</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
