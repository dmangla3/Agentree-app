import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { agentClient } from '../lib/agentClient';
import type { GraphSnapshot } from './useGraphSnapshot';
import {
  normalizeThreadSession,
  threadSessionSortKey,
  type ThreadSession,
} from '../lib/threadSessions';

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
    if (leftKey.updatedAtMs !== rightKey.updatedAtMs) return rightKey.updatedAtMs - leftKey.updatedAtMs;
    return leftKey.id.localeCompare(rightKey.id);
  });
};

export const removeThreadSessionFromCache = (
  current: ThreadSession[] | undefined,
  threadId: string,
): ThreadSession[] => (current ?? []).filter((thread) => thread.id !== threadId);

type CachedGraphSnapshotThreadSession = { id?: unknown };

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
    const rawSessions = agentClient.hasRuntime()
      ? await agentClient.listThreadSessions(workspaceId)
      : (await api.get(`/workspaces/${workspaceId}/threads`)).data;
    return (Array.isArray(rawSessions) ? rawSessions : [])
      .map((item) => normalizeThreadSession(item))
      .filter((item): item is ThreadSession => Boolean(item));
  },
  enabled: Boolean(workspaceId),
  staleTime: agentClient.hasRuntime() ? Infinity : 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

export const useCreateThreadSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      workspaceId: string;
      title?: string | null;
      source?: ThreadSession['source'];
      baseCommitSha?: string | null;
      firstMessageId?: string | null;
    }): Promise<ThreadSession> => {
      const now = new Date().toISOString();
      const payload = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        title: input.title ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        baseCommitSha: input.baseCommitSha ?? null,
        firstMessageId: input.firstMessageId ?? null,
        source: input.source ?? 'user',
      };
      const created = agentClient.hasRuntime()
        ? await agentClient.createThreadSession(payload)
        : (await api.post(`/workspaces/${input.workspaceId}/threads`, payload)).data;
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

export const useDeleteThreadSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      workspaceId: string;
      threadId: string;
    }): Promise<{ workspaceId: string; threadId: string }> => {
      if (agentClient.hasRuntime()) {
        await agentClient.deleteThreadSession(input.workspaceId, input.threadId);
      } else {
        await api.delete(`/workspaces/${input.workspaceId}/threads/${input.threadId}`);
      }
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
