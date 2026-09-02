import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { Workspace, useWorkspaceStore } from '../stores/workspaceStore';
import { isTauriEnvironment } from './useTauriWorkspace';
import { useToast } from '../components/Toast';
import { agentClient, WorkspaceInfo } from '../lib/agentClient';
import { trackedRefKeys } from './useTrackedRefs';
import { localNodeKeys } from './useLocalNodes';
import { trackWorkspaceCreated } from '../lib/analytics';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { useAuthStore } from '../stores/authStore';
import { queueLocalSyncFlush } from '../lib/localSyncScheduler';
import type { LocalWorkspaceRecord } from '../lib/agentClient';

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
const NATO_WORKSPACE_SUFFIXES = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
  'India',
  'Juliett',
  'Kilo',
  'Lima',
  'Mike',
  'November',
  'Oscar',
  'Papa',
  'Quebec',
  'Romeo',
  'Sierra',
  'Tango',
  'Uniform',
  'Victor',
  'Whiskey',
  'Xray',
  'Yankee',
  'Zulu',
] as const;

const quoteShellArg = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;

function normalizeRepoPathForComparison(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\\/]+$/, '').toLowerCase();
}

function getRepoNameFromPath(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[/\\]/).pop()?.trim() || 'Workspace';
}

export function suggestWorkspaceNameForRepo(
  repoPath: string,
  existingWorkspaces: Workspace[] | undefined,
): string {
  const repoName = getRepoNameFromPath(repoPath);
  const normalizedRepoPath = normalizeRepoPathForComparison(repoPath);
  const usedNames = new Set(
    (existingWorkspaces ?? [])
      .filter((workspace) => {
        const workspaceRepoPath = workspace.git_repo_path
          ?? workspace.repo_path
          ?? workspace.local_repo_path
          ?? workspace.localRepoPath
          ?? workspace.folderPath
          ?? null;
        return normalizeRepoPathForComparison(workspaceRepoPath) === normalizedRepoPath;
      })
      .map((workspace) => workspace.name.trim().toLowerCase())
      .filter(Boolean),
  );

  for (const suffix of NATO_WORKSPACE_SUFFIXES) {
    const candidate = `${repoName} ${suffix}`;
    if (!usedNames.has(candidate.toLowerCase())) return candidate;
  }

  let index = NATO_WORKSPACE_SUFFIXES.length + 1;
  while (usedNames.has(`${repoName} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${repoName} ${index}`;
}

function workspaceFromLocalRecord(record: LocalWorkspaceRecord): Workspace {
  const localRepoPath = record.localRepoPath ?? null;
  return {
    id: record.id,
    name: record.name,
    userId: record.userId,
    folderPath: localRepoPath,
    repo_path: localRepoPath,
    git_repo_path: localRepoPath,
    local_repo_path: localRepoPath,
    localRepoPath,
    connection_status: record.connectionStatus,
    connectionStatus: record.connectionStatus,
    sync_status: record.syncStatus,
    syncStatus: record.syncStatus,
    base_commit_sha: record.baseCommitSha ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function mergeWorkspaceIntoCachedWorkspaces(
  current: Workspace[] | undefined,
  workspace: Workspace
): Workspace[] {
  const existing = current ?? [];
  return [
    workspace,
    ...existing.filter((candidate) => candidate.id !== workspace.id),
  ];
}

export function renameWorkspaceInCachedWorkspaces(
  current: Workspace[] | undefined,
  workspaceId: string,
  name: string,
  serverWorkspace?: Partial<Workspace> | null
): Workspace[] | undefined {
  if (!current) return current;
  return current.map((candidate) => {
    if (candidate.id !== workspaceId) return candidate;
    return {
      ...candidate,
      ...(serverWorkspace ?? {}),
      id: workspaceId,
      name,
    };
  });
}

export const workspaceKeys = {
  all: ['workspaces'] as const,
  list: (userId: string | null | undefined) => ['workspaces', userId ?? 'anonymous'] as const,
};

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
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const query = useQuery<Workspace[]>({
    queryKey: workspaceKeys.list(userId),
    enabled: Boolean(userId),
    queryFn: async () => {
      const startedAt = performance.now();
      if (isTauriEnvironment()) {
        const localWorkspaces = await agentClient.listLocalWorkspaces();
        let mergedLocalWorkspaces = localWorkspaces;
        try {
          const response = await api.get('/workspaces');
          if (Array.isArray(response.data)) {
            mergedLocalWorkspaces = await agentClient.mergeServerWorkspaces(response.data);
          }
        } catch (error) {
          console.warn('[useWorkspaces] Server workspace merge failed; using local workspaces.', error);
        }
        recordPerfEvent('query.workspaces.fetch', {
          elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
          workspaceCount: mergedLocalWorkspaces.length,
          source: 'local-first',
        }, {
          source: 'useWorkspaces',
          durationMs: Number((performance.now() - startedAt).toFixed(2)),
        });
        return mergedLocalWorkspaces.map(workspaceFromLocalRecord);
      }
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
    if (!userId) return;
    queueLocalSyncFlush({ reason: 'workspaces-mounted' });
  }, [userId]);

  return query;
};

export const useCreateWorkspace = () => {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const markWorkspaceUsed = useWorkspaceStore((state) => state.markWorkspaceUsed);

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
      const existingWorkspaces = queryClient.getQueryData<Workspace[]>(workspaceKeys.list(userId));
      const workspaceName = name?.trim() || suggestWorkspaceNameForRepo(repo.repo_path || folderPath, existingWorkspaces);
      if (isTauriEnvironment()) {
        const workspaceId = crypto.randomUUID();
        const localWorkspace = await agentClient.localFirstCreateWorkspace({
          workspaceId,
          name: workspaceName,
          localRepoPath: repo.repo_path,
          baseCommitSha: repo.base_commit,
          repoFingerprint: repo.base_commit ? `base:${repo.base_commit}` : null,
          mutationId: `workspace.create:${workspaceId}`,
        });
        return workspaceFromLocalRecord(localWorkspace);
      }
      const response = await api.post('/workspaces', {
        name: workspaceName,
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
      if (workspace?.id) {
        markWorkspaceUsed(workspace.id);
        queryClient.setQueryData<Workspace[]>(workspaceKeys.list(userId), (current) =>
          mergeWorkspaceIntoCachedWorkspaces(current, workspace as Workspace)
        );
      }
      queueLocalSyncFlush({ reason: 'workspace-created' });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
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
  const { addToast } = useToast();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      if (isTauriEnvironment()) {
        return workspaceFromLocalRecord(await agentClient.localFirstRenameWorkspace(id, name));
      }
      const response = await api.patch(`/workspaces/${id}`, { name });
      return response.data;
    },
    onSuccess: (workspace, variables) => {
      queryClient.setQueryData<Workspace[]>(workspaceKeys.list(userId), (current) =>
        renameWorkspaceInCachedWorkspaces(
          current,
          variables.id,
          variables.name,
          workspace && typeof workspace === 'object' ? workspace : null
        )
      );
      queueLocalSyncFlush({ reason: 'workspace-renamed' });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to rename workspace';
      addToast({ title: 'Error renaming workspace', description: message, variant: 'error' });
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
      queueLocalSyncFlush({ reason: 'workspace-deleted' });
      return id;
    },
    onSuccess: (deletedWorkspaceId) => {
      if (selectedWorkspaceId === deletedWorkspaceId) {
        clearSelectedWorkspace();
      }
      queryClient.removeQueries({ queryKey: ['messages', deletedWorkspaceId] });
      queryClient.removeQueries({ queryKey: ['summaries', deletedWorkspaceId] });
      queryClient.removeQueries({ queryKey: trackedRefKeys.workspace(deletedWorkspaceId) });
      queryClient.removeQueries({ queryKey: localNodeKeys.workspace(deletedWorkspaceId) });
      queryClient.removeQueries({ queryKey: ['branches', deletedWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });
};

export const useDeleteMultipleWorkspaces = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => agentClient.localFirstDeleteWorkspace(id)));
      queueLocalSyncFlush({ reason: 'workspaces-deleted', limit: Math.max(25, ids.length) });
      return ids;
    },
    onSuccess: (deletedWorkspaceIds) => {
      for (const deletedWorkspaceId of deletedWorkspaceIds) {
        queryClient.removeQueries({ queryKey: ['messages', deletedWorkspaceId] });
        queryClient.removeQueries({ queryKey: ['summaries', deletedWorkspaceId] });
        queryClient.removeQueries({ queryKey: trackedRefKeys.workspace(deletedWorkspaceId) });
        queryClient.removeQueries({ queryKey: localNodeKeys.workspace(deletedWorkspaceId) });
        queryClient.removeQueries({ queryKey: ['branches', deletedWorkspaceId] });
      }
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
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
      if (isTauriEnvironment()) {
        return workspaceFromLocalRecord(await agentClient.localFirstReconnectWorkspace({
          workspaceId,
          localRepoPath: repo.repo_path,
          baseCommitSha: repo.base_commit,
          repoFingerprint: repo.base_commit ? `base:${repo.base_commit}` : null,
          mutationId: `workspace.reconnect:${workspaceId}:${Date.now()}`,
        }));
      }
      const response = await api.patch(`/workspaces/${workspaceId}`, {
        folderPath,
        repoPath: repo.repo_path,
        baseCommitSha: repo.base_commit,
      });
      return response.data;
    },
    onSuccess: () => {
      queueLocalSyncFlush({ reason: 'workspace-reconnected' });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      addToast({ title: 'Repo connected', description: 'The repo has been connected.', variant: 'success' });
    },
    onError: (error: unknown) => {
      if (error instanceof RepoPrepareActionRequiredError) return;
      const message = error instanceof Error ? error.message : 'Failed to connect repo';
      addToast({ title: 'Error connecting repo', description: message, variant: 'error' });
    },
  });
};
