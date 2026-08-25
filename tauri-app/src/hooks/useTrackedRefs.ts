import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWorkspaceStore, type TrackedGitRef } from '../stores/workspaceStore';
import axios from 'axios';
import { agentClient } from '../lib/agentClient';

export const trackedRefKeys = {
  all: ['tracked-refs'] as const,
  workspace: (workspaceId: string | null) => [...trackedRefKeys.all, workspaceId ?? ''] as const,
};

const TRACKED_REFS_CACHE_PREFIX = 'agentree.tracked-refs.v1';

const trackedRefsCacheKey = (workspaceId: string) => `${TRACKED_REFS_CACHE_PREFIX}.${workspaceId}`;

const normalizeTrackedRefs = (workspaceId: string, value: unknown): TrackedGitRef[] => (
  Array.isArray(value)
    ? value.filter((ref): ref is TrackedGitRef => (
      ref &&
      typeof ref === 'object' &&
      (ref as TrackedGitRef).workspace_id === workspaceId &&
      typeof (ref as TrackedGitRef).git_ref === 'string'
    ))
    : []
);

export const readCachedTrackedRefs = (workspaceId: string | null): TrackedGitRef[] => {
  if (!workspaceId || typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(trackedRefsCacheKey(workspaceId));
    if (!raw) return [];
    return normalizeTrackedRefs(workspaceId, JSON.parse(raw));
  } catch {
    return [];
  }
};

export const writeCachedTrackedRefs = (workspaceId: string, refs: TrackedGitRef[]) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      trackedRefsCacheKey(workspaceId),
      JSON.stringify(normalizeTrackedRefs(workspaceId, refs))
    );
  } catch {
    // Best-effort cache; query data remains authoritative for this session.
  }
};

const displayNameFromGitRef = (gitRef: string) => (
  gitRef.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '')
);

const upsertCachedTrackedRef = (workspaceId: string, ref: TrackedGitRef): TrackedGitRef[] => {
  const current = readCachedTrackedRefs(workspaceId);
  const byId = new Map(current.map((item) => [item.id, item]));
  byId.set(ref.id, ref);
  const next = Array.from(byId.values());
  writeCachedTrackedRefs(workspaceId, next);
  return next;
};

const removeCachedTrackedRef = (workspaceId: string, refId: string): TrackedGitRef[] => {
  const next = readCachedTrackedRefs(workspaceId).filter((ref) => ref.id !== refId);
  writeCachedTrackedRefs(workspaceId, next);
  return next;
};

export const useTrackedRefs = (workspaceId: string | null): UseQueryResult<TrackedGitRef[], Error> => {
  const clearSelectedWorkspace = useWorkspaceStore((state) => state.clearSelectedWorkspace);
  const queryResult = useQuery<TrackedGitRef[]>({
    queryKey: trackedRefKeys.workspace(workspaceId),
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      if (!workspaceId) return [];
      if (agentClient.hasRuntime()) {
        return readCachedTrackedRefs(workspaceId);
      }
      const response = await api.get(`/workspaces/${workspaceId}/tracked-refs`);
      writeCachedTrackedRefs(workspaceId, response.data);
      return response.data;
    },
    staleTime: agentClient.hasRuntime() ? Infinity : undefined,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    const error = queryResult.error;
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      clearSelectedWorkspace();
    }
  }, [queryResult.error, clearSelectedWorkspace]);

  return queryResult;
};

export const useCreateTrackedRef = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      workspaceId: string;
      gitRef: string;
      displayName?: string;
      enabled?: boolean;
    }) => {
      const { workspaceId, ...body } = input;
      if (agentClient.hasRuntime()) {
        const now = new Date().toISOString();
        const localRef: TrackedGitRef = {
          id: `local:${workspaceId}:${input.gitRef}`,
          workspace_id: workspaceId,
          git_ref: input.gitRef,
          display_name: input.displayName?.trim() || displayNameFromGitRef(input.gitRef),
          enabled: input.enabled ?? true,
          last_seen_commit_sha: null,
          createdAt: now,
          updatedAt: now,
        };
        upsertCachedTrackedRef(workspaceId, localRef);
        return localRef;
      }
      const response = await api.post(`/workspaces/${workspaceId}/tracked-refs`, body);
      return response.data as TrackedGitRef;
    },
    onSuccess: (data, variables) => {
      if (agentClient.hasRuntime()) {
        queryClient.setQueryData<TrackedGitRef[]>(
          trackedRefKeys.workspace(variables.workspaceId),
          () => upsertCachedTrackedRef(variables.workspaceId, data)
        );
        return;
      }
      writeCachedTrackedRefs(variables.workspaceId, [
        ...readCachedTrackedRefs(variables.workspaceId).filter((ref) => ref.id !== data.id),
        data,
      ]);
      queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(variables.workspaceId) });
    },
  });
};

export const useUpdateTrackedRef = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      workspaceId: string;
      refId: string;
      displayName?: string;
      enabled?: boolean;
      lastSeenCommitSha?: string | null;
    }) => {
      const { workspaceId, refId, ...body } = input;
      if (agentClient.hasRuntime()) {
        const current = readCachedTrackedRefs(workspaceId);
        const existing = current.find((ref) => ref.id === refId);
        if (!existing) throw new Error('Tracked ref not found in local cache.');
        const updated: TrackedGitRef = {
          ...existing,
          display_name: input.displayName ?? existing.display_name,
          enabled: input.enabled ?? existing.enabled,
          last_seen_commit_sha: input.lastSeenCommitSha ?? existing.last_seen_commit_sha ?? null,
          updatedAt: new Date().toISOString(),
        };
        upsertCachedTrackedRef(workspaceId, updated);
        return updated;
      }
      const response = await api.patch(`/workspaces/${workspaceId}/tracked-refs/${refId}`, body);
      return response.data as TrackedGitRef;
    },
    onSuccess: (data, variables) => {
      if (agentClient.hasRuntime()) {
        queryClient.setQueryData<TrackedGitRef[]>(
          trackedRefKeys.workspace(variables.workspaceId),
          () => upsertCachedTrackedRef(variables.workspaceId, data)
        );
        return;
      }
      writeCachedTrackedRefs(variables.workspaceId, [
        ...readCachedTrackedRefs(variables.workspaceId).filter((ref) => ref.id !== data.id),
        data,
      ]);
      queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(variables.workspaceId) });
    },
  });
};

export const useDeleteTrackedRef = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { workspaceId: string; refId: string }) => {
      if (agentClient.hasRuntime()) {
        removeCachedTrackedRef(input.workspaceId, input.refId);
        return input;
      }
      await api.delete(`/workspaces/${input.workspaceId}/tracked-refs/${input.refId}`);
      return input;
    },
    onSuccess: (_data, variables) => {
      if (agentClient.hasRuntime()) {
        queryClient.setQueryData<TrackedGitRef[]>(
          trackedRefKeys.workspace(variables.workspaceId),
          () => removeCachedTrackedRef(variables.workspaceId, variables.refId)
        );
        return;
      }
      queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(variables.workspaceId) });
    },
  });
};
