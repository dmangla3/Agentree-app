import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Message, Summary, AttachmentMetadata, Scope, CommitEntity, useWorkspaceStore } from '../stores/workspaceStore';
import axios from 'axios';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { agentClient } from '../lib/agentClient';
import { localNodeKeys, parseLocalNode } from './useLocalNodes';
import { applyLocalNodeMessages } from './useLiveMessages';
import { getAccessToken } from '../lib/authSession';
import { useRunStatusStore } from '../stores/runStatusStore';

interface ScopesResponse {
    scopes: Scope[];
    activeScopeId: string | null;
}

const patchMessageInCache = (
    queryClient: ReturnType<typeof useQueryClient>,
    workspaceId: string,
    messageId: string,
    patch: (message: Message) => Message
) => {
    if (agentClient.hasRuntime()) {
        const current = queryClient
            .getQueryData<Message[]>(['messages', workspaceId])
            ?.find((message) => message.id === messageId);
        if (!current) return;
        const next = patch(current);
        void agentClient
            .upsertLocalNode(workspaceId, messageId, next)
            .finally(() => {
                queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
                markMessagesStaleOnly(queryClient, workspaceId, 'local-message-patch');
            });
        return;
    }
    void patch;
};

const markMessagesStaleOnly = (
    queryClient: ReturnType<typeof useQueryClient>,
    workspaceId: string,
    reason: string
) => {
    void scheduleMessagesRefreshWhenGraphIdle(queryClient, workspaceId, { reason });
};

const fetchServerMessages = async (workspaceId: string): Promise<Message[]> => {
    const response = await api.get(`/workspaces/${workspaceId}/messages`);
    return Array.isArray(response.data) ? response.data : [];
};

const byCreatedAt = (left: Message, right: Message) =>
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

const mergeServerMessages = (current: Message[] | undefined, incoming: Message[]): Message[] => {
    if (!incoming.length) return current ?? [];
    const merged = new Map<string, Message>((current ?? []).map((message) => [message.id, message]));
    for (const message of incoming) {
        merged.set(message.id, message);
    }
    return Array.from(merged.values()).sort(byCreatedAt);
};

