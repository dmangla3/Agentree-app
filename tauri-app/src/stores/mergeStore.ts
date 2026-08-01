import { create } from 'zustand';
import { GitMergePreview, GitMergeResult } from '../lib/agentClient';

export interface GitMergeSession {
  repoPath: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceBranch: string;
  targetBranch: string;
  sourceLabel: string;
  targetLabel: string;
  preview: GitMergePreview;
}

export interface GitMergeApplyResult extends GitMergeResult {
  resultNodeId: string | null;
}

interface MergeState {
  selectionMode: boolean;
  sourceNodeId: string | null;
  sourceRepoPath: string | null;
  sourceBranchName: string | null;
  sourceLabel: string | null;

  previewDialogOpen: boolean;
  previewSession: GitMergeSession | null;

  progressDialogOpen: boolean;
  isApplying: boolean;
  applyResult: GitMergeApplyResult | null;
  applyError: string | null;

  enterSelectionMode: (sourceNodeId: string, repoPath: string, branchName: string, sourceLabel: string) => void;
  exitSelectionMode: () => void;

  setPreviewSession: (session: GitMergeSession | null) => void;
  setPreviewDialogOpen: (open: boolean) => void;

  setProgressDialogOpen: (open: boolean) => void;
  setIsApplying: (applying: boolean) => void;
  setApplyResult: (result: GitMergeApplyResult | null) => void;
  setApplyError: (error: string | null) => void;

  reset: () => void;
}

const initialState = {
  selectionMode: false,
  sourceNodeId: null,
  sourceRepoPath: null,
  sourceBranchName: null,
  sourceLabel: null,
  previewDialogOpen: false,
  previewSession: null,
  progressDialogOpen: false,
  isApplying: false,
  applyResult: null,
  applyError: null,
};

export const useMergeStore = create<MergeState>((set) => ({
  ...initialState,

  enterSelectionMode: (sourceNodeId, repoPath, branchName, sourceLabel) => {
    set({
      selectionMode: true,
      sourceNodeId,
      sourceRepoPath: repoPath,
      sourceBranchName: branchName,
      sourceLabel,
    });
  },

  exitSelectionMode: () => {
    set({
      selectionMode: false,
      sourceNodeId: null,
      sourceRepoPath: null,
      sourceBranchName: null,
      sourceLabel: null,
    });
  },

  setPreviewSession: (session) => {
    set({
      previewSession: session,
      previewDialogOpen: !!session,
    });
  },

  setPreviewDialogOpen: (open) => {
    set((state) => ({
      previewDialogOpen: open,
      previewSession: open ? state.previewSession : null,
    }));
  },

  setProgressDialogOpen: (open) => {
    set({
      progressDialogOpen: open,
      isApplying: open,
      applyResult: open ? null : null,
      applyError: open ? null : null,
    });
  },

  setIsApplying: (applying) => {
    set({ isApplying: applying });
  },

  setApplyResult: (result) => {
    set({
      applyResult: result,
      isApplying: false,
      progressDialogOpen: true,
    });
  },

  setApplyError: (error) => {
    set({
      applyError: error,
      isApplying: false,
      progressDialogOpen: true,
    });
  },

  reset: () => {
    set(initialState);
  },
}));
