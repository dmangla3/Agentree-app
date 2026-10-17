import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { agentClient, type LocalNodeRecord } from '../lib/agentClient';
import type { Message } from '../stores/workspaceStore';
import { queueLocalSyncFlush } from '../lib/localSyncScheduler';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';

export interface LocalNodeMessage {
  nodeId: string;
  workspaceId: string;
  syncStatus: 'local_only' | 'persisted';
  finalizedAt: number;
  serverAckAt?: number | null;
  retryAttempt: number;
  nextRetryAt?: number | null;
  lastUploadError?: string | null;
  message: Partial<Message> & { id: string };
}

export const localNodeKeys = {
  workspace: (workspaceId: string | null | undefined) => ['local-nodes', workspaceId] as const,
};

const LOCAL_NODE_RETRY_POLL_MS = 60_000;

const isPermanentLocalNodeSyncError = (error: string | null | undefined): boolean => (
  Boolean(error?.startsWith('node.update_terminal failed with status 404 Not Found'))
);

export const isRetryableLocalOnlySync = (row: {
  syncStatus?: string | null;
  retryAttempt?: number | null;
  nextRetryAt?: number | null;
  lastUploadError?: string | null;
}): boolean => {
  if (row.syncStatus !== 'local_only') return false;
  if (isPermanentLocalNodeSyncError(row.lastUploadError)) return false;
  if (typeof row.nextRetryAt === 'number' && Number.isFinite(row.nextRetryAt)) return true;
  return Boolean(row.retryAttempt || row.lastUploadError);
};

const getRetryableAt = (row: LocalNodeMessage, nowSeconds: number): number | null => {
  if (!isRetryableLocalOnlySync(row)) return null;
  if (typeof row.nextRetryAt === 'number' && Number.isFinite(row.nextRetryAt)) {
    return row.nextRetryAt;
  }
  return nowSeconds;
};

export const getLocalNodeRetryPollIntervalMs = (
  rows: LocalNodeMessage[] | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): number | false => {
  const retryTimes = (rows ?? [])
    .map((row) => getRetryableAt(row, nowSeconds))
    .filter((value): value is number => value !== null);
  if (retryTimes.length === 0) return false;
  const nextRetryAt = Math.min(...retryTimes);
  if (nextRetryAt <= nowSeconds) return LOCAL_NODE_RETRY_POLL_MS;
  return Math.max(
    LOCAL_NODE_RETRY_POLL_MS,
    (nextRetryAt - nowSeconds) * 1000,
  );
};

export const hasDueRetryableLocalNode = (
  rows: LocalNodeMessage[] | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
) => (rows ?? []).some((row) => {
  const retryAt = getRetryableAt(row, nowSeconds);
  return retryAt !== null && retryAt <= nowSeconds;
});

const readMessageCreatedAtMs = (row: LocalNodeMessage): number => {
  const value = row.message.createdAt ?? row.message.updatedAt;
  const parsed = typeof value === 'string' ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : row.finalizedAt * 1000;
};

export const upsertMessagesIntoLocalNodeCache = (
  current: LocalNodeMessage[] | null | undefined,
  workspaceId: string | null | undefined,
  messages: Array<Partial<Message> & { id: string }>,
  options: {
    syncStatus?: LocalNodeMessage['syncStatus'];
    finalizedAt?: number;
    serverAckAt?: number | null;
    retryAttempt?: number;
  } = {},
): LocalNodeMessage[] => {
  const existingRows = current ?? [];
  if (!workspaceId || messages.length === 0) return existingRows;

  const finalizedAt = options.finalizedAt ?? Math.floor(Date.now() / 1000);
  const rowsById = new Map(existingRows.map((row) => [row.nodeId, row]));

  for (const message of messages) {
    const messageWorkspaceId: string = typeof message.workspaceId === 'string' ? message.workspaceId : workspaceId;
    if (messageWorkspaceId !== workspaceId) continue;
    const existing = rowsById.get(message.id);
    rowsById.set(message.id, {
      ...existing,
      nodeId: message.id,
      workspaceId,
      syncStatus: options.syncStatus ?? existing?.syncStatus ?? 'local_only',
      finalizedAt: options.finalizedAt ?? existing?.finalizedAt ?? finalizedAt,
      serverAckAt: options.serverAckAt ?? existing?.serverAckAt,
      retryAttempt: options.retryAttempt ?? existing?.retryAttempt ?? 0,
      message: {
        ...(existing?.message ?? {}),
        ...message,
        id: message.id,
        workspaceId,
      },
    });
  }

  return Array.from(rowsById.values()).sort((left, right) => {
    const leftTs = readMessageCreatedAtMs(left);
    const rightTs = readMessageCreatedAtMs(right);
    if (leftTs !== rightTs) return leftTs - rightTs;
    return left.nodeId.localeCompare(right.nodeId);
  });
};

