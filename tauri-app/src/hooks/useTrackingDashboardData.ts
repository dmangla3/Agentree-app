import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { buildTrackingDashboardMetrics, type TrackingRange } from '../domain/trackingDashboardMetrics';
import { agentClient } from '../lib/agentClient';
import { mapLocalCommitToCommitEntity } from '../lib/localCommitGraphProjection';
import { useAgentRunProjectionStore, type AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message, Workspace } from '../stores/workspaceStore';
import { useGraphSnapshot } from './useGraphSnapshot';
import { useLocalNodes, type LocalNodeMessage } from './useLocalNodes';
import { applyLocalNodeMessages } from './useLiveMessages';
import { useMessages } from './useMessages';

const emptyLocalCommitGraph = { commits: [], commitParents: [], commitObservations: [] };
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'error']);

const cleanTerminalStatus = (status: unknown): Message['status'] | null => {
  if (typeof status !== 'string') return null;
  const normalized = status.trim();
  return terminalStatuses.has(normalized) ? normalized as Message['status'] : null;
};

const terminalStatusFromExecutionData = (executionData: unknown): Message['status'] | null => {
  if (!executionData || typeof executionData !== 'object') return null;
  return cleanTerminalStatus((executionData as Record<string, unknown>).last_terminal_status);
};

const terminalStatusFromProjection = (projection: AgentRunProjectedMessage): Message['status'] | null => (
  terminalStatusFromExecutionData(projection.execution_data)
    ?? cleanTerminalStatus(projection._optimisticStatus)
    ?? cleanTerminalStatus(projection.status)
);

const mergeExecutionDataForDashboard = (
  base: Message['execution_data'],
  projection: Message['execution_data'],
) => {
  const baseObject = base && typeof base === 'object' ? base as Record<string, any> : {};
  const projectedObject = projection && typeof projection === 'object' ? projection as Record<string, any> : {};
  return {
    ...baseObject,
    ...projectedObject,
    meta: {
      ...(baseObject.meta || {}),
      ...(projectedObject.meta || {}),
    },
  };
};

export const applyDashboardMetricMessageProjection = ({
  workspaceId,
  messages,
  localMessages,
  projectionsById,
}: {
  workspaceId: string | null;
  messages: Message[];
  localMessages?: LocalNodeMessage[] | null;
  projectionsById: Record<string, AgentRunProjectedMessage>;
}): Message[] => {
  const localBaseMessages = applyLocalNodeMessages(messages, localMessages, workspaceId);
  if (!workspaceId) return localBaseMessages;

  const merged = new Map<string, Message>(localBaseMessages.map((message) => [message.id, message]));
  for (const projection of Object.values(projectionsById)) {
    if (projection.workspaceId !== workspaceId) continue;
    const terminalStatus = terminalStatusFromProjection(projection);
    if (!terminalStatus) continue;
    const base = merged.get(projection.id);
    if (!base) continue;
    const executionData = mergeExecutionDataForDashboard(base.execution_data, projection.execution_data);
    merged.set(projection.id, {
      ...base,
      status: terminalStatus,
      updatedAt: projection.updatedAt ?? base.updatedAt,
      execution_data: executionData,
      promptTokens: projection.promptTokens ?? base.promptTokens ?? null,
      completionTokens: projection.completionTokens ?? base.completionTokens ?? null,
      totalTokens: projection.totalTokens ?? base.totalTokens ?? null,
      output_commit_sha: projection.output_commit_sha ?? base.output_commit_sha ?? null,
      git_branch_name: projection.git_branch_name ?? base.git_branch_name ?? null,
    });
  }

  return Array.from(merged.values()).sort((left, right) => (
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  ));
};

const dashboardProjectionFingerprint = (
  workspaceId: string | null,
  projectionsById: Record<string, AgentRunProjectedMessage>,
) => (
  Object.values(projectionsById)
    .filter((projection) => projection.workspaceId === workspaceId && terminalStatusFromProjection(projection))
    .map((projection) => {
      const executionData = projection.execution_data && typeof projection.execution_data === 'object'
        ? projection.execution_data as Record<string, unknown>
        : {};
      const usage = executionData.usage && typeof executionData.usage === 'object'
        ? executionData.usage
        : null;
      return [
        projection.id,
        terminalStatusFromProjection(projection) ?? '',
        projection.updatedAt ?? '',
        projection.promptTokens ?? '',
        projection.completionTokens ?? '',
        projection.totalTokens ?? '',
        projection.output_commit_sha ?? '',
        projection.git_branch_name ?? '',
        JSON.stringify(usage ?? null),
      ].join('|');
    })
    .sort()
    .join(';')
);

export function useTrackingDashboardData(workspace: Workspace | null, range: TrackingRange) {
  const workspaceId = workspace?.id ?? null;
  const repoPath = workspace?.git_repo_path ?? workspace?.folderPath ?? null;
  const messagesQuery = useMessages(workspaceId, { enabled: Boolean(workspaceId) });
  const localNodesQuery = useLocalNodes(workspaceId);
  const graphSnapshotQuery = useGraphSnapshot(workspaceId);
  const terminalProjectionFingerprint = useAgentRunProjectionStore((state) => (
    dashboardProjectionFingerprint(workspaceId, state.projectionsById)
  ));
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

  const metricMessages = useMemo(() => applyDashboardMetricMessageProjection({
    workspaceId,
    messages: messagesQuery.data ?? [],
    localMessages: localNodesQuery.data,
    projectionsById: useAgentRunProjectionStore.getState().projectionsById,
  }), [localNodesQuery.data, messagesQuery.data, terminalProjectionFingerprint, workspaceId]);

  const metrics = useMemo(() => buildTrackingDashboardMetrics({
    range,
    messages: metricMessages,
    commits,
  }), [commits, metricMessages, range]);

  return {
    metrics,
    isLoading: messagesQuery.isLoading || localNodesQuery.isLoading || graphSnapshotQuery.isLoading || localCommitGraphQuery.isLoading,
    isRefreshing: messagesQuery.isFetching || localNodesQuery.isFetching || graphSnapshotQuery.isFetching || localCommitGraphQuery.isFetching,
    error: messagesQuery.error ?? localNodesQuery.error ?? graphSnapshotQuery.error ?? localCommitGraphQuery.error ?? null,
  };
}
