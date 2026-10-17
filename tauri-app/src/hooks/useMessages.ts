import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { AGENTREE_DATA_PLANE_ENABLED, api } from '../lib/api';
import {
    Message,
    Summary,
    AttachmentMetadata,
    CommitEntity,
    MessageHighlightColor,
    MessageHighlightRange,
    useWorkspaceStore,
} from '../stores/workspaceStore';
import axios from 'axios';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { agentClient } from '../lib/agentClient';
import { localNodeKeys, parseLocalNode } from './useLocalNodes';
import { applyLocalNodeMessages } from './useLiveMessages';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { queueLocalSyncFlush } from '../lib/localSyncScheduler';
import {
    addOrUpdateMessageHighlight,
    createMessageHighlight,
    removeMessageHighlight,
    updateMessageHighlightColor,
} from '../lib/messageHighlights';
import { messageApplication } from '../application/messages';

const patchMessageInCache = (
    queryClient: ReturnType<typeof useQueryClient>,
    workspaceId: string,
    messageId: string,
    patch: (message: Message) => Message,
    options: { persistLocal?: boolean } = {},
) => {
    let patchedMessage: Message | null = null;
    queryClient.setQueryData<Message[]>(['messages', workspaceId], (current) => {
        if (!current) return current;
        return current.map((message) => {
            if (message.id !== messageId) return message;
            patchedMessage = patch(message);
            return patchedMessage;
        });
    });

    if (!patchedMessage) return;
    if (options.persistLocal !== false && agentClient.hasRuntime()) {
        void agentClient
            .upsertLocalNode(workspaceId, messageId, patchedMessage)
            .finally(() => {
                queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
                markMessagesStaleOnly(queryClient, workspaceId, 'local-message-patch');
            });
    }
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

type MessageBranchNode = Pick<Message, 'id' | 'parentId'>;

export const collectMessageBranchIds = (
    current: Iterable<MessageBranchNode> | undefined,
    rootMessageId: string
): Set<string> => {
    const messages = Array.from(current ?? []);
    const idsToRemove = new Set<string>();
    if (!rootMessageId) return idsToRemove;

    const childrenByParentId = new Map<string, string[]>();
    for (const message of messages) {
        if (!message.parentId) continue;
        const children = childrenByParentId.get(message.parentId) ?? [];
        children.push(message.id);
        childrenByParentId.set(message.parentId, children);
    }

    const pending = [rootMessageId];
    while (pending.length > 0) {
        const id = pending.pop();
        if (!id || idsToRemove.has(id)) continue;
        idsToRemove.add(id);
        pending.push(...(childrenByParentId.get(id) ?? []));
    }

    return idsToRemove;
};

export const cleanupMessageBranchRunState = (
    current: Iterable<MessageBranchNode> | undefined,
    rootMessageId: string
): Set<string> => {
    const projectedMessages = Object.values(useAgentRunProjectionStore.getState().projectionsById);
    const idsToRemove = collectMessageBranchIds(
        [...Array.from(current ?? []), ...projectedMessages],
        rootMessageId
    );
    for (const messageId of idsToRemove) {
        agentRunManager.cleanup(messageId);
    }
    return idsToRemove;
};

export const removeMessageBranchFromCache = (
    current: Message[] | undefined,
    rootMessageId: string
): Message[] => {
    const messages = current ?? [];
    if (!rootMessageId || messages.length === 0) return messages;
    const idsToRemove = collectMessageBranchIds(messages, rootMessageId);
    return messages.filter((message) => !idsToRemove.has(message.id));
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
                if (!queryClient.getQueryData(localNodeKeys.workspace(workspaceId))) {
                    queryClient.setQueryData(localNodeKeys.workspace(workspaceId), localMessages);
                }
                const localRenderMessages = applyLocalNodeMessages([], localMessages, workspaceId);
                if (localRenderMessages.length === 0 && AGENTREE_DATA_PLANE_ENABLED) {
                    try {
                        const serverMessages = await fetchServerMessages(workspaceId);
                        if (serverMessages.length > 0) {
                            try {
                                await agentClient.hydrateLocalNodesFromServer(workspaceId, serverMessages);
                                queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
                            } catch (hydrateError) {
                                recordPerfEvent('query.messages.local-restore-hydrate-failed', {
                                    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                                    workspaceId,
                                    messageCount: serverMessages.length,
                                    error: hydrateError instanceof Error ? hydrateError.message : String(hydrateError),
                                }, {
                                    source: 'useMessages',
                                    durationMs: Number((performance.now() - startedAt).toFixed(2)),
                                });
                            }
                        }
                        recordPerfEvent('query.messages.local-restore-server-fetch', {
                            elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                            workspaceId,
                            localRowCount: localRows.length,
                            messageCount: serverMessages.length,
                        }, {
                            source: 'useMessages',
                            durationMs: Number((performance.now() - startedAt).toFixed(2)),
                        });
                        return serverMessages;
                    } catch (error) {
                        recordPerfEvent('query.messages.local-restore-server-fetch-failed', {
                            elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
                            workspaceId,
                            localRowCount: localRows.length,
                            error: error instanceof Error ? error.message : String(error),
                        }, {
                            source: 'useMessages',
                            durationMs: Number((performance.now() - startedAt).toFixed(2)),
                        });
                    }
                }
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

            if (!AGENTREE_DATA_PLANE_ENABLED) return [];

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
        enabled: (agentClient.hasRuntime() || AGENTREE_DATA_PLANE_ENABLED)
            && !!workspaceId
            && options.enabled !== false,
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
    enabled: AGENTREE_DATA_PLANE_ENABLED && !!workspaceId && !!baseSha && options.enabled !== false,
    staleTime: 15_000,
    gcTime: 5 * 60 * 1000,
});

