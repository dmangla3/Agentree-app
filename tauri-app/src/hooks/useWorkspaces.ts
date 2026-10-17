import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Workspace, useWorkspaceStore } from '../stores/workspaceStore';
import { useToast } from '../components/Toast';
import { agentClient, WorkspaceInfo } from '../lib/agentClient';
import { trackedRefKeys } from './useTrackedRefs';
import { localNodeKeys } from './useLocalNodes';
import { trackWorkspaceCreated } from '../lib/analytics';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { useAuthStore } from '../stores/authStore';
import { queueLocalSyncFlush } from '../lib/localSyncScheduler';
import { workspaceApplication } from '../application/workspaces';

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
const GIT_COMMIT_COMMAND = 'git commit';
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

const desktopWorkspaceListKey = (cloudAccountId: string | null, cloudConnected: boolean) =>
  cloudConnected && cloudAccountId ? `desktop:cloud:${cloudAccountId}` : 'desktop:local';

async function prepareRepoForWorkspace(
  folderPath: string,
  allowGitInit: boolean,
  commitMessage: string | null,
  dirtyStrategy?: RepoDirtyStrategy
): Promise<WorkspaceInfo> {
  if (!workspaceApplication.isDesktop()) {
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
          `${GIT_COMMIT_COMMAND} --allow-empty -m ${quoteShellArg('Initial commit')}`,
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
          `${GIT_COMMIT_COMMAND} --allow-empty -m ${quoteShellArg(DEFAULT_CHECKPOINT_COMMIT_MESSAGE)}`,
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
          `${GIT_COMMIT_COMMAND} --allow-empty -m ${quoteShellArg(DEFAULT_CHECKPOINT_COMMIT_MESSAGE)}`,
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
  const desktopSession = useAuthStore((state) => state.desktopSession);
  const isDesktop = workspaceApplication.isDesktop();
  const cloudConnected = Boolean(userId && (!isDesktop || desktopSession));
  const workspaceListKey = isDesktop ? desktopWorkspaceListKey(userId, cloudConnected) : userId;
  const query = useQuery<Workspace[]>({
    queryKey: workspaceKeys.list(workspaceListKey),
    enabled: isDesktop || Boolean(userId),
    queryFn: async () => {
      const startedAt = performance.now();
      const workspaces = await workspaceApplication.list({
        cloudAccountId: userId,
        cloudConnected,
      });
      recordPerfEvent('query.workspaces.fetch', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceCount: workspaces.length,
        source: isDesktop ? 'local-first' : 'server-adapter',
      }, {
        source: 'useWorkspaces',
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });
      return workspaces;
    },
    staleTime: 30 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (!cloudConnected) return;
    queueLocalSyncFlush({ reason: 'workspaces-mounted' });
  }, [cloudConnected]);

  return query;
};

export const useCreateWorkspace = () => {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const desktopSession = useAuthStore((state) => state.desktopSession);
  const isDesktop = workspaceApplication.isDesktop();
  const cloudConnected = Boolean(userId && desktopSession);
  const workspaceListKey = isDesktop ? desktopWorkspaceListKey(userId, cloudConnected) : userId;
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
      const existingWorkspaces = queryClient.getQueryData<Workspace[]>(workspaceKeys.list(workspaceListKey));
      const workspaceName = name?.trim() || suggestWorkspaceNameForRepo(repo.repo_path || folderPath, existingWorkspaces);
      const workspaceId = crypto.randomUUID();
      return workspaceApplication.create({
        workspaceId,
        name: workspaceName,
        folderPath,
        repoPath: repo.repo_path,
        baseCommitSha: repo.base_commit,
      });
    },
    onSuccess: (workspace, variables) => {
      trackWorkspaceCreated('workspace_mutation', {
        allow_git_init: variables.allowGitInit ?? false,
        ...(variables.dirtyStrategy ? { dirty_strategy: variables.dirtyStrategy } : {}),
      });
      if (workspace?.id) {
        markWorkspaceUsed(workspace.id);
        queryClient.setQueryData<Workspace[]>(workspaceKeys.list(workspaceListKey), (current) =>
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
  const desktopSession = useAuthStore((state) => state.desktopSession);
  const isDesktop = workspaceApplication.isDesktop();
  const cloudConnected = Boolean(userId && desktopSession);
  const workspaceListKey = isDesktop ? desktopWorkspaceListKey(userId, cloudConnected) : userId;
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      return workspaceApplication.rename(id, name);
    },
    onSuccess: (workspace, variables) => {
      queryClient.setQueryData<Workspace[]>(workspaceKeys.list(workspaceListKey), (current) =>
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
      await workspaceApplication.remove(id);
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
      await Promise.all(ids.map((id) => workspaceApplication.remove(id)));
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
      return workspaceApplication.reconnect({
        workspaceId,
        folderPath,
        repoPath: repo.repo_path,
        baseCommitSha: repo.base_commit,
      });
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
