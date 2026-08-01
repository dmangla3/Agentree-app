import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { BranchPointer } from '../stores/workspaceStore';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';

export const branchKeys = {
    all: ['branches'] as const,
    workspace: (workspaceId: string | null) => [...branchKeys.all, workspaceId ?? ''] as const,
};

export const useBranches = (workspaceId: string | null): UseQueryResult<BranchPointer[], Error> => {
    return useQuery<BranchPointer[]>({
        queryKey: branchKeys.workspace(workspaceId),
        enabled: Boolean(workspaceId),
        queryFn: async () => {
            if (!workspaceId) return [];
            const startedAt = performance.now();
            const response = await api.get(`/workspaces/${workspaceId}/branches`);
            recordPerfEvent('query.branches.fetch', {
                elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                workspaceId,
                branchPointerCount: Array.isArray(response.data) ? response.data.length : null,
            }, {
                source: 'useBranches',
                durationMs: Number((performance.now() - startedAt).toFixed(2)),
            });
            return response.data;
        },
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
};

export const useCreateBranch = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (input: {
            workspaceId: string;
            name: string;
            nodeId: string;
            gitRef: string;
            isShipPath?: boolean;
        }) => {
            const { workspaceId, ...body } = input;
            const response = await api.post(`/workspaces/${workspaceId}/branches`, body);
            return response.data;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: branchKeys.workspace(variables.workspaceId) });
        },
    });
};

export const useUpdateBranch = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (input: {
            workspaceId: string;
            branchId: string;
            commitSha?: string;
            gitRef?: string;
            isShipPath?: boolean;
            name?: string;
            expectedCommitSha?: string;
        }) => {
            const { workspaceId, branchId, ...body } = input;
            const response = await api.put(`/workspaces/${workspaceId}/branches/${branchId}`, body);
            return response.data;
        },
        onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: branchKeys.workspace(variables.workspaceId) });
        },
    });
};
