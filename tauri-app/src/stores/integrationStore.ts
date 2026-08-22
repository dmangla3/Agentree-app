import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  GitMergePreview,
  MergeResolutionSynthesisResult,
  MergeReviewIssue,
  MergeReviewResult,
  MergeReviewRunStatus,
  MergeReviewSummary,
  MergeReviewTimelineEvent,
} from '../lib/agentClient';
import { createBestEffortStorage } from '../lib/bestEffortStorage';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ResolutionMode = 'smart' | 'manual';
export type IntegrationStage = 'setup' | 'smart-resolution' | 'result';
export type FileDecisionAction = 'keep-target' | 'take-source' | 'use-base' | 'manual' | 'pending';
export type FileGroup = 'auto-apply' | 'needs-review' | 'conflicted' | 'blocked';

export interface MergeSource {
  id: string;
  type: 'graph-node' | 'tracked-ref' | 'external-commit' | 'sha';
  label: string;
  commitSha: string;
  branchName?: string | null;
  nodeId?: string;
}

export interface MergeSourceCommitNode {
  sha: string;
  parentShas: string[];
}

export interface MergeSourcePrunePlan {
  sourcesToAdd: MergeSource[];
  sourceIdsToRemove: string[];
  skippedSources: MergeSource[];
}

export function isCommitAncestorOf(
  ancestorSha: string,
  descendantSha: string,
  commitsBySha: Map<string, Pick<MergeSourceCommitNode, 'sha' | 'parentShas'>>
): boolean {
  if (!ancestorSha || !descendantSha || ancestorSha === descendantSha) return false;

  const seen = new Set<string>();
  const stack = [...(commitsBySha.get(descendantSha)?.parentShas ?? [])];

  while (stack.length > 0) {
    const sha = stack.pop();
    if (!sha || seen.has(sha)) continue;
    if (sha === ancestorSha) return true;

    seen.add(sha);
    stack.push(...(commitsBySha.get(sha)?.parentShas ?? []));
  }

  return false;
}

export function getMergeSourcePrunePlan(
  existingSources: MergeSource[],
  incomingSources: MergeSource[],
  commitsBySha: Map<string, Pick<MergeSourceCommitNode, 'sha' | 'parentShas'>>
): MergeSourcePrunePlan {
  const activeSources = [...existingSources];
  const existingSourceIds = new Set(existingSources.map((source) => source.id));
  const inactiveSourceIds = new Set<string>();
  const sourceIdsToRemove = new Set<string>();
  const sourcesToAdd: MergeSource[] = [];
  const skippedSources: MergeSource[] = [];

  const isActiveSource = (source: MergeSource) => !inactiveSourceIds.has(source.id);
  const deactivateSource = (source: MergeSource) => {
    inactiveSourceIds.add(source.id);
    if (existingSourceIds.has(source.id)) {
      sourceIdsToRemove.add(source.id);
    } else {
      skippedSources.push(source);
    }
  };

  for (const incomingSource of incomingSources) {
    const currentSources = activeSources.filter(isActiveSource);
    const ancestorSourcesToPrune = currentSources.filter((source) => (
      source.id !== incomingSource.id
      && source.commitSha !== incomingSource.commitSha
      && isCommitAncestorOf(source.commitSha, incomingSource.commitSha, commitsBySha)
    ));
    const isAlreadyCovered = currentSources.some((source) => (
      source.id === incomingSource.id
      || source.commitSha === incomingSource.commitSha
      || isCommitAncestorOf(incomingSource.commitSha, source.commitSha, commitsBySha)
    ));

    for (const source of ancestorSourcesToPrune) {
      deactivateSource(source);
    }

    if (isAlreadyCovered) {
      skippedSources.push(incomingSource);
      continue;
    }

    activeSources.push(incomingSource);
    sourcesToAdd.push(incomingSource);
  }

  return {
    sourcesToAdd: sourcesToAdd.filter(isActiveSource),
    sourceIdsToRemove: Array.from(sourceIdsToRemove),
    skippedSources,
  };
}

