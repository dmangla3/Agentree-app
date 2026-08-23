import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { Bot, Check, ChevronDown, CornerDownRight, FileText, GitBranchIcon, GitCommitHorizontal, History, Loader2, Minus, Pencil, Plus, Puzzle, RotateCcw, Search, Send, Workflow, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore, type Message, type Workspace } from '../stores/workspaceStore';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import { isLoginProfileActive } from '../lib/loginProfiles';
import { applyLocalNodeMessages } from '../hooks/useLiveMessages';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, type LocalNodeMessage } from '../hooks/useLocalNodes';
import { useAgents, type Agent } from '../hooks/useAgents';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useCommitAncestors, useCommitDescendants } from '../hooks/useMessages';
import { useCreateThreadSession } from '../hooks/useThreadSessions';
import { useAgentFlowRunner } from '../hooks/useAgentFlowRunner';
import { getEnabledTrackedGitRefs, useGitRefSnapshot } from '../hooks/useGitRefSnapshot';
import { useTrackedRefs } from '../hooks/useTrackedRefs';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { agentClient, type GitCommitMetadata, type SkillSummary } from '../lib/agentClient';
import { getAccessToken } from '../lib/authSession';
import { createSendFlowId, recordSendFlowEvent } from '../perf/sendFlow';
import {
  buildComposerCommitPickerChipItems,
  buildComposerCommitPickerItems,
  getVisibleRefName,
  shortCommitSha,
  type ComposerCommitPickerCommit,
} from '../lib/composerBaseCommit';
import { buildComposerContextManifest, buildComposerContextSelection } from '../lib/composerContext';
import { reconstructContext } from '../lib/contextUtils';
import { getMergeVisualParentEntries, isMergeResultNode } from '../lib/graph/lineage';
import { isFirstClassCommitMessage } from '../lib/graph/turnUtils';
import { hasFreshContextBoundary } from '../lib/messageContext';
import { isSteerableAssistantNode } from '../lib/agentRunSteering';
import { dispatchGraphComposerDockExpand } from '../lib/graphComposerDockEvents';
import { cn } from '../lib/utils';
import {
  buildComposerAgentRuns,
  normalizeComposerAgentRunCounts,
  updateComposerAgentRunCount,
  type ComposerAgentRunCounts,
} from '../lib/composerAgentRuns';
import {
  buildRepoMentionSearchIndex,
  extractRepoMentionPaths,
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
import { UnifiedAgentModelSelector } from '../components/UnifiedAgentModelSelector';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../../@/components/ui/popover';
import { sendHeadlessComposerMessage } from './headlessComposerSend';
import { resolveComposerTargetModeAfterSuccessfulSend } from '../lib/composerSendParent';
import {
  resolveGraphDockComposerAgent,
  resolveGraphDockComposerBase,
  resolveGraphDockComposerEffectiveAgentId,
  resolveGraphDockComposerRunCountsForEffectiveAgent,
  resolveGraphDockComposerTarget,
  shouldSubmitGraphDockComposerKey,
} from './graphDockComposerLogic';

const FLOW_NONE_ID = '__none__';
const FLOW_PARALLEL_MIN_COUNT = 2;
const FLOW_PARALLEL_MAX_COUNT = 8;
const GRAPH_DOCK_PROMPT_DRAFT_DEBOUNCE_MS = 300;

type ContextPolicy = 'continue' | 'fresh';
type ComposerTargetMode = 'reply' | 'new-thread';
type EditUserMessageEventDetail = { message?: Message };
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

const clampFlowParallelCount = (value: number): number => (
  Math.max(FLOW_PARALLEL_MIN_COUNT, Math.min(FLOW_PARALLEL_MAX_COUNT, Number.isFinite(value) ? Math.round(value) : FLOW_PARALLEL_MIN_COUNT))
);

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
  onPromptChange,
  onDraftChange,
  onSelectionChange,
  onPromptKeyDown,
  onSubmit,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  initialValue: string;
  resetVersion: number;
  disabled: boolean;
  onPromptChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSelectionChange: (value: string, cursorPosition: number | null | undefined) => void;
  onPromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
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
    <TextareaAutosize
      ref={textareaRef}
      data-testid="chat-composer-textarea"
      aria-label="Graph composer prompt"
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
      placeholder="Ask anything... Type @ for files or $ for skills"
      className="max-h-[216px] min-h-[58px] w-full resize-none overflow-y-auto rounded-lg bg-[hsl(var(--background)/0.44)] px-2.5 py-2 text-[13px] leading-5 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.54)] outline-none transition-[background-color,box-shadow] duration-150 placeholder:text-muted-foreground/68 focus:bg-[hsl(var(--background)/0.64)] focus:shadow-[inset_0_0_0_1px_hsl(var(--app-focus)/0.48),0_0_0_3px_hsl(var(--app-focus)/0.08)]"
      disabled={disabled}
      minRows={2}
      maxRows={10}
      cacheMeasurements
    />
  );
}

