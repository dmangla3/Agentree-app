import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { agentClient, type LocalNodeRecord } from '../lib/agentClient';
import { getAccessToken } from '../lib/authSession';
import type { Message } from '../stores/workspaceStore';

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

export const parseLocalNode = (row: LocalNodeRecord): LocalNodeMessage | null => {
  try {
    const payload = JSON.parse(row.payload);
    if (!payload || typeof payload.id !== 'string') return null;
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

export const useLocalNodes = (workspaceId: string | null | undefined) => {
  const syncInFlightRef = useRef(false);
  const query = useQuery<LocalNodeMessage[]>({
    queryKey: localNodeKeys.workspace(workspaceId),
    queryFn: async () => {
      if (!workspaceId || !agentClient.hasRuntime()) return [];
      const rows = await agentClient.listLocalNodes(workspaceId);
      return rows
        .map(parseLocalNode)
        .filter((row): row is LocalNodeMessage => Boolean(row));
    },
    enabled: Boolean(workspaceId) && agentClient.hasRuntime(),
    staleTime: 1000,
    gcTime: 30 * 60 * 1000,
    refetchInterval: (query) => {
      if (!agentClient.hasRuntime()) return false;
      const data = query.state.data;
      if (!data?.some((row) => row.syncStatus === 'local_only')) return false;
      return 5000;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  const localNodes = query.data;
  const refetchLocalNodes = query.refetch;

  useEffect(() => {
    if (!workspaceId || !agentClient.hasRuntime()) return;
    if (syncInFlightRef.current) return;
    const hasRetryableLocalOnly = (localNodes ?? []).some((row) => {
      if (row.syncStatus !== 'local_only') return false;
      if (!row.nextRetryAt) return true;
      return row.nextRetryAt <= Math.floor(Date.now() / 1000);
    });
    if (!hasRetryableLocalOnly) return;
    syncInFlightRef.current = true;
    void getAccessToken()
      .then((token) => agentClient.processLocalSyncEvents(token))
      .then(() => refetchLocalNodes())
      .catch(() => undefined)
      .finally(() => {
        syncInFlightRef.current = false;
      });
  }, [localNodes, refetchLocalNodes, workspaceId]);

  return query;
};