export interface MergeTarget {
  id: string;
  type: 'graph-node' | 'tracked-ref' | 'external-commit' | 'sha';
  label: string;
  commitSha: string;
  branchName?: string | null;
  nodeId?: string;
}

export interface MergePolicy {
  preserveTargetBehavior: boolean;
  preferSourceForPaths: string[];
  doNotModifyLockfiles: boolean;
  stopOnBinaryConflicts: boolean;
  runTestsAfterMerge: boolean;
  summarizeRiskyResolutions: boolean;
}

export interface FileDecision {
  path: string;
  action: FileDecisionAction;
  sourceProvenance: string;
  targetProvenance: string;
  suggestedResolution?: string;
  agentRationale?: string;
  appliedContent?: string;
}

export interface AgentActivity {
  id: string;
  timestamp: number;
  filePath: string;
  action: 'analyzing' | 'proposing' | 'applying' | 'completed';
  proposedAction?: FileDecisionAction;
  rationale?: string;
  needsApproval: boolean;
}

export interface SmartResolutionOption {
  id: string;
  title: string;
  description: string;
  action: FileDecisionAction;
  content?: string;
  agentRationale: string;
}

export interface SmartResolutionData {
  filePath: string;
  options: SmartResolutionOption[];
  selectedOptionId?: string;
}

export interface PromotionTarget {
  name: string;
  gitRef: string;
  kind: 'branch' | 'pointer';
}

export interface MergeReviewRun {
  status: MergeReviewRunStatus;
  runId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  selectedAgentType: string | null;
  selectedAgentName: string | null;
  selectedAgentCliArgs: string | null;
  selectedAgentPromptFlag: string | null;
  selectedModelId: string | null;
  error: string | null;
  canBypass: boolean;
}

export interface ApplyState {
  status: 'not-run' | 'running' | 'passed' | 'failed' | 'noop';
  log?: string;
  error?: string;
}

export type MergeTabRunIndicator = 'idle' | 'running' | 'completed';

export const defaultApplyState: ApplyState = {
  status: 'not-run',
};

export const defaultReviewRun: MergeReviewRun = {
  status: 'idle',
  runId: null,
  startedAt: null,
  completedAt: null,
  selectedAgentType: null,
  selectedAgentName: null,
  selectedAgentCliArgs: null,
  selectedAgentPromptFlag: null,
  selectedModelId: null,
  error: null,
  canBypass: false,
};

export interface IntegrationSession {
  id: string;
  workspaceId: string;
  repoPath: string;
  stage: IntegrationStage;
  
  // Setup
  target: MergeTarget | null;
  sources: MergeSource[];
  baseCommit: string | null;
  resolutionMode: ResolutionMode;
  policy: MergePolicy;
  
  // Preview
  preview: GitMergePreview | null;
  fileDecisions: FileDecision[];
  
  // Resolution
  agentActivities: AgentActivity[];
  selectedFilePath: string | null;
  smartResolutions: Record<string, SmartResolutionData>;
  reviewRun: MergeReviewRun;
  reviewSummary: MergeReviewSummary | null;
  reviewIssues: MergeReviewIssue[];
  issueSelections: Record<string, string>;
  reviewTimeline: MergeReviewTimelineEvent[];
  synthesizedSummaryText: string | null;
  
  // Apply
  applyState: ApplyState;
  
  // Result
  resultNodeId: string | null;
  resultCommitSha: string | null;
  promotionTarget: PromotionTarget | null;
  