export const useCommitAncestors = (
    workspaceId: string | null,
    baseSha: string | null | undefined,
    options: { enabled?: boolean; limit?: number } = {}
) => useQuery<CommitDescendantsResponse>({
    queryKey: ['commit-ancestors', workspaceId, baseSha, options.limit ?? 120],
    queryFn: async () => {
        if (!workspaceId || !baseSha) return { baseSha: baseSha ?? '', commits: [], parents: [], observations: [] };
        const response = await api.get(`/workspaces/${workspaceId}/commits/ancestors`, {
            params: { baseSha, limit: options.limit ?? 120 },
        });
        return {
            baseSha: response.data?.baseSha ?? baseSha,
            commits: Array.isArray(response.data?.commits) ? response.data.commits : [],
            parents: Array.isArray(response.data?.parents) ? response.data.parents : [],
            observations: Array.isArray(response.data?.observations) ? response.data.observations : [],
        };
    },
    enabled: AGENTREE_DATA_PLANE_ENABLED && !!workspaceId && !!baseSha && options.enabled !== false,
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
            llmModel,
            agentModel: legacyAgentModel,
            role,
            contextMode,
            contextPolicy,
            contextParentId,
            baseCommitSha,
            baseSelectedFromNodeId,
            threadId,
            threadOriginId,
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
            llmModel?: string | null;
            agentModel?: string | null;
            role?: 'user' | 'assistant' | 'system';
            contextMode?: 'active' | 'none';
            contextPolicy?: 'continue' | 'fresh' | null;
            contextParentId?: string | null;
            baseCommitSha?: string | null;
            baseSelectedFromNodeId?: string | null;
            threadId?: string | null;
            threadOriginId?: string | null;
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
                llmModel: llmModel ?? legacyAgentModel ?? null,
                role,
                contextParentId,
                baseCommitSha,
                baseSelectedFromNodeId,
                threadId,
                threadOriginId,
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
            queueLocalSyncFlush({ reason: 'message-branch-deleted' });
        },
        onSuccess: (_, variables) => {
            const cachedMessages = queryClient.getQueryData<Message[]>(['messages', variables.workspaceId]) ?? [];
            const cachedSnapshot = queryClient.getQueryData<{ messages?: Message[] }>(['graph-snapshot', variables.workspaceId]);
            cleanupMessageBranchRunState(
                [...cachedMessages, ...(cachedSnapshot?.messages ?? [])],
                variables.messageId
            );
            queryClient.setQueryData<Message[]>(
                ['messages', variables.workspaceId],
                (current) => removeMessageBranchFromCache(current, variables.messageId)
            );
            queryClient.setQueryData<any>(
                ['graph-snapshot', variables.workspaceId],
                (current: any) => current && Array.isArray(current.messages)
                    ? {
                        ...current,
                        messages: removeMessageBranchFromCache(current.messages, variables.messageId),
                        cacheWriteDisabled: true,
                    }
                    : current
            );
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
            const updatedMessage = await messageApplication.updateTags({
                workspaceId,
                messageId,
                tags,
                action,
            });
            queueLocalSyncFlush({ reason: 'message-tags-updated' });
            return updatedMessage;
        },
        onSuccess: (updatedMessage, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => {
                const currentTags = Array.isArray(message.tags) ? message.tags : [];
                const nextTags = variables.action === 'add'
                    ? Array.from(new Set([...currentTags, ...variables.tags]))
                    : currentTags.filter((tag) => !variables.tags.includes(tag));
                return {
                    ...message,
                    ...(updatedMessage ?? {}),
                    tags: Array.isArray(updatedMessage?.tags) ? updatedMessage.tags : nextTags,
                    updatedAt: updatedMessage?.updatedAt ?? new Date().toISOString(),
                };
            }, { persistLocal: false });
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

export const useAddHighlight = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            messageId,
            color,
            range,
        }: {
            workspaceId: string;
            messageId: string;
            color: MessageHighlightColor;
            range: MessageHighlightRange;
        }) => {
            const highlight = createMessageHighlight({ color, range });
            const message = await messageApplication.updateHighlight({
                workspaceId,
                messageId,
                action: 'add',
                highlight,
            });
            queueLocalSyncFlush({ reason: 'message-highlight-added' });
            return { message, highlight };
        },
        onSuccess: (data, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => ({
                ...message,
                ...(data.message ?? {}),
                annotations: Array.isArray(data.message?.annotations)
                    ? data.message.annotations
                    : addOrUpdateMessageHighlight(message.annotations, data.highlight),
                updatedAt: data.message?.updatedAt ?? new Date().toISOString(),
            }), { persistLocal: false });
            markMessagesStaleOnly(queryClient, variables.workspaceId, 'add-highlight');
        },
    });
};

