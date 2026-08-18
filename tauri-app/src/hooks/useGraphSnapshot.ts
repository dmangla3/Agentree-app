import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { api } from '../lib/api';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { isTauriEnvironment } from './useTauriWorkspace';
import type { CommitEntity, CommitObservationEntity, CommitParentEntity, Message, Summary } from '../stores/workspaceStore';
import { useRunStatusStore } from '../stores/runStatusStore';

const GRAPH_SNAPSHOT_CACHE_PREFIX = 'agentree.graph-snapshot.v2';
const LOCAL_STORAGE_GRAPH_SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024;

export interface GraphSnapshotMessage extends Omit<Partial<Message>, 'content'> {
  id: string;
  role: Message['role'];
  parentId: string | null;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  contentPreview?: string;
  contentLength?: number;
}

export interface GraphSnapshotSummary extends Omit<Partial<Summary>, 'content'> {
  id: string;
  workspaceId: string;
  startMessageId: string;
  endMessageId: string;
  createdAt: string;
  updatedAt?: string;
  contentPreview?: string;
  contentLength?: number;
}

export interface GraphSnapshot {
  version: number;
  workspaceId: string;
  generatedAt: string;
  workspaceUpdatedAt?: string | null;
  messages: GraphSnapshotMessage[];
  summaries: GraphSnapshotSummary[];
  commits?: CommitEntity[];
  commitParents?: CommitParentEntity[];
  commitObservations?: CommitObservationEntity[];
  cacheWriteDisabled?: boolean;
}

const normalizeGraphSnapshot = (snapshot: GraphSnapshot): GraphSnapshot => ({
  ...snapshot,
  commits: Array.isArray(snapshot.commits) ? snapshot.commits : [],
  commitParents: Array.isArray(snapshot.commitParents) ? snapshot.commitParents : [],
  commitObservations: Array.isArray(snapshot.commitObservations) ? snapshot.commitObservations : [],
});

const emptyGraphSnapshot = (workspaceId: string): GraphSnapshot => ({
  version: 2,
  workspaceId,
  generatedAt: new Date(0).toISOString(),
  messages: [],
  summaries: [],
  commits: [],
  commitParents: [],
  commitObservations: [],
  cacheWriteDisabled: true,
});

const cacheKey = (workspaceId: string) => `${GRAPH_SNAPSHOT_CACHE_PREFIX}.${workspaceId}`;

export const clearCachedGraphSnapshot = async (workspaceId: string | null): Promise<void> => {
  if (!workspaceId) return;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(cacheKey(workspaceId));
    } catch (error) {
      recordPerfEvent('query.graph-snapshot.cache-clear-failed', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        target: 'localStorage',
        error: error instanceof Error ? error.message : String(error),
      }, { source: 'useGraphSnapshot' });
    }
  }

  if (isTauriEnvironment()) {
    try {
      await invoke('delete_graph_snapshot_cache', { workspaceId });
    } catch (error) {
      recordPerfEvent('query.graph-snapshot.cache-clear-failed', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        target: 'tauri-app-data',
        error: error instanceof Error ? error.message : String(error),
      }, { source: 'useGraphSnapshot' });
    }
  }
};

const readCachedGraphSnapshot = (workspaceId: string | null): GraphSnapshot | undefined => {
  if (!workspaceId || typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(cacheKey(workspaceId));
    if (!raw) {
      recordPerfEvent('query.graph-snapshot.cache-miss', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        reason: 'empty',
      }, { source: 'useGraphSnapshot' });
      return undefined;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 2 || parsed.workspaceId !== workspaceId || !Array.isArray(parsed.messages)) {
      recordPerfEvent('query.graph-snapshot.cache-miss', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        reason: 'invalid',
      }, { source: 'useGraphSnapshot' });
      return undefined;
    }
    recordPerfEvent('query.graph-snapshot.cache-hit', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      messageCount: parsed.messages.length,
      summaryCount: Array.isArray(parsed.summaries) ? parsed.summaries.length : null,
    }, { source: 'useGraphSnapshot' });
    return normalizeGraphSnapshot(parsed as GraphSnapshot);
  } catch {
    recordPerfEvent('query.graph-snapshot.cache-miss', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      reason: 'parse-error',
    }, { source: 'useGraphSnapshot' });
    return undefined;
  }
};