  createdAt: number;
  updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════

const defaultPolicy: MergePolicy = {
  preserveTargetBehavior: true,
  preferSourceForPaths: [],
  doNotModifyLockfiles: true,
  stopOnBinaryConflicts: true,
  runTestsAfterMerge: false,
  summarizeRiskyResolutions: true,
};

const createMergeSession = (workspaceId: string, repoPath: string, now = Date.now()): IntegrationSession => ({
  id: crypto.randomUUID(),
  workspaceId,
  repoPath,
  stage: 'setup',
  target: null,
  sources: [],
  baseCommit: null,
  resolutionMode: 'smart',
  policy: { ...defaultPolicy },
  preview: null,
  fileDecisions: [],
  agentActivities: [],
  selectedFilePath: null,
  smartResolutions: {},
  reviewRun: { ...defaultReviewRun },
  reviewSummary: null,
  reviewIssues: [],
  issueSelections: {},
  reviewTimeline: [],
  synthesizedSummaryText: null,
  applyState: { ...defaultApplyState },
  resultNodeId: null,
  resultCommitSha: null,
  promotionTarget: null,
  createdAt: now,
  updatedAt: now,
});

const sanitizeMergeDraftForPersistence = (session: IntegrationSession | null): IntegrationSession | null => {
  if (!session || typeof session.workspaceId !== 'string' || typeof session.repoPath !== 'string') {
    return null;
  }

  const now = Date.now();
  const createdAt = Number.isFinite(session.createdAt) ? session.createdAt : now;
  const updatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : now;

  return {
    ...createMergeSession(session.workspaceId, session.repoPath, createdAt),
    id: typeof session.id === 'string' && session.id ? session.id : crypto.randomUUID(),
    target: session.target ?? null,
    sources: Array.isArray(session.sources) ? session.sources : [],
    resolutionMode: session.resolutionMode === 'manual' ? 'manual' : 'smart',
    policy: {
      ...defaultPolicy,
      ...(session.policy ?? {}),
    },
    createdAt,
    updatedAt,
  };
};

const clearTargetDependentState = (session: IntegrationSession, now = Date.now()): IntegrationSession => ({
  ...session,
  stage: 'setup',
  baseCommit: null,
  preview: null,
  fileDecisions: [],
  agentActivities: [],
  selectedFilePath: null,
  smartResolutions: {},
  reviewRun: { ...defaultReviewRun },
  reviewSummary: null,
  reviewIssues: [],
  issueSelections: {},
  reviewTimeline: [],
  synthesizedSummaryText: null,
  applyState: { ...defaultApplyState },
  resultNodeId: null,
  resultCommitSha: null,
  promotionTarget: null,
  updatedAt: now,
});

// ═══════════════════════════════════════════════════════════════════════════
// STORE STATE
// ═══════════════════════════════════════════════════════════════════════════

interface IntegrationState {
  // Session
  session: IntegrationSession | null;
  isMergeOpen: boolean;
  mergeTabAttentionNonce: number;
  
  // UI State
  isApplying: boolean;
  applyError: string | null;
  
  // Actions
  openMergeSession: (workspaceId: string, repoPath: string) => void;
  ensureMergeSession: (workspaceId: string, repoPath: string) => void;
  closeMergeSession: () => void;
  
  // Setup Stage
  setTarget: (target: MergeTarget) => void;
  clearTarget: () => void;
  addSource: (source: MergeSource) => boolean;
  removeSource: (sourceId: string) => void;
  reorderSources: (sourceIds: string[]) => void;
  setResolutionMode: (mode: ResolutionMode) => void;
  setPolicy: (policy: Partial<MergePolicy>) => void;
  
  // Stage Navigation
  moveToStage: (stage: IntegrationStage) => void;
  
  // Preview Stage
  setPreview: (preview: GitMergePreview) => void;
  initializeFileDecisions: () => void;
  
