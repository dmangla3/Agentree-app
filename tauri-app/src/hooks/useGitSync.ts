import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { agentClient } from '../lib/agentClient';
import { trackedRefKeys } from './useTrackedRefs';
import { branchKeys } from './useBranches';
import type { TrackedGitRef } from '../stores/workspaceStore';
import type { GraphSnapshot } from './useGraphSnapshot';

type IgnoredSyncRef = {
  gitRef: string;
  reason: string;
};

export const useGitSync = (workspaceId: string | null, repoPath: string | null) => {
  const queryClient = useQueryClient();

  const syncMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !repoPath) {
        return {
          didSync: false,
          importedCount: 0,
          importedNodeIds: [],
          importedByRef: {},
          ignoredRefs: [],
        };
      }

      const trackedRefs = await queryClient.ensureQueryData<TrackedGitRef[]>({
        queryKey: trackedRefKeys.workspace(workspaceId),
        queryFn: async () => {
          const response = await api.get(`/workspaces/${workspaceId}/tracked-refs`);
          return response.data;
        },
      });
      const cachedGraphSnapshot = queryClient.getQueryData<GraphSnapshot>(['graph-snapshot', workspaceId]);
      const knownCommitShas = new Set((cachedGraphSnapshot?.commits ?? []).map((commit) => commit.sha));
      const ignoredRefs: IgnoredSyncRef[] = [];
      const enabledRefs = trackedRefs.filter((ref) => ref.enabled);

      if (enabledRefs.length === 0) {
        return {
          didSync: false,
          importedCount: 0,
          importedNodeIds: [],
          importedByRef: {},
          ignoredRefs,
        };
      }

      const refsPayload: Array<{
        gitRef: string;
        tipCommitSha: string;
        commits: Array<{
          sha: string;
          parents: string[];
          subject: string;
          authorName: string | null;
          authorEmail: string | null;
          authoredAt: string | null;
        }>;
      }> = [];

      for (const tracked of enabledRefs) {
        const gitRef = tracked.git_ref;
        let tipCommitSha: string;
        try {
          tipCommitSha = await agentClient.resolveRefTip(repoPath, gitRef);
        } catch (error) {
          ignoredRefs.push({
            gitRef,
            reason: error instanceof Error ? error.message : 'Unable to resolve ref tip',
          });
          continue;
        }

        const lastSeenCommit = tracked.last_seen_commit_sha ?? null;
        let fromCommit = lastSeenCommit;

        // Recover from an older bad sync where a tracked ref was marked as seen at the tip
        // even though no canonical commit row was imported for that commit.
        if (lastSeenCommit === tipCommitSha && knownCommitShas.size > 0 && !knownCommitShas.has(tipCommitSha)) {
          fromCommit = null;
        }

        if (fromCommit && fromCommit === tipCommitSha) {
          refsPayload.push({ gitRef, tipCommitSha, commits: [] });
          continue;
        }

        let commits: Awaited<ReturnType<typeof agentClient.listMissingCommits>>;
        try {
          commits = await agentClient.listMissingCommits(repoPath, fromCommit, tipCommitSha);
        } catch (error) {
          ignoredRefs.push({
            gitRef,
            reason: error instanceof Error ? error.message : 'Unable to list missing commits',
          });
          continue;
        }
        refsPayload.push({
          gitRef,
          tipCommitSha,
          commits: commits.map((commit) => ({
            sha: commit.sha,
            parents: commit.parents,
            subject: commit.subject,
            authorName: commit.author_name ?? null,
            authorEmail: commit.author_email ?? null,
            authoredAt: commit.authored_at ?? null,
          })),
        });
      }

      if (refsPayload.length === 0 && ignoredRefs.length > 0) {
        throw new Error(`Git sync failed for all tracked refs: ${ignoredRefs.map((ref) => `${ref.gitRef} (${ref.reason})`).join(', ')}`);
      }

      // Local check found no commit delta; skip server sync entirely.
      if (refsPayload.every((ref) => ref.commits.length === 0)) {
        return {
          didSync: false,
          importedCount: 0,
          importedNodeIds: [],
          importedByRef: {},
          ignoredRefs,
        };
      }

      const ingestResponse = await api.post(`/workspaces/${workspaceId}/git-sync/ingest`, {
        refs: refsPayload,
      });

      return {
        didSync: true,
        ignoredRefs,
        ...ingestResponse.data,
      };
    },
    onSuccess: (result) => {
      if (!workspaceId) return;
      if (!result?.didSync) return;
      if ((result.importedCount ?? 0) > 0) {
        void queryClient.invalidateQueries({ queryKey: ['graph-snapshot', workspaceId], refetchType: 'active' });
        void queryClient.invalidateQueries({ queryKey: ['local-commits', workspaceId], refetchType: 'active' });
      }
      queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(workspaceId) });
      queryClient.invalidateQueries({ queryKey: branchKeys.workspace(workspaceId) });
    },
  });

  const runSync = useCallback(async () => {
    if (!workspaceId || !repoPath) return;
    return await syncMutation.mutateAsync();
  }, [workspaceId, repoPath, syncMutation]);

  return {
    runSync,
    isSyncing: syncMutation.isPending,
    lastError: syncMutation.error,
    lastResult: syncMutation.data,
  };
};
