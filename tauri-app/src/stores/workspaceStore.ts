import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { recordPerfEvent } from '../lib/perfRecorder';
import { createBestEffortStorage } from '../lib/bestEffortStorage';
import type { AgentStatus } from '@shared/agentStatus';

export interface Workspace {
  id: string;
  name: string;
  userId: string;
  folderPath?: string | null;
  snapshot_id?: string | null;
  repo_path?: string | null;
  git_repo_path?: string | null;
  local_repo_path?: string | null;
  localRepoPath?: string | null;
  connection_status?: 'connected' | 'missing' | 'remote_unconnected' | 'path_mismatch' | string | null;
  connectionStatus?: 'connected' | 'missing' | 'remote_unconnected' | 'path_mismatch' | string | null;
  sync_status?: 'sync_pending' | 'synced' | 'sync_error' | 'local_only' | string | null;
  syncStatus?: 'sync_pending' | 'synced' | 'sync_error' | 'local_only' | string | null;
  base_commit_sha?: string | null;
  agentArgs?: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: Message[];
}

export interface CommitEntity {
  id?: string;
  workspace_id?: string;
  sha: string;
  subject?: string | null;
  author_name?: string | null;
  author_email?: string | null;
  authored_at?: string | null;
  committer_name?: string | null;
  committer_email?: string | null;
  committed_at?: string | null;
  source_kind?: 'agent' | 'merge' | 'manual' | 'external' | string | null;
  produced_by_node_id?: string | null;
  first_parent_sha?: string | null;
  files_changed_count?: number | null;
  total_additions?: number | null;
  total_deletions?: number | null;
  parents?: Array<{ child_sha?: string; parent_sha: string; parent_index: number }>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CommitParentEntity {
  id?: string;
  workspace_id?: string;
  child_sha: string;
  parent_sha: string;
  parent_index: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CommitObservationEntity {
  id?: string;
  workspace_id?: string;
  commit_sha: string;
  git_ref?: string | null;
  source_kind?: 'external' | 'manual' | 'unknown' | string | null;
  first_seen_at?: string;
  last_seen_at?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BranchPointer {
  id: string;
  workspace_id: string;
  name: string;
  node_id?: string | null;
  commit_sha: string;
  git_ref: string;
  is_ship_path: boolean;
  createdAt: string;
  updatedAt: string;
  commit?: CommitEntity | null;
  node?: {
    id: string;
    output_commit_sha?: string | null;
    base_commit_sha?: string | null;
    base_selected_from_node_id?: string | null;
    git_branch_name?: string | null;
    content?: string | null;
    createdAt?: string;
  } | null;
}

export interface TrackedGitRef {
  id: string;
  workspace_id: string;
  git_ref: string;
  display_name: string;
  enabled: boolean;
  last_seen_commit_sha?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Summary {
  id: string;
  workspaceId: string;
  startMessageId: string;
  endMessageId: string;
  content: string;
  tokenCountBefore?: number;
  tokenCountAfter?: number;
  createdAt: string;
}

export interface AttachmentMetadata {
  path: string;
  publicUrl: string | null;
  filename: string;
  contentType: string;
}

export interface Citation {
  fileId: string;
  fileName: string;
  similarity: number;
  content?: string;
}

export interface Annotation {
  type: string;
  [key: string]: unknown;
}

export interface Comment {
  type: string;
  content: string;
  author: string;
  timestamp: string;
  metadata?: any;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  parentId: string | null;
  workspaceId: string;
  llmProvider?: string | null;
  llmModel?: string | null;
  attachments?: AttachmentMetadata[] | null;
  annotations?: Annotation[] | null;
  tags?: string[] | null;
  createdAt: string;
  updatedAt: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  processedContent?: string | null;
  reasoning?: string | null;
  followupQuestions?: string[] | null;
  aiLabel?: string | null;
  parentSummaryId?: string | null;
  citations?: Citation[] | null;
  comments?: Comment[] | null;
  agent_id?: string | null;
  status?: AgentStatus | null;
  node_delta?: any | null;
  path_ids?: string[] | null;
  depth?: number | null;
  execution_data?: any | null;
  threadId?: string | null;
  thread_id?: string | null;
  last_event_at?: string | null;
  lease_expires_at?: string | null;
  heartbeat_at?: string | null;
  collapsed?: boolean;
  context_active?: boolean | null;
  base_commit_sha?: string | null;
  output_commit_sha?: string | null;
  base_selected_from_node_id?: string | null;
  commit?: CommitEntity | null;
  git_branch_name?: string | null;
  branchPointers?: BranchPointer[] | null;
}

export interface ActiveSendFlowFocus {
  flowId: string;
  workspaceId: string;
  preferredMessageId: string | null;
  guardedMessageIds: string[];
  ownerFocusNonce: number;
  phase: 'optimistic-user' | 'real-user' | 'real-assistant' | 'commit' | 'completed';
}

export interface Insight {
  id: string;
  agentType: 'hypothesis' | 'doubt' | 'meta' | 'association' | 'memory' | 'kb';
  isLocal: boolean;
  content: string;
  fullExploration?: string;
  reasoning?: string;
  sourceWorkspaceId?: string;
  sourceFileId?: string;
  validationResults?: {
    confidence: number;
  };
  parentNodeId: string;
  createdAt: string;
}

export interface ComposerContextPreviewState {
  workspaceId: string | null;
  parentId: string | null;
  contextParentId: string | null;
  contextPolicy: 'continue' | 'fresh';
  contextStartId: string | null;
  baseCommitSha: string | null;
}

export interface ComposerBaseCommitOverrideState {
  workspaceId: string;
  commitSha: string;
  label?: string | null;
  source: 'graph-header';
}

export interface ThreadComposerTargetState {
  workspaceId: string;
  threadId: string;
  reason: 'create-thread' | 'empty-thread' | 'thread-origin';
  nonce: number;
}

interface WorkspaceState {
  selectedWorkspaceId: string | null;
  focusedMessageId: string | null;
  lastFocusSource: 'chat' | 'graph' | 'list' | 'system' | 'composer' | null;
  lastFocusMetadata: Record<string, unknown> | null;
  selectedMessageIds: string[];
  focusNonce: number;
  composerContextPreview: ComposerContextPreviewState | null;
  composerBaseCommitOverride: ComposerBaseCommitOverrideState | null;
  threadComposerTarget: ThreadComposerTargetState | null;
  composerDraftByWorkspace: Record<string, string>;
  lastFocusedMessageByWorkspace: Record<string, string>;
  recentFocusedMessageIdsByWorkspace: Record<string, string[]>;
  autoCheckoutOnAgentCommit: boolean;
  hoveredWorkspaceId: string | null;
  pendingInitialFocusId: string | null;
  disabledSummaryIds: string[];
  activeSendFlowFocus: ActiveSendFlowFocus | null;
  clearSelectedWorkspace: () => void;

  insights: Insight[];
  insightsEnabled: boolean;
  insightsVisible: boolean;
  showInsightsInGraph: boolean;
  isLoadingInsights: boolean;

  selectWorkspace: (id: string, initialFocusId?: string | null) => void;
  setHoveredWorkspace: (id: string | null) => void;
  beginSendFlowFocus: (input: ActiveSendFlowFocus) => void;
  advanceSendFlowFocus: (input: {
    flowId: string;
    preferredMessageId?: string | null;
    addGuardedMessageIds?: Array<string | null | undefined>;
    phase?: ActiveSendFlowFocus['phase'];
  }) => void;
  endSendFlowFocus: (flowId: string) => void;
  dispatchFocus: (input: {
    messageId: string | null;
    source: 'chat' | 'graph' | 'list' | 'system' | 'composer';
    entityId?: string;
    metadata?: Record<string, unknown>;
  }) => void;
  replaceSelectedMessageIds: (messageIds: string[]) => void;
  toggleSelectedMessageId: (messageId: string) => void;
  clearSelectedMessageIds: () => void;
  setComposerContextPreview: (preview: ComposerContextPreviewState | null) => void;
  setComposerBaseCommitOverride: (override: ComposerBaseCommitOverrideState | null) => void;
  setThreadComposerTarget: (target: ThreadComposerTargetState | null) => void;
  clearThreadComposerTarget: (nonce?: number) => void;
  getComposerDraft: (workspaceId: string | null | undefined) => string;
  setComposerDraft: (workspaceId: string | null | undefined, prompt: string) => void;
  clearComposerDraft: (workspaceId: string | null | undefined) => void;
  setAutoCheckoutOnAgentCommit: (enabled: boolean) => void;
  clearPendingInitialFocusId: () => void;
  toggleSummaryDisabled: (summaryId: string) => void;
  selectedAgentId: string | null;
  setSelectedAgentId: (agentId: string | null) => void;

  setInsights: (insights: Insight[]) => void;
  addInsights: (insights: Insight[]) => void;
  dismissInsight: (insightId: string) => void;
  clearInsights: () => void;
  toggleInsightsEnabled: () => void;
  toggleInsightsVisible: () => void;
  toggleShowInsightsInGraph: () => void;
  setLoadingInsights: (loading: boolean) => void;

  isFloatingChatInputOpen: boolean;
  floatingChatInputParentId: string | null;
  setFloatingChatInputOpen: (isOpen: boolean) => void;
  openFloatingChatInput: (parentId: string) => void;
  closeFloatingChatInput: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      selectedWorkspaceId: null,
      focusedMessageId: null,
      lastFocusSource: null,
      lastFocusMetadata: null,
      selectedMessageIds: [],
      focusNonce: 0,
      composerContextPreview: null,
      composerBaseCommitOverride: null,
      threadComposerTarget: null,
      composerDraftByWorkspace: {},
      lastFocusedMessageByWorkspace: {},
      recentFocusedMessageIdsByWorkspace: {},
      autoCheckoutOnAgentCommit: false,
      hoveredWorkspaceId: null,
      pendingInitialFocusId: null,
      disabledSummaryIds: [],
      activeSendFlowFocus: null,
      selectedAgentId: null,
      insights: [],
      insightsEnabled: true,
      insightsVisible: true,
      showInsightsInGraph: false,
      isLoadingInsights: false,
      isFloatingChatInputOpen: false,
      floatingChatInputParentId: null,

      clearSelectedWorkspace: () =>
        set({
          selectedWorkspaceId: null,
          pendingInitialFocusId: null,
          focusedMessageId: null,
          lastFocusSource: null,
          lastFocusMetadata: null,
          selectedMessageIds: [],
          focusNonce: 0,
          composerContextPreview: null,
          composerBaseCommitOverride: null,
          threadComposerTarget: null,
          composerDraftByWorkspace: {},
          activeSendFlowFocus: null,
          insights: [],
        }),

      selectWorkspace: (id, initialFocusId = null) =>
        set((state) => {
          const nextFocusId = initialFocusId ?? state.lastFocusedMessageByWorkspace[id] ?? null;
          return {
            selectedWorkspaceId: id,
            pendingInitialFocusId: initialFocusId,
            focusedMessageId: nextFocusId,
            lastFocusSource: initialFocusId ? 'system' : null,
            lastFocusMetadata: initialFocusId ? { reason: 'initial-focus' } : null,
            selectedMessageIds: [],
            focusNonce: Date.now(),
            composerContextPreview: null,
            composerBaseCommitOverride: null,
            threadComposerTarget: null,
            insights: [],
          };
        }),

      setHoveredWorkspace: (id) => set({ hoveredWorkspaceId: id }),

      beginSendFlowFocus: (input) => set({
        activeSendFlowFocus: {
          ...input,
          guardedMessageIds: Array.from(new Set(input.guardedMessageIds.filter(Boolean))),
        },
      }),

      advanceSendFlowFocus: ({ flowId, preferredMessageId, addGuardedMessageIds = [], phase }) =>
        set((state) => {
          if (state.activeSendFlowFocus?.flowId !== flowId) return state;
          return {
            activeSendFlowFocus: {
              ...state.activeSendFlowFocus,
              preferredMessageId: preferredMessageId !== undefined
                ? preferredMessageId
                : state.activeSendFlowFocus.preferredMessageId,
              phase: phase ?? state.activeSendFlowFocus.phase,
              guardedMessageIds: Array.from(new Set([
                ...state.activeSendFlowFocus.guardedMessageIds,
                ...addGuardedMessageIds.filter((value): value is string => typeof value === 'string' && value.length > 0),
              ])),
            },
          };
        }),

      endSendFlowFocus: (flowId) =>
        set((state) => (
          state.activeSendFlowFocus?.flowId === flowId
            ? { activeSendFlowFocus: null }
            : state
        )),

      dispatchFocus: ({ messageId, source, metadata }) =>
        set((state) => {
          const fallbackReason = typeof metadata?.reason === 'string' ? metadata.reason : null;
          const isSystemFallbackFocus =
            source === 'system' &&
            (fallbackReason === 'default-workspace-focus' || fallbackReason === 'restore-workspace-focus');
          if (isSystemFallbackFocus && state.focusedMessageId === messageId) {
            return state;
          }
          const activeSendFlowFocus = state.activeSendFlowFocus;
          const shouldBlockFallbackFocus =
            isSystemFallbackFocus &&
            activeSendFlowFocus?.workspaceId === state.selectedWorkspaceId &&
            (!!messageId && !activeSendFlowFocus.guardedMessageIds.includes(messageId));

          if (shouldBlockFallbackFocus) {
            recordPerfEvent('workspace.focus.blocked', {
              workspaceId: state.selectedWorkspaceId,
              attemptedMessageId: messageId,
              source,
              flowId: activeSendFlowFocus.flowId,
              metadata: metadata ?? null,
            }, { source: 'workspace-store' });
            return state;
          }
          recordPerfEvent('workspace.focus.dispatched', {
            workspaceId: state.selectedWorkspaceId,
            messageId,
            source,
            flowId: typeof metadata?.flowId === 'string' ? metadata.flowId : null,
            metadata: metadata ?? null,
          }, { source: 'workspace-store' });
          return {
            focusedMessageId: messageId,
            lastFocusSource: source,
            lastFocusMetadata: metadata ?? null,
            focusNonce: Date.now(),
            lastFocusedMessageByWorkspace: messageId && state.selectedWorkspaceId
              ? {
                  ...state.lastFocusedMessageByWorkspace,
                  [state.selectedWorkspaceId]: messageId,
                }
              : state.lastFocusedMessageByWorkspace,
            recentFocusedMessageIdsByWorkspace: messageId && state.selectedWorkspaceId
              ? {
                  ...state.recentFocusedMessageIdsByWorkspace,
                  [state.selectedWorkspaceId]: [
                    messageId,
                    ...(state.recentFocusedMessageIdsByWorkspace[state.selectedWorkspaceId] ?? []).filter((id) => id !== messageId),
                  ].slice(0, 16),
                }
              : state.recentFocusedMessageIdsByWorkspace,
          };
        }),

      replaceSelectedMessageIds: (messageIds) => set({ selectedMessageIds: messageIds }),
      toggleSelectedMessageId: (messageId) =>
        set((state) => ({
          selectedMessageIds: state.selectedMessageIds.includes(messageId)
            ? state.selectedMessageIds.filter((id) => id !== messageId)
            : [...state.selectedMessageIds, messageId],
        })),
      clearSelectedMessageIds: () => set({ selectedMessageIds: [] }),
      setComposerContextPreview: (preview) =>
        set((state) => {
          const current = state.composerContextPreview;
          if (
            current?.workspaceId === preview?.workspaceId &&
            current?.parentId === preview?.parentId &&
            current?.contextParentId === preview?.contextParentId &&
            current?.contextPolicy === preview?.contextPolicy &&
            current?.contextStartId === preview?.contextStartId &&
            current?.baseCommitSha === preview?.baseCommitSha
          ) {
            return state;
          }
          return { composerContextPreview: preview };
        }),
      setComposerBaseCommitOverride: (override) => set({ composerBaseCommitOverride: override }),
      setThreadComposerTarget: (target) => set({ threadComposerTarget: target }),
      clearThreadComposerTarget: (nonce) =>
        set((state) => {
          if (nonce !== undefined && state.threadComposerTarget?.nonce !== nonce) return state;
          return { threadComposerTarget: null };
        }),
      getComposerDraft: (workspaceId) => {
        if (!workspaceId) return '';
        return get().composerDraftByWorkspace[workspaceId] ?? '';
      },
      setComposerDraft: (workspaceId, prompt) => {
        if (!workspaceId) return;
        set((state) => ({
          composerDraftByWorkspace: {
            ...state.composerDraftByWorkspace,
            [workspaceId]: prompt,
          },
        }));
      },
      clearComposerDraft: (workspaceId) => {
        if (!workspaceId) return;
        set((state) => {
          const { [workspaceId]: _removed, ...rest } = state.composerDraftByWorkspace;
          return { composerDraftByWorkspace: rest };
        });
      },
      setAutoCheckoutOnAgentCommit: (enabled) => set({ autoCheckoutOnAgentCommit: enabled }),
      clearPendingInitialFocusId: () => set({ pendingInitialFocusId: null }),
      toggleSummaryDisabled: (summaryId) =>
        set((state) => ({
          disabledSummaryIds: state.disabledSummaryIds.includes(summaryId)
            ? state.disabledSummaryIds.filter((id) => id !== summaryId)
            : [...state.disabledSummaryIds, summaryId],
        })),
      setSelectedAgentId: (agentId) => set({ selectedAgentId: agentId }),

      setInsights: (insights) => set({ insights }),
      addInsights: (insights) => set((state) => ({ insights: [...state.insights, ...insights] })),
      dismissInsight: (insightId) =>
        set((state) => ({ insights: state.insights.filter((insight) => insight.id !== insightId) })),
      clearInsights: () => set({ insights: [] }),
      toggleInsightsEnabled: () => set((state) => ({ insightsEnabled: !state.insightsEnabled })),
      toggleInsightsVisible: () => set((state) => ({ insightsVisible: !state.insightsVisible })),
      toggleShowInsightsInGraph: () =>
        set((state) => ({ showInsightsInGraph: !state.showInsightsInGraph })),
      setLoadingInsights: (loading) => set({ isLoadingInsights: loading }),
      setFloatingChatInputOpen: (isOpen) => set((state) => ({
        isFloatingChatInputOpen: isOpen,
        floatingChatInputParentId: isOpen ? state.floatingChatInputParentId : null,
      })),
      openFloatingChatInput: (parentId) => set({
        isFloatingChatInputOpen: true,
        floatingChatInputParentId: parentId,
      }),
      closeFloatingChatInput: () => set({
        isFloatingChatInputOpen: false,
        floatingChatInputParentId: null,
      }),
    }),
    {
      name: 'workspace-storage',
      storage: createJSONStorage(() => createBestEffortStorage(
        () => localStorage,
        (error, key) => {
          recordPerfEvent('workspace.persist.failed', {
            key,
            error: error instanceof Error ? error.message : String(error),
          }, { source: 'workspace-store' });
        }
      )),
      partialize: (state) => ({
        selectedWorkspaceId: state.selectedWorkspaceId,
        focusedMessageId: state.focusedMessageId,
        lastFocusedMessageByWorkspace: state.lastFocusedMessageByWorkspace,
        recentFocusedMessageIdsByWorkspace: state.recentFocusedMessageIdsByWorkspace,
        focusNonce: state.focusNonce,
        autoCheckoutOnAgentCommit: state.autoCheckoutOnAgentCommit,
        disabledSummaryIds: state.disabledSummaryIds,
      }),
    }
  )
);