  // Resolution Stage
  setFileDecision: (path: string, action: FileDecisionAction, content?: string) => void;
  setSelectedFile: (path: string | null) => void;
  addAgentActivity: (activity: AgentActivity) => void;
  clearAgentActivities: () => void;
  applyAgentProposals: () => void;
  setSmartResolutions: (resolutions: Record<string, SmartResolutionData>) => void;
  selectSmartResolutionOption: (filePath: string, optionId: string) => void;
  resetReviewState: () => void;
  beginReviewRun: (payload: { runId: string; selectedAgentType: string | null; selectedAgentName: string | null; selectedAgentCliArgs: string | null; selectedAgentPromptFlag: string | null; selectedModelId: string | null }) => void;
  setReviewStatus: (status: MergeReviewRunStatus, updates?: Partial<Pick<MergeReviewRun, 'error' | 'canBypass' | 'completedAt'>>) => void;
  setReviewIssueSelection: (issueId: string, optionId: string) => void;
  appendReviewTimeline: (event: MergeReviewTimelineEvent) => void;
  completeReviewRun: (result: MergeReviewResult) => void;
  applySynthesisResult: (result: MergeResolutionSynthesisResult) => void;
  
  // Apply Stage
  setApplyState: (state: Partial<ApplyState>) => void;
  
  // Result Stage
  setResult: (nodeId: string, commitSha: string) => void;
  setPromotionTarget: (target: PromotionTarget | null) => void;
  