const writeCachedGraphSnapshot = (workspaceId: string, snapshot: GraphSnapshot) => {
  if (typeof window === 'undefined') return;
  if (isTauriEnvironment()) {
    recordPerfEvent('query.graph-snapshot.cache-write-skipped', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      target: 'localStorage',
      reason: 'tauri-native-cache',
      messageCount: snapshot.messages.length,
    }, { source: 'useGraphSnapshot' });
    return;
  }
  try {
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > LOCAL_STORAGE_GRAPH_SNAPSHOT_MAX_BYTES) {
      recordPerfEvent('query.graph-snapshot.cache-write-skipped', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        target: 'localStorage',
        reason: 'too-large',
        byteLength: serialized.length,
        messageCount: snapshot.messages.length,
      }, { source: 'useGraphSnapshot' });
      return;
    }
    window.localStorage.setItem(cacheKey(workspaceId), serialized);
    recordPerfEvent('query.graph-snapshot.cache-write', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      target: 'localStorage',
      byteLength: serialized.length,
      messageCount: snapshot.messages.length,
    }, { source: 'useGraphSnapshot' });
  } catch (error) {
    recordPerfEvent('query.graph-snapshot.cache-write-failed', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      target: 'localStorage',
      error: error instanceof Error ? error.message : String(error),
      messageCount: snapshot.messages.length,
    }, { source: 'useGraphSnapshot' });
  }
};

const parseCachedGraphSnapshot = (workspaceId: string, raw: string): GraphSnapshot | undefined => {
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.version !== 2 || parsed.workspaceId !== workspaceId || !Array.isArray(parsed.messages)) return undefined;
  return normalizeGraphSnapshot(parsed as GraphSnapshot);
};

const readNativeCachedGraphSnapshot = async (workspaceId: string): Promise<GraphSnapshot | undefined> => {
  const startedAt = performance.now();
  const raw = await invoke<string | null>('read_graph_snapshot_cache', { workspaceId });
  if (!raw) {
    recordPerfEvent('query.graph-snapshot.native-cache-miss', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      reason: 'empty',
    }, {
      source: 'useGraphSnapshot',
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    });
    return undefined;
  }

  const parsed = parseCachedGraphSnapshot(workspaceId, raw);
  recordPerfEvent(parsed ? 'query.graph-snapshot.native-cache-hit' : 'query.graph-snapshot.native-cache-miss', {
    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
    workspaceId,
    reason: parsed ? undefined : 'invalid',
    byteLength: raw.length,
    messageCount: parsed?.messages.length ?? null,
    summaryCount: Array.isArray(parsed?.summaries) ? parsed.summaries.length : null,
  }, {
    source: 'useGraphSnapshot',
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  });
  return parsed;
};

const writeNativeCachedGraphSnapshot = async (workspaceId: string, snapshot: GraphSnapshot) => {
  const serialized = JSON.stringify(snapshot);
  const startedAt = performance.now();
  await invoke('write_graph_snapshot_cache', { workspaceId, contents: serialized });
  recordPerfEvent('query.graph-snapshot.cache-write', {
    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
    workspaceId,
    target: 'tauri-app-data',
    byteLength: serialized.length,
    messageCount: snapshot.messages.length,
  }, {
    source: 'useGraphSnapshot',
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  });
};

const scheduleNativeGraphSnapshotCacheWrite = (workspaceId: string, snapshot: GraphSnapshot) => {
  if (useRunStatusStore.getState().hasHotSendActivity(workspaceId, 5_000)) {
    recordPerfEvent('query.graph-snapshot.cache-write-skipped', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      target: 'tauri-app-data',
      reason: 'hot-send-active',
      messageCount: snapshot.messages.length,
    }, { source: 'useGraphSnapshot' });
    return;
  }

  if (typeof window === 'undefined') {
    void writeNativeCachedGraphSnapshot(workspaceId, snapshot);
    return;
  }

  const write = () => {
    void writeNativeCachedGraphSnapshot(workspaceId, snapshot).catch((error) => {
      recordPerfEvent('query.graph-snapshot.cache-write-failed', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        target: 'tauri-app-data',
        error: error instanceof Error ? error.message : String(error),
        messageCount: snapshot.messages.length,
      }, { source: 'useGraphSnapshot' });
    });
  };

  const browserWindow = window as Window & typeof globalThis & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  };

  if (typeof browserWindow.requestIdleCallback === 'function') {
    browserWindow.requestIdleCallback(write, { timeout: 10_000 });
    return;
  }

  browserWindow.setTimeout(write, 2_000);
};

