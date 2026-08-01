import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Scope, useWorkspaceStore } from '../stores/workspaceStore';
import axios from 'axios';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';

export interface ScopesResponse {
    scopes: Scope[];
    activeScopeId: string | null;
}

export const useScopes = (workspaceId: string | null): UseQueryResult<ScopesResponse, Error> => {
    const clearSelectedWorkspace = useWorkspaceStore((state) => state.clearSelectedWorkspace);
    const queryResult = useQuery<ScopesResponse>({
        queryKey: ['scopes', workspaceId],
        queryFn: async () => {
            if (!workspaceId) return { scopes: [], activeScopeId: null };
            const startedAt = performance.now();
            const response = await api.get(`/workspaces/${workspaceId}/scopes`);
            const payload = response.data ?? {};
            recordPerfEvent('query.scopes.fetch', {
                elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                workspaceId,
                scopeCount: Array.isArray(payload.scopes) ? payload.scopes.length : null,
            }, {
                source: 'useScopes',
                durationMs: Number((performance.now() - startedAt).toFixed(2)),
            });
            return {
                scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
                activeScopeId: typeof payload.activeScopeId === 'string' ? payload.activeScopeId : null,
            };
        },
        enabled: !!workspaceId,
        staleTime: 15 * 1000,
        gcTime: 10 * 60 * 1000,
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

export const useCreateScope = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            name,
            description = null,
            color = null,
            status = 'active',
            baseNodeId = null,
            setActive = true,
        }: {
            workspaceId: string;
            name?: string | null;
            description?: string | null;
            color?: string | null;
            status?: 'active' | 'done' | 'archived';
            baseNodeId?: string | null;
            setActive?: boolean;
        }) => {
            const response = await api.post(`/workspaces/${workspaceId}/scopes`, {
                name,
                description,
                color,
                status,
                baseNodeId,
                setActive,
            });
            return response.data as Scope;
        },
        onSuccess: (_, vars) => {
            queryClient.invalidateQueries({ queryKey: ['scopes', vars.workspaceId] });
            queryClient.invalidateQueries({ queryKey: ['workspaces'] });
        },
    });
};

export const useUpdateScope = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            scopeId,
            ...updates
        }: {
            workspaceId: string;
            scopeId: string;
            name?: string;
            description?: string | null;
            color?: string | null;
            status?: 'active' | 'done' | 'archived';
            baseNodeId?: string | null;
            setActive?: boolean;
        }) => {
            const response = await api.patch(`/workspaces/${workspaceId}/scopes/${scopeId}`, updates);
            return response.data as Scope;
        },
        onSuccess: (_, vars) => {
            queryClient.invalidateQueries({ queryKey: ['scopes', vars.workspaceId] });
            queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            void scheduleMessagesRefreshWhenGraphIdle(queryClient, vars.workspaceId, { reason: 'update-scope' });
        },
    });
};

export const useArchiveScope = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ workspaceId, scopeId }: { workspaceId: string; scopeId: string }) => {
            const response = await api.delete(`/workspaces/${workspaceId}/scopes/${scopeId}`);
            return response.data as Scope;
        },
        onSuccess: (_, vars) => {
            queryClient.invalidateQueries({ queryKey: ['scopes', vars.workspaceId] });
            queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            void scheduleMessagesRefreshWhenGraphIdle(queryClient, vars.workspaceId, { reason: 'archive-scope' });
        },
    });
};

export const useSetActiveScope = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            scopeId,
        }: {
            workspaceId: string;
            scopeId: string | null;
        }) => {
            const response = await api.patch(`/workspaces/${workspaceId}`, {
                lastActiveScopeId: scopeId,
            });
            return response.data;
        },
        onSuccess: (_, vars) => {
            queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            queryClient.invalidateQueries({ queryKey: ['scopes', vars.workspaceId] });
        },
    });
};