export const parseLocalNode = (row: LocalNodeRecord): LocalNodeMessage | null => {
  try {
    const payload = JSON.parse(row.payload);
    if (!payload || typeof payload.id !== 'string') return null;
    if (payload.role === 'assistant' && (typeof payload.agent_id !== 'string' || !payload.agent_id.trim())) {
      const executionData = payload.execution_data;
      const meta = executionData?.meta;
      const persistedAgentId = executionData?.agent_id ?? meta?.agent_id ?? meta?.selected_agent_id;
      if (typeof persistedAgentId === 'string' && persistedAgentId.trim()) {
        payload.agent_id = persistedAgentId.trim();
      } else {
        const provider = meta?.provider;
        const model = meta?.provider_model ?? payload.llmModel;
        const effort = meta?.provider_reasoning_effort;
        if (
          typeof provider === 'string' && provider.trim()
          && typeof model === 'string' && model.trim()
          && typeof effort === 'string' && effort.trim()
        ) {
          payload.agent_id = `${provider.trim()}:${model.trim()}:${effort.trim()}`;
        }
      }
    }
    const controlledByNodeId = row.controlledByNodeId ?? payload.controlledByNodeId ?? payload.controlled_by_node_id ?? null;
    if (controlledByNodeId && typeof controlledByNodeId === 'string') {
      payload.controlledByNodeId = controlledByNodeId;
      payload.controlled_by_node_id = controlledByNodeId;
    }
    return {
      nodeId: row.nodeId,
      workspaceId: row.workspaceId,
      syncStatus: row.syncStatus,
      finalizedAt: row.finalizedAt,
      serverAckAt: row.serverAckAt,
      retryAttempt: row.retryAttempt,
      nextRetryAt: row.nextRetryAt,
      lastUploadError: row.lastUploadError,
      message: payload,
    };
  } catch {
    return null;
  }
};

export const useLocalNodes = (
  workspaceId: string | null | undefined,
  options: { enabled?: boolean } = {},
) => {
  const query = useQuery<LocalNodeMessage[]>({
    queryKey: localNodeKeys.workspace(workspaceId),
    queryFn: async () => {
      if (!workspaceId || !agentClient.hasRuntime()) return [];
      const startedAt = performance.now();
      const rows = await agentClient.listLocalNodes(workspaceId);
      const localNodes = rows
        .map(parseLocalNode)
        .filter((row): row is LocalNodeMessage => Boolean(row));
      recordPerfEvent('query.local-nodes.read', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        rowCount: rows.length,
        messageCount: localNodes.length,
      }, {
        source: 'useLocalNodes',
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });
      return localNodes;
    },
    enabled: Boolean(workspaceId) && agentClient.hasRuntime() && options.enabled !== false,
    staleTime: 5000,
    gcTime: 30 * 60 * 1000,
    refetchInterval: (query) => {
      if (!agentClient.hasRuntime()) return false;
      return getLocalNodeRetryPollIntervalMs(query.state.data);
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  const localNodes = query.data;

  useEffect(() => {
    if (!workspaceId || !agentClient.hasRuntime()) return;
    if (!hasDueRetryableLocalNode(localNodes)) return;
    queueLocalSyncFlush({ reason: 'local-node-retryable' });
  }, [localNodes, workspaceId]);

  return query;
};