export const graphSnapshotToSummaries = (snapshot: GraphSnapshot | undefined): Summary[] => {
  if (!snapshot) return [];
  return snapshot.summaries.map((summary) => ({
    id: summary.id,
    workspaceId: summary.workspaceId,
    startMessageId: summary.startMessageId,
    endMessageId: summary.endMessageId,
    content: summary.contentPreview ?? '',
    tokenCountBefore: summary.tokenCountBefore,
    tokenCountAfter: summary.tokenCountAfter,
    createdAt: summary.createdAt,
  }));
};

export const useGraphSnapshot = (workspaceId: string | null, cacheResetNonce = 0): UseQueryResult<GraphSnapshot, Error> => {
  const isNativeRuntime = isTauriEnvironment();
  const queryClient = useQueryClient();
  const localInitialSnapshot = useMemo(() => readCachedGraphSnapshot(workspaceId), [workspaceId, cacheResetNonce]);
  const shouldUseNativeCache = !!workspaceId && !localInitialSnapshot && isNativeRuntime;
  const [nativeCacheState, setNativeCacheState] = useState<{
    ready: boolean;
    snapshot?: GraphSnapshot;
    workspaceId: string | null;
  }>({ ready: false, workspaceId: null });

  const nativeCachedSnapshot = nativeCacheState.workspaceId === workspaceId
    ? nativeCacheState.snapshot
    : undefined;
  const nativeCacheReady = nativeCacheState.workspaceId === workspaceId && nativeCacheState.ready;

  useEffect(() => {
    setNativeCacheState({ ready: false, workspaceId });
    if (!workspaceId || !shouldUseNativeCache) {
      setNativeCacheState({ ready: true, workspaceId });
      return;
    }

    let cancelled = false;
    readNativeCachedGraphSnapshot(workspaceId)
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot) {
          queryClient.setQueryData(['graph-snapshot', workspaceId], snapshot);
        }
        setNativeCacheState({ ready: true, snapshot, workspaceId });
      })
      .catch((error) => {
        if (cancelled) return;
        recordPerfEvent('query.graph-snapshot.native-cache-miss', {
          elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
          workspaceId,
          reason: 'read-error',
          error: error instanceof Error ? error.message : String(error),
        }, { source: 'useGraphSnapshot' });
        setNativeCacheState({ ready: true, workspaceId });
      });

    return () => {
      cancelled = true;
    };
  }, [shouldUseNativeCache, workspaceId, cacheResetNonce, queryClient]);

  const queryResult = useQuery<GraphSnapshot>({
    queryKey: ['graph-snapshot', workspaceId],
    queryFn: async () => {
      if (!workspaceId) {
        throw new Error('Workspace ID required.');
      }
      const startedAt = performance.now();
      const response = await api.get(`/workspaces/${workspaceId}/graph-snapshot`);
      recordPerfEvent('query.graph-snapshot.fetch', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        messageCount: Array.isArray(response.data?.messages) ? response.data.messages.length : null,
        summaryCount: Array.isArray(response.data?.summaries) ? response.data.summaries.length : null,
      }, {
        source: 'useGraphSnapshot',
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });
      return normalizeGraphSnapshot(response.data);
    },
    enabled: !!workspaceId && !isNativeRuntime && (!shouldUseNativeCache || nativeCacheReady),
    initialData: () => localInitialSnapshot,
    staleTime: 30 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });

  useEffect(() => {
    if (!workspaceId || !queryResult.data) return;
    if (queryResult.data.cacheWriteDisabled) return;
    writeCachedGraphSnapshot(workspaceId, queryResult.data);
    if (isNativeRuntime) {
      scheduleNativeGraphSnapshotCacheWrite(workspaceId, queryResult.data);
    }
  }, [isNativeRuntime, queryResult.data, workspaceId]);

  const nativeFallbackSnapshot = workspaceId && isNativeRuntime && nativeCacheReady
    ? nativeCachedSnapshot ?? emptyGraphSnapshot(workspaceId)
    : undefined;
  const resolvedData = queryResult.data ?? nativeCachedSnapshot ?? nativeFallbackSnapshot;

  return {
    ...queryResult,
    data: resolvedData,
    status: resolvedData ? 'success' : queryResult.status,
    isSuccess: queryResult.isSuccess || !!resolvedData,
    isPending: !resolvedData && queryResult.isPending,
    isLoading: !resolvedData && queryResult.isLoading,
  } as UseQueryResult<GraphSnapshot, Error>;
};
