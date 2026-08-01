import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWorkspaceStore, type TrackedGitRef } from '../stores/workspaceStore';
import axios from 'axios';

export const trackedRefKeys = {
  all: ['tracked-refs'] as const,
  workspace: (workspaceId: string | null) => [...trackedRefKeys.all, workspaceId ?? ''] as const,
};

export const useTrackedRefs = (workspaceId: string | null): UseQueryResult<TrackedGitRef[], Error> => {
  const clearSelectedWorkspace = useWorkspaceStore((state) => state.clearSelectedWorkspace);
  const queryResult = useQuery<TrackedGitRef[]>({
    queryKey: trackedRefKeys.workspace(workspaceId),
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      if (!workspaceId) return [];
      const response = await api.get(`/workspaces/${workspaceId}/tracked-refs`);
      return response.data;
    },
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
      const response = await api.post(`/workspaces/${workspaceId}/tracked-refs`, body);
      return response.data as TrackedGitRef;
    },
    onSuccess: (_data, variables) => {
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
      const response = await api.patch(`/workspaces/${workspaceId}/tracked-refs/${refId}`, body);
      return response.data as TrackedGitRef;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(variables.workspaceId) });
    },
  });
};

export const useDeleteTrackedRef = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { workspaceId: string; refId: string }) => {
      await api.delete(`/workspaces/${input.workspaceId}/tracked-refs/${input.refId}`);
      return input;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(variables.workspaceId) });
    },
  });
};