  // Reset
  resetSession: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// STORE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

const createIntegrationStore: StateCreator<IntegrationState> = (set) => ({
  // Initial State
  session: null,
  isMergeOpen: false,
  mergeTabAttentionNonce: 0,
  isApplying: false,
  applyError: null,

  // ═══════════════════════════════════════════════════════════════════════
  // Workspace Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  openMergeSession: (workspaceId: string, repoPath: string) => {
    const now = Date.now();
    set({
      isMergeOpen: true,
      session: createMergeSession(workspaceId, repoPath, now),
      isApplying: false,
      applyError: null,
    });
  },

  ensureMergeSession: (workspaceId: string, repoPath: string) => {
    const now = Date.now();
    set((state) => {
      if (
        state.session &&
        state.session.workspaceId === workspaceId &&
        state.session.repoPath === repoPath
      ) {
        return {
          isMergeOpen: true,
          isApplying: state.session.applyState.status === 'running',
          applyError: state.session.applyState.status === 'failed'
            ? state.session.applyState.error || state.applyError
            : null,
        };
      }

      return {
        isMergeOpen: true,
        session: createMergeSession(workspaceId, repoPath, now),
        isApplying: false,
        applyError: null,
      };
    });
  },

  closeMergeSession: () => {
    set({
      isMergeOpen: false,
      session: null,
      isApplying: false,
      applyError: null,
    });
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Setup Stage
  // ═══════════════════════════════════════════════════════════════════════

  setTarget: (target: MergeTarget) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...clearTargetDependentState(state.session),
          target,
        },
        isApplying: false,
        applyError: null,
      };
    });
  },

  clearTarget: () => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...clearTargetDependentState(state.session),
          target: null,
        },
        isApplying: false,
        applyError: null,
      };
    });
  },

  addSource: (source: MergeSource) => {
    let wasAdded = false;
    set((state) => {
      if (!state.session) return state;
      // Prevent duplicates
      if (state.session.sources.some((s) => s.id === source.id)) return state;
      wasAdded = true;
      return {
        mergeTabAttentionNonce: state.mergeTabAttentionNonce + 1,
        isApplying: false,
        applyError: null,
        session: {
          ...clearTargetDependentState(state.session),
          sources: [...state.session.sources, source],
        },
      };
    });
    return wasAdded;
  },

  removeSource: (sourceId: string) => {
    set((state) => {
      if (!state.session) return state;
      return {
        isApplying: false,
        applyError: null,
        session: {
          ...clearTargetDependentState(state.session),
          sources: state.session.sources.filter((s) => s.id !== sourceId),
        },
      };
    });
  },

  reorderSources: (sourceIds: string[]) => {
    set((state) => {
      if (!state.session) return state;
      const sourceMap = new Map(state.session.sources.map((s) => [s.id, s]));
      const reordered = sourceIds
        .map((id) => sourceMap.get(id))
        .filter((s): s is MergeSource => !!s);
      return {
        isApplying: false,
        applyError: null,
        session: {
          ...clearTargetDependentState(state.session),
          sources: reordered,
        },
      };
    });
  },

  setResolutionMode: (mode: ResolutionMode) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          resolutionMode: mode,
          updatedAt: Date.now(),
        },
      };
    });
  },

  setPolicy: (policy: Partial<MergePolicy>) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          policy: { ...state.session.policy, ...policy },
          updatedAt: Date.now(),
        },
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Stage Navigation
  // ═══════════════════════════════════════════════════════════════════════

  moveToStage: (stage: IntegrationStage) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          stage,
          updatedAt: Date.now(),
        },
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Preview Stage
  // ═══════════════════════════════════════════════════════════════════════

  setPreview: (preview: GitMergePreview) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          preview,
          baseCommit: preview.base_commit,
          reviewRun: { ...defaultReviewRun },
          reviewSummary: null,
          reviewIssues: [],
          issueSelections: {},
          reviewTimeline: [],
          synthesizedSummaryText: null,
          updatedAt: Date.now(),
        },
      };
    });
  },

  initializeFileDecisions: () => {
    set((state) => {
      if (!state.session || !state.session.preview) return state;
      
      const { preview, sources, target } = state.session;
      const decisions: FileDecision[] = [];
      
      // Build file decisions from preview data
      const allFiles = [
        ...preview.auto_mergeable_files.map((path) => ({ path, group: 'auto-apply' as FileGroup })),
        ...preview.conflicted_files.map((path) => ({ path, group: 'conflicted' as FileGroup })),
      ];
      
      for (const { path, group } of allFiles) {
        decisions.push({
          path,
          action: group === 'auto-apply' ? 'take-source' : 'pending',
          sourceProvenance: sources.map((s) => s.label).join(', ') || 'unknown',
          targetProvenance: target?.label || 'unknown',
        });
      }
      
      return {
        session: {
          ...state.session,
          fileDecisions: decisions,
          reviewRun: { ...defaultReviewRun },
          reviewSummary: null,
          reviewIssues: [],
          issueSelections: {},
          reviewTimeline: [],
          synthesizedSummaryText: null,
          updatedAt: Date.now(),
        },
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Resolution Stage
  // ═══════════════════════════════════════════════════════════════════════

  setFileDecision: (path: string, action: FileDecisionAction, content?: string) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          fileDecisions: state.session.fileDecisions.map((d) =>
            d.path === path
              ? { ...d, action, appliedContent: content }
              : d
          ),
          updatedAt: Date.now(),
        },
      };
    });
  },

  setSelectedFile: (path: string | null) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          selectedFilePath: path,
        },
      };
    });
  },

  addAgentActivity: (activity: AgentActivity) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          agentActivities: [...state.session.agentActivities, activity],
          updatedAt: Date.now(),
        },
      };
    });
  },

  clearAgentActivities: () => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          agentActivities: [],
          updatedAt: Date.now(),
        },
      };
    });
  },

  applyAgentProposals: () => {
    set((state) => {
      if (!state.session) return state;
      
      // Find the most recent proposal for each file
      const proposalsByFile = new Map<string, AgentActivity>();
      for (const activity of state.session.agentActivities) {
        if (activity.action === 'proposing' && activity.proposedAction) {
          proposalsByFile.set(activity.filePath, activity);
        }
      }
      
      const updatedDecisions = state.session.fileDecisions.map((d) => {
        const proposal = proposalsByFile.get(d.path);
        if (proposal && proposal.proposedAction) {
          return {
            ...d,
            action: proposal.proposedAction,
            agentRationale: proposal.rationale,
          };
        }
        return d;
      });
      
      return {
        session: {
          ...state.session,
          fileDecisions: updatedDecisions,
          updatedAt: Date.now(),
        },
      };
    });
  },

  setSmartResolutions: (resolutions: Record<string, SmartResolutionData>) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          smartResolutions: resolutions,
          updatedAt: Date.now(),
        }
      };
    });
  },

  selectSmartResolutionOption: (filePath: string, optionId: string) => {
    set((state) => {
      if (!state.session) return state;
      
      const currentFileRes = state.session.smartResolutions[filePath];
      if (!currentFileRes) return state;
      
      return {
        session: {
          ...state.session,
          smartResolutions: {
            ...state.session.smartResolutions,
            [filePath]: {
              ...currentFileRes,
              selectedOptionId: optionId
            }
          },
          updatedAt: Date.now()
        }
      };
    });
  },

  resetReviewState: () => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          reviewRun: { ...defaultReviewRun },
          reviewSummary: null,
          reviewIssues: [],
          issueSelections: {},
          reviewTimeline: [],
          synthesizedSummaryText: null,
          updatedAt: Date.now(),
        },
      };
    });
  },

  beginReviewRun: ({ runId, selectedAgentType, selectedAgentName, selectedAgentCliArgs, selectedAgentPromptFlag, selectedModelId }) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          reviewRun: {
            status: 'running',
            runId,
            startedAt: Date.now(),
            completedAt: null,
            selectedAgentType,
            selectedAgentName,
            selectedAgentCliArgs,
            selectedAgentPromptFlag,
            selectedModelId,
            error: null,
            canBypass: false,
          },
          reviewSummary: null,
          reviewIssues: [],
          issueSelections: {},
          reviewTimeline: [],
          synthesizedSummaryText: null,
          updatedAt: Date.now(),
        },
      };
    });
  },

  setReviewStatus: (status, updates) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          reviewRun: {
            ...state.session.reviewRun,
            status,
            error: updates?.error ?? state.session.reviewRun.error,
            canBypass: updates?.canBypass ?? state.session.reviewRun.canBypass,
            completedAt: updates?.completedAt ?? (status === 'completed' || status === 'failed' || status === 'cancelled' ? Date.now() : state.session.reviewRun.completedAt),
          },
          updatedAt: Date.now(),
        },
      };
    });
  },

  setReviewIssueSelection: (issueId, optionId) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          issueSelections: {
            ...state.session.issueSelections,
            [issueId]: optionId,
          },
          updatedAt: Date.now(),
        },
      };
    });
  },

  appendReviewTimeline: (event) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          reviewTimeline: [...state.session.reviewTimeline, event].slice(-200),
          updatedAt: Date.now(),
        },
      };
    });
  },

  completeReviewRun: (result) => {
    set((state) => {
      if (!state.session) return state;

      return {
        session: {
          ...state.session,
          reviewRun: {
            ...state.session.reviewRun,
            status: 'completed',
            completedAt: Date.now(),
            error: null,
            canBypass: false,
          },
          reviewSummary: result.summary,
          reviewIssues: result.issues,
          issueSelections: {},
          synthesizedSummaryText: null,
          updatedAt: Date.now(),
        },
      };
    });
  },

  applySynthesisResult: (result) => {
    set((state) => {
      if (!state.session) return state;

      const reviewIssues = state.session.reviewIssues;
      const byPath = new Map(result.resolutions.map((resolution) => [resolution.path, resolution]));
      const fileDecisions = state.session.fileDecisions.map((decision) => {
        const resolution = byPath.get(decision.path);
        if (!resolution) return decision;

        let action: FileDecisionAction = 'pending';
        if (resolution.action === 'source') action = 'take-source';
        else if (resolution.action === 'target') action = 'keep-target';
        else if (resolution.action === 'base') action = 'use-base';
        else if (resolution.action === 'manual') action = 'manual';

        return {
          ...decision,
          action,
          appliedContent: resolution.content ?? undefined,
          agentRationale: reviewIssues.find((issue) => issue.affectedFiles.includes(decision.path))?.rationale,
          sourceProvenance: resolution.sourceCommit ?? decision.sourceProvenance,
        };
      });

      return {
        session: {
          ...state.session,
          fileDecisions,
          synthesizedSummaryText: result.summaryText,
          updatedAt: Date.now(),
        },
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Apply Stage
  // ═══════════════════════════════════════════════════════════════════════

  setApplyState: (applyStateUpdate: Partial<ApplyState>) => {
    set((state) => {
      if (!state.session) return state;
      const nextApplyState = {
        ...state.session.applyState,
        ...applyStateUpdate
      };
      return {
        isApplying: nextApplyState.status === 'running',
        applyError: nextApplyState.status === 'failed'
          ? (nextApplyState.error || state.applyError)
          : null,
        session: {
          ...state.session,
          applyState: nextApplyState,
          updatedAt: Date.now(),
        },
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Result Stage
  // ═══════════════════════════════════════════════════════════════════════

  setResult: (nodeId: string, commitSha: string) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          resultNodeId: nodeId,
          resultCommitSha: commitSha,
          stage: 'result',
          updatedAt: Date.now(),
        },
      };
    });
  },

  setPromotionTarget: (target: PromotionTarget | null) => {
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          promotionTarget: target,
          updatedAt: Date.now(),
        },
      };
    });
  },

  // ═══════════════════════════════════════════════════════════════════════
  // Reset
  // ═══════════════════════════════════════════════════════════════════════

  resetSession: () => {
    set({
      session: null,
      isApplying: false,
      applyError: null,
    });
  },
});

