import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { BranchPointer, Workspace } from '../stores/workspaceStore';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { agentClient, type GitBranchPointerInfo } from '../lib/agentClient';

export const branchKeys = {
    all: ['branches'] as const,
    workspace: (workspaceId: string | null) => [...branchKeys.all, workspaceId ?? ''] as const,
};

const resolveWorkspaceRepoPath = (queryClient: QueryClient, workspaceId: string): string | null => {
    const workspaceQueries = queryClient.getQueriesData<Workspace[]>({ queryKey: ['workspaces'] });
    for (const [, workspaces] of workspaceQueries) {
        const workspace = workspaces?.find((candidate) => candidate.id === workspaceId);
        const repoPath = workspace?.git_repo_path?.trim() || workspace?.folderPath?.trim() || null;
        if (repoPath) return repoPath;
    }
    return null;
};

const mapLocalBranchPointer = (
    workspaceId: string,
    pointer: GitBranchPointerInfo,
    nowIso: string
): BranchPointer => ({
    id: `local:${workspaceId}:${pointer.git_ref}`,
    workspace_id: workspaceId,
    name: pointer.name,
    node_id: null,
    commit_sha: pointer.commit_sha,
    git_ref: pointer.git_ref,
    is_ship_path: pointer.name === 'ship',
    createdAt: nowIso,
    updatedAt: nowIso,
    commit: {
        workspace_id: workspaceId,
        sha: pointer.commit_sha,
    },
});

export const useBranches = (workspaceId: string | null): UseQueryResult<BranchPointer[], Error> => {
    const queryClient = useQueryClient();
    return useQuery<BranchPointer[]>({
        queryKey: branchKeys.workspace(workspaceId),
        enabled: Boolean(workspaceId),
        queryFn: async () => {
            if (!workspaceId) return [];
            const startedAt = performance.now();
            if (agentClient.hasRuntime()) {
                const repoPath = resolveWorkspaceRepoPath(queryClient, workspaceId);
                if (!repoPath) return [];
                const pointers = await agentClient.listBranchPointers(repoPath);
                const nowIso = new Date().toISOString();
                const localBranches = pointers.map((pointer) => mapLocalBranchPointer(workspaceId, pointer, nowIso));
                recordPerfEvent('query.branches.local-fetch', {
                    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                    workspaceId,
                    branchPointerCount: localBranches.length,
                }, {
                    source: 'useBranches',
                    durationMs: Number((performance.now() - startedAt).toFixed(2)),
                });
                return localBranches;
            }
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
        staleTime: agentClient.hasRuntime() ? 30_000 : undefined,
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
