import { useQuery } from '@tanstack/react-query';
import { agentClient, GitCommitMetadata, GitLocalRefInfo } from '../lib/agentClient';
import type { TrackedGitRef } from '../stores/workspaceStore';
import { useTrackedRefs } from './useTrackedRefs';

export interface CommitWithRef extends GitCommitMetadata {
  refName?: string;
  refType?: 'branch' | 'tag' | 'head';
}

interface UseCommitsOptions {
  repoPath: string | null;
  workspaceId: string | null;
  limit?: number;
  exclusions?: string[];
  excludeDescendantsOf?: string;
}

const isInternalAgentreeBranch = (ref: GitLocalRefInfo): boolean =>
  ref.git_ref.startsWith('refs/heads/agentree/');

const isAgentreePointer = (ref: GitLocalRefInfo): boolean =>
  ref.git_ref.startsWith('refs/agentree/pointers/');

const isHumanBranch = (ref: GitLocalRefInfo): boolean =>
  ref.git_ref.startsWith('refs/heads/') && !isInternalAgentreeBranch(ref);

const isPrimaryBranchName = (shortName: string): boolean =>
  shortName === 'main' || shortName === 'master' || shortName === 'trunk';

const trackedRefKeysForPriority = (trackedRefs: TrackedGitRef[] = []): Set<string> => {
  const keys = new Set<string>();
  for (const ref of trackedRefs) {
    if (!ref.enabled) continue;
    keys.add(ref.git_ref);
    if (ref.git_ref.startsWith('refs/heads/')) {
      keys.add(ref.git_ref.replace('refs/heads/', ''));
    }
    if (ref.display_name) {
      keys.add(ref.display_name);
    }
  }
  return keys;
};

const refPriority = (ref: GitLocalRefInfo, trackedKeys: Set<string>): number => {
  let priority = 100;

  if (isHumanBranch(ref)) {
    priority = 0;
  } else if (isAgentreePointer(ref)) {
    priority = 40;
  } else if (isInternalAgentreeBranch(ref)) {
    priority = 200;
  }

  if (trackedKeys.has(ref.git_ref) || trackedKeys.has(ref.short_name)) {
    priority -= 50;
  }

  if (isPrimaryBranchName(ref.short_name)) {
    priority -= 20;
  }

  return priority;
};

export const buildPreferredRefNameBySha = (
  refs: GitLocalRefInfo[],
  trackedRefs: TrackedGitRef[] = []
): Map<string, string> => {
  const trackedKeys = trackedRefKeysForPriority(trackedRefs);
  const preferredBySha = new Map<string, { refName: string; priority: number; nameLength: number; index: number }>();

  refs.forEach((ref, index) => {
    const priority = refPriority(ref, trackedKeys);
    const candidate = {
      refName: ref.short_name,
      priority,
      nameLength: ref.short_name.length,
      index,
    };
    const existing = preferredBySha.get(ref.commit_sha);

    if (
      !existing ||
      candidate.priority < existing.priority ||
      (candidate.priority === existing.priority && candidate.nameLength < existing.nameLength) ||
      (
        candidate.priority === existing.priority &&
        candidate.nameLength === existing.nameLength &&
        candidate.index < existing.index
      )
    ) {
      preferredBySha.set(ref.commit_sha, candidate);
    }
  });

  return new Map(Array.from(preferredBySha.entries()).map(([sha, ref]) => [sha, ref.refName]));
};

export const filterCommitsReachableFrom = <T extends Pick<GitCommitMetadata, 'sha' | 'parents'>>(
  commits: T[],
  exclusions: string[] = []
): T[] => {
  const commitBySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const excludedReachableShas = new Set<string>();
  const stack = exclusions
    .map((sha) => sha.trim())
    .filter((sha) => sha.length > 0);

  while (stack.length > 0) {
    const sha = stack.pop();
    if (!sha || excludedReachableShas.has(sha)) continue;

    excludedReachableShas.add(sha);
    const commit = commitBySha.get(sha);
    if (commit) {
      stack.push(...commit.parents);
    }
  }

  if (excludedReachableShas.size === 0) return commits;
  return commits.filter((commit) => !excludedReachableShas.has(commit.sha));
};

/**
 * Hook to fetch git commits and refs for merge workflow.
 * Shows commits directly instead of nodes.
 * Fetches commits by walking back from branch tips and collecting all history.
 */
export function useCommits({ repoPath, workspaceId, limit = 100, exclusions, excludeDescendantsOf }: UseCommitsOptions) {
  const trackedRefsQuery = useTrackedRefs(workspaceId);

  // Fetch local refs (branches, tags) for marking branch tips
  const refsQuery = useQuery({
    queryKey: ['git-refs', repoPath, workspaceId],
    queryFn: async (): Promise<GitLocalRefInfo[]> => {
      if (!repoPath) return [];
      return agentClient.listLocalRefs(repoPath);
    },
    enabled: !!repoPath && !!workspaceId,
    staleTime: 30 * 1000, // 30 seconds
  });

  // Fetch ALL commits
  const commitsQuery = useQuery({
    queryKey: ['git-commits', repoPath, workspaceId, limit, exclusions, excludeDescendantsOf, refsQuery.data, trackedRefsQuery.data],
    queryFn: async (): Promise<CommitWithRef[]> => {
      if (!repoPath || !refsQuery.data) return [];
      
      const refNameBySha = buildPreferredRefNameBySha(refsQuery.data, trackedRefsQuery.data ?? []);
      
      // Fetch commits using the new command
      try {
        const metadataList = await agentClient.listAllCommits(repoPath, limit, exclusions, excludeDescendantsOf);
        
        return metadataList.map(metadata => {
          const refName = refNameBySha.get(metadata.sha);
          return {
            ...metadata,
            refName: refName,
            refType: refName ? 'branch' : undefined,
          };
        });
      } catch (error) {
        console.warn(`Failed to list commits for repo ${repoPath}:`, error);
        return [];
      }
    },
    enabled: !!repoPath && !!workspaceId && refsQuery.isSuccess,
    staleTime: 30 * 1000,
  });

  return {
    commits: commitsQuery.data ?? [],
    refs: refsQuery.data ?? [],
    isLoading: refsQuery.isLoading || commitsQuery.isLoading,
    isError: refsQuery.isError || commitsQuery.isError,
    error: refsQuery.error || commitsQuery.error,
    refetch: () => {
      refsQuery.refetch();
      commitsQuery.refetch();
    },
  };
}

/**
 * Hook to fetch a single commit's metadata
 */
export function useCommitMetadata(repoPath: string | null, commitSha: string | null) {
  return useQuery({
    queryKey: ['commit-metadata', repoPath, commitSha],
    queryFn: async (): Promise<GitCommitMetadata | null> => {
      if (!repoPath || !commitSha) return null;
      return agentClient.readCommitMetadata(repoPath, commitSha);
    },
    enabled: !!repoPath && !!commitSha,
    staleTime: 60 * 1000, // 1 minute
  });
}