export const useMessages = (
    workspaceId: string | null,
    options: { enabled?: boolean } = {}
): UseQueryResult<Message[], Error> => {
    const clearSelectedWorkspace = useWorkspaceStore((state) => state.clearSelectedWorkspace);
    const queryClient = useQueryClient();
    const queryResult = useQuery<Message[]>({
        queryKey: ['messages', workspaceId],
        queryFn: async () => {
            if (!workspaceId) return [];
            const startedAt = performance.now();
            if (agentClient.hasRuntime()) {
                const hasHotSendActivity = () => useRunStatusStore.getState().hasHotSendActivity(workspaceId, 5_000);
                const readCachedMessages = () => queryClient.getQueryData<Message[]>(['messages', workspaceId]) ?? [];
                if (hasHotSendActivity()) {
                    recordPerfEvent('query.messages.local-read-skipped', {
                        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                        workspaceId,
                        reason: 'hot-send-active-at-start',
                        cachedMessageCount: readCachedMessages().length,
                    }, {
                        source: 'useMessages',
                        durationMs: Number((performance.now() - startedAt).toFixed(2)),
                    });
                    return readCachedMessages();
                }
                const localRows = await agentClient.listLocalNodes(workspaceId);
                const localMessages = localRows
                    .map(parseLocalNode)
                    .filter((row): row is NonNullable<ReturnType<typeof parseLocalNode>> => Boolean(row));
                const localRenderMessages = applyLocalNodeMessages([], localMessages, workspaceId);
                recordPerfEvent('query.messages.local-read-model', {
                    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                    workspaceId,
                    messageCount: localRenderMessages.length,
                }, {
                    source: 'useMessages',
                    durationMs: Number((performance.now() - startedAt).toFixed(2)),
                });
                return localRenderMessages;
            }

            try {
                const serverMessages = await fetchServerMessages(workspaceId);
                recordPerfEvent('query.messages.server-fetch', {
                    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                    workspaceId,
                    messageCount: serverMessages.length,
                    reason: 'local-runtime-missing',
                }, {
                    source: 'useMessages',
                    durationMs: Number((performance.now() - startedAt).toFixed(2)),
                });
                return serverMessages;
            } catch (error) {
                if (axios.isAxiosError(error) && error.response?.status === 404) {
                    throw error;
                }
                recordPerfEvent('query.messages.server-fetch-failed', {
                    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                    workspaceId,
                    reason: 'local-runtime-missing',
                    error: error instanceof Error ? error.message : String(error),
                }, {
                    source: 'useMessages',
                    durationMs: Number((performance.now() - startedAt).toFixed(2)),
                });
                throw error;
            }
        },
        enabled: !!workspaceId && options.enabled !== false,
        staleTime: agentClient.hasRuntime() ? Infinity : 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        refetchInterval: false,
        refetchOnMount: false,
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

export const useSummaries = (
    workspaceId: string | null,
    options: { enabled?: boolean } = {}
): UseQueryResult<Summary[], Error> => {
    const clearSelectedWorkspace = useWorkspaceStore((state) => state.clearSelectedWorkspace);
    const queryResult = useQuery<Summary[]>({
        queryKey: ['summaries', workspaceId],
        queryFn: async () => {
            if (!workspaceId) return [];
            const startedAt = performance.now();
            const response = await api.get(`/workspaces/${workspaceId}/summaries`);
            recordPerfEvent('query.summaries.fetch', {
                elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                workspaceId,
                summaryCount: Array.isArray(response.data) ? response.data.length : null,
            }, {
                source: 'useSummaries',
                durationMs: Number((performance.now() - startedAt).toFixed(2)),
            });
            return response.data;
        },
        enabled: !!workspaceId && options.enabled !== false,
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        refetchOnMount: false,
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

export interface CommitDescendantsResponse {
    baseSha: string;
    commits: CommitEntity[];
    parents: Array<{ child_sha: string; parent_sha: string; parent_index: number }>;
    observations: Array<Record<string, unknown>>;
}

export const useCommitDescendants = (
    workspaceId: string | null,
    baseSha: string | null | undefined,
    options: { enabled?: boolean; limit?: number } = {}
) => useQuery<CommitDescendantsResponse>({
    queryKey: ['commit-descendants', workspaceId, baseSha, options.limit ?? 120],
    queryFn: async () => {
        if (!workspaceId || !baseSha) return { baseSha: baseSha ?? '', commits: [], parents: [], observations: [] };
        const response = await api.get(`/workspaces/${workspaceId}/commits/descendants`, {
            params: { baseSha, limit: options.limit ?? 120 },
        });
        return {
            baseSha: response.data?.baseSha ?? baseSha,
            commits: Array.isArray(response.data?.commits) ? response.data.commits : [],
            parents: Array.isArray(response.data?.parents) ? response.data.parents : [],
            observations: Array.isArray(response.data?.observations) ? response.data.observations : [],
        };
    },
    enabled: !!workspaceId && !!baseSha && options.enabled !== false,
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
});

export const useSendMessage = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            prompt,
            parentId,
            attachments,
            contextIds,
            useAgent,
            agentId,
            agentProvider,
            agentModel,
            role,
            contextMode,
            contextPolicy,
            scopeId,
            activeScopeId,
            scopeMode,
            contextParentId,
            scopeParentId,
            newScopeName,
            newScopeDescription,
            baseCommitSha,
            baseSelectedFromNodeId,
            signal,
        }: {
            workspaceId: string;
            prompt: string;
            parentId?: string | null;
            attachments?: AttachmentMetadata[];
            contextIds?: string[];
            useAgent?: boolean;
            agentId?: string | null;
            agentProvider?: string | null;
            agentModel?: string | null;
            role?: 'user' | 'assistant' | 'system';
            contextMode?: 'active' | 'none';
            contextPolicy?: 'continue' | 'fresh' | null;
            scopeId?: string | null;
            activeScopeId?: string | null;
            scopeMode?: 'inherit' | 'active' | 'existing' | 'new' | null;
            contextParentId?: string | null;
            scopeParentId?: string | null;
            newScopeName?: string | null;
            newScopeDescription?: string | null;
            baseCommitSha?: string | null;
            baseSelectedFromNodeId?: string | null;
            perfFlowId?: string | null;
            signal?: AbortSignal;
        }) => {
            const response = await api.post(`/workspaces/${workspaceId}/messages`, {
                content: prompt,  // Server expects 'content', not 'prompt'
                parentId,
                attachments,
                contextIds,
                contextMode,
                contextPolicy,
                useAgent,  // Pass agent mode flag to server
                agentId,
                agentProvider,
                agentModel,
                role,
                scopeId,
                activeScopeId,
                scopeMode,
                contextParentId,
                scopeParentId,
                newScopeName,
                newScopeDescription,
                baseCommitSha,
                baseSelectedFromNodeId,
            }, { signal });
            return response.data;
        },
        onSuccess: async (data, variables) => {
            const createdMessages = [
                data?.userMessage,
                ...(Array.isArray(data?.assistantMessages) ? data.assistantMessages : []),
            ].filter((message): message is Message => Boolean(message?.id));
            if (createdMessages.length > 0) {
                if (agentClient.hasRuntime()) {
                    await agentClient.hydrateLocalNodesFromServer(variables.workspaceId, createdMessages);
                    queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(variables.workspaceId) });
                    queryClient.setQueryData<Message[]>(
                        ['messages', variables.workspaceId],
                        (current) => applyLocalNodeMessages(current ?? [], createdMessages.map((message) => ({
                            nodeId: message.id,
                            workspaceId: variables.workspaceId,
                            syncStatus: 'persisted' as const,
                            finalizedAt: Math.floor(Date.now() / 1000),
                            retryAttempt: 0,
                            message,
                        })), variables.workspaceId)
                    );
                    void scheduleMessagesRefreshWhenGraphIdle(queryClient, variables.workspaceId, {
                        reason: 'send-message-created',
                    });
                } else {
                    queryClient.setQueryData<Message[]>(
                        ['messages', variables.workspaceId],
                        (current) => mergeServerMessages(current, createdMessages)
                    );
                }
            }

            if (
                variables.scopeMode === 'new' &&
                variables.newScopeName?.trim() &&
                data?.userMessage?.scope_id
            ) {
                const now = data.userMessage.createdAt || new Date().toISOString();
                queryClient.setQueryData<ScopesResponse>(
                    ['scopes', variables.workspaceId],
                    (current) => {
                        const existing = current?.scopes ?? [];
                        const scopeId = data.userMessage.scope_id as string;

                        if (existing.some((scope) => scope.id === scopeId)) {
                            return {
                                scopes: existing,
                                activeScopeId: scopeId,
                            };
                        }

                        return {
                            scopes: [
                                {
                                    id: scopeId,
                                    workspace_id: variables.workspaceId,
                                    name: variables.newScopeName!.trim(),
                                    description: variables.newScopeDescription?.trim() || null,
                                    color: null,
                                    status: 'active',
                                    base_node_id: variables.parentId ?? null,
                                    created_by_user_id: null,
                                    archivedAt: null,
                                    createdAt: now,
                                    updatedAt: now,
                                },
                                ...existing,
                            ],
                            activeScopeId: scopeId,
                        };
                    }
                );
            }

            if (
                variables.scopeMode === 'new' &&
                variables.newScopeName?.trim() &&
                data?.userMessage?.scope_id
            ) {
                queryClient.setQueryData<ScopesResponse>(
                    ['scopes', variables.workspaceId],
                    (current) => current ?? { scopes: [], activeScopeId: data.userMessage.scope_id as string }
                );
            }

            if (typeof data?.updatedWorkspaceName === 'string' && data.updatedWorkspaceName.trim()) {
                queryClient.setQueryData<any[]>(
                    ['workspaces'],
                    (current) => Array.isArray(current)
                        ? current.map((workspace) => (
                            workspace?.id === variables.workspaceId
                                ? {
                                    ...workspace,
                                    name: data.updatedWorkspaceName,
                                    updatedAt: data.userMessage?.createdAt || workspace.updatedAt,
                                }
                                : workspace
                        ))
                        : current
                );
            }
        },
    });
};