export const useIntegrationStore = create<IntegrationState>()(
  persist(
    createIntegrationStore,
    {
      name: 'integration-merge-storage',
      storage: createJSONStorage(() => createBestEffortStorage(() => localStorage)),
      partialize: (state): Partial<IntegrationState> => ({
        session: sanitizeMergeDraftForPersistence(state.session),
      }),
      merge: (persistedState, currentState): IntegrationState => {
        const persisted = persistedState as Partial<IntegrationState> | undefined;
        return {
          ...currentState,
          session: sanitizeMergeDraftForPersistence(persisted?.session ?? null),
          isMergeOpen: false,
          isApplying: false,
          applyError: null,
        };
      },
    }
  )
);

// ═══════════════════════════════════════════════════════════════════════════
// SELECTORS / HELPERS
// ═══════════════════════════════════════════════════════════════════════════

export function getFileGroup(decision: FileDecision): FileGroup {
  if (decision.action === 'pending') return 'conflicted';
  if (decision.action === 'manual') return 'needs-review';
  return 'auto-apply';
}

export function countDecisionsByGroup(decisions: FileDecision[]): Record<FileGroup, number> {
  return decisions.reduce(
    (acc, d) => {
      const group = getFileGroup(d);
      acc[group]++;
      return acc;
    },
    { 'auto-apply': 0, 'needs-review': 0, conflicted: 0, blocked: 0 }
  );
}

export function areAllDecisionsResolved(decisions: FileDecision[]): boolean {
  return decisions.every((d) => d.action !== 'pending');
}

export function getMergeTabRunIndicator(session: IntegrationSession | null): MergeTabRunIndicator {
  if (!session) return 'idle';

  const isReviewRunning = session.reviewRun.status === 'running';
  const isApplyRunning = session.applyState.status === 'running';
  if (isReviewRunning || isApplyRunning) return 'running';

  const hasReviewCompleted = session.reviewRun.status === 'completed';
  const hasMergeApplied = session.applyState.status === 'passed'
    || session.applyState.status === 'noop'
    || session.stage === 'result'
    || Boolean(session.resultCommitSha);

  if (hasReviewCompleted && !hasMergeApplied) return 'completed';
  return 'idle';
}
