import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { agentClient, type GitRefSnapshot } from '../lib/agentClient';
import type { TrackedGitRef } from '../stores/workspaceStore';

const REF_SNAPSHOT_INTERVAL_MS = 5_000;

export const gitRefSnapshotKeys = {
  all: ['git-ref-snapshot'] as const,
  repo: (repoPath: string | null, gitRefs: readonly string[]) => [
    ...gitRefSnapshotKeys.all,
    repoPath ?? '',
    gitRefs.join('\0'),
  ] as const,
};

export const getEnabledTrackedGitRefs = (trackedRefs: readonly TrackedGitRef[]): string[] => {
  return Array.from(new Set(
    trackedRefs
      .filter((ref) => ref.enabled)
      .map((ref) => ref.git_ref.trim())
      .filter(Boolean)
      .sort()
  ));
};

export const getTrackedRefsNeedingSync = (
  trackedRefs: readonly TrackedGitRef[],
  snapshot: GitRefSnapshot | null | undefined
): TrackedGitRef[] => {
  if (!snapshot) return [];

  const tipByRef = new Map(
    snapshot.refs
      .filter((ref) => Boolean(ref.commit_sha))
      .map((ref) => [ref.git_ref, ref.commit_sha?.trim() ?? null])
  );

  return trackedRefs.filter((ref) => {
    if (!ref.enabled) return false;
    const tip = tipByRef.get(ref.git_ref);
    if (!tip) return false;
    return (ref.last_seen_commit_sha?.trim() || null) !== tip;
  });
};

export const useGitRefSnapshot = (
  repoPath: string | null,
  gitRefs: readonly string[]
) => {
  const normalizedGitRefs = useMemo(
    () => Array.from(new Set(gitRefs.map((ref) => ref.trim()).filter(Boolean))).sort(),
    [gitRefs]
  );

  return useQuery({
    queryKey: gitRefSnapshotKeys.repo(repoPath, normalizedGitRefs),
    queryFn: async () => {
      if (!repoPath) return null;
      return agentClient.snapshotGitRefs(repoPath, normalizedGitRefs);
    },
    enabled: Boolean(repoPath),
    refetchInterval: REF_SNAPSHOT_INTERVAL_MS,
    staleTime: 2_000,
    refetchOnWindowFocus: true,
  });
};
