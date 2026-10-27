import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react';
import { Check, ChevronDown, CornerDownRight, FileText, GitBranchIcon, GitCommitHorizontal, History, Loader2, Minus, Paperclip, Pencil, Plus, Puzzle, RotateCcw, Search, Send, Shield, Square, Workflow, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import { buildComposerDraftKey, useWorkspaceStore, type Message, type Workspace } from '../stores/workspaceStore';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import { useOrchestrationTemplateStore } from '../stores/orchestrationTemplateStore';
import type { OrchestrationPromptTemplate } from '../orchestration/templates';
import { buildProviderLoginRequiredToast } from '../lib/loginNavigationEvents';
import { isNoAgentSessionFoundError, markStaleLocalAgentNodeCancelled } from '../lib/localAgentRunTerminal';
import { applyLocalNodeMessages } from '../hooks/useLiveMessages';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, type LocalNodeMessage } from '../hooks/useLocalNodes';
import { useAgents, type Agent } from '../hooks/useAgents';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useCommitAncestors, useCommitDescendants } from '../hooks/useMessages';
import { useCreateThreadSession } from '../hooks/useThreadSessions';
import { getEnabledTrackedGitRefs, useGitRefSnapshot } from '../hooks/useGitRefSnapshot';
import { useTrackedRefs } from '../hooks/useTrackedRefs';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { agentClient, type GitCommitMetadata, type ProviderSkill } from '../lib/agentClient';
import { getOptionalCloudAuthToken } from '../lib/authSession';
import { createSendFlowId, recordSendFlowEvent } from '../perf/sendFlow';
import {
  buildComposerCommitPickerChipItems,
  buildComposerCommitPickerItems,
  getVisibleRefName,
  shortCommitSha,
  type ComposerCommitPickerCommit,
} from '../lib/composerBaseCommit';
import { buildLiveGitRefs, getComposerBaseSnapshotGitRefs } from '../lib/liveGitRefs';
import { reconstructContext } from '../lib/contextUtils';
import { getMergeVisualParentEntries, isMergeResultNode } from '../lib/graph/lineage';
import { isFirstClassCommitMessage } from '../lib/graph/turnUtils';
import { hasFreshContextBoundary } from '../lib/messageContext';
import { isSteerableAssistantNode } from '../lib/agentRunSteering';
import { resolveLocalWorkspaceRepoPath } from '../lib/workspaceRepoPath';
import { dispatchGraphComposerDockExpand } from '../lib/graphComposerDockEvents';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { cn } from '../lib/utils';
import { getLegacyThreadIdForMessage, getMessageThreadSessionId } from '../lib/threadSessions';
import {
  buildComposerAgentRuns,
  normalizeComposerAgentRunCounts,
  updateComposerAgentRunCount,
  type ComposerAgentRunCounts,
} from '../lib/composerAgentRuns';
import {
  buildRepoMentionSearchIndex,
  getMentionedRepoPathSet,
  getRepoMentionMatches,
  type RepoMentionFile,
} from '../lib/composerRepoMentions';
import {
  getActiveSkillMention,
  getSkillMentionNames,
  getSkillMentionSuggestions,
  insertSkillMention,
  type ActiveSkillMention,
} from '../lib/composerSkillMentions';
import {
  COMPOSER_PERMISSION_OPTIONS,
  DEFAULT_COMPOSER_PERMISSION_MODE,
  getComposerPermissionOption,
  type ComposerPermissionMode,
} from '../lib/composerPermissions';
import { UnifiedAgentModelSelector } from '../components/UnifiedAgentModelSelector';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent } from '../../@/components/ui/popover';
import {
  sendHeadlessComposerMessage,
} from './headlessComposerSend';
import {
  AgentRunPreflightError,
  createAgentRunSpec,
  launchAgentRunBatch,
  prepareAgentRuns,
  type PreparedAgentRun,
} from './agentRunBatch';
import { resolveComposerTargetModeAfterSuccessfulSend } from '../lib/composerSendParent';
import {
  resolveGraphDockComposerAgent,
  resolveGraphDockComposerBase,
  resolveGraphDockComposerEffectiveAgentId,
  resolveGraphDockComposerRunCountsForEffectiveAgent,
  resolveGraphDockComposerTarget,
  shouldSubmitGraphDockComposerKey,
} from './graphDockComposerLogic';
import { TemplateMentionTextarea } from '../components/composer/TemplateMentionTextarea';
import { AttachmentPreview } from '../components/AttachmentPreview';
import { useToast } from '../components/Toast';
import {
  getActiveTemplateMention,
  getTemplateMentionText,
  type ActiveTemplateMention,
} from '../lib/composerTemplateMentions';
import { getComposerAttachmentId, useComposerAttachments } from './useComposerAttachments';
import {
  ComposerSendAcceptanceQueue,
  type ComposerSendAcceptanceQueueState,
} from './composerSendAcceptanceQueue';
import {
  acceptComposerSendFocus,
  beginComposerSendFocus,
  cancelComposerSendFocus,
  finishComposerSendFocus,
} from './composerSendFocus';

const GRAPH_DOCK_PROMPT_DRAFT_DEBOUNCE_MS = 300;

type ContextPolicy = 'continue' | 'fresh';
type ComposerTargetMode = 'reply' | 'new-thread';
type ModelPickerTarget = { kind: 'replace'; agentId: string } | { kind: 'add' };
type EditUserMessageEventDetail = { message?: Message };
export type GraphDockComposerSurface = 'graph' | 'chat-panel' | 'floating-reply';

export interface GraphDockComposerProps {
  surface?: GraphDockComposerSurface;
  parentMessageIdOverride?: string | null;
  autoFocus?: boolean;
  onRequestClose?: () => void;
  onSendComplete?: () => void;
}
interface ActiveFileMention {
  start: number;
  end: number;
  query: string;
}

interface SelectedGraphBaseCommit {
  sha: string;
  label: string;
  selectedFromNodeId: string | null;
}

const trimToWholeWords = (value: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const slice = normalized.slice(0, maxLength + 1);
  const lastSpaceIndex = slice.search(/\s+\S*$/);
  const wholeWords = lastSpaceIndex > 0 ? slice.slice(0, lastSpaceIndex) : normalized.slice(0, maxLength);
  return `${wholeWords.trimEnd()}...`;
};

const previewText = (message: Message | null | undefined, fallback = 'Selected node'): string => {
  const text = message?.content?.trim();
  return text ? trimToWholeWords(text, 72) : fallback;
};

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
    const normalized = String(candidate || '').replace(/\s+/g, ' ').trim();
    if (normalized && !/^[0-9a-f]{24,}$/i.test(normalized)) return normalized;
  }

  return null;
};

const formatContextParentLabel = (message: Message | null | undefined, fallback = 'Parent'): string => (
  (getMessagePreviewText(message) || fallback).slice(0, 42)
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

const baseSourceLabel = (source: string | undefined): string => {
  if (source === 'main-ref') return 'main';
  if (source === 'head-ref') return 'HEAD';
  if (source === 'focused-commit') return 'Focused commit';
  if (source === 'reply-parent-output') return 'Parent output';
  if (source === 'reply-parent-base') return 'Parent base';
  if (source === 'latest-ancestor-output') return 'Ancestor output';
  if (source === 'tracked-ref') return 'Tracked ref';
  if (source === 'workspace-base') return 'Workspace base';
  if (source === 'override') return 'Selected base';
  return 'Base';
};

const areAgentRunCountsEqual = (left: ComposerAgentRunCounts, right: ComposerAgentRunCounts): boolean => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
};

