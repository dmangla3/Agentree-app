import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { Workspace, useWorkspaceStore } from '../stores/workspaceStore';
import { isTauriEnvironment } from './useTauriWorkspace';
import { useToast } from '../components/Toast';
import { agentClient, WorkspaceInfo } from '../lib/agentClient';
import { trackedRefKeys } from './useTrackedRefs';
import { localNodeKeys } from './useLocalNodes';
import { trackWorkspaceCreated } from '../lib/analytics';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { getAccessToken } from '../lib/authSession';

export type RepoPrepareRequirementType = 'git_init' | 'commit_checkpoint';
export type RepoDirtyStrategy = 'last-commit' | 'checkpoint';

export interface RepoPrepareRequirement {
  type: RepoPrepareRequirementType;
  folderPath: string;
  workspace: WorkspaceInfo;
  defaultCommitMessage: string;
  commandPreview: string[];
}

export class RepoPrepareActionRequiredError extends Error {
  requirement: RepoPrepareRequirement;

  constructor(requirement: RepoPrepareRequirement) {
    const label =
      requirement.type === 'git_init'
        ? 'Repo requires git initialization.'
        : 'Repo requires a checkpoint commit.';
    super(label);
    this.name = 'RepoPrepareActionRequiredError';
    this.requirement = requirement;
  }
}

const DEFAULT_CHECKPOINT_COMMIT_MESSAGE = 'WIP: pre-agentree checkpoint';
const AGENTREE_GIT_COMMIT_PREFIX = 'git -c user.name=Agentree -c user.email=agentree@local commit';

const quoteShellArg = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;

async function prepareRepoForWorkspace(
  folderPath: string,
  allowGitInit: boolean,
  commitMessage: string | null,
  dirtyStrategy?: RepoDirtyStrategy
): Promise<WorkspaceInfo> {
  if (!isTauriEnvironment()) {
    throw new Error('Workspace creation requires the Tauri app environment.');
  }

  let workspace = await agentClient.attachWorkspace(folderPath);

  if (workspace.needs_git_init) {
    if (!allowGitInit) {
      throw new RepoPrepareActionRequiredError({
        type: 'git_init',
        folderPath,
        workspace,
        defaultCommitMessage: DEFAULT_CHECKPOINT_COMMIT_MESSAGE,
        commandPreview: [
          'git init',
          'git add -A',
          `${AGENTREE_GIT_COMMIT_PREFIX} --allow-empty -m ${quoteShellArg('Initial commit')}`,
        ],
      });
    }
    const baseCommit = await agentClient.initGitRepo(folderPath);
    workspace = { ...workspace, needs_git_init: false, base_commit: baseCommit };
  }

  if (workspace.has_uncommitted_changes) {
    if (!dirtyStrategy) {
      throw new RepoPrepareActionRequiredError({
        type: 'commit_checkpoint',
        folderPath,
        workspace,
        defaultCommitMessage: DEFAULT_CHECKPOINT_COMMIT_MESSAGE,
        commandPreview: [
          'git add -A',
          `${AGENTREE_GIT_COMMIT_PREFIX} --allow-empty -m ${quoteShellArg(DEFAULT_CHECKPOINT_COMMIT_MESSAGE)}`,
        ],
      });
    }

    if (dirtyStrategy === 'last-commit' && workspace.base_commit) {
      return workspace;
    }

    const trimmedMessage = (commitMessage || '').trim();
    if (!trimmedMessage) {
      throw new RepoPrepareActionRequiredError({
        type: 'commit_checkpoint',
        folderPath,
        workspace,
        defaultCommitMessage: DEFAULT_CHECKPOINT_COMMIT_MESSAGE,
        commandPreview: [
          'git add -A',
          `${AGENTREE_GIT_COMMIT_PREFIX} --allow-empty -m ${quoteShellArg(DEFAULT_CHECKPOINT_COMMIT_MESSAGE)}`,
        ],
      });
    }

    const baseCommit = await agentClient.commitUncommitted(folderPath, trimmedMessage);
    workspace = {
      ...workspace,
      has_uncommitted_changes: false,
      base_commit: baseCommit,
      changed_files: [],
    };
  }

  if (!workspace.base_commit) {
    throw new Error('Repo preparation failed to resolve a base commit.');
  }

  await agentClient.createBaseBranch(folderPath).catch((error) => {
    console.warn('[prepareRepoForWorkspace] Failed to create agentree/base:', error);
  });

  return workspace;
}

export const useWorkspaces = (): UseQueryResult<Workspace[], Error> => {
  const syncInFlightRef = useRef(false);
  const query = useQuery<Workspace[]>({
    queryKey: ['workspaces'],
    queryFn: async () => {
      const startedAt = performance.now();
      const [response, deletedWorkspaceIds] = await Promise.all([
        api.get('/workspaces'),
        agentClient.listLocalDeletedWorkspaceIds(),
      ]);
      recordPerfEvent('query.workspaces.fetch', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceCount: Array.isArray(response.data) ? response.data.length : null,
      }, {
        source: 'useWorkspaces',
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });
      if (!deletedWorkspaceIds.length || !Array.isArray(response.data)) return response.data;
      const deleted = new Set(deletedWorkspaceIds);
      return response.data.filter((workspace: Workspace) => !deleted.has(workspace.id));
    },
    staleTime: 30 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    void getAccessToken()
      .then((token) => agentClient.processLocalSyncEvents(token))
      .catch(() => undefined)
      .finally(() => {
        syncInFlightRef.current = false;
      });
  }, []);

  return query;
};

