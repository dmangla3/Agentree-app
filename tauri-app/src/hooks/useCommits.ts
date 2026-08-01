import { useQuery } from '@tanstack/react-query';
import { agentClient, GitCommitMetadata, GitLocalRefInfo } from '../lib/agentClient';

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

/**
 * Hook to fetch git commits and refs for merge workflow.
 * Shows commits directly instead of nodes.
 * Fetches commits by walking back from branch tips and collecting all history.
 */
export function useCommits({ repoPath, workspaceId, limit = 100, exclusions, excludeDescendantsOf }: UseCommitsOptions) {
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
    queryKey: ['git-commits', repoPath, workspaceId, limit, exclusions, excludeDescendantsOf, refsQuery.data],
    queryFn: async (): Promise<CommitWithRef[]> => {
      if (!repoPath || !refsQuery.data) return [];
      
      // Build a map of commit SHAs to ref names
      const refNameBySha = new Map<string, string>();
      for (const ref of refsQuery.data) {
        if (!refNameBySha.has(ref.commit_sha)) {
          refNameBySha.set(ref.commit_sha, ref.short_name);
        }
      }
      
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