export function GraphDockComposer() {
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptRef = useRef('');
  const assistantNodeIdRef = useRef<string | null>(null);
  const [composerTargetMode, setComposerTargetMode] = useState<ComposerTargetMode>('reply');
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy>('continue');
  const [selectedBaseCommit, setSelectedBaseCommit] = useState<SelectedGraphBaseCommit | null>(null);
  const [baseCommitSearch, setBaseCommitSearch] = useState('');
  const [isBasePickerOpen, setIsBasePickerOpen] = useState(false);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [selectedMergeContextParentId, setSelectedMergeContextParentId] = useState<string | null>(null);
  const [selectedContextStartId, setSelectedContextStartId] = useState<string | null>(null);
  const [selectedAgentRunCounts, setSelectedAgentRunCounts] = useState<ComposerAgentRunCounts>({});
  const [flowParallelCount, setFlowParallelCount] = useState(3);
  const [promptSeed, setPromptSeed] = useState('');
  const [promptResetVersion, setPromptResetVersion] = useState(0);
  const [promptHasContent, setPromptHasContent] = useState(false);
  const [editDraftSource, setEditDraftSource] = useState<Message | null>(null);
  const [repoMentionFiles, setRepoMentionFiles] = useState<RepoMentionFile[]>([]);
  const [repoMentionCommit, setRepoMentionCommit] = useState<string | null>(null);
  const [activeFileMention, setActiveFileMention] = useState<ActiveFileMention | null>(null);
  const [activeFileMentionIndex, setActiveFileMentionIndex] = useState(0);
  const [activeSkillMention, setActiveSkillMention] = useState<ActiveSkillMention | null>(null);
  const [activeSkillMentionIndex, setActiveSkillMentionIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isSteering, setIsSteering] = useState(false);
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
    getComposerDraft,
    setComposerDraft,
    clearComposerDraft,
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
    getComposerDraft: state.getComposerDraft,
    setComposerDraft: state.setComposerDraft,
    clearComposerDraft: state.clearComposerDraft,
  })));
  const { data: agents = [] } = useAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const createThreadSession = useCreateThreadSession();
  const selectedWorkspace = useMemo(
    () => (workspaces as Workspace[]).find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces]
  );
  const selectedWorkspaceRepoPath = useMemo(
    () => selectedWorkspace?.git_repo_path?.trim() || selectedWorkspace?.folderPath?.trim() || null,
    [selectedWorkspace?.folderPath, selectedWorkspace?.git_repo_path]
  );
  const installedSkillsQuery = useQuery({
    queryKey: ['skills', 'installed'],
    queryFn: () => agentClient.listInstalledSkills('graph-composer-skills-installed'),
    enabled: Boolean(selectedWorkspaceId) && agentClient.hasRuntime(),
    staleTime: 30_000,
  });
  const installedSkills = useMemo(() => installedSkillsQuery.data ?? [], [installedSkillsQuery.data]);
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
  const shouldLoadBaseRefs = isBasePickerOpen || composerTargetMode === 'new-thread';
  const trackedRefsQuery = useTrackedRefs(shouldLoadBaseRefs ? selectedWorkspaceId : null);
  const enabledTrackedGitRefs = useMemo(
    () => getEnabledTrackedGitRefs(trackedRefsQuery.data ?? []),
    [trackedRefsQuery.data]
  );
  const gitRefSnapshotQuery = useGitRefSnapshot(
    isBasePickerOpen ? selectedWorkspaceRepoPath : null,
    enabledTrackedGitRefs
  );
  const currentHeadSha = gitRefSnapshotQuery.data?.head_sha?.trim() || null;
  const commitPickerRefsWithHead = useMemo(() => {
    const refs = localRefsQuery.data ?? [];
    if (!currentHeadSha) return refs;
    return [
      { git_ref: 'HEAD', short_name: 'HEAD', commit_sha: currentHeadSha },
      ...refs.filter((ref) => ref.git_ref !== 'HEAD'),
    ];
  }, [currentHeadSha, localRefsQuery.data]);
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
  const rawTarget = resolveGraphDockComposerTarget({
    focusedMessageId,
    lastFocusSource,
    lastFocusMetadata,
  });
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
  const selectedRunTotal = selectedAgentRuns.length;
  const base = resolveGraphDockComposerBase({
    targetMode: composerTargetMode,
    replyParentMessageId: target.parentMessageId,
    selectedNodeId: target.selectedNodeId,
    focusedCommitSha: target.focusedCommitSha,
    messages,
    refs: localRefsQuery.data ?? [],
    trackedRefs: trackedRefsQuery.data ?? [],
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
  const contextManifest = useMemo(() => {
    if (!target.parentMessageId || effectiveContextPolicy === 'fresh') {
      return buildComposerContextManifest([], new Set());
    }
    const selection = buildComposerContextSelection(
      target.parentMessageId,
      messages,
      effectiveContextParentId,
      effectiveContextPolicy,
      effectiveContextStartId
    );
    return buildComposerContextManifest(selection.turns, new Set(selection.defaultSelectedIds));
  }, [
    effectiveContextParentId,
    effectiveContextPolicy,
    effectiveContextStartId,
    messages,
    target.parentMessageId,
  ]);
  const flowRunner = useAgentFlowRunner({
    workspaceId: selectedWorkspaceId,
    selectedAgentId: agent?.id ?? null,
    selectedAgentType: agent?.type ?? null,
    baseNodeId: effectiveBase?.selectedFromNodeId ?? target.parentMessageId,
    baseCommitSha: effectiveBase?.commitSha ?? null,
    rootParentNodeId: target.parentMessageId,
    rootContextParentNodeId: effectiveContextParentId,
    rootContextManifest: contextManifest,
    agentCliArgs: agent?.cliArgs ?? null,
    agentPromptFlag: agent?.promptFlag ?? null,
    agentName: agent?.name ?? null,
    llmModel: agent?.model_config?.model ?? null,
    reasoningEffort: (agent?.model_config as any)?.reasoningEffort ?? null,
  });
  const selectedFlow = useMemo(
    () => flowRunner.flows.find((flow) => flow.id === flowRunner.selectedFlowId) ?? null,
    [flowRunner.flows, flowRunner.selectedFlowId]
  );
  const isFlowSelected = Boolean(selectedFlow);
  const isPrimaryActionBusy = isSending || isSteering;
  const isComposerConfigurationDisabled = isPrimaryActionBusy || isSteeringRunningAssistant;
  const canSend = Boolean(selectedWorkspaceId && promptHasContent && !isPrimaryActionBusy && (
    isSteeringRunningAssistant
      ? target.parentMessageId
      : effectiveBase && (isFlowSelected ? agent : selectedAgentRunItems.length > 0)
  ));
  const rootTargetLabel = composerTargetMode === 'new-thread' ? 'Thread root' : 'Workspace root';
  const targetLabel = previewText(parentMessage, target.parentMessageId ? 'Selected node' : rootTargetLabel);
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
    commitPickerRefsWithHead.filter((ref) => Boolean(getVisibleRefName(ref)))
  ), [commitPickerRefsWithHead]);
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
    trackedRefs: trackedRefsQuery.data ?? [],
    laterCommitShas,
    earlierCommitShas,
  }), [
    base?.commitSha,
    baseCommitPickerCommits,
    earlierCommitShas,
    effectiveBase?.commitSha,
    laterCommitShas,
    refPickerRefs,
    trackedRefsQuery.data,
  ]);
  const filteredBasePickerItems = useMemo(() => {
    const query = baseCommitSearch.trim().toLowerCase();
    if (!query) return basePickerItems;
    return basePickerItems.filter((item) => item.searchText.includes(query));
  }, [baseCommitSearch, basePickerItems]);
  const baseChipItems = useMemo(() => buildComposerCommitPickerChipItems({
    items: basePickerItems,
    refs: refPickerRefs,
    trackedRefs: trackedRefsQuery.data ?? [],
    headSha: currentHeadSha,
    commitRecencyBySha: new Map(baseCommitPickerCommits.map((commit) => {
      const timestamp = Date.parse(commit.committed_at || commit.authored_at || '');
      return [commit.sha, Number.isFinite(timestamp) ? timestamp : 0] as const;
    })),
    limit: 6,
  }), [baseCommitPickerCommits, basePickerItems, currentHeadSha, refPickerRefs, trackedRefsQuery.data]);
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
    () => getMentionedRepoPathSet(promptRef.current, repoMentionFilePathSet),
    [promptHasContent, repoMentionFilePathSet]
  );
  const skillMentionNameSet = useMemo(
    () => new Set(getSkillMentionNames(promptRef.current).filter((name) => installedSkills.some((skill: SkillSummary) => skill.name === name))),
    [installedSkills, promptHasContent]
  );
  const activeMentionFiles = useMemo(
    () => activeFileMention ? getRepoMentionMatches(repoMentionSearchIndex, activeFileMention.query, 8) : [],
    [activeFileMention, repoMentionSearchIndex]
  );
  const activeMentionSkills = useMemo(
    () => activeSkillMention ? getSkillMentionSuggestions(installedSkills, activeSkillMention.query, 8) : [],
    [activeSkillMention, installedSkills]
  );
  const isBaseChoicesLoading = localRefsQuery.isLoading || trackedRefsQuery.isLoading || gitRefSnapshotQuery.isLoading || lazyCommitsQuery.isLoading || baseCommitCandidatesQuery.isLoading || baseCommitAncestorsQuery.isLoading;
  const modelSelectorLabel = !isFlowSelected && selectedRunTotal > 1
    ? `${selectedRunTotal} runs`
    : agent?.name ?? 'Choose model';
  const footerStatusText = error ?? (isSteeringRunningAssistant ? 'Steer the running agent' : selectedFlow ? `${selectedFlow.label} · ${flowParallelCount} parallel runs` : '');
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
    const saved = getComposerDraft(selectedWorkspaceId);
    promptRef.current = saved;
    setPromptSeed(saved);
    setPromptHasContent(saved.trim().length > 0);
    setPromptResetVersion((version) => version + 1);
  }, [getComposerDraft, selectedWorkspaceId]);

  useEffect(() => {
    const handleEditUserMessage = (event: CustomEvent<EditUserMessageEventDetail>) => {
      const sourceMessage = event.detail?.message;
      if (!sourceMessage || sourceMessage.role !== 'user') return;
      if (sourceMessage.workspaceId !== selectedWorkspaceId) return;

      setEditDraftSource(sourceMessage);
      promptRef.current = sourceMessage.content || '';
      setPromptSeed(sourceMessage.content || '');
      setPromptHasContent(Boolean(sourceMessage.content?.trim()));
      setPromptResetVersion((version) => version + 1);
      setComposerDraft(selectedWorkspaceId, sourceMessage.content || '');
      setComposerTargetMode('reply');
      setPendingThreadId(null);
      setContextPolicy(sourceMessage.parentId ? 'continue' : 'fresh');
      setSelectedContextStartId(null);
      setSelectedMergeContextParentId(null);
      dispatchGraphComposerDockExpand();
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    };

    window.addEventListener('editUserMessage', handleEditUserMessage as EventListener);

    return () => {
      window.removeEventListener('editUserMessage', handleEditUserMessage as EventListener);
    };
  }, [selectedWorkspaceId, setComposerDraft]);

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
    if (!isFlowSelected || !effectiveSelectedAgentId) return;
    const nextCounts = { [effectiveSelectedAgentId]: 1 };
    if (!areAgentRunCountsEqual(normalizedSelectedAgentRunCounts, nextCounts)) {
      setSelectedAgentRunCounts(nextCounts);
    }
  }, [effectiveSelectedAgentId, isFlowSelected, normalizedSelectedAgentRunCounts]);

  useEffect(() => {
    let cancelled = false;
    const commit = effectiveBase?.commitSha?.trim() || null;
    if (!selectedWorkspaceRepoPath || !commit) {
      setRepoMentionFiles([]);
      setRepoMentionCommit(null);
      return;
    }

    const loadRepoMentionFiles = async () => {
      try {
        const repoPaths = await agentClient.listFilesAtCommit(selectedWorkspaceRepoPath, commit);
        if (cancelled) return;
        setRepoMentionCommit(commit);
        setRepoMentionFiles(repoPaths.map((path) => ({
          path,
          name: path.split('/').pop() || path,
        })));
      } catch (caught) {
        if (cancelled) return;
        console.warn('[GraphDockComposer] Failed to load repo mention files:', caught);
        setRepoMentionFiles([]);
        setRepoMentionCommit(null);
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
    if (selectedWorkspaceId) return;
    setActiveFileMention(null);
    setActiveSkillMention(null);
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
    const nextHasContent = value.trim().length > 0;
    setPromptHasContent((current) => (current === nextHasContent ? current : nextHasContent));
  }, []);

  const savePromptDraft = useCallback((value: string) => {
    setComposerDraft(selectedWorkspaceId, value);
  }, [selectedWorkspaceId, setComposerDraft]);

  const setPromptValue = useCallback((value: string) => {
    promptRef.current = value;
    setPromptSeed(value);
    setPromptHasContent(value.trim().length > 0);
    setPromptResetVersion((version) => version + 1);
    setComposerDraft(selectedWorkspaceId, value);
  }, [selectedWorkspaceId, setComposerDraft]);

  const clearPrompt = useCallback(() => {
    promptRef.current = '';
    setPromptSeed('');
    setPromptHasContent(false);
    setPromptResetVersion((version) => version + 1);
    setActiveFileMention(null);
    setActiveSkillMention(null);
  }, []);

  const handleCancelEditDraft = useCallback(() => {
    setEditDraftSource(null);
    clearPrompt();
    clearComposerDraft(selectedWorkspaceId);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [clearComposerDraft, clearPrompt, selectedWorkspaceId]);

  const handleAgentSelect = useCallback((agentId: string) => {
    if (isFlowSelected) {
      setSelectedAgentRunCounts({ [agentId]: 1 });
    }
    setSelectedAgentId(agentId);
  }, [isFlowSelected, setSelectedAgentId]);

  const handleAgentRunCountChange = useCallback((agentId: string, count: number) => {
    const updated = updateComposerAgentRunCount(normalizedSelectedAgentRunCounts, agentId, count);
    const normalized = normalizeComposerAgentRunCounts(agents, agentId, updated);
    const nextSelectedAgentId = normalized[agentId] > 0
      ? agentId
      : Object.keys(normalized)[0] ?? agentId;

    setSelectedAgentRunCounts(normalized);
    setSelectedAgentId(nextSelectedAgentId);
  }, [agents, normalizedSelectedAgentRunCounts, setSelectedAgentId]);

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

  const handleFlowSelection = useCallback((flowId: string) => {
    flowRunner.setSelectedFlowId(flowId === FLOW_NONE_ID ? '' : flowId);
  }, [flowRunner]);

  const resetComposerTargetAfterSuccessfulSend = useCallback(() => {
    setComposerTargetMode((current) => resolveComposerTargetModeAfterSuccessfulSend(current));
    setPendingThreadId(null);
  }, []);

  const updateFlowParallelCount = useCallback((value: number) => {
    setFlowParallelCount(clampFlowParallelCount(value));
  }, []);

  const syncActiveMentions = useCallback((value: string, cursorPosition: number | null | undefined) => {
    if (!selectedWorkspaceId || cursorPosition == null) {
      setActiveFileMention(null);
      setActiveSkillMention(null);
      return;
    }

    const nextFileMention = getActiveFileMention(value, cursorPosition);
    const nextSkillMention = nextFileMention ? null : getActiveSkillMention(value, cursorPosition);
    setActiveFileMention(nextFileMention);
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

  const handleSkillMentionSelect = useCallback((skill: SkillSummary) => {
    if (!activeSkillMention) return;

    const replacement = insertSkillMention(promptRef.current, activeSkillMention, skill.name);
    setPromptValue(replacement.value);
    setActiveSkillMention(null);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(replacement.cursor, replacement.cursor);
    }, 80);
  }, [activeSkillMention, setPromptValue]);

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
  }, [
    activeFileMention,
    activeFileMentionIndex,
    activeMentionFiles,
    activeMentionSkills,
    activeSkillMention,
    activeSkillMentionIndex,
    handleFileMentionSelect,
    handleSkillMentionSelect,
  ]);

  const expandRepoMentionContext = useCallback(async (rawPrompt: string) => {
    if (!selectedWorkspaceRepoPath || !repoMentionCommit) return rawPrompt;
    const mentionedPaths = Array.from(new Set(
      extractRepoMentionPaths(rawPrompt).filter((path) => repoMentionFilePathSet.has(path))
    ));
    if (mentionedPaths.length === 0) return rawPrompt;

    const fileBlocks = await Promise.all(mentionedPaths.slice(0, 8).map(async (filePath) => {
      const content = await agentClient.showFileAtCommit(selectedWorkspaceRepoPath, repoMentionCommit, filePath);
      return `Path: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
    }));

    return `${rawPrompt}\n\n[REPO FILE CONTEXT]\n${fileBlocks.join('\n\n')}`.trim();
  }, [repoMentionCommit, repoMentionFilePathSet, selectedWorkspaceRepoPath]);

  const handleSend = useCallback(async () => {
    const trimmedPrompt = promptRef.current.trim();
    if (!selectedWorkspaceId || !trimmedPrompt || isPrimaryActionBusy) {
      recordSendFlowEvent('graph-dock.blocked', {
        workspaceId: selectedWorkspaceId,
        promptLength: trimmedPrompt.length,
        hasWorkspace: Boolean(selectedWorkspaceId),
        isPrimaryActionBusy,
      }, { source: 'GraphDockComposer' });
      return;
    }
    if (isSteeringRunningAssistant && target.parentMessageId) {
      setError(null);
      setIsSteering(true);
      try {
        await agentClient.steerAgentRun(target.parentMessageId, trimmedPrompt, crypto.randomUUID());
        clearComposerDraft(selectedWorkspaceId);
        clearPrompt();
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
    if (!agent || (!selectedFlow && runsToSend.length === 0)) {
      recordSendFlowEvent('graph-dock.blocked', {
        workspaceId: selectedWorkspaceId,
        reason: 'missing-agent',
        selectedFlowId: selectedFlow?.id ?? null,
        runCount: runsToSend.length,
      }, { source: 'GraphDockComposer' });
      setError('Select an agent before sending.');
      return;
    }
    if (!effectiveBase) {
      recordSendFlowEvent('graph-dock.blocked', {
        workspaceId: selectedWorkspaceId,
        reason: 'missing-base',
        selectedFlowId: selectedFlow?.id ?? null,
        runCount: runsToSend.length,
      }, { source: 'GraphDockComposer' });
      setError('No base commit is available for this workspace.');
      return;
    }

    let promptForAgent = trimmedPrompt;
    try {
      promptForAgent = await expandRepoMentionContext(trimmedPrompt);
    } catch (caught) {
      console.warn('[GraphDockComposer] Failed to expand repo mention context:', caught);
    }

    setError(null);
    setIsSending(true);
    assistantNodeIdRef.current = null;
    recordSendFlowEvent('graph-dock.submit', {
      workspaceId: selectedWorkspaceId,
      promptLength: promptForAgent.length,
      parentMessageId: target.parentMessageId,
      selectedFlowId: selectedFlow?.id ?? null,
      runCount: selectedFlow ? flowParallelCount : runsToSend.length,
      agentId: agent?.id ?? null,
      baseCommitSha: effectiveBase.commitSha,
    }, { source: 'GraphDockComposer' });
    try {
      if (selectedFlow) {
        await flowRunner.runFlow({ input: promptForAgent, count: flowParallelCount });
        clearComposerDraft(selectedWorkspaceId);
        setEditDraftSource(null);
        clearPrompt();
        resetComposerTargetAfterSuccessfulSend();
        return;
      }

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
      for (const run of runsToSend) {
        const compatibleLoginProfiles = useLoginProfilesStore.getState().profiles
          .filter((profile) => profile.provider === run.agent.type);
        const selectedLoginProfileId =
          compatibleLoginProfiles.find((profile) => profile.isDefault)?.id
          ?? compatibleLoginProfiles[0]?.id
          ?? null;
        const selectedLoginProfile = compatibleLoginProfiles.find((profile) => profile.id === selectedLoginProfileId) ?? null;
        if (compatibleLoginProfiles.length > 0 && (!selectedLoginProfile || !isLoginProfileActive(selectedLoginProfile))) {
          setError(`${run.agent.name ?? run.agent.type} needs a ready login profile before it can run.`);
          return;
        }
        const flowId = createSendFlowId();
        await sendHeadlessComposerMessage({
          workspaceId: selectedWorkspaceId,
          parentMessageId: target.parentMessageId,
          contextParentId: effectiveContextParentId,
          contextPolicy: effectiveContextPolicy,
          contextStartId: effectiveContextStartId,
          prompt: promptForAgent,
          messages,
          agent: run.agent,
          base: {
            commitSha: effectiveBase.commitSha,
            selectedFromNodeId: effectiveBase.selectedFromNodeId,
          },
          workspaces: workspaces as Workspace[],
          hasRuntime: () => agentClient.hasRuntime(),
          startAgentRun: (payload) => agentClient.startAgentRun(payload as any),
          getAccessToken,
          seedAgentRun: (message) => agentRunManager.seed(message),
          dispatchAgentRun: (nodeId, event) => agentRunManager.dispatch(nodeId, event as any),
          persistLocalNode: (workspaceId, nodeId, message) => agentClient.upsertLocalNode(workspaceId, nodeId, message),
          onMessagesCreated: (createdMessages) => {
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
          },
          onAssistantMessageCreated: (message) => {
            assistantNodeIdRef.current = message.id;
          },
          perfFlowId: flowId,
          perfSource: 'GraphDockComposer',
          setupProgress: 'Starting graph composer run...',
          selectedLoginProfileId: selectedLoginProfile?.id ?? null,
          threadId,
          threadOriginId: threadId,
          meta: {
            composer_surface: 'graph-dock',
            base_source: effectiveBase.source,
            agent_run_ordinal: run.ordinal,
            agent_run_total_for_agent: run.totalForAgent,
          },
        });
      }
      clearComposerDraft(selectedWorkspaceId);
      setEditDraftSource(null);
      clearPrompt();
      resetComposerTargetAfterSuccessfulSend();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to send message.';
      recordSendFlowEvent('graph-dock.error', {
        workspaceId: selectedWorkspaceId,
        parentMessageId: target.parentMessageId,
        selectedFlowId: selectedFlow?.id ?? null,
        message,
      }, { source: 'GraphDockComposer' });
      if (assistantNodeIdRef.current) {
        agentRunManager.dispatch(assistantNodeIdRef.current, {
          type: 'terminal',
          status: 'failed',
          reason: message,
        });
      }
      setError(message);
    } finally {
      setIsSending(false);
    }
  }, [
    agent,
    clearComposerDraft,
    clearPrompt,
    createThreadSession,
    effectiveBase,
    effectiveContextParentId,
    effectiveContextPolicy,
    effectiveContextStartId,
    expandRepoMentionContext,
    flowParallelCount,
    flowRunner,
    isPrimaryActionBusy,
    isSteeringRunningAssistant,
    messages,
    pendingThreadId,
    queryClient,
    resetComposerTargetAfterSuccessfulSend,
    selectedWorkspaceId,
    selectedAgentRunItems,
    selectedFlow,
    target.parentMessageId,
    workspaces,
  ]);

  const targetModeLabel = composerTargetMode === 'new-thread' ? 'New thread' : 'Reply to';
  const sendButtonLabel = isSteeringRunningAssistant ? 'Steer' : editDraftSource ? 'Edit and run' : selectedFlow ? 'Run Flow' : 'Send';
  const sendButtonBusyLabel = isSteeringRunningAssistant ? 'Steering' : 'Sending';

  return (
    <div
      data-testid="graph-dock-composer"
      className={cn(
        'pointer-events-auto mx-auto w-[min(50rem,calc(100vw-1rem))] max-w-4xl overflow-visible rounded-xl sm:w-[min(50rem,calc(100vw-7rem))]',
        'border border-[hsl(var(--app-border)/0.86)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-panel)/0.95))]',
        'shadow-[0_22px_70px_-40px_hsl(34_28%_18%/0.72),0_1px_0_hsl(44_80%_99%/0.72)_inset,0_-1px_0_hsl(var(--app-border)/0.26)_inset] backdrop-blur-xl'
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[hsl(var(--app-border)/0.68)] bg-[linear-gradient(180deg,hsl(var(--app-bg-elevated)/0.78),hsl(var(--app-panel)/0.58))] px-2.5 py-1.5 text-[11px]">
        <div className="grid min-w-0 max-w-[min(28rem,calc(100vw-5rem))] grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--background)/0.42)] px-2 py-1 shadow-[inset_0_1px_0_hsl(44_80%_99%/0.42)] sm:max-w-[30rem]">
          <span className="flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[hsl(var(--app-accent-soft)/0.74)] px-1.5 text-[10px] font-semibold text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.12)]">
            {composerTargetMode === 'new-thread' ? <Plus className="h-3 w-3" /> : <CornerDownRight className="h-3 w-3" />}
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
                    Search installed skills. Enter to insert, Esc to dismiss.
                  </p>
                </div>
                {activeSkillMention.query ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {activeSkillMention.query}
                  </span>
                ) : null}
              </div>
              <div className="max-h-72 overflow-y-auto p-2">
                {installedSkillsQuery.isLoading ? (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 px-3 py-6 text-[12px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading skills...
                  </div>
                ) : installedSkillsQuery.error ? (
                  <div className="rounded-xl border border-dashed border-destructive/40 px-3 py-6 text-center text-[12px] text-destructive">
                    Skills could not be loaded.
                  </div>
                ) : activeMentionSkills.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/70 px-3 py-6 text-center text-[12px] text-muted-foreground">
                    No installed skills match this query.
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
                              {skill.description || skill.id}
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
          <GraphDockPromptTextarea
            textareaRef={textareaRef}
            initialValue={promptSeed}
            resetVersion={promptResetVersion}
            disabled={isPrimaryActionBusy}
            onPromptChange={updatePrompt}
            onDraftChange={savePromptDraft}
            onSelectionChange={syncActiveMentions}
            onPromptKeyDown={handlePromptKeyDown}
            onSubmit={() => void handleSend()}
          />
        </div>
        <div data-testid="graph-dock-control-row" className="mt-1.5 grid min-w-0 grid-cols-2 gap-1.5 border-t border-[hsl(var(--app-border)/0.52)] px-0.5 pt-1.5 md:grid-cols-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Select flow"
                title="Select a flow to run multiple agents in a predefined flow."
                disabled={isComposerConfigurationDisabled || !selectedWorkspaceId}
                className={cn(
                  dockControlButtonClass,
                  'w-full border-[hsl(var(--app-border-strong)/0.42)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.96),hsl(var(--app-accent-soft)/0.34)_52%,hsl(var(--app-panel)/0.86))]',
                  'shadow-[inset_0_1px_0_hsl(44_80%_99%/0.62),inset_0_-1px_0_hsl(var(--app-border)/0.28),0_9px_20px_-18px_hsl(34_28%_18%/0.58)]',
                  'hover:border-[hsl(var(--app-border-strong)/0.62)] hover:bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-accent-soft)/0.46)_52%,hsl(var(--app-panel)/0.9))]',
                  isFlowSelected && 'border-[hsl(var(--app-accent)/0.42)] bg-[linear-gradient(180deg,hsl(var(--app-accent-soft)/0.58),hsl(var(--app-panel-strong)/0.94))] shadow-[inset_0_1px_0_hsl(44_80%_99%/0.54),inset_0_-1px_0_hsl(var(--app-accent)/0.16),0_11px_24px_-18px_hsl(34_28%_18%/0.62)]'
                )}
              >
                <Workflow className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{selectedFlow?.label ?? 'No flow'}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-[min(21rem,calc(100vw-1.5rem))] rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-xl backdrop-blur-xl">
              <DropdownMenuLabel className="px-1.5 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Flow</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => handleFlowSelection(FLOW_NONE_ID)} className="min-h-9 gap-2 rounded-lg px-2 py-1.5">
                {!isFlowSelected ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold">None</div>
                  <div className="truncate text-[10.5px] text-muted-foreground">Send a normal agent request</div>
                </div>
              </DropdownMenuItem>
              {flowRunner.flows.length > 0 ? <DropdownMenuSeparator /> : null}
              {flowRunner.flows.map((flow) => (
                <DropdownMenuItem key={flow.id} onClick={() => handleFlowSelection(flow.id)} className="min-h-10 gap-2 rounded-lg px-2 py-1.5">
                  {flow.id === flowRunner.selectedFlowId ? <Check className="h-3.5 w-3.5" /> : <Workflow className="h-3.5 w-3.5" />}
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-semibold">{flow.label}</div>
                    <div className="truncate text-[10.5px] text-muted-foreground">Run a predefined multi-agent flow</div>
                  </div>
                </DropdownMenuItem>
              ))}
              {isFlowSelected ? (
                <div className="mt-1 rounded-lg border border-border/65 bg-background/72 px-2 py-2" onClick={(event) => event.stopPropagation()}>
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Parallel count</div>
                  <input
                    aria-label="Parallel count"
                    type="number"
                    min={FLOW_PARALLEL_MIN_COUNT}
                    max={FLOW_PARALLEL_MAX_COUNT}
                    value={flowParallelCount}
                    onChange={(event) => updateFlowParallelCount(Number(event.target.value))}
                    onKeyDown={(event) => event.stopPropagation()}
                    className="h-7 w-16 rounded-md border border-[hsl(var(--app-border))] bg-transparent text-center text-xs font-semibold outline-none"
                  />
                </div>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover open={isAgentPickerOpen} onOpenChange={setIsAgentPickerOpen}>
            <PopoverTrigger
              type="button"
              aria-label="Select model"
              title="Select one or more models to run."
              disabled={isComposerConfigurationDisabled || !selectedWorkspaceId}
              className={cn(
                dockControlButtonClass,
                'w-full border-[hsl(var(--app-border-strong)/0.42)] bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.96),hsl(var(--app-accent-soft)/0.34)_52%,hsl(var(--app-panel)/0.86))]',
                'shadow-[inset_0_1px_0_hsl(44_80%_99%/0.62),inset_0_-1px_0_hsl(var(--app-border)/0.28),0_9px_20px_-18px_hsl(34_28%_18%/0.58)]',
                'hover:border-[hsl(var(--app-border-strong)/0.62)] hover:bg-[linear-gradient(180deg,hsl(var(--app-panel-strong)/0.98),hsl(var(--app-accent-soft)/0.46)_52%,hsl(var(--app-panel)/0.9))]'
              )}
            >
              <Bot className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{modelSelectorLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent disableAnimation className="h-[390px] w-[620px] p-0" side="top" align="start" sideOffset={8}>
              <UnifiedAgentModelSelector
                onSelectAgent={handleAgentSelect}
                selectedAgentId={agent?.id ?? selectedAgentId}
                agentRunCounts={!isFlowSelected ? normalizedSelectedAgentRunCounts : undefined}
                onAgentRunCountChange={!isFlowSelected ? handleAgentRunCountChange : undefined}
              />
            </PopoverContent>
          </Popover>

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
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5 pb-0.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
              {footerStatusText}
            </div>
            {!isFlowSelected && selectedAgentRunChips.length > 0 ? (
              <div data-testid="graph-dock-selected-model-chips" className="hidden min-w-0 flex-1 items-center gap-1 sm:flex">
                {selectedAgentRunChips.slice(0, 3).map(({ agent: chipAgent, count }) => {
                  const canRemove = selectedRunTotal > count;
                  const canDecrement = count > 1 || selectedRunTotal > 1;
                  return (
                    <div
                      key={chipAgent.id}
                      className="group/chip flex h-6 min-w-0 items-center gap-1 rounded-full border border-[hsl(var(--app-warning)/0.24)] bg-[hsl(var(--app-warning)/0.08)] py-0.5 pl-2 pr-0.5 text-[10.5px] font-semibold text-foreground shadow-none transition-colors duration-150 hover:border-[hsl(var(--app-warning)/0.34)]"
                    >
                      <span className="max-w-[104px] truncate">{chipAgent.name}</span>
                      <span className="rounded-full bg-[hsl(var(--app-warning)/0.14)] px-1.5 text-[9.5px] tabular-nums text-[hsl(var(--app-warning))]">
                        {count}x
                      </span>
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
                          className="flex h-4 w-4 items-center justify-center rounded bg-[hsl(var(--app-success))] text-white transition-[background-color,transform] hover:brightness-105 active:scale-[0.94]"
                          aria-label={`Increase ${chipAgent.name}`}
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
            {isPrimaryActionBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            <span>{isPrimaryActionBusy ? sendButtonBusyLabel : sendButtonLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