export const useDeleteMessageBranch = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ workspaceId, messageId }: { workspaceId: string; messageId: string }) => {
            console.log(`[useDeleteMessageBranch] Deleting branch for message ${messageId} in workspace ${workspaceId}`);
            await agentClient.localFirstDeleteBranch(workspaceId, messageId);
            void getAccessToken()
                .then((token) => agentClient.processLocalSyncEvents(token))
                .catch(() => undefined);
        },
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(variables.workspaceId) });
            void scheduleMessagesRefreshWhenGraphIdle(queryClient, variables.workspaceId, {
                refetchActive: true,
                reason: 'delete-message-branch',
            });
        },
    });
};

export const useDeleteSummary = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ workspaceId, summaryId }: { workspaceId: string; summaryId: string }) => {
            console.log(`Deleting summary ${summaryId} in workspace ${workspaceId}`);
            await api.delete(`/summaries/${summaryId}`);
        },
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: ['summaries', variables.workspaceId] });
        },
    });
};

export const useUpdateTags = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            messageId,
            tags,
            action,
        }: {
            workspaceId: string;
            messageId: string;
            tags: string[];
            action: 'add' | 'remove';
        }) => {
            console.log(`${action === 'add' ? 'Adding' : 'Removing'} tags for message ${messageId} in workspace ${workspaceId}`);
            if (action === 'add') {
                await api.post(`/messages/${messageId}/tags`, { tags });
            } else {
                await api.delete(`/messages/${messageId}/tags`, { data: { tags } });
            }
        },
        onSuccess: (_, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => {
                const currentTags = Array.isArray(message.tags) ? message.tags : [];
                const nextTags = variables.action === 'add'
                    ? Array.from(new Set([...currentTags, ...variables.tags]))
                    : currentTags.filter((tag) => !variables.tags.includes(tag));
                return { ...message, tags: nextTags, updatedAt: new Date().toISOString() };
            });
            markMessagesStaleOnly(queryClient, variables.workspaceId, 'update-tags');
        },
    });
};

