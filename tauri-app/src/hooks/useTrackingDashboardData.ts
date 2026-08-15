import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { buildTrackingDashboardMetrics, type TrackingRange } from '../domain/trackingDashboardMetrics';
import { agentClient } from '../lib/agentClient';
import { mapLocalCommitToCommitEntity } from '../lib/localCommitGraphProjection';
import type { Workspace } from '../stores/workspaceStore';
import { useGraphSnapshot } from './useGraphSnapshot';
import { useMessages } from './useMessages';

const emptyLocalCommitGraph = { commits: [], commitParents: [], commitObservations: [] };

export function useTrackingDashboardData(workspace: Workspace | null, range: TrackingRange) {
  const workspaceId = workspace?.id ?? null;
  const repoPath = workspace?.git_repo_path ?? workspace?.folderPath ?? null;
  const messagesQuery = useMessages(workspaceId, { enabled: Boolean(workspaceId) });
  const graphSnapshotQuery = useGraphSnapshot(workspaceId);
  const localCommitGraphQuery = useQuery({
    queryKey: ['local-commit-graph', workspaceId, repoPath, 'tracking'],
    queryFn: async () => {
      if (!workspaceId) return emptyLocalCommitGraph;
      if (repoPath) {
        await agentClient.repairLocalCommitGraph(workspaceId, repoPath);
      }
      return agentClient.listLocalCommitGraph(workspaceId);
    },
    enabled: Boolean(workspaceId && agentClient.hasRuntime()),
    staleTime: 5_000,
    gcTime: 5 * 60 * 1000,
  });

  const commits = useMemo(() => {
    if (!workspaceId) return [];
    if (agentClient.hasRuntime()) {
      return (localCommitGraphQuery.data?.commits ?? []).map((commit) => mapLocalCommitToCommitEntity(commit, workspaceId));
    }
    return graphSnapshotQuery.data?.commits ?? [];
  }, [graphSnapshotQuery.data?.commits, localCommitGraphQuery.data?.commits, workspaceId]);

  const metrics = useMemo(() => buildTrackingDashboardMetrics({
    range,
    messages: messagesQuery.data ?? [],
    commits,
  }), [commits, messagesQuery.data, range]);

  return {
    metrics,
    isLoading: messagesQuery.isLoading || graphSnapshotQuery.isLoading || localCommitGraphQuery.isLoading,
    isRefreshing: messagesQuery.isFetching || graphSnapshotQuery.isFetching || localCommitGraphQuery.isFetching,
    error: messagesQuery.error ?? graphSnapshotQuery.error ?? localCommitGraphQuery.error ?? null,
  };
}
