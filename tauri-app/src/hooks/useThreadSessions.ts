import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getErrorMessage } from '../lib/api';
import { agentClient } from '../lib/agentClient';
import type { GraphSnapshot } from './useGraphSnapshot';
import {
  normalizeThreadSession,
  threadSessionSortKey,
  type ThreadSession,
} from '../lib/threadSessions';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { threadApplication } from '../application/threads';
import { isTauriEnvironment } from './useTauriWorkspace';
import { localNodeKeys } from './useLocalNodes';
import { queueLocalSyncFlush } from '../lib/localSyncScheduler';

export const threadSessionKeys = {
  workspace: (workspaceId: string | null | undefined) => ['thread-sessions', workspaceId] as const,
};

export const mergeThreadSessionIntoCache = (
  current: ThreadSession[] | undefined,
  next: ThreadSession,
): ThreadSession[] => {
  const byId = new Map((current ?? []).map((thread) => [thread.id, thread]));
  byId.set(next.id, next);
  return Array.from(byId.values()).sort((left, right) => {
    const leftKey = threadSessionSortKey(left);
    const rightKey = threadSessionSortKey(right);
    if (leftKey.statusRank !== rightKey.statusRank) return leftKey.statusRank - rightKey.statusRank;
    if (leftKey.createdAtMs !== rightKey.createdAtMs) return rightKey.createdAtMs - leftKey.createdAtMs;
    return leftKey.id.localeCompare(rightKey.id);
  });
};

export const removeThreadSessionFromCache = (
  current: ThreadSession[] | undefined,
  threadId: string,
): ThreadSession[] => (current ?? []).filter((thread) => thread.id !== threadId);

type CachedGraphSnapshotThreadSession = Partial<ThreadSession> & { id?: unknown };

export const mergeThreadSessionIntoGraphSnapshotCache = <T extends { threadSessions?: CachedGraphSnapshotThreadSession[] } | undefined>(
  current: T,
  next: ThreadSession,
): T => {
  if (!current) return current;
  const threadSessions = current.threadSessions ?? [];
  const hasExisting = threadSessions.some((thread) => thread.id === next.id);
  return {
    ...current,
    threadSessions: hasExisting
      ? threadSessions.map((thread) => (thread.id === next.id ? next : thread))
      : [...threadSessions, next],
  };
};

export const removeThreadSessionFromGraphSnapshotCache = <T extends { threadSessions?: CachedGraphSnapshotThreadSession[] } | undefined>(
  current: T,
  threadId: string,
): T => {
  if (!current || !Array.isArray(current.threadSessions)) return current;
  return {
    ...current,
    threadSessions: current.threadSessions.filter((thread) => thread.id !== threadId),
  };
};

export const useThreadSessions = (workspaceId: string | null | undefined) => useQuery({
  queryKey: threadSessionKeys.workspace(workspaceId),
  queryFn: async (): Promise<ThreadSession[]> => {
    if (!workspaceId) return [];
    const startedAt = performance.now();
    const source = isTauriEnvironment() ? 'local-runtime' : 'api';
    const rawSessions = await threadApplication.list(workspaceId);
    const sessions = (Array.isArray(rawSessions) ? rawSessions : [])
      .map((item) => normalizeThreadSession(item))
      .filter((item): item is ThreadSession => Boolean(item));
    recordPerfEvent('query.thread-sessions.read', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      source,
      threadCount: sessions.length,
    }, {
      source: 'useThreadSessions',
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    });
    return sessions;
  },
  enabled: Boolean(workspaceId),
  staleTime: isTauriEnvironment() ? Infinity : 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

export const useCreateThreadSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id?: string;
      workspaceId: string;
      title?: string | null;
      status?: ThreadSession['status'];
      source?: ThreadSession['source'];
      baseCommitSha?: string | null;
      firstMessageId?: string | null;
      parentThreadId?: string | null;
      createdAt?: string;
      updatedAt?: string;
    }): Promise<ThreadSession> => {
      const now = input.createdAt ?? new Date().toISOString();
      const payload = {
        id: input.id ?? crypto.randomUUID(),
        workspaceId: input.workspaceId,
        title: input.title ?? null,
        status: input.status ?? 'active',
        createdAt: now,
        updatedAt: input.updatedAt ?? now,
        baseCommitSha: input.baseCommitSha ?? null,
        firstMessageId: input.firstMessageId ?? null,
        parentThreadId: input.parentThreadId ?? null,
        anchorNodeId: null,
        source: input.source ?? 'user',
      } as const;
      const created = await threadApplication.create(payload);
      const normalized = normalizeThreadSession(created);
      if (!normalized) throw new Error('Invalid thread session response.');
      return normalized;
    },
    onSuccess: (thread) => {
      queryClient.setQueryData<ThreadSession[]>(
        threadSessionKeys.workspace(thread.workspaceId),
        (current) => mergeThreadSessionIntoCache(current, thread),
      );
    },
  });
};

