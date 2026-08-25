import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { agentClient } from '../lib/agentClient';
import { trackedRefKeys } from './useTrackedRefs';
import { branchKeys } from './useBranches';
import type { TrackedGitRef } from '../stores/workspaceStore';
import type { GraphSnapshot } from './useGraphSnapshot';
import { queueLocalSyncFlush } from '../lib/localSyncScheduler';

type IgnoredSyncRef = {
  gitRef: string;
  reason: string;
};

export const useGitSync = (workspaceId: string | null, repoPath: string | null) => {
  const queryClient = useQueryClient();

  const flushLocalCommitGraphSync = async () => {
    queueLocalSyncFlush({ reason: 'git-sync-commit-graph' });
  };

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

      const trackedRefs = agentClient.hasRuntime()
        ? queryClient.getQueryData<TrackedGitRef[]>(trackedRefKeys.workspace(workspaceId)) ?? []
        : await queryClient.ensureQueryData<TrackedGitRef[]>({
          queryKey: trackedRefKeys.workspace(workspaceId),
          queryFn: async () => {
            const response = await api.get(`/workspaces/${workspaceId}/tracked-refs`);
            return response.data;
          },
        });
      const cachedGraphSnapshot = queryClient.getQueryData<GraphSnapshot>(['graph-snapshot', workspaceId]);
      const knownCommitShas = new Set((cachedGraphSnapshot?.commits ?? []).map((commit) => commit.sha));
      if (agentClient.hasRuntime()) {
        try {
          const localGraph = await agentClient.listLocalCommitGraph(workspaceId);
          for (const commit of localGraph.commits) {
            if (commit.sha) knownCommitShas.add(commit.sha);
          }
        } catch (error) {
          console.warn('[useGitSync] Unable to read local commit graph before sync:', error);
        }
      }
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
          filesChangedCount: number | null;
          totalAdditions: number | null;
          totalDeletions: number | null;
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

        // Recover when a tracked ref was marked as seen at the tip even though
        // the graph currently available to this app has no commit row for it.
        if (lastSeenCommit === tipCommitSha && !knownCommitShas.has(tipCommitSha)) {
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
            filesChangedCount: commit.files_changed_count ?? null,
            totalAdditions: commit.total_additions ?? null,
            totalDeletions: commit.total_deletions ?? null,
          })),
        });
      }

      if (refsPayload.length === 0 && ignoredRefs.length > 0) {
        throw new Error(`Git sync failed for all tracked refs: ${ignoredRefs.map((ref) => `${ref.gitRef} (${ref.reason})`).join(', ')}`);
      }

      // Local check found no commit delta; skip server sync entirely.
      if (refsPayload.every((ref) => ref.commits.length === 0)) {
        if (agentClient.hasRuntime()) {
          const localGraph = await agentClient.listLocalCommitGraph(workspaceId);
          const commitsBySha = new Map(localGraph.commits.map((commit) => [commit.sha, commit]));
          let importedCount = 0;
          const backfilledRefsPayload: typeof refsPayload = [];

          for (const refPayload of refsPayload) {
            const observedShas = new Set(
              localGraph.commitObservations
                .filter((observation) => observation.gitRef === refPayload.gitRef)
                .map((observation) => observation.commitSha)
            );
            const needsStatsBackfill = Array.from(observedShas).some((sha) => {
              const commit = commitsBySha.get(sha);
              return commit && (
                commit.filesChangedCount == null ||
                commit.totalAdditions == null ||
                commit.totalDeletions == null
              );
            });
            if (!needsStatsBackfill) continue;

            const commits = await agentClient.listMissingCommits(repoPath, null, refPayload.tipCommitSha, 500);
            const commitsForRef = commits
              .filter((commit) => observedShas.has(commit.sha))
              .map((commit) => ({
                sha: commit.sha,
                parents: commit.parents,
                subject: commit.subject,
                authorName: commit.author_name ?? null,
                authorEmail: commit.author_email ?? null,
                authoredAt: commit.authored_at ?? null,
                filesChangedCount: commit.files_changed_count ?? null,
                totalAdditions: commit.total_additions ?? null,
                totalDeletions: commit.total_deletions ?? null,
              }));
            if (commitsForRef.length === 0) continue;

            importedCount += await agentClient.importLocalCommits(
              workspaceId,
              commitsForRef.map((commit) => ({
                sha: commit.sha,
                parents: commit.parents,
                subject: commit.subject,
                authorName: commit.authorName,
                authorEmail: commit.authorEmail,
                authoredAt: commit.authoredAt,
                committedAt: commit.authoredAt,
                sourceKind: 'external',
                filesChangedCount: commit.filesChangedCount,
                totalAdditions: commit.totalAdditions,
                totalDeletions: commit.totalDeletions,
              })),
              refPayload.gitRef,
              repoPath
            );
            backfilledRefsPayload.push({ ...refPayload, commits: commitsForRef });
          }

          if (importedCount > 0) {
            const mutationId = backfilledRefsPayload
              .map((ref) => `${ref.gitRef}:${ref.tipCommitSha}:stats`)
              .sort()
              .join('|');
            await agentClient.enqueueLocalCommitGraphSync(workspaceId, { refs: backfilledRefsPayload }, mutationId);
            await flushLocalCommitGraphSync();
            return {
              didSync: true,
              importedCount,
              importedNodeIds: [],
              importedByRef: Object.fromEntries(backfilledRefsPayload.map((ref) => [ref.gitRef, ref.commits.length])),
              ignoredRefs,
              queuedForServerSync: true,
              statsBackfill: true,
            };
          }
        }

        return {
          didSync: false,
          importedCount: 0,
          importedNodeIds: [],
          importedByRef: {},
          ignoredRefs,
        };
      }

      if (agentClient.hasRuntime()) {
        let importedCount = 0;
        for (const refPayload of refsPayload) {
          if (refPayload.commits.length === 0) continue;
          importedCount += await agentClient.importLocalCommits(
            workspaceId,
            refPayload.commits.map((commit) => ({
              sha: commit.sha,
              parents: commit.parents,
              subject: commit.subject,
              authorName: commit.authorName,
              authorEmail: commit.authorEmail,
              authoredAt: commit.authoredAt,
              committedAt: commit.authoredAt,
              sourceKind: 'external',
              filesChangedCount: commit.filesChangedCount ?? null,
              totalAdditions: commit.totalAdditions ?? null,
              totalDeletions: commit.totalDeletions ?? null,
            })),
            refPayload.gitRef,
            repoPath
          );
        }
        const mutationId = refsPayload
          .map((ref) => `${ref.gitRef}:${ref.tipCommitSha}`)
          .sort()
          .join('|');
        await agentClient.enqueueLocalCommitGraphSync(workspaceId, { refs: refsPayload }, mutationId);
        await flushLocalCommitGraphSync();
        queryClient.setQueryData<TrackedGitRef[]>(
          trackedRefKeys.workspace(workspaceId),
          (current) => {
            if (!current) return current;
            const tipByRef = new Map(refsPayload.map((ref) => [ref.gitRef, ref.tipCommitSha]));
            let changed = false;
            const next = current.map((ref) => {
              const tip = tipByRef.get(ref.git_ref);
              if (!tip || ref.last_seen_commit_sha === tip) return ref;
              changed = true;
              return { ...ref, last_seen_commit_sha: tip };
            });
            return changed ? next : current;
          }
        );
        return {
          didSync: true,
          importedCount,
          importedNodeIds: [],
          importedByRef: Object.fromEntries(refsPayload.map((ref) => [ref.gitRef, ref.commits.length])),
          ignoredRefs,
          queuedForServerSync: true,
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
      // Callers own graph refresh timing. GraphView batches graph/local commit
      // refetches after sync, so eager active refetches here duplicate the most
      // expensive work during the 1-minute background sync path.
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