export const useCreateWorkspace = () => {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  return useMutation({
    mutationFn: async ({
      folderPath,
      name = null,
      allowGitInit = false,
      commitMessage = null,
      dirtyStrategy,
    }: {
      folderPath: string;
      name?: string | null;
      allowGitInit?: boolean;
      commitMessage?: string | null;
      dirtyStrategy?: RepoDirtyStrategy;
    }) => {
      const repo = await prepareRepoForWorkspace(folderPath, allowGitInit, commitMessage, dirtyStrategy);
      const response = await api.post('/workspaces', {
        name,
        folderPath,
        snapshot_id: null,
        repoPath: repo.repo_path,
        baseCommitSha: repo.base_commit,
      });
      return response.data;
    },
    onSuccess: (workspace, variables) => {
      trackWorkspaceCreated('workspace_mutation', {
        workspace_id: workspace?.id ?? null,
        allow_git_init: variables.allowGitInit ?? false,
        dirty_strategy: variables.dirtyStrategy ?? null,
      });
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
    onError: (error: unknown) => {
      if (error instanceof RepoPrepareActionRequiredError) return;
      const message = error instanceof Error ? error.message : 'Failed to create workspace';
      addToast({ title: 'Error creating workspace', description: message, variant: 'error' });
    },
  });
};

export const useRenameWorkspace = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const response = await api.patch(`/workspaces/${id}`, { name });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
};

export const useDeleteWorkspace = () => {
  const queryClient = useQueryClient();
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const clearSelectedWorkspace = useWorkspaceStore((state) => state.clearSelectedWorkspace);

  return useMutation({
    mutationFn: async (id: string) => {
      await agentClient.localFirstDeleteWorkspace(id);
      void getAccessToken()
        .then((token) => agentClient.processLocalSyncEvents(token))
        .catch(() => undefined);
      return id;
    },
    onSuccess: (deletedWorkspaceId) => {
      if (selectedWorkspaceId === deletedWorkspaceId) {
        clearSelectedWorkspace();
      }
      queryClient.removeQueries({ queryKey: ['messages', deletedWorkspaceId] });
      queryClient.removeQueries({ queryKey: ['summaries', deletedWorkspaceId] });
      queryClient.removeQueries({ queryKey: ['scopes', deletedWorkspaceId] });
      queryClient.removeQueries({ queryKey: trackedRefKeys.workspace(deletedWorkspaceId) });
      queryClient.removeQueries({ queryKey: localNodeKeys.workspace(deletedWorkspaceId) });
      queryClient.removeQueries({ queryKey: ['branches', deletedWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
};

export const useDeleteMultipleWorkspaces = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => agentClient.localFirstDeleteWorkspace(id)));
      void getAccessToken()
        .then((token) => agentClient.processLocalSyncEvents(token, Math.max(25, ids.length)))
        .catch(() => undefined);
      return ids;
    },
    onSuccess: (deletedWorkspaceIds) => {
      for (const deletedWorkspaceId of deletedWorkspaceIds) {
        queryClient.removeQueries({ queryKey: ['messages', deletedWorkspaceId] });
        queryClient.removeQueries({ queryKey: ['summaries', deletedWorkspaceId] });
        queryClient.removeQueries({ queryKey: ['scopes', deletedWorkspaceId] });
        queryClient.removeQueries({ queryKey: trackedRefKeys.workspace(deletedWorkspaceId) });
        queryClient.removeQueries({ queryKey: localNodeKeys.workspace(deletedWorkspaceId) });
        queryClient.removeQueries({ queryKey: ['branches', deletedWorkspaceId] });
      }
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
};

export const useConnectRepo = () => {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      folderPath,
      allowGitInit = false,
      commitMessage = null,
      dirtyStrategy,
    }: {
      workspaceId: string;
      folderPath: string;
      allowGitInit?: boolean;
      commitMessage?: string | null;
      dirtyStrategy?: RepoDirtyStrategy;
    }) => {
      const repo = await prepareRepoForWorkspace(folderPath, allowGitInit, commitMessage, dirtyStrategy);
      const response = await api.patch(`/workspaces/${workspaceId}`, {
        folderPath,
        repoPath: repo.repo_path,
        baseCommitSha: repo.base_commit,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      addToast({ title: 'Repo connected', description: 'The repo has been connected.', variant: 'success' });
    },
    onError: (error: unknown) => {
      if (error instanceof RepoPrepareActionRequiredError) return;
      const message = error instanceof Error ? error.message : 'Failed to connect repo';
      addToast({ title: 'Error connecting repo', description: message, variant: 'error' });
    },
  });
};