const getActiveFileMention = (
  value: string,
  cursorPosition: number | null | undefined
): ActiveFileMention | null => {
  if (cursorPosition == null) return null;
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

function GraphDockPromptTextarea({
  textareaRef,
  initialValue,
  resetVersion,
  disabled,
  templates,
  onPromptChange,
  onDraftChange,
  onSelectionChange,
  onPromptKeyDown,
  onPaste,
  onSubmit,
  ariaLabel,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  initialValue: string;
  resetVersion: number;
  disabled: boolean;
  templates: OrchestrationPromptTemplate[];
  onPromptChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSelectionChange: (value: string, cursorPosition: number | null | undefined) => void;
  onPromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  ariaLabel: string;
}) {
  const [localPrompt, setLocalPrompt] = useState(initialValue);
  const draftSaveTimeoutRef = useRef<number | null>(null);

  const clearPendingDraftSave = useCallback(() => {
    if (draftSaveTimeoutRef.current === null) return;
    window.clearTimeout(draftSaveTimeoutRef.current);
    draftSaveTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    clearPendingDraftSave();
    setLocalPrompt(initialValue);
    onPromptChange(initialValue);
  }, [clearPendingDraftSave, initialValue, onPromptChange, resetVersion]);

  useEffect(() => clearPendingDraftSave, [clearPendingDraftSave]);

  const handlePromptChange = useCallback((value: string) => {
    setLocalPrompt(value);
    onPromptChange(value);
    clearPendingDraftSave();
    draftSaveTimeoutRef.current = window.setTimeout(() => onDraftChange(value), GRAPH_DOCK_PROMPT_DRAFT_DEBOUNCE_MS);
  }, [clearPendingDraftSave, onDraftChange, onPromptChange]);

  return (
    <TemplateMentionTextarea
      ref={textareaRef}
      templates={templates}
      data-testid="chat-composer-textarea"
      aria-label={ariaLabel}
      value={localPrompt}
      onChange={(event) => {
        handlePromptChange(event.target.value);
        onSelectionChange(event.currentTarget.value, event.currentTarget.selectionStart);
      }}
      onSelect={(event) => onSelectionChange(event.currentTarget.value, event.currentTarget.selectionStart)}
      onKeyDown={(event) => {
        onPromptKeyDown(event);
        if (event.defaultPrevented) return;
        if (shouldSubmitGraphDockComposerKey(event)) {
          event.preventDefault();
          onSubmit();
        }
      }}
      onPaste={onPaste}
      placeholder="Ask anything... Type @ for files, # for orchestration, or $ for skills"
      className="max-h-[216px] min-h-[58px] w-full resize-none overflow-y-auto rounded-lg bg-[hsl(var(--background)/0.44)] px-2.5 py-2 text-[13px] leading-5 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.54)] outline-none transition-[background-color,box-shadow] duration-150 placeholder:text-muted-foreground/68 focus:bg-[hsl(var(--background)/0.64)] focus:shadow-[inset_0_0_0_1px_hsl(var(--app-focus)/0.48),0_0_0_3px_hsl(var(--app-focus)/0.08)]"
      disabled={disabled}
      minRows={2}
      maxRows={10}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      cacheMeasurements
    />
  );
}

export function GraphDockComposer({
  surface = 'graph',
  parentMessageIdOverride,
  autoFocus = false,
  onRequestClose,
  onSendComplete,
}: GraphDockComposerProps = {}) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef('');
  const [composerTargetMode, setComposerTargetMode] = useState<ComposerTargetMode>('reply');
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy>('continue');
  const [permissionMode, setPermissionMode] = useState<ComposerPermissionMode>(DEFAULT_COMPOSER_PERMISSION_MODE);
  const [selectedBaseCommit, setSelectedBaseCommit] = useState<SelectedGraphBaseCommit | null>(null);
  const [baseCommitSearch, setBaseCommitSearch] = useState('');
  const [isBasePickerOpen, setIsBasePickerOpen] = useState(false);
  const [modelPickerTarget, setModelPickerTarget] = useState<ModelPickerTarget | null>(null);
  const [selectedMergeContextParentId, setSelectedMergeContextParentId] = useState<string | null>(null);
  const [selectedContextStartId, setSelectedContextStartId] = useState<string | null>(null);
  const [selectedAgentRunCounts, setSelectedAgentRunCounts] = useState<ComposerAgentRunCounts>({});
  const [promptSeed, setPromptSeed] = useState('');
  const [promptText, setPromptText] = useState('');
  const [promptResetVersion, setPromptResetVersion] = useState(0);
  const [promptHasContent, setPromptHasContent] = useState(false);
  const [editDraftSource, setEditDraftSource] = useState<Message | null>(null);
  const orchestrationTemplates = useOrchestrationTemplateStore((state) => state.templates);
  const [repoMentionFiles, setRepoMentionFiles] = useState<RepoMentionFile[]>([]);
  const [activeFileMention, setActiveFileMention] = useState<ActiveFileMention | null>(null);
  const [activeFileMentionIndex, setActiveFileMentionIndex] = useState(0);
  const [activeSkillMention, setActiveSkillMention] = useState<ActiveSkillMention | null>(null);
  const [activeSkillMentionIndex, setActiveSkillMentionIndex] = useState(0);
  const [activeTemplateMention, setActiveTemplateMention] = useState<ActiveTemplateMention | null>(null);
  const [activeTemplateMentionIndex, setActiveTemplateMentionIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sendAcceptanceQueueRef = useRef<ComposerSendAcceptanceQueue<{ prompt: string }> | null>(null);
  if (!sendAcceptanceQueueRef.current) {
    sendAcceptanceQueueRef.current = new ComposerSendAcceptanceQueue<{ prompt: string }>();
  }
  const [sendAcceptanceState, setSendAcceptanceState] = useState<ComposerSendAcceptanceQueueState>(() => (
    sendAcceptanceQueueRef.current!.getState()
  ));
  const [isSteering, setIsSteering] = useState(false);
  const [isCancellingRun, setIsCancellingRun] = useState(false);
  const {
    selectedWorkspaceId,
    focusedMessageId,
    lastFocusSource,
    lastFocusMetadata,
    selectedAgentId,
    setSelectedAgentId,
    setComposerContextPreview,
    composerBaseCommitOverride,
    threadComposerTarget,
    clearThreadComposerTarget,
    composerDraftByWorkspace,
    setComposerDraft,
    clearComposerDraft,
    autoCheckoutOnAgentCommit,
    setAutoCheckoutOnAgentCommit,
  } = useWorkspaceStore(useShallow((state) => ({
    selectedWorkspaceId: state.selectedWorkspaceId,
    focusedMessageId: state.focusedMessageId,
    lastFocusSource: state.lastFocusSource,
    lastFocusMetadata: state.lastFocusMetadata,
    selectedAgentId: state.selectedAgentId,
    setSelectedAgentId: state.setSelectedAgentId,
    setComposerContextPreview: state.setComposerContextPreview,
    composerBaseCommitOverride: state.composerBaseCommitOverride,
    threadComposerTarget: state.threadComposerTarget,
    clearThreadComposerTarget: state.clearThreadComposerTarget,
    composerDraftByWorkspace: state.composerDraftByWorkspace,
    setComposerDraft: state.setComposerDraft,
    clearComposerDraft: state.clearComposerDraft,
    autoCheckoutOnAgentCommit: state.autoCheckoutOnAgentCommit,
    setAutoCheckoutOnAgentCommit: state.setAutoCheckoutOnAgentCommit,
  })));
  const handleAttachmentError = useCallback((message: string) => {
    addToast({
      title: 'Attachment upload failed',
      description: message,
      variant: 'error',
    });
  }, [addToast]);
  const composerAttachments = useComposerAttachments({
    workspaceId: selectedWorkspaceId,
    onError: handleAttachmentError,
  });
  const { data: agents = [] } = useAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const createThreadSession = useCreateThreadSession();
  const selectedWorkspace = useMemo(
    () => (workspaces as Workspace[]).find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces]
  );
  const selectedWorkspaceRepoPath = useMemo(
    () => resolveLocalWorkspaceRepoPath(selectedWorkspace),
    [selectedWorkspace]
  );
  const ambientTarget = resolveGraphDockComposerTarget({
    focusedMessageId,
    lastFocusSource,
    lastFocusMetadata,
  });
  const rawTarget = parentMessageIdOverride !== undefined
    ? {
      parentMessageId: parentMessageIdOverride,
      selectedNodeId: parentMessageIdOverride,
      focusedCommitSha: null,
    }
    : ambientTarget;
  const isRootComposerTarget = editDraftSource
    ? !editDraftSource.parentId
    : composerTargetMode === 'new-thread' || !rawTarget.parentMessageId;
  const localRefsQuery = useQuery({
    queryKey: ['git-refs', selectedWorkspaceRepoPath, selectedWorkspaceId],
    queryFn: async () => {
      if (!selectedWorkspaceRepoPath) return [];
      try {
        return await agentClient.listLocalRefs(selectedWorkspaceRepoPath);
      } catch {
        return [];
      }
    },
    enabled: Boolean(selectedWorkspaceRepoPath && selectedWorkspaceId),
    staleTime: 30_000,
  });
  const shouldLoadBaseRefs = isBasePickerOpen || isRootComposerTarget;
  const trackedRefsQuery = useTrackedRefs(shouldLoadBaseRefs ? selectedWorkspaceId : null);
  const enabledTrackedGitRefs = useMemo(
    () => getEnabledTrackedGitRefs(trackedRefsQuery.data ?? []),
    [trackedRefsQuery.data]
  );
  const composerBaseSnapshotGitRefs = useMemo(
    () => getComposerBaseSnapshotGitRefs(enabledTrackedGitRefs),
    [enabledTrackedGitRefs]
  );
  const gitRefSnapshotQuery = useGitRefSnapshot(
    shouldLoadBaseRefs ? selectedWorkspaceRepoPath : null,
    composerBaseSnapshotGitRefs
  );
  const liveGitRefs = useMemo(() => buildLiveGitRefs({
    refs: localRefsQuery.data ?? [],
    trackedRefs: trackedRefsQuery.data ?? [],
    snapshot: gitRefSnapshotQuery.data,
  }), [gitRefSnapshotQuery.data, localRefsQuery.data, trackedRefsQuery.data]);
  const liveRefs = liveGitRefs.refs;
  const liveTrackedRefs = liveGitRefs.trackedRefs;
  const currentHeadSha = liveGitRefs.headSha;
  const lazyCommitsQuery = useQuery({
    queryKey: ['graph-dock-commit-choices', selectedWorkspaceRepoPath, selectedWorkspaceId],
    queryFn: async (): Promise<GitCommitMetadata[]> => {
      if (!selectedWorkspaceRepoPath) return [];
      try {
        return await agentClient.listAllCommits(selectedWorkspaceRepoPath, 160);
      } catch {
        return [];
      }
    },
    enabled: Boolean(isBasePickerOpen && selectedWorkspaceRepoPath && selectedWorkspaceId),
    staleTime: 30_000,
  });
  const persistedMessages = queryClient.getQueryData<Message[]>(['messages', selectedWorkspaceId]) ?? [];
  const localMessages = queryClient.getQueryData<LocalNodeMessage[]>(localNodeKeys.workspace(selectedWorkspaceId)) ?? [];
  const messages = useMemo(
    () => applyLocalNodeMessages(persistedMessages, localMessages, selectedWorkspaceId),
    [localMessages, persistedMessages, selectedWorkspaceId]
  );
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  );
  const target = editDraftSource
    ? {
      parentMessageId: editDraftSource.parentId ?? null,
      selectedNodeId: editDraftSource.parentId ?? null,
      focusedCommitSha: null,
    }
    : composerTargetMode === 'new-thread'
    ? {
      parentMessageId: null,
      selectedNodeId: rawTarget.selectedNodeId,
      focusedCommitSha: null,
    }
    : rawTarget;
  const composerDraftTargetId = editDraftSource?.id
    ?? (composerTargetMode === 'new-thread' ? pendingThreadId : null)
    ?? target.parentMessageId
    ?? target.selectedNodeId
    ?? null;
  const composerDraftKey = buildComposerDraftKey(selectedWorkspaceId, composerDraftTargetId);
  const composerDraft = composerDraftKey ? composerDraftByWorkspace[composerDraftKey] ?? '' : '';
  const parentMessage = useMemo(
    () => target.parentMessageId
      ? messages.find((message) => message.id === target.parentMessageId) ?? null
      : null,
    [messages, target.parentMessageId]
  );
  const targetRunStatus = useRunStatusStore((state) => (
    target.parentMessageId ? state.byNodeId[target.parentMessageId]?.status ?? null : null
  ));
  const isSteeringRunningAssistant = isSteerableAssistantNode({
    nodeId: target.parentMessageId,
    role: parentMessage?.role ?? null,
    status: parentMessage?.status ?? null,
    runStatus: targetRunStatus,
  });
  const defaultContextParentMessage = useMemo(
    () => resolveConversationContextMessage(target.parentMessageId, messageById),
    [messageById, target.parentMessageId]
  );
  const mergeContextOptions = useMemo(() => {
    if (!parentMessage || !isMergeResultNode(parentMessage, messageById)) return [];
    const seen = new Set<string>();
    const options: Array<{ id: string; role: string; label: string }> = [];

    for (const entry of getMergeVisualParentEntries(parentMessage, messageById)) {
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
  }, [messageById, parentMessage]);
  const agent = resolveGraphDockComposerAgent({
    agents,
    selectedAgentId,
    parentMessage,
  });
  const effectiveSelectedAgentId = resolveGraphDockComposerEffectiveAgentId({
    selectedAgentId,
    resolvedAgent: agent,
  });
  const normalizedSelectedAgentRunCounts = useMemo(
    () => normalizeComposerAgentRunCounts(
      agents,
      effectiveSelectedAgentId,
      resolveGraphDockComposerRunCountsForEffectiveAgent({
        selectedAgentId,
        effectiveSelectedAgentId,
        currentCounts: selectedAgentRunCounts,
      })
    ),
    [agents, effectiveSelectedAgentId, selectedAgentId, selectedAgentRunCounts]
  );
  const selectedAgentRuns = useMemo(
    () => buildComposerAgentRuns(agents, normalizedSelectedAgentRunCounts),
    [agents, normalizedSelectedAgentRunCounts]
  );
  const selectedAgentRunItems = useMemo(() => (
    selectedAgentRuns
      .map((run) => ({
        ...run,
        agent: agents.find((candidate) => candidate.id === run.agentId) ?? null,
      }))
      .filter((run): run is typeof run & { agent: Agent } => run.agent != null)
  ), [agents, selectedAgentRuns]);
  const selectedAgentRunChips = useMemo(() => (
    agents
      .map((candidate) => ({
        agent: candidate,
        count: normalizedSelectedAgentRunCounts[candidate.id] ?? 0,
      }))
      .filter((entry) => entry.count > 0)
  ), [agents, normalizedSelectedAgentRunCounts]);
  const selectedSkillProviders = useMemo(() => (
    Array.from(new Set(
      selectedAgentRunItems
        .map((run) => run.agent.type)
        .filter((provider) => provider === 'codex' || provider === 'claude' || provider === 'opencode')
    )).sort()
  ), [selectedAgentRunItems]);
  const providerSkillsQuery = useQuery({
    queryKey: ['provider-skills', selectedWorkspaceRepoPath, selectedSkillProviders],
    queryFn: () => agentClient.listProviderSkills(selectedSkillProviders, selectedWorkspaceRepoPath),
    enabled: Boolean(selectedWorkspaceId && selectedSkillProviders.length > 0 && agentClient.hasRuntime()),
    staleTime: 30_000,
  });
  const providerSkills = useMemo(() => providerSkillsQuery.data ?? [], [providerSkillsQuery.data]);
  const selectedRunTotal = selectedAgentRuns.length;
  const base = resolveGraphDockComposerBase({
    targetMode: isRootComposerTarget ? 'new-thread' : composerTargetMode,
    replyParentMessageId: target.parentMessageId,
    selectedNodeId: target.selectedNodeId,
    focusedCommitSha: target.focusedCommitSha,
    messages,
    refs: liveRefs,
    trackedRefs: liveTrackedRefs,
    workspace: selectedWorkspace,
    override: composerBaseCommitOverride,
  });
  const defaultBaseCommitSha = base?.commitSha ?? null;
  const baseCommitCandidatesQuery = useCommitDescendants(selectedWorkspaceId, defaultBaseCommitSha, {
    enabled: Boolean(isBasePickerOpen && selectedWorkspaceId && defaultBaseCommitSha),
    limit: 80,
  });
  const baseCommitAncestorsQuery = useCommitAncestors(selectedWorkspaceId, defaultBaseCommitSha, {
    enabled: Boolean(isBasePickerOpen && selectedWorkspaceId && defaultBaseCommitSha),
    limit: 80,
  });
  const effectiveBase = selectedBaseCommit
    ? {
      commitSha: selectedBaseCommit.sha,
      selectedFromNodeId: selectedBaseCommit.selectedFromNodeId,
      source: 'selected' as const,
    }
    : base;
  const effectiveContextPolicy: ContextPolicy = !target.parentMessageId
    ? 'fresh'
    : contextPolicy;
  const effectiveContextParentId = effectiveContextPolicy === 'fresh'
    ? null
    : mergeContextOptions.length > 0
      ? selectedMergeContextParentId
      : defaultContextParentMessage?.id ?? null;
  const selectedMergeContextOption = useMemo(
    () => mergeContextOptions.find((option) => option.id === selectedMergeContextParentId) ?? null,
    [mergeContextOptions, selectedMergeContextParentId]
  );
  const effectiveContextParentMessage = useMemo(
    () => effectiveContextParentId ? messageById.get(effectiveContextParentId) ?? null : null,
    [effectiveContextParentId, messageById]
  );
  const contextStartOptions = useMemo(() => {
    if (!effectiveContextParentId || effectiveContextPolicy === 'fresh') return [];
    const seen = new Set<string>();
    return reconstructContext(effectiveContextParentId, messages)
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
  }, [effectiveContextParentId, effectiveContextPolicy, messageById, messages]);
  const defaultContextStartMessage = useMemo(
    () => effectiveContextPolicy === 'fresh'
      ? null
      : resolveContextStartMessage(effectiveContextParentId, messages, messageById),
    [effectiveContextParentId, effectiveContextPolicy, messageById, messages]
  );
  const effectiveContextStartId = effectiveContextPolicy === 'fresh'
    ? null
    : (
      selectedContextStartId && contextStartOptions.some((option) => option.id === selectedContextStartId)
        ? selectedContextStartId
        : defaultContextStartMessage?.id ?? null
    );
  const effectiveContextStartMessage = useMemo(
    () => effectiveContextStartId ? messageById.get(effectiveContextStartId) ?? null : null,
    [effectiveContextStartId, messageById]
  );
  const contextStartLabel = formatContextParentLabel(effectiveContextStartMessage, 'Root');
  const contextParentLabel = effectiveContextPolicy === 'fresh'
    ? 'Fresh context'
    : selectedMergeContextOption
      ? formatContextParentLabel(messageById.get(selectedMergeContextOption.id), selectedMergeContextOption.label)
      : formatContextParentLabel(effectiveContextParentMessage, 'No prior conversation');
  const selectedPermissionOption = getComposerPermissionOption(permissionMode);
  const isSending = sendAcceptanceState.acceptingId !== null || sendAcceptanceState.queuedCount > 0;
  const isBlockingPrimaryAction = isSteering || isCancellingRun;
  const isComposerConfigurationDisabled = isSteering || isCancellingRun || isSteeringRunningAssistant;
  const hasComposerInput = promptHasContent || composerAttachments.metadata.length > 0;
  const canSend = Boolean(selectedWorkspaceId
    && !isSteering
    && !isCancellingRun
    && !composerAttachments.hasPendingUploads
    && !composerAttachments.hasUploadErrors
    && hasComposerInput && (
    isSteeringRunningAssistant
      ? target.parentMessageId && promptHasContent
      : effectiveBase && selectedAgentRunItems.length > 0
  ));
  const targetLabel = previewText(parentMessage, isRootComposerTarget ? 'Thread root' : 'Selected node');
  const baseCommitPickerCommits = useMemo<ComposerCommitPickerCommit[]>(() => {
    const commitsBySha = new Map<string, ComposerCommitPickerCommit>();
    const upsert = (commit: Partial<ComposerCommitPickerCommit> & { sha?: string | null }) => {
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

    for (const commit of lazyCommitsQuery.data ?? []) {
      upsert({
        sha: commit.sha,
        subject: commit.subject,
        parents: commit.parents,
        authored_at: commit.authored_at,
      });
    }
    for (const commit of baseCommitAncestorsQuery.data?.commits ?? []) {
      upsert({
        sha: commit.sha,
        subject: commit.subject,
        produced_by_node_id: commit.produced_by_node_id ?? null,
        authored_at: commit.authored_at,
        committed_at: commit.committed_at,
      });
    }
    for (const commit of baseCommitCandidatesQuery.data?.commits ?? []) {
      upsert({
        sha: commit.sha,
        subject: commit.subject,
        produced_by_node_id: commit.produced_by_node_id ?? null,
        authored_at: commit.authored_at,
        committed_at: commit.committed_at,
      });
    }
    if (base) {
      upsert({
        sha: base.commitSha,
        subject: baseSourceLabel(base.source),
        produced_by_node_id: base.selectedFromNodeId,
      });
    }
    if (currentHeadSha) {
      upsert({
        sha: currentHeadSha,
        subject: 'HEAD',
      });
    }
    if (selectedBaseCommit) {
      upsert({
        sha: selectedBaseCommit.sha,
        subject: selectedBaseCommit.label,
        produced_by_node_id: selectedBaseCommit.selectedFromNodeId,
      });
    }

    return Array.from(commitsBySha.values());
  }, [
    base,
    baseCommitAncestorsQuery.data?.commits,
    baseCommitCandidatesQuery.data?.commits,
    currentHeadSha,
    lazyCommitsQuery.data,
    selectedBaseCommit,
  ]);
  const refPickerRefs = useMemo(() => (
    liveRefs.filter((ref) => Boolean(getVisibleRefName(ref)))
  ), [liveRefs]);
  const laterCommitShas = useMemo(
    () => new Set((baseCommitCandidatesQuery.data?.commits ?? []).map((commit) => commit.sha)),
    [baseCommitCandidatesQuery.data?.commits]
  );
  const earlierCommitShas = useMemo(
    () => new Set((baseCommitAncestorsQuery.data?.commits ?? []).map((commit) => commit.sha)),
    [baseCommitAncestorsQuery.data?.commits]
  );
  const basePickerItems = useMemo(() => buildComposerCommitPickerItems({
    defaultSha: base?.commitSha ?? null,
    effectiveSha: effectiveBase?.commitSha ?? null,
    commits: baseCommitPickerCommits,
    refs: refPickerRefs,
    trackedRefs: liveTrackedRefs,
    laterCommitShas,
    earlierCommitShas,
  }), [
    base?.commitSha,
    baseCommitPickerCommits,
    earlierCommitShas,
    effectiveBase?.commitSha,
    laterCommitShas,
    liveTrackedRefs,
    refPickerRefs,
  ]);
  const filteredBasePickerItems = useMemo(() => {
    const query = baseCommitSearch.trim().toLowerCase();
    if (!query) return basePickerItems;
    return basePickerItems.filter((item) => item.searchText.includes(query));
  }, [baseCommitSearch, basePickerItems]);
  const baseChipItems = useMemo(() => buildComposerCommitPickerChipItems({
    items: basePickerItems,
    refs: refPickerRefs,
    trackedRefs: liveTrackedRefs,
    headSha: currentHeadSha,
    commitRecencyBySha: new Map(baseCommitPickerCommits.map((commit) => {
      const timestamp = Date.parse(commit.committed_at || commit.authored_at || '');
      return [commit.sha, Number.isFinite(timestamp) ? timestamp : 0] as const;
    })),
    limit: 6,
  }), [baseCommitPickerCommits, basePickerItems, currentHeadSha, liveTrackedRefs, refPickerRefs]);
  const effectiveBaseLabel = selectedBaseCommit?.label
    ?? basePickerItems.find((item) => item.sha === effectiveBase?.commitSha)?.primaryLabel
    ?? baseSourceLabel(effectiveBase?.source)
    ?? (effectiveBase ? shortCommitSha(effectiveBase.commitSha) : 'No base');
  const repoMentionSearchIndex = useMemo(
    () => buildRepoMentionSearchIndex(repoMentionFiles),
    [repoMentionFiles]
  );
  const repoMentionFilePathSet = useMemo(
    () => new Set(repoMentionFiles.map((file) => file.path)),
    [repoMentionFiles]
  );
  const repoMentionPathSet = useMemo(
    () => getMentionedRepoPathSet(promptText, repoMentionFilePathSet),
    [promptText, repoMentionFilePathSet]
  );
  const providerSkillNames = useMemo(
    () => providerSkills.map((skill: ProviderSkill) => skill.name),
    [providerSkills]
  );
  const skillMentionNameSet = useMemo(
    () => new Set(getSkillMentionNames(promptText, providerSkillNames)),
    [providerSkillNames, promptText]
  );
  const activeMentionFiles = useMemo(
    () => activeFileMention ? getRepoMentionMatches(repoMentionSearchIndex, activeFileMention.query, 8) : [],
    [activeFileMention, repoMentionSearchIndex]
  );
  const activeMentionSkills = useMemo(
    () => activeSkillMention ? getSkillMentionSuggestions(providerSkills, activeSkillMention.query) : [],
    [activeSkillMention, providerSkills]
  );
  const activeMentionTemplates = useMemo(() => {
    if (!activeTemplateMention) return [];
    const query = activeTemplateMention.query.trim().toLowerCase();
    return orchestrationTemplates
      .filter((template) => {
        const mention = getTemplateMentionText(template).toLowerCase();
        return !query || mention.includes(query) || template.label.toLowerCase().includes(query);
      })
      .slice(0, 8);
  }, [activeTemplateMention, orchestrationTemplates]);
  const isBaseChoicesLoading = localRefsQuery.isLoading || trackedRefsQuery.isLoading || gitRefSnapshotQuery.isLoading || lazyCommitsQuery.isLoading || baseCommitCandidatesQuery.isLoading || baseCommitAncestorsQuery.isLoading;
  const footerStatusText = error ?? (isSteeringRunningAssistant ? 'Steer the running agent' : '');
  const dockControlButtonClass = cn(
    'group/control flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-[hsl(var(--app-border)/0.78)]',
    'bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.96),hsl(var(--app-panel)/0.82))]',
    'pl-2 pr-2 text-left text-[11px] font-semibold text-foreground shadow-[inset_0_1px_0_hsl(44_80%_99%/0.55)]',
    'transition-[background-color,border-color,box-shadow,transform,color] duration-200 ease-out',
    'hover:-translate-y-0.5 hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-panel-strong)/0.98)]',
    'active:translate-y-0 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0'
  );

  useEffect(() => {
    promptRef.current = composerDraft;
    setPromptSeed(composerDraft);
    setPromptText(composerDraft);
    setPromptHasContent(composerDraft.trim().length > 0);
    setPromptResetVersion((version) => version + 1);
  }, [composerDraft]);

  useEffect(() => sendAcceptanceQueueRef.current!.subscribe(setSendAcceptanceState), []);

  useEffect(() => {
    if (!autoFocus) return;
    const timeoutId = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [autoFocus]);

  useEffect(() => {
    const handleEditUserMessage = (event: CustomEvent<EditUserMessageEventDetail>) => {
      const sourceMessage = event.detail?.message;
      if (!sourceMessage || sourceMessage.role !== 'user') return;
      if (sourceMessage.workspaceId !== selectedWorkspaceId) return;

      setEditDraftSource(sourceMessage);
      promptRef.current = sourceMessage.content || '';
      setPromptSeed(sourceMessage.content || '');
      setPromptText(sourceMessage.content || '');
      setPromptHasContent(Boolean(sourceMessage.content?.trim()));
      setPromptResetVersion((version) => version + 1);
      setComposerDraft(selectedWorkspaceId, sourceMessage.content || '', sourceMessage.id);
      setComposerTargetMode('reply');
      setPendingThreadId(sourceMessage.parentId
        ? null
        : getMessageThreadSessionId(sourceMessage) ?? getLegacyThreadIdForMessage(sourceMessage, messageById)
      );
      setContextPolicy(sourceMessage.parentId ? 'continue' : 'fresh');
      setSelectedContextStartId(null);
      setSelectedMergeContextParentId(null);
      composerAttachments.replaceAttachments(sourceMessage.attachments ?? []);
      dispatchGraphComposerDockExpand();
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    };

    window.addEventListener('editUserMessage', handleEditUserMessage as EventListener);

    return () => {
      window.removeEventListener('editUserMessage', handleEditUserMessage as EventListener);
    };
  }, [composerAttachments.replaceAttachments, messageById, selectedWorkspaceId, setComposerDraft]);

  useEffect(() => {
    const normalized = normalizeComposerAgentRunCounts(
      agents,
      effectiveSelectedAgentId,
      resolveGraphDockComposerRunCountsForEffectiveAgent({
        selectedAgentId,
        effectiveSelectedAgentId,
        currentCounts: selectedAgentRunCounts,
      })
    );
    if (!areAgentRunCountsEqual(normalized, selectedAgentRunCounts)) {
      setSelectedAgentRunCounts(normalized);
    }
  }, [agents, effectiveSelectedAgentId, selectedAgentId, selectedAgentRunCounts]);

  useEffect(() => {
    let cancelled = false;
    const commit = effectiveBase?.commitSha?.trim() || null;
    if (!selectedWorkspaceRepoPath || !commit) {
      setRepoMentionFiles([]);
      return;
    }

    const loadRepoMentionFiles = async () => {
      try {
        const repoPaths = await agentClient.listFilesAtCommit(selectedWorkspaceRepoPath, commit);
        if (cancelled) return;
        setRepoMentionFiles(repoPaths.map((path) => ({
          path,
          name: path.split('/').pop() || path,
        })));
      } catch (caught) {
        if (cancelled) return;
        console.warn('[GraphDockComposer] Failed to load repo mention files:', caught);
        setRepoMentionFiles([]);
      }
    };

    void loadRepoMentionFiles();
    return () => {
      cancelled = true;
    };
  }, [effectiveBase?.commitSha, selectedWorkspaceRepoPath]);

  useEffect(() => {
    setActiveFileMentionIndex(0);
  }, [activeFileMention?.query]);

  useEffect(() => {
    setActiveSkillMentionIndex(0);
  }, [activeSkillMention?.query]);

  useEffect(() => {
    setActiveTemplateMentionIndex(0);
  }, [activeTemplateMention?.query]);

  useEffect(() => {
    if (selectedWorkspaceId) return;
    setActiveFileMention(null);
    setActiveSkillMention(null);
    setActiveTemplateMention(null);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    setSelectedBaseCommit(null);
    setBaseCommitSearch('');
  }, [base?.commitSha, selectedWorkspaceId, target.parentMessageId]);

  const consumedThreadComposerTargetNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!threadComposerTarget || threadComposerTarget.workspaceId !== selectedWorkspaceId) return;
    if (consumedThreadComposerTargetNonceRef.current === threadComposerTarget.nonce) return;
    consumedThreadComposerTargetNonceRef.current = threadComposerTarget.nonce;
    setComposerTargetMode('new-thread');
    setPendingThreadId(threadComposerTarget.threadId);
    setContextPolicy('fresh');
    setSelectedContextStartId(null);
    setSelectedMergeContextParentId(null);
    clearThreadComposerTarget(threadComposerTarget.nonce);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [clearThreadComposerTarget, selectedWorkspaceId, threadComposerTarget]);

  useEffect(() => {
    if (!rawTarget.parentMessageId && !rawTarget.focusedCommitSha) return;
    if (editDraftSource) return;
    setComposerTargetMode('reply');
    setPendingThreadId(null);
  }, [editDraftSource, rawTarget.parentMessageId, rawTarget.focusedCommitSha]);

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

  useEffect(() => {
    setContextPolicy(target.parentMessageId ? 'continue' : 'fresh');
    setSelectedContextStartId(null);
  }, [target.parentMessageId]);

  useEffect(() => {
    setComposerContextPreview({
      workspaceId: selectedWorkspaceId,
      parentId: target.parentMessageId,
      contextParentId: effectiveContextPolicy === 'fresh' ? null : effectiveContextParentId,
      contextPolicy: effectiveContextPolicy,
      contextStartId: effectiveContextStartId,
      baseCommitSha: effectiveBase?.commitSha ?? null,
    });
    return () => setComposerContextPreview(null);
  }, [
    effectiveBase?.commitSha,
    effectiveContextParentId,
    effectiveContextPolicy,
    effectiveContextStartId,
    selectedWorkspaceId,
    setComposerContextPreview,
    target.parentMessageId,
  ]);

  const updatePrompt = useCallback((value: string) => {
    promptRef.current = value;
    setPromptText(value);
    const nextHasContent = value.trim().length > 0;
    setPromptHasContent((current) => (current === nextHasContent ? current : nextHasContent));
  }, []);

  const savePromptDraft = useCallback((value: string) => {
    setComposerDraft(selectedWorkspaceId, value, composerDraftTargetId);
  }, [composerDraftTargetId, selectedWorkspaceId, setComposerDraft]);

  const setPromptValue = useCallback((value: string) => {
    promptRef.current = value;
    setPromptSeed(value);
    setPromptText(value);
    setPromptHasContent(value.trim().length > 0);
    setPromptResetVersion((version) => version + 1);
    setComposerDraft(selectedWorkspaceId, value, composerDraftTargetId);
  }, [composerDraftTargetId, selectedWorkspaceId, setComposerDraft]);

  const clearPrompt = useCallback(() => {
    promptRef.current = '';
    setPromptSeed('');
    setPromptText('');
    setPromptHasContent(false);
    setPromptResetVersion((version) => version + 1);
    setActiveFileMention(null);
    setActiveSkillMention(null);
    setActiveTemplateMention(null);
  }, []);

  useEffect(() => {
    const handlePopulateComposer = (event: CustomEvent<{ text?: string }>) => {
      const text = event.detail?.text;
      if (typeof text !== 'string' || !text) return;
      setPromptValue(text);
      setEditDraftSource(null);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    };
    window.addEventListener('populateChatInput', handlePopulateComposer as EventListener);
    return () => window.removeEventListener('populateChatInput', handlePopulateComposer as EventListener);
  }, [setPromptValue]);

  const handleCancelEditDraft = useCallback(() => {
    setEditDraftSource(null);
    clearPrompt();
    composerAttachments.clearAttachments();
    clearComposerDraft(selectedWorkspaceId, composerDraftTargetId);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [clearComposerDraft, clearPrompt, composerAttachments.clearAttachments, composerDraftTargetId, selectedWorkspaceId]);

  const handleAgentRunCountChange = useCallback((agentId: string, count: number) => {
    const updated = updateComposerAgentRunCount(normalizedSelectedAgentRunCounts, agentId, count);
    const normalized = normalizeComposerAgentRunCounts(agents, agentId, updated);
    const nextSelectedAgentId = normalized[agentId] > 0
      ? agentId
      : Object.keys(normalized)[0] ?? agentId;

    setSelectedAgentRunCounts(normalized);
    setSelectedAgentId(nextSelectedAgentId);
  }, [agents, normalizedSelectedAgentRunCounts, setSelectedAgentId]);

  const handleModelPickerSelect = useCallback((agentId: string) => {
    if (!modelPickerTarget) return;

    if (modelPickerTarget.kind === 'add') {
      if ((normalizedSelectedAgentRunCounts[agentId] ?? 0) === 0) {
        const normalized = normalizeComposerAgentRunCounts(agents, agentId, {
          ...normalizedSelectedAgentRunCounts,
          [agentId]: 1,
        });
        setSelectedAgentRunCounts(normalized);
        setSelectedAgentId(agentId);
      }
      setModelPickerTarget(null);
      return;
    }

    const replacedAgentId = modelPickerTarget.agentId;
    if (replacedAgentId !== agentId) {
      const replacedCount = normalizedSelectedAgentRunCounts[replacedAgentId] ?? 1;
      const updated = { ...normalizedSelectedAgentRunCounts };
      delete updated[replacedAgentId];
      updated[agentId] = (updated[agentId] ?? 0) + replacedCount;
      const normalized = normalizeComposerAgentRunCounts(agents, agentId, updated);
      setSelectedAgentRunCounts(normalized);
      setSelectedAgentId(agentId);
    }
    setModelPickerTarget(null);
  }, [agents, modelPickerTarget, normalizedSelectedAgentRunCounts, setSelectedAgentId]);

  const handleBaseSelect = useCallback((item: typeof filteredBasePickerItems[number]) => {
    if (item.isDefault) {
      setSelectedBaseCommit(null);
      return;
    }
    setSelectedBaseCommit({
      sha: item.sha,
      label: item.primaryLabel || item.subject || shortCommitSha(item.sha),
      selectedFromNodeId: item.producedByNodeId,
    });
  }, []);

  const resetComposerTargetAfterSuccessfulSend = useCallback(() => {
    setComposerTargetMode((current) => resolveComposerTargetModeAfterSuccessfulSend(current));
    setPendingThreadId(null);
  }, []);

  const syncActiveMentions = useCallback((value: string, cursorPosition: number | null | undefined) => {
    if (!selectedWorkspaceId || cursorPosition == null) {
      setActiveFileMention(null);
      setActiveSkillMention(null);
      setActiveTemplateMention(null);
      return;
    }

    const nextFileMention = getActiveFileMention(value, cursorPosition);
    const nextTemplateMention = nextFileMention ? null : getActiveTemplateMention(value, cursorPosition);
    const nextSkillMention = nextFileMention || nextTemplateMention ? null : getActiveSkillMention(value, cursorPosition);
    setActiveFileMention(nextFileMention);
    setActiveTemplateMention(nextTemplateMention);
    setActiveSkillMention(nextSkillMention);
  }, [selectedWorkspaceId]);

  const handleFileMentionSelect = useCallback((file: RepoMentionFile) => {
    if (!activeFileMention) return;

    const currentPrompt = promptRef.current;
    const nextPrompt = `${currentPrompt.slice(0, activeFileMention.start)}@${file.path} ${currentPrompt.slice(activeFileMention.end)}`;
    const nextCursor = activeFileMention.start + file.path.length + 2;

    setPromptValue(nextPrompt);
    setActiveFileMention(null);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 80);
  }, [activeFileMention, setPromptValue]);

  const handleSkillMentionSelect = useCallback((skill: ProviderSkill) => {
    if (!activeSkillMention) return;

    const replacement = insertSkillMention(promptRef.current, activeSkillMention, skill.name);
    setPromptValue(replacement.value);
    setActiveSkillMention(null);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(replacement.cursor, replacement.cursor);
    }, 80);
  }, [activeSkillMention, setPromptValue]);

  const handleTemplateMentionSelect = useCallback((template: OrchestrationPromptTemplate) => {
    if (!activeTemplateMention) return;

    const mentionText = getTemplateMentionText(template);
    const currentPrompt = promptRef.current;
    const nextPrompt = `${currentPrompt.slice(0, activeTemplateMention.start)}${mentionText} ${currentPrompt.slice(activeTemplateMention.end)}`;
    const nextCursor = activeTemplateMention.start + mentionText.length + 1;

    setPromptValue(nextPrompt);
    setActiveTemplateMention(null);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 80);
  }, [activeTemplateMention, setPromptValue]);

  const handlePromptPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file != null);
    if (files.length === 0) return;
    event.preventDefault();
    composerAttachments.addFiles(files);
  }, [composerAttachments.addFiles]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (activeFileMention) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (activeMentionFiles.length > 0) {
          setActiveFileMentionIndex((current) => (current + 1) % activeMentionFiles.length);
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (activeMentionFiles.length > 0) {
          setActiveFileMentionIndex((current) => (current - 1 + activeMentionFiles.length) % activeMentionFiles.length);
        }
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        const selectedFile = activeMentionFiles[activeFileMentionIndex] ?? null;
        if (selectedFile) handleFileMentionSelect(selectedFile);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setActiveFileMention(null);
        return;
      }
    }

    if (activeSkillMention) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (activeMentionSkills.length > 0) {
          setActiveSkillMentionIndex((current) => (current + 1) % activeMentionSkills.length);
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (activeMentionSkills.length > 0) {
          setActiveSkillMentionIndex((current) => (current - 1 + activeMentionSkills.length) % activeMentionSkills.length);
        }
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        const selectedSkill = activeMentionSkills[activeSkillMentionIndex] ?? null;
        if (selectedSkill) handleSkillMentionSelect(selectedSkill);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setActiveSkillMention(null);
      }
    }

    if (activeTemplateMention) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (activeMentionTemplates.length > 0) {
          setActiveTemplateMentionIndex((current) => (current + 1) % activeMentionTemplates.length);
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (activeMentionTemplates.length > 0) {
          setActiveTemplateMentionIndex((current) => (current - 1 + activeMentionTemplates.length) % activeMentionTemplates.length);
        }
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        const selectedTemplate = activeMentionTemplates[activeTemplateMentionIndex] ?? null;
        if (selectedTemplate) handleTemplateMentionSelect(selectedTemplate);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setActiveTemplateMention(null);
      }
    }

    if (
      event.key === 'Escape'
      && !promptRef.current.trim()
      && composerAttachments.attachments.length === 0
      && onRequestClose
    ) {
      event.preventDefault();
      onRequestClose();
    }
  }, [
    activeFileMention,
    activeFileMentionIndex,
    activeMentionFiles,
    activeMentionSkills,
    activeMentionTemplates,
    activeSkillMention,
    activeSkillMentionIndex,
    activeTemplateMention,
    activeTemplateMentionIndex,
    composerAttachments.attachments.length,
    handleFileMentionSelect,
    handleSkillMentionSelect,
    handleTemplateMentionSelect,
    onRequestClose,
  ]);

  const handleSend = useCallback(async () => {
    const trimmedPrompt = promptRef.current.trim();
    const hasAttachments = composerAttachments.metadata.length > 0;
    if (!selectedWorkspaceId || (!trimmedPrompt && !hasAttachments) || isSteering || isCancellingRun) {
      recordSendFlowEvent('graph-dock.blocked', {
        workspaceId: selectedWorkspaceId,
        promptLength: trimmedPrompt.length,
        hasWorkspace: Boolean(selectedWorkspaceId),
        isSteering,
        isCancellingRun,
      }, { source: 'GraphDockComposer' });
      return;
    }
    if (isSteeringRunningAssistant && !trimmedPrompt) return;
    if (isSteeringRunningAssistant && target.parentMessageId) {
      setError(null);
      setIsSteering(true);
      try {
        await agentClient.steerAgentRun(target.parentMessageId, trimmedPrompt, crypto.randomUUID());
        clearComposerDraft(selectedWorkspaceId, composerDraftTargetId);
        clearPrompt();
        onSendComplete?.();
        window.setTimeout(() => textareaRef.current?.focus(), 0);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Failed to steer running agent.';
        setError(message);
      } finally {
        setIsSteering(false);
      }
      return;
    }
    const runsToSend = selectedAgentRunItems.length > 0
      ? selectedAgentRunItems
      : agent
        ? [{
          agentId: agent.id,
          agentName: agent.name,
          ordinal: 1,
          totalForAgent: 1,
          agent,
        }]
        : [];
    if (!agent || runsToSend.length === 0) {
      recordSendFlowEvent('graph-dock.blocked', {
        workspaceId: selectedWorkspaceId,
        reason: 'missing-agent',
        runCount: runsToSend.length,
      }, { source: 'GraphDockComposer' });
      setError('Select an agent before sending.');
      return;
    }
    if (!effectiveBase) {
      recordSendFlowEvent('graph-dock.blocked', {
        workspaceId: selectedWorkspaceId,
        reason: 'missing-base',
        runCount: runsToSend.length,
      }, { source: 'GraphDockComposer' });
      setError('No base commit is available for this workspace.');
      return;
    }

    const promptForAgent = trimmedPrompt;

    setError(null);
    let runsToLaunch: PreparedAgentRun[];
    try {
      runsToLaunch = prepareAgentRuns({
        runs: runsToSend,
        profiles: useLoginProfilesStore.getState().profiles,
      });
    } catch (caught) {
      if (caught instanceof AgentRunPreflightError) {
        const providers = new Set(caught.failures.map((failure) => failure.provider));
        providers.forEach((provider) => addToast(buildProviderLoginRequiredToast(provider)));
        return;
      }
      throw caught;
    }

    const attachmentsForSend = Object.freeze(
      composerAttachments.metadata.map((attachment) => Object.freeze({ ...attachment })),
    );
    const queuedSend = sendAcceptanceQueueRef.current!.submit(
      { prompt: promptForAgent },
      async (sendSnapshot, accepted) => {
        recordSendFlowEvent('graph-dock.submit', {
          workspaceId: selectedWorkspaceId,
          promptLength: sendSnapshot.prompt.length,
          parentMessageId: target.parentMessageId,
          runCount: runsToLaunch.length,
          agentId: agent?.id ?? null,
          baseCommitSha: effectiveBase.commitSha,
        }, { source: 'GraphDockComposer' });

        const acceptedRunKeys = new Set<string>();
        let didNotifySendComplete = false;
        const notifySendComplete = () => {
          if (didNotifySendComplete) return;
          didNotifySendComplete = true;
          onSendComplete?.();
        };
        const acceptRun = (runKey: string) => {
          acceptedRunKeys.add(runKey);
          if (acceptedRunKeys.size < runsToLaunch.length) return;
          // The entire batch is durable before the next queued batch begins.
          // Native launches continue independently after this boundary.
          accepted();
          notifySendComplete();
        };
        try {
          let threadId = target.parentMessageId ? null : pendingThreadId;
          if (!target.parentMessageId && selectedWorkspaceId && (!threadId || threadId.startsWith('workspace-empty-thread:'))) {
            const thread = await createThreadSession.mutateAsync({
              workspaceId: selectedWorkspaceId,
              source: 'user',
              baseCommitSha: effectiveBase.commitSha,
            });
            threadId = thread.id;
            setPendingThreadId(thread.id);
          }
          const specs = runsToLaunch.map((run) => createAgentRunSpec(run, {
            prompt: sendSnapshot.prompt,
            base: {
              commitSha: effectiveBase.commitSha,
              selectedFromNodeId: effectiveBase.selectedFromNodeId,
            },
            context: {
              parentMessageId: target.parentMessageId,
              contextParentId: effectiveContextParentId,
              contextPolicy: effectiveContextPolicy,
              contextStartId: effectiveContextStartId,
              threadId,
              threadOriginId: threadId,
              attachments: attachmentsForSend,
            },
          }));
          const shouldAutoCheckoutThisBatch = autoCheckoutOnAgentCommit && specs.length === 1;
          const focusOwnerRunKey = specs[0]?.runKey ?? null;
          const flowIdByRunKey = new Map(specs.map((spec) => [spec.runKey, createSendFlowId()]));
          const focusOwnerFlowId = focusOwnerRunKey ? flowIdByRunKey.get(focusOwnerRunKey) ?? null : null;
          if (focusOwnerFlowId) {
            beginComposerSendFocus({
              flowId: focusOwnerFlowId,
              workspaceId: selectedWorkspaceId,
              parentMessageId: target.parentMessageId,
            });
          }
          const assistantNodeIds = new Map<string, string>();
          const batchResults = await launchAgentRunBatch(specs, async (spec) => {
            const flowId = flowIdByRunKey.get(spec.runKey)!;
            try {
              return await sendHeadlessComposerMessage({
                workspaceId: selectedWorkspaceId,
                parentMessageId: spec.context.parentMessageId,
                contextParentId: spec.context.contextParentId,
                contextPolicy: spec.context.contextPolicy,
                contextStartId: spec.context.contextStartId,
                prompt: spec.prompt,
                attachments: spec.context.attachments,
                messages,
                agent: spec.agent,
                base: spec.base,
                workspaces: workspaces as Workspace[],
                startAgentRun: (payload) => agentClient.launchAgentMessage(payload as any),
                getAccessToken: getOptionalCloudAuthToken,
                seedAgentRun: (message) => agentRunManager.seed(message),
                dispatchAgentRun: (nodeId, event) => agentRunManager.dispatch(nodeId, event as any),
                persistLocalNode: (workspaceId, nodeId, message) => agentClient.upsertLocalNode(workspaceId, nodeId, message),
                onMessagesCreated: (createdMessages) => {
                  const createdUserMessage = createdMessages.find((message) => message.role === 'user') ?? null;
                  const createdAssistantMessage = createdMessages.find((message) => message.role === 'assistant') ?? null;
                  if (createdAssistantMessage) {
                    assistantNodeIds.set(spec.runKey, createdAssistantMessage.id);
                  }
                  queryClient.setQueryData<Message[]>(['messages', selectedWorkspaceId], (current) => {
                    const existing = current ?? [];
                    const ids = new Set(createdMessages.map((message) => message.id));
                    return [...existing.filter((message) => !ids.has(message.id)), ...createdMessages]
                      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
                  });
                  queryClient.setQueryData<LocalNodeMessage[]>(
                    localNodeKeys.workspace(selectedWorkspaceId),
                    (current) => upsertMessagesIntoLocalNodeCache(current, selectedWorkspaceId, createdMessages, {
                      syncStatus: 'local_only',
                      finalizedAt: Math.floor(Date.now() / 1000),
                    })
                  );
                  void queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(selectedWorkspaceId) });
                  if (spec.runKey === focusOwnerRunKey && createdUserMessage && createdAssistantMessage) {
                    acceptComposerSendFocus({
                      flowId,
                      workspaceId: selectedWorkspaceId,
                      userMessageId: createdUserMessage.id,
                      assistantMessageId: createdAssistantMessage.id,
                      parentMessageId: spec.context.parentMessageId,
                    });
                  }
                  acceptRun(spec.runKey);
                },
                onAssistantMessageCreated: (message) => {
                  assistantNodeIds.set(spec.runKey, message.id);
                },
                perfFlowId: flowId,
                perfSource: 'GraphDockComposer',
                setupProgress: 'Starting graph composer run...',
                selectedLoginProfileId: spec.loginProfileId,
                permissionMode,
                threadId: spec.context.threadId,
                threadOriginId: spec.context.threadOriginId,
                meta: {
                  composer_surface: surface,
                  composer_permission_mode: permissionMode,
                  auto_checkout_requested: shouldAutoCheckoutThisBatch,
                  base_source: effectiveBase.source,
                  agent_run_ordinal: spec.ordinal,
                  agent_run_total_for_agent: spec.totalForAgent,
                },
              });
            } catch (caught) {
              const assistantNodeId = assistantNodeIds.get(spec.runKey);
              if (assistantNodeId) {
                agentRunManager.dispatch(assistantNodeId, {
                  type: 'terminal',
                  status: 'failed',
                  reason: caught instanceof Error ? caught.message : 'Failed to send message.',
                });
                finishComposerSendFocus({
                  assistantMessageId: assistantNodeId,
                  workspaceId: selectedWorkspaceId,
                  terminalStatus: 'failed',
                });
              } else if (spec.runKey === focusOwnerRunKey) {
                cancelComposerSendFocus(flowId);
              }
              throw caught;
            }
          });
          const failedResults = batchResults.filter((entry) => entry.result.status === 'rejected');
          const successfulResultCount = batchResults.length - failedResults.length;
          if (failedResults.length > 0) {
            const firstFailure = failedResults[0].result;
            const message = firstFailure.status === 'rejected' && firstFailure.reason instanceof Error
              ? firstFailure.reason.message
              : `${failedResults.length} selected run${failedResults.length === 1 ? '' : 's'} failed to start.`;
            recordSendFlowEvent('graph-dock.error', {
              workspaceId: selectedWorkspaceId,
              parentMessageId: target.parentMessageId,
              message,
              failedRunCount: failedResults.length,
              successfulRunCount: successfulResultCount,
            }, { source: 'GraphDockComposer' });
            setError(message);
          }
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : 'Failed to send message.';
          recordSendFlowEvent('graph-dock.error', {
            workspaceId: selectedWorkspaceId,
            parentMessageId: target.parentMessageId,
            message,
          }, { source: 'GraphDockComposer' });
          setError(message);
        } finally {
          accepted();
          if (acceptedRunKeys.size > 0) notifySendComplete();
        }
      },
    );
    recordSendFlowEvent(queuedSend.queued ? 'queue.enqueued' : 'queue.acceptance-started', {
      workspaceId: selectedWorkspaceId,
      queuedSendId: queuedSend.id,
      queueDepth: sendAcceptanceQueueRef.current!.getState().queuedCount,
      parentId: target.parentMessageId,
      promptLength: promptForAgent.length,
    }, { source: 'GraphDockComposer' });
    clearComposerDraft(selectedWorkspaceId, composerDraftTargetId);
    setEditDraftSource(null);
    clearPrompt();
    composerAttachments.clearAttachments();
    resetComposerTargetAfterSuccessfulSend();
    await queuedSend.completion;
  }, [
    addToast,
    agent,
    autoCheckoutOnAgentCommit,
    clearComposerDraft,
    clearPrompt,
    composerAttachments.clearAttachments,
    composerAttachments.metadata,
    composerDraftTargetId,
    createThreadSession,
    effectiveBase,
    effectiveContextParentId,
    effectiveContextPolicy,
    effectiveContextStartId,
    isCancellingRun,
    isSteering,
    isSteeringRunningAssistant,
    messages,
    pendingThreadId,
    permissionMode,
    queryClient,
    resetComposerTargetAfterSuccessfulSend,
    selectedWorkspaceId,
    selectedAgentRunItems,
    target.parentMessageId,
    onSendComplete,
    surface,
    workspaces,
  ]);

  const handleCancelRunningAgent = useCallback(async () => {
    const nodeId = target.parentMessageId;
    if (!nodeId || !selectedWorkspaceId || isCancellingRun) return;

    setError(null);
    setIsCancellingRun(true);
    try {
      await agentClient.stopAgent(nodeId);
      agentRunManager.dispatch(nodeId, {
        type: 'cancel',
        reason: 'cancelled',
      }, {
        workspaceId: selectedWorkspaceId,
        parentId: parentMessage?.parentId ?? null,
        role: 'assistant',
        agentId: parentMessage?.agent_id ?? null,
        content: parentMessage?.content ?? '',
        executionData: (parentMessage?.execution_data ?? {}) as Record<string, any>,
      });
      void scheduleMessagesRefreshWhenGraphIdle(queryClient, selectedWorkspaceId, { reason: 'cancel-agent' });
    } catch (caught) {
      if (isNoAgentSessionFoundError(caught)) {
        const marked = await markStaleLocalAgentNodeCancelled({
          queryClient,
          workspaceId: selectedWorkspaceId,
          nodeId,
          node: parentMessage,
          reason: 'Run cancelled after the app restarted before the native agent session was created.',
        });
        if (marked) {
          agentRunManager.dispatch(nodeId, {
            type: 'cancel',
            reason: 'cancelled',
          }, {
            workspaceId: selectedWorkspaceId,
            parentId: parentMessage?.parentId ?? null,
            role: 'assistant',
            agentId: parentMessage?.agent_id ?? null,
            content: parentMessage?.content ?? '',
            executionData: (parentMessage?.execution_data ?? {}) as Record<string, any>,
          });
          void scheduleMessagesRefreshWhenGraphIdle(queryClient, selectedWorkspaceId, { reason: 'cancel-stale-local-node' });
          return;
        }
      }
      console.error('[GraphDockComposer] Failed to stop agent:', caught);
      setError('Unable to cancel the running agent.');
    } finally {
      setIsCancellingRun(false);
    }
  }, [isCancellingRun, parentMessage, queryClient, selectedWorkspaceId, target.parentMessageId]);

  const targetModeLabel = isRootComposerTarget ? 'New thread' : 'Reply to';
  const sendButtonLabel = isSteeringRunningAssistant ? 'Steer' : editDraftSource ? 'Edit and run' : 'Send';
  const sendButtonBusyLabel = isCancellingRun ? 'Cancelling' : isSteeringRunningAssistant ? 'Steering' : 'Sending';
  const sendButtonDisplayLabel = isBlockingPrimaryAction
    ? sendButtonBusyLabel
    : isSending
      ? sendAcceptanceState.queuedCount > 0
        ? `Queue ${sendAcceptanceState.queuedCount + 1}`
        : 'Queue'
      : sendButtonLabel;

  return (
    <div
      data-testid="graph-dock-composer"
      data-composer-surface={surface}
      aria-label={surface === 'graph' ? 'Graph composer' : surface === 'chat-panel' ? 'Chat composer' : 'Reply composer'}
      className={cn(
        'pointer-events-auto overflow-visible rounded-xl',
        surface === 'graph'
          ? 'mx-auto w-[min(50rem,calc(100vw-1rem))] max-w-4xl sm:w-[min(50rem,calc(100vw-7rem))]'
          : 'w-full max-w-none',
        'border border-[hsl(var(--app-border)/0.86)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-panel)/0.95))]',
        'shadow-[0_22px_70px_-40px_hsl(34_28%_18%/0.72),0_1px_0_hsl(44_80%_99%/0.72)_inset,0_-1px_0_hsl(var(--app-border)/0.26)_inset] backdrop-blur-xl'
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[hsl(var(--app-border)/0.68)] bg-[linear-gradient(180deg,hsl(var(--app-bg-elevated)/0.78),hsl(var(--app-panel)/0.58))] px-2.5 py-1.5 text-[11px]">
        <div className="grid min-w-0 max-w-[min(28rem,calc(100vw-5rem))] grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--background)/0.42)] px-2 py-1 shadow-[inset_0_1px_0_hsl(44_80%_99%/0.42)] sm:max-w-[30rem]">
          <span className="flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[hsl(var(--app-accent-soft)/0.74)] px-1.5 text-[10px] font-semibold text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.12)]">
            {isRootComposerTarget ? <Plus className="h-3 w-3" /> : <CornerDownRight className="h-3 w-3" />}
            {targetModeLabel}
          </span>
          <div className="min-w-0 text-[11px] font-medium leading-5 text-foreground/86" title={targetLabel}>
            <div className="truncate">{targetLabel}</div>
          </div>
        </div>
        <span className="hidden h-6 shrink-0 items-center rounded-md border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-bg-muted)/0.66)] px-2 font-mono text-[10px] font-semibold text-muted-foreground sm:flex">
          {base ? shortCommitSha(base.commitSha) : 'No base'}
        </span>
      </div>
      <div className="p-2">
        {editDraftSource ? (
          <div className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border border-[hsl(var(--app-warning)/0.28)] bg-[hsl(var(--app-warning)/0.08)] px-2.5 py-1.5 text-[11px] text-foreground">
            <div className="flex min-w-0 items-center gap-1.5">
              <Pencil className="h-3 w-3 shrink-0 text-[hsl(var(--app-warning))]" />
              <span className="shrink-0 font-semibold">Editing</span>
              <span className="truncate text-muted-foreground">{trimToWholeWords(editDraftSource.content || '', 80)}</span>
            </div>
            <button
              type="button"
              onClick={handleCancelEditDraft}
              className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--app-warning)/0.12)] hover:text-foreground"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        ) : null}
        <div className="relative">
          {activeFileMention ? (
            <div className="absolute inset-x-0 bottom-[calc(100%+8px)] z-50 overflow-hidden rounded-xl border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong)/0.98)] shadow-[0_20px_60px_-28px_rgba(15,23,42,0.45)] backdrop-blur-xl">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] font-semibold text-foreground">
                    <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                      <FileText className="h-3 w-3" />
                    </span>
                    Reference files
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    Search by file name or path. Enter to attach, Esc to dismiss.
                  </p>
                </div>
                {activeFileMention.query ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {activeFileMention.query}
                  </span>
                ) : null}
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
                            'flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                            isHighlighted ? 'bg-[hsl(var(--app-accent-soft))] text-foreground shadow-sm' : 'hover:bg-muted/60'
                          )}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-2 text-sm font-medium">
                              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--app-accent))]" />
                              <span className="truncate">{file.name}</span>
                            </span>
                            <span className="mt-1 block truncate pl-6 text-[11px] text-muted-foreground">{file.path}</span>
                          </span>
                          <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {isSelected ? 'Added' : 'Enter'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}
          {activeSkillMention ? (
            <div className="absolute inset-x-0 bottom-[calc(100%+8px)] z-50 overflow-hidden rounded-xl border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong)/0.98)] shadow-[0_20px_60px_-28px_rgba(15,23,42,0.45)] backdrop-blur-xl">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] font-semibold text-foreground">
                    <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                      <Puzzle className="h-3 w-3" />
                    </span>
                    Reference skills
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    Search skills for the selected provider. Enter to insert, Esc to dismiss.
                  </p>
                </div>
                {activeSkillMention.query ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {activeSkillMention.query}
                  </span>
                ) : null}
              </div>
              <div className="max-h-72 overflow-y-auto p-2">
                {providerSkillsQuery.isLoading ? (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 px-3 py-6 text-[12px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading skills...
                  </div>
                ) : providerSkillsQuery.error ? (
                  <div className="rounded-xl border border-dashed border-destructive/40 px-3 py-6 text-center text-[12px] text-destructive">
                    Skills could not be loaded.
                  </div>
                ) : activeMentionSkills.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/70 px-3 py-6 text-center text-[12px] text-muted-foreground">
                    No selected-provider skills match this query.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {activeMentionSkills.map((skill, index) => {
                      const isHighlighted = index === activeSkillMentionIndex;
                      const isSelected = skillMentionNameSet.has(skill.name);
                      return (
                        <button
                          key={skill.id}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleSkillMentionSelect(skill)}
                          className={cn(
                            'flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                            isHighlighted ? 'bg-[hsl(var(--app-accent-soft))] text-foreground shadow-sm' : 'hover:bg-muted/60'
                          )}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-2 text-sm font-medium">
                              <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--app-accent))]" />
                              <span className="truncate">{skill.name}</span>
                            </span>
                            <span className="mt-1 block truncate pl-6 text-[11px] text-muted-foreground">
                              {skill.description || skill.path}
                            </span>
                          </span>
                          <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {isSelected ? 'Added' : 'Enter'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}
          {activeTemplateMention ? (
            <div className="absolute inset-x-0 bottom-[calc(100%+8px)] z-50 overflow-hidden rounded-xl border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong)/0.98)] shadow-[0_20px_60px_-28px_rgba(15,23,42,0.45)] backdrop-blur-xl">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] font-semibold text-foreground">
                    <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                      <Workflow className="h-3 w-3" />
                    </span>
                    Orchestration
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    Select reusable node prompts or orchestration prompts.
                  </p>
                </div>
                {activeTemplateMention.query ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {activeTemplateMention.query}
                  </span>
                ) : null}
              </div>
              <div className="max-h-72 overflow-y-auto p-2">
                {activeMentionTemplates.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/70 px-3 py-6 text-center text-[12px] text-muted-foreground">
                    No orchestration items match this query.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {activeMentionTemplates.map((template, index) => {
                      const isHighlighted = index === activeTemplateMentionIndex;
                      const mentionText = getTemplateMentionText(template);
                      return (
                        <button
                          key={`${template.kind}:${template.id}`}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleTemplateMentionSelect(template)}
                          className={cn(
                            'flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                            isHighlighted ? 'bg-[hsl(var(--app-accent-soft))] text-foreground shadow-sm' : 'hover:bg-muted/60'
                          )}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-2 text-sm font-medium">
                              {template.kind === 'orchestration' ? (
                                <Workflow className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--app-accent))]" />
                              ) : (
                                <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--app-accent))]" />
                              )}
                              <span className="truncate">{mentionText}</span>
                            </span>
                            <span className="mt-1 block truncate pl-6 text-[11px] text-muted-foreground">
                              {template.prompt}
                            </span>
                          </span>
                          <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {template.kind === 'orchestration' ? 'Orchestration' : 'Node'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}
          <GraphDockPromptTextarea
            textareaRef={textareaRef}
            initialValue={promptSeed}
            resetVersion={promptResetVersion}
            disabled={isBlockingPrimaryAction}
            onPromptChange={updatePrompt}
            onDraftChange={savePromptDraft}
            onSelectionChange={syncActiveMentions}
            onPromptKeyDown={handlePromptKeyDown}
            onPaste={handlePromptPaste}
            onSubmit={() => void handleSend()}
            templates={orchestrationTemplates}
            ariaLabel={surface === 'graph' ? 'Graph composer prompt' : surface === 'chat-panel' ? 'Chat composer prompt' : 'Reply composer prompt'}
          />
        </div>
        {composerAttachments.attachments.length > 0 ? (
          <div data-testid="composer-attachment-previews" className="mt-1.5 flex max-w-full gap-2 overflow-x-auto px-0.5 py-1">
            {composerAttachments.attachments.map((attachment) => (
              <AttachmentPreview
                key={getComposerAttachmentId(attachment)}
                attachment={attachment}
                onRemove={composerAttachments.removeAttachment}
                size="small"
                className="shrink-0"
              />
            ))}
          </div>
        ) : null}
        <div data-testid="graph-dock-control-row" className="mt-1.5 grid min-w-0 grid-cols-3 gap-1.5 border-t border-[hsl(var(--app-border)/0.52)] px-0.5 pt-1.5">
          <DropdownMenu open={isBasePickerOpen} onOpenChange={setIsBasePickerOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Select code base commit"
                title="Base commit to use"
                disabled={isComposerConfigurationDisabled || !effectiveBase}
                className={cn(
                  dockControlButtonClass,
                  'w-full border-[hsl(var(--app-border-strong)/0.42)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.96),hsl(var(--app-accent-soft)/0.34)_52%,hsl(var(--app-panel)/0.86))]',
                  'shadow-[inset_0_1px_0_hsl(44_80%_99%/0.62),inset_0_-1px_0_hsl(var(--app-border)/0.28),0_9px_20px_-18px_hsl(34_28%_18%/0.58)]',
                  'hover:border-[hsl(var(--app-border-strong)/0.62)] hover:bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-accent-soft)/0.46)_52%,hsl(var(--app-panel)/0.9))]'
                )}
              >
                <GitBranchIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{effectiveBaseLabel}</span>
                <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">{effectiveBase ? shortCommitSha(effectiveBase.commitSha) : ''}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-0 shadow-xl backdrop-blur-xl">
              <div className="border-b border-border/60 p-2.5">
                <DropdownMenuLabel className="px-0 pb-2 pt-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Run from code base</DropdownMenuLabel>
                <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={baseCommitSearch}
                    onChange={(event) => setBaseCommitSearch(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                    placeholder="Search branches, commits, SHA"
                    className="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
                  />
                  {isBaseChoicesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
                </div>
                {baseChipItems.length > 0 ? (
                  <div className="mt-2 flex max-h-14 flex-wrap gap-1.5 overflow-hidden">
                    {baseChipItems.map((chip) => (
                      <button
                        key={chip.key}
                        type="button"
                        onClick={() => handleBaseSelect(chip.item)}
                        className={cn(
                          'max-w-[10rem] truncate rounded-full border px-2 py-1 text-[10px] font-medium transition-colors',
                          chip.item.selected
                            ? 'border-[hsl(var(--app-accent)/0.42)] bg-[hsl(var(--app-accent)/0.10)] text-foreground'
                            : 'border-border/70 bg-background/60 text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                        )}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="max-h-[min(19rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto p-1.5">
                {filteredBasePickerItems.length > 0 ? (
                  filteredBasePickerItems.map((item) => (
                    <DropdownMenuItem key={item.sha} onClick={() => handleBaseSelect(item)} className="min-h-11 gap-2 rounded-lg px-2 py-1.5" title={`${item.sha} ${item.subject}`.trim()}>
                      {item.selected ? <Check className="h-3.5 w-3.5" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-semibold">{item.primaryLabel}</div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground">{shortCommitSha(item.sha)} · {item.secondaryLabel}</div>
                      </div>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled className="min-h-10 rounded-lg px-2 py-1.5 text-xs text-muted-foreground">
                    {isBaseChoicesLoading ? 'Loading code bases...' : 'No matching code base'}
                  </DropdownMenuItem>
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Select context"
                title="Manually filter context if required."
                disabled={isComposerConfigurationDisabled}
                className={cn(
                  dockControlButtonClass,
                  'w-full border-[hsl(var(--app-border-strong)/0.42)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.96),hsl(var(--app-accent-soft)/0.34)_52%,hsl(var(--app-panel)/0.86))]',
                  'shadow-[inset_0_1px_0_hsl(44_80%_99%/0.62),inset_0_-1px_0_hsl(var(--app-border)/0.28),0_9px_20px_-18px_hsl(34_28%_18%/0.58)]',
                  'hover:border-[hsl(var(--app-border-strong)/0.62)] hover:bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-accent-soft)/0.46)_52%,hsl(var(--app-panel)/0.9))]',
                  effectiveContextPolicy === 'fresh' && 'border-[hsl(var(--app-accent)/0.42)] bg-[linear-gradient(180deg,hsl(var(--app-accent-soft)/0.58),hsl(var(--app-panel-strong)/0.94))] shadow-[inset_0_1px_0_hsl(44_80%_99%/0.54),inset_0_-1px_0_hsl(var(--app-accent)/0.16),0_11px_24px_-18px_hsl(34_28%_18%/0.62)]'
                )}
              >
                <History className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{contextParentLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-80 rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-xl backdrop-blur-xl">
              <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">End context</DropdownMenuLabel>
              {mergeContextOptions.length > 0 ? (
                mergeContextOptions.map((option) => {
                  const selected = effectiveContextPolicy === 'continue' && option.id === selectedMergeContextParentId;
                  return (
                    <DropdownMenuItem
                      key={option.id}
                      disabled={!target.parentMessageId}
                      onClick={() => {
                        setContextPolicy('continue');
                        setSelectedMergeContextParentId(option.id);
                      }}
                      className="min-h-11 gap-2 rounded-lg"
                      title={option.label}
                    >
                      <GitBranchIcon className="h-3.5 w-3.5" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{option.label.slice(0, 52)}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{option.role}</div>
                      </div>
                      {selected ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                    </DropdownMenuItem>
                  );
                })
              ) : (
                <DropdownMenuItem
                  disabled={!target.parentMessageId}
                  onClick={() => setContextPolicy('continue')}
                  className="min-h-11 gap-2 rounded-lg"
                  title={getMessagePreviewText(effectiveContextParentMessage) || 'Use inferred conversation context'}
                >
                  <GitBranchIcon className="h-3.5 w-3.5" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{formatContextParentLabel(effectiveContextParentMessage, 'No prior conversation')}</div>
                    <div className="truncate text-[11px] text-muted-foreground">Inferred from reply</div>
                  </div>
                  {effectiveContextPolicy === 'continue' ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                </DropdownMenuItem>
              )}
              {target.parentMessageId && effectiveContextPolicy === 'continue' && contextStartOptions.length > 0 ? (
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
                          <div className="truncate text-sm font-medium">{option.label.slice(0, 52)}</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {option.isFreshBoundary ? 'Fresh boundary' : option.id === defaultContextStartMessage?.id ? 'Inferred start' : option.role}
                          </div>
                        </div>
                        {selected ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                      </DropdownMenuItem>
                    );
                  })}
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setContextPolicy('fresh')} className="min-h-11 gap-2 rounded-lg">
                <RotateCcw className="h-3.5 w-3.5" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">Fresh context</div>
                  <div className="truncate text-[11px] text-muted-foreground">Start without inherited conversation context</div>
                </div>
                {effectiveContextPolicy === 'fresh' ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
              </DropdownMenuItem>
              {effectiveContextPolicy === 'continue' ? (
                <div className="px-2 pb-1 pt-1.5 text-[10.5px] text-muted-foreground">
                  Starts at {contextStartLabel}; ends at {contextParentLabel}.
                </div>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Select permissions"
                title={selectedPermissionOption.description}
                disabled={isComposerConfigurationDisabled}
                className={cn(
                  dockControlButtonClass,
                  'w-full border-[hsl(var(--app-border-strong)/0.42)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.96),hsl(var(--app-accent-soft)/0.34)_52%,hsl(var(--app-panel)/0.86))]',
                  'shadow-[inset_0_1px_0_hsl(44_80%_99%/0.62),inset_0_-1px_0_hsl(var(--app-border)/0.28),0_9px_20px_-18px_hsl(34_28%_18%/0.58)]',
                  'hover:border-[hsl(var(--app-border-strong)/0.62)] hover:bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-accent-soft)/0.46)_52%,hsl(var(--app-panel)/0.9))]',
                  permissionMode === 'full-access' && 'border-[hsl(var(--app-warning)/0.36)]'
                )}
              >
                <Shield className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{selectedPermissionOption.label}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-xl backdrop-blur-xl">
              <DropdownMenuLabel className="px-1.5 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Permissions</DropdownMenuLabel>
              {COMPOSER_PERMISSION_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  onClick={() => setPermissionMode(option.id)}
                  className="min-h-11 gap-2 rounded-lg px-2 py-1.5"
                >
                  {permissionMode === option.id ? <Check className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-semibold">{option.label}</div>
                    <div className="truncate text-[10.5px] text-muted-foreground">{option.description}</div>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5 pb-0.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
              {footerStatusText}
            </div>
            {selectedAgentRunChips.length > 0 ? (
              <Popover
                open={modelPickerTarget != null}
                onOpenChange={(open) => {
                  if (!open) setModelPickerTarget(null);
                }}
              >
                <PopoverAnchor asChild>
                  <div data-testid="graph-dock-selected-model-chips" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                    {selectedAgentRunChips.map(({ agent: chipAgent, count }) => {
                      const canRemove = selectedRunTotal > count;
                      const canDecrement = count > 1 || selectedRunTotal > 1;
                      return (
                        <div
                          key={chipAgent.id}
                          className="group/chip flex h-7 min-w-0 items-center rounded-md border border-[hsl(var(--app-border)/0.78)] bg-[hsl(var(--app-panel-strong)/0.72)] pr-0.5 text-[10.5px] font-semibold text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] transition-[background-color,border-color,box-shadow] duration-150 hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-panel)/0.9)]"
                        >
                          <button
                            type="button"
                            onClick={() => setModelPickerTarget({ kind: 'replace', agentId: chipAgent.id })}
                            disabled={isComposerConfigurationDisabled}
                            className="flex h-full min-w-0 items-center gap-1 rounded-md pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`Change ${chipAgent.name}`}
                          >
                            <span className="max-w-[104px] truncate">{chipAgent.name}</span>
                            <span className="rounded bg-muted/70 px-1.5 text-[9.5px] tabular-nums text-muted-foreground">
                              {count}x
                            </span>
                          </button>
                          <div className="ml-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/chip:opacity-100 group-focus-within/chip:opacity-100">
                            <button
                              type="button"
                              onClick={() => handleAgentRunCountChange(chipAgent.id, 0)}
                              disabled={!canRemove || isComposerConfigurationDisabled}
                              className="flex h-4 w-4 items-center justify-center rounded bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.75)] transition-[background-color,color,transform] hover:bg-red-50 hover:text-red-600 active:scale-[0.94] disabled:pointer-events-none disabled:opacity-35 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                              aria-label={`Remove ${chipAgent.name}`}
                            >
                              <X className="h-2.5 w-2.5" strokeWidth={2.5} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAgentRunCountChange(chipAgent.id, count - 1)}
                              disabled={!canDecrement || isComposerConfigurationDisabled}
                              className="flex h-4 w-4 items-center justify-center rounded bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.75)] transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.94] disabled:pointer-events-none disabled:opacity-35"
                              aria-label={`Decrease ${chipAgent.name}`}
                            >
                              <Minus className="h-2.5 w-2.5" strokeWidth={2.5} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAgentRunCountChange(chipAgent.id, count + 1)}
                              disabled={isComposerConfigurationDisabled}
                              className="flex h-4 w-4 items-center justify-center rounded bg-background text-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.75)] transition-[background-color,color,transform] hover:bg-muted active:scale-[0.96]"
                              aria-label={`Increase ${chipAgent.name}`}
                            >
                              <Plus className="h-2.5 w-2.5" strokeWidth={2.6} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setModelPickerTarget({ kind: 'add' })}
                      disabled={isComposerConfigurationDisabled || !selectedWorkspaceId}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.78)] bg-[hsl(var(--app-panel-strong)/0.72)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)] transition-[background-color,border-color,color,transform] hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-panel)/0.9)] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="Add model"
                    >
                      <Plus className="h-3 w-3" strokeWidth={2.5} />
                    </button>
                  </div>
                </PopoverAnchor>
                <PopoverContent disableAnimation className="h-[390px] w-[620px] p-0" side="top" align="start" sideOffset={8}>
                  <UnifiedAgentModelSelector
                    onSelectAgent={handleModelPickerSelect}
                    selectedAgentId={modelPickerTarget?.kind === 'replace' ? modelPickerTarget.agentId : null}
                    agentRunCounts={normalizedSelectedAgentRunCounts}
                    excludedAgentIds={modelPickerTarget?.kind === 'add' ? Object.keys(normalizedSelectedAgentRunCounts) : undefined}
                  />
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              aria-label="Auto checkout generated commit"
              aria-pressed={autoCheckoutOnAgentCommit && selectedRunTotal === 1}
              title={selectedRunTotal > 1
                ? 'Auto checkout is available only when launching one agent run.'
                : 'Automatically check out a generated commit when the run finishes'}
              disabled={isComposerConfigurationDisabled || !selectedWorkspaceId || selectedRunTotal > 1}
              onClick={() => setAutoCheckoutOnAgentCommit(!autoCheckoutOnAgentCommit)}
              className={cn(
                'flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border px-2 text-[10.5px] font-semibold transition-[background-color,border-color,color,transform]',
                'active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50',
                autoCheckoutOnAgentCommit && selectedRunTotal === 1
                  ? 'border-[hsl(var(--app-accent)/0.45)] bg-[hsl(var(--app-accent-soft)/0.72)] text-foreground'
                  : 'border-[hsl(var(--app-border)/0.78)] bg-[hsl(var(--app-panel-strong)/0.72)] text-muted-foreground hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-panel)/0.9)] hover:text-foreground'
              )}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">Checkout</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => {
                if (event.currentTarget.files) {
                  composerAttachments.addFiles(Array.from(event.currentTarget.files));
                }
                event.currentTarget.value = '';
              }}
              data-testid="composer-file-input"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isBlockingPrimaryAction || !selectedWorkspaceId}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--app-border)/0.78)] bg-[hsl(var(--app-panel-strong)/0.72)] text-muted-foreground transition-[background-color,border-color,color,transform] hover:border-[hsl(var(--app-border-strong)/0.72)] hover:bg-[hsl(var(--app-panel)/0.9)] hover:text-foreground active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Attach files"
              title="Attach files"
            >
              {composerAttachments.hasPendingUploads ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
            </button>
            {isSteeringRunningAssistant ? (
              <button
                type="button"
                data-testid="graph-dock-cancel-running-agent-button"
                disabled={isCancellingRun}
                onClick={() => void handleCancelRunningAgent()}
                className={cn(
                  'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[hsl(var(--app-border)/0.78)] px-2.5 text-xs font-semibold text-muted-foreground',
                  'bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.96),hsl(var(--app-panel)/0.84))] shadow-[inset_0_1px_0_hsl(44_80%_99%/0.44)]',
                  'transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]',
                  'hover:-translate-y-0.5 hover:border-destructive/35 hover:bg-destructive/10 hover:text-destructive active:translate-y-0',
                  'disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:border-[hsl(var(--app-border)/0.78)] disabled:hover:text-muted-foreground'
                )}
                aria-label="Cancel running agent"
                title="Cancel running agent"
              >
                {isCancellingRun ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-2.5 w-2.5 fill-current" />}
                <span className="hidden sm:inline">{isCancellingRun ? 'Stopping' : 'Cancel'}</span>
              </button>
            ) : null}
            <button
              type="button"
              data-testid="graph-dock-send-button"
              disabled={!canSend}
              onClick={() => void handleSend()}
              className={cn(
                'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold',
                'transition-[background-color,box-shadow,opacity,transform,filter] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]',
                canSend
                  ? 'bg-[hsl(var(--app-accent))] text-white shadow-[0_16px_36px_-20px_hsl(var(--app-accent)/0.68),inset_0_1px_0_hsl(44_80%_99%/0.24)] hover:-translate-y-0.5 hover:brightness-105 active:translate-y-0'
                  : 'cursor-not-allowed bg-muted text-muted-foreground opacity-60'
              )}
              aria-label={isSteeringRunningAssistant ? "Steer running agent" : "Send graph composer message"}
            >
              {isBlockingPrimaryAction ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              <span>{sendButtonDisplayLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
