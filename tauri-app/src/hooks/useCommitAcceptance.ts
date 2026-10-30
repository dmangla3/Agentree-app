import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GitRefSnapshot } from '../lib/agentClient';
import { agentClient } from '../lib/agentClient';
import type { TrackedGitRef } from '../stores/workspaceStore';
import { canBeAcceptanceGitRef, trackedRefCountsAsMerged } from './useTrackedRefs';

export const getEnabledAcceptanceGitRefs = (
  trackedRefs: readonly TrackedGitRef[]
): string[] => Array.from(new Set(
  trackedRefs
    .filter((ref) => ref.enabled && canBeAcceptanceGitRef(ref.git_ref))
    .filter(trackedRefCountsAsMerged)
    .map((ref) => ref.git_ref.trim())
    .filter(Boolean)
)).sort();

export const buildCommitAcceptanceRefreshKey = ({
  acceptedGitRefs,
  refSnapshot,
  agentCommitShas,
}: {
  acceptedGitRefs: readonly string[];
  refSnapshot: GitRefSnapshot | null | undefined;
  agentCommitShas: readonly string[];
}): string => {
  const tipByRef = new Map(
    (refSnapshot?.refs ?? []).map((ref) => [ref.git_ref, ref.commit_sha ?? ref.error ?? 'missing'])
  );
  const refsKey = [...acceptedGitRefs]
    .sort()
    .map((gitRef) => `${gitRef}:${tipByRef.get(gitRef) ?? 'unresolved'}`)
    .join('|');
  return `${refsKey}::${[...agentCommitShas].sort().join(',')}`;
};

export const useCommitAcceptanceRefresh = ({
  workspaceId,
  repoPath,
  trackedRefs,
  refSnapshot,
  agentCommitShas,
  enabled,
}: {
  workspaceId: string | null;
  repoPath: string | null;
  trackedRefs: readonly TrackedGitRef[];
  refSnapshot: GitRefSnapshot | null | undefined;
  agentCommitShas: readonly string[];
  enabled: boolean;
}) => {
  const queryClient = useQueryClient();
  const acceptedGitRefs = useMemo(
    () => getEnabledAcceptanceGitRefs(trackedRefs),
    [trackedRefs]
  );
  const refreshKey = useMemo(() => buildCommitAcceptanceRefreshKey({
    acceptedGitRefs,
    refSnapshot,
    agentCommitShas,
  }), [acceptedGitRefs, agentCommitShas, refSnapshot]);
  const acceptedGitRefsKey = acceptedGitRefs.join('\0');
  const latestRequestRef = useRef(0);

  useEffect(() => {
    if (!enabled || !workspaceId || !repoPath || !agentClient.hasRuntime()) return;
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;

    void agentClient.refreshLocalCommitAcceptance(
      workspaceId,
      repoPath,
      acceptedGitRefsKey ? acceptedGitRefsKey.split('\0') : []
    ).then((result) => {
      if (latestRequestRef.current !== requestId) return;
      if (result.errors.length > 0) {
        console.warn('[commit-acceptance] Some acceptance branches could not be checked:', result.errors);
      }
      if (result.changed) {
        void queryClient.invalidateQueries({ queryKey: ['local-commit-graph', workspaceId] });
      }
    }).catch((error) => {
      if (latestRequestRef.current !== requestId) return;
      console.warn('[commit-acceptance] Automatic refresh failed:', error);
    });
  }, [acceptedGitRefsKey, enabled, queryClient, refreshKey, repoPath, workspaceId]);

  return { acceptedGitRefs };
};