export const useUpdateHighlight = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            messageId,
            highlightId,
            color,
        }: {
            workspaceId: string;
            messageId: string;
            highlightId: string;
            color: MessageHighlightColor;
        }) => {
            const message = await messageApplication.updateHighlight({
                workspaceId,
                messageId,
                action: 'update',
                highlightId,
                color,
            });
            queueLocalSyncFlush({ reason: 'message-highlight-updated' });
            return message;
        },
        onSuccess: (updatedMessage, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => ({
                ...message,
                ...(updatedMessage ?? {}),
                annotations: Array.isArray(updatedMessage?.annotations)
                    ? updatedMessage.annotations
                    : updateMessageHighlightColor(message.annotations, variables.highlightId, variables.color),
                updatedAt: updatedMessage?.updatedAt ?? new Date().toISOString(),
            }), { persistLocal: false });
            markMessagesStaleOnly(queryClient, variables.workspaceId, 'update-highlight');
        },
    });
};

export const useDeleteHighlight = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({
            workspaceId,
            messageId,
            highlightId,
        }: {
            workspaceId: string;
            messageId: string;
            highlightId: string;
        }) => {
            const message = await messageApplication.updateHighlight({
                workspaceId,
                messageId,
                action: 'delete',
                highlightId,
            });
            queueLocalSyncFlush({ reason: 'message-highlight-deleted' });
            return message;
        },
        onSuccess: (updatedMessage, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => ({
                ...message,
                ...(updatedMessage ?? {}),
                annotations: Array.isArray(updatedMessage?.annotations)
                    ? updatedMessage.annotations
                    : removeMessageHighlight(message.annotations, variables.highlightId),
                updatedAt: updatedMessage?.updatedAt ?? new Date().toISOString(),
            }), { persistLocal: false });
            markMessagesStaleOnly(queryClient, variables.workspaceId, 'delete-highlight');
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
            workspaceId,
            messageId,
            collapsed,
        }: {
            workspaceId: string;
            messageId: string;
            collapsed: boolean;
        }) => {
            const message = await messageApplication.setCollapsed({ workspaceId, messageId, collapsed });
            queueLocalSyncFlush({ reason: 'message-collapse-updated' });
            return message;
        },
        onSuccess: (updatedMessage, variables) => {
            patchMessageInCache(queryClient, variables.workspaceId, variables.messageId, (message) => ({
                ...message,
                ...(updatedMessage ?? {}),
                collapsed: updatedMessage?.collapsed ?? variables.collapsed,
                updatedAt: updatedMessage?.updatedAt ?? new Date().toISOString(),
            }), { persistLocal: false });
            markMessagesStaleOnly(queryClient, variables.workspaceId, 'toggle-collapse');
        },
    });
};