export const useRenameThreadSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      workspaceId: string;
      threadId: string;
      title: string;
    }): Promise<ThreadSession> => {
      const title = input.title.trim();
      if (!title) throw new Error('Thread title is required.');

      const currentSessions = queryClient.getQueryData<ThreadSession[]>(threadSessionKeys.workspace(input.workspaceId)) ?? [];
      const graphSnapshot = queryClient.getQueryData<GraphSnapshot | undefined>(['graph-snapshot', input.workspaceId]);
      const current = currentSessions.find((thread) => thread.id === input.threadId)
        ?? graphSnapshot?.threadSessions?.find((thread) => thread.id === input.threadId)
        ?? null;
      const now = new Date().toISOString();
      const payload = {
        id: input.threadId,
        workspaceId: input.workspaceId,
        title,
        status: current?.status ?? 'active',
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        baseCommitSha: current?.baseCommitSha ?? null,
        firstMessageId: current?.firstMessageId ?? null,
        parentThreadId: current?.parentThreadId ?? null,
        anchorNodeId: current?.anchorNodeId ?? null,
        source: current?.source ?? 'user',
      };
      const updated = await threadApplication.update(payload);
      const normalized = normalizeThreadSession(updated);
      if (!normalized) throw new Error('Invalid thread session response.');
      return normalized;
    },
    onSuccess: (thread) => {
      queryClient.setQueryData<ThreadSession[]>(
        threadSessionKeys.workspace(thread.workspaceId),
        (current) => mergeThreadSessionIntoCache(current, thread),
      );
      queryClient.setQueryData<GraphSnapshot | undefined>(
        ['graph-snapshot', thread.workspaceId],
        (current) => mergeThreadSessionIntoGraphSnapshotCache(current, thread),
      );
      void queryClient.invalidateQueries({ queryKey: ['graph-snapshot', thread.workspaceId], refetchType: 'active' });
    },
  });
};

export const useDeleteThreadSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      workspaceId: string;
      threadId: string;
    }): Promise<{ workspaceId: string; threadId: string }> => {
      await threadApplication.remove(input.workspaceId, input.threadId);
      return input;
    },
    onSuccess: ({ workspaceId, threadId }) => {
      queryClient.setQueryData<ThreadSession[]>(
        threadSessionKeys.workspace(workspaceId),
        (current) => removeThreadSessionFromCache(current, threadId),
      );
      queryClient.setQueryData<GraphSnapshot | undefined>(
        ['graph-snapshot', workspaceId],
        (current) => removeThreadSessionFromGraphSnapshotCache(current, threadId),
      );
      void queryClient.invalidateQueries({ queryKey: ['graph-snapshot', workspaceId], refetchType: 'active' });
    },
  });
};

export interface ConvertSubgraphToThreadInput {
  workspaceId: string;
  rootNodeId: string;
  idempotencyKey?: string;
  targetThreadId?: string;
}

export interface ConvertSubgraphToThreadResult {
  thread: ThreadSession;
  conversionId: string;
  rootNodeId: string;
  sourceThreadId: string | null;
  targetThreadId: string;
  originalParentId: string;
  movedNodeIds: string[];
}

export const useConvertSubgraphToThread = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConvertSubgraphToThreadInput): Promise<ConvertSubgraphToThreadResult> => {
      const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
      const targetThreadId = input.targetThreadId ?? crypto.randomUUID();
      try {
        const raw = agentClient.hasRuntime()
          ? await agentClient.convertSubgraphToThread({ ...input, idempotencyKey, targetThreadId })
          : (await api.post(`/workspaces/${input.workspaceId}/threads/convert-subgraph`, {
            rootNodeId: input.rootNodeId,
            idempotencyKey,
            targetThreadId,
          })).data;
        const thread = normalizeThreadSession(raw?.thread);
        if (!thread) throw new Error('Invalid converted thread response.');
        return {
          thread,
          conversionId: String(raw.conversionId),
          rootNodeId: String(raw.rootNodeId),
          sourceThreadId: typeof raw.sourceThreadId === 'string' ? raw.sourceThreadId : null,
          targetThreadId: String(raw.targetThreadId),
          originalParentId: String(raw.originalParentId),
          movedNodeIds: Array.isArray(raw.movedNodeIds) ? raw.movedNodeIds.filter((id: unknown): id is string => typeof id === 'string') : [],
        };
      } catch (error) {
        throw new Error(getErrorMessage(error));
      }
    },
    onSuccess: (result) => {
      const workspaceId = result.thread.workspaceId;
      queryClient.setQueryData<ThreadSession[]>(
        threadSessionKeys.workspace(workspaceId),
        (current) => mergeThreadSessionIntoCache(current, result.thread),
      );
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['messages', workspaceId] }),
        queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: ['summaries', workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ['graph-snapshot', workspaceId] }),
        queryClient.invalidateQueries({ queryKey: threadSessionKeys.workspace(workspaceId) }),
      ]);
      if (agentClient.hasRuntime()) queueLocalSyncFlush({ reason: 'subgraph-thread-conversion' });
    },
  });
};