export const useAddComment = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId: _workspaceId,
            messageId,
            type,
            content,
            author,
            metadata,
        }: {
            workspaceId: string;
            messageId: string;
            type: string;
            content: string;
            author?: string;
            metadata?: any;
        }) => {
            console.log(`Adding comment to message ${messageId}`);
            const response = await api.post(`/messages/${messageId}/comments`, {
                type,
                content,
                author: author || 'user',
                metadata,
            });
            return response.data;
        },
        onSuccess: (data, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => {
                if (Array.isArray(data?.comments)) {
                    return { ...message, comments: data.comments, updatedAt: data.updatedAt ?? new Date().toISOString() };
                }
                if (Array.isArray(data?.message?.comments)) {
                    return { ...message, comments: data.message.comments, updatedAt: data.message.updatedAt ?? new Date().toISOString() };
                }
                const nextComment = data?.comment ?? {
                    type: variables.type,
                    content: variables.content,
                    author: variables.author || 'user',
                    timestamp: new Date().toISOString(),
                    metadata: variables.metadata,
                };
                return {
                    ...message,
                    comments: [...(message.comments ?? []), nextComment],
                    updatedAt: new Date().toISOString(),
                };
            });
            markMessagesStaleOnly(queryClient, variables.workspaceId, 'add-comment');
        },
    });
};

export const useDeleteComment = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId: _workspaceId,
            messageId,
            commentIndex,
        }: {
            workspaceId: string;
            messageId: string;
            commentIndex: number;
        }) => {
            console.log(`Deleting comment index ${commentIndex} from message ${messageId}`);
            const response = await api.delete(`/messages/${messageId}/comments/${commentIndex}`);
            return response.data;
        },
        onSuccess: (data, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => {
                if (Array.isArray(data?.comments)) {
                    return { ...message, comments: data.comments, updatedAt: data.updatedAt ?? new Date().toISOString() };
                }
                if (Array.isArray(data?.message?.comments)) {
                    return { ...message, comments: data.message.comments, updatedAt: data.message.updatedAt ?? new Date().toISOString() };
                }
                return {
                    ...message,
                    comments: (message.comments ?? []).filter((_, index) => index !== variables.commentIndex),
                    updatedAt: new Date().toISOString(),
                };
            });
            markMessagesStaleOnly(queryClient, variables.workspaceId, 'delete-comment');
        },
    });
};

export const useCreateSummary = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            startMessageId,
            endMessageId,
            content,
        }: {
            workspaceId: string;
            startMessageId: string;
            endMessageId: string;
            content: string;
        }) => {
            const response = await api.post(`/workspaces/${workspaceId}/summaries`, {
                startMessageId,
                endMessageId,
                content,
            });
            return response.data;
        },
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: ['summaries', variables.workspaceId] });
        },
    });
};
export const useGenerateSummary = () => {
    return useMutation({
        mutationFn: async ({
            workspaceId,
            startMessageId,
            endMessageId,
            prompt,
        }: {
            workspaceId: string;
            startMessageId: string;
            endMessageId: string;
            prompt: string;
        }) => {
            const response = await api.post(`/workspaces/${workspaceId}/summaries/generate`, {
                startMessageId,
                endMessageId,
                prompt,
            });
            const payload = response.data;
            if (typeof payload === 'string') return payload;
            if (typeof payload?.content === 'string') return payload.content;
            if (typeof payload?.summary === 'string') return payload.summary;
            if (typeof payload?.body?.content === 'string') return payload.body.content;
            if (typeof payload?.body?.summary === 'string') return payload.body.summary;
            return '';
        },
    });
};

export const useToggleCollapse = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            messageId,
            collapsed,
        }: {
            workspaceId: string;
            messageId: string;
            collapsed: boolean;
        }) => {
            await api.patch(`/messages/${messageId}`, { collapsed });
        },
        onSuccess: (_, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => ({
                ...message,
                collapsed: variables.collapsed,
                updatedAt: new Date().toISOString(),
            }));
            markMessagesStaleOnly(queryClient, variables.workspaceId, 'toggle-collapse');
        },
    });
};
