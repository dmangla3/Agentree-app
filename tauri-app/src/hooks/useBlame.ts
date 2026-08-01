import { useQuery } from '@tanstack/react-query';
import { agentClient, BlameResult, BlameContextResponse } from '../lib/agentClient';
import { mapBlameCommitsToMessages } from '../lib/gitNodeUtils';
import { Message } from '../stores/workspaceStore';
import { api } from '../lib/api';

// ═══════════════════════════════════════════════════════════════════════════
// QUERY KEYS
// ═══════════════════════════════════════════════════════════════════════════

export const blameKeys = {
    all: ['blame'] as const,
    file: (nodeId: string, repoPath: string, commit: string, filePath: string) =>
        [...blameKeys.all, 'file', nodeId, repoPath, commit, filePath] as const,
    context: (nodeId: string, filePath: string) =>
        [...blameKeys.all, 'context', nodeId, filePath] as const,
    toolCalls: (nodeId: string) =>
        [...blameKeys.all, 'toolCalls', nodeId] as const,
};

// ═══════════════════════════════════════════════════════════════════════════
// BLAME QUERIES (Tauri IPC)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute blame for a file - shows which node introduced each line.
 * Uses Tauri IPC to call the Rust compute_blame command.
 */
export function useBlame(
    nodeId: string | null,
    repoPath: string | null,
    commit: string | null,
    filePath: string | null,
    messages: Message[],
    baseCommitSha: string | null
) {
    return useQuery<BlameResult, Error>({
        queryKey: blameKeys.file(nodeId ?? '', repoPath ?? '', commit ?? '', filePath ?? ''),
        queryFn: async () => {
            if (!nodeId || !repoPath || !commit || !filePath) {
                throw new Error('nodeId, repoPath, commit, and filePath are required');
            }
            const result = await agentClient.computeGitBlame(repoPath, commit, filePath);
            return mapBlameCommitsToMessages(result, messages, baseCommitSha);
        },
        enabled: Boolean(nodeId && repoPath && commit && filePath),
        staleTime: 5 * 60 * 1000, // 5 minutes - blame data is stable
        gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
    });
}

/**
 * Get blame without content - lighter version for summary stats.
 */
export function useBlameSummary(
    nodeId: string | null,
    repoPath: string | null,
    commit: string | null,
    filePath: string | null,
    messages: Message[],
    baseCommitSha: string | null
) {
    return useQuery<BlameResult, Error>({
        queryKey: [...blameKeys.file(nodeId ?? '', repoPath ?? '', commit ?? '', filePath ?? ''), 'summary'],
        queryFn: async () => {
            if (!nodeId || !repoPath || !commit || !filePath) {
                throw new Error('nodeId, repoPath, commit, and filePath are required');
            }
            const result = await agentClient.computeGitBlame(repoPath, commit, filePath);
            return mapBlameCommitsToMessages(result, messages, baseCommitSha);
        },
        enabled: Boolean(nodeId && repoPath && commit && filePath),
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT QUERIES (Server API)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get tool call context for a blame entry.
 * Uses the server endpoint to fetch workspace context and tool call matching.
 */
export function useBlameContext(
    nodeId: string | null,
    filePath: string | null
) {
    return useQuery<BlameContextResponse, Error>({
        queryKey: blameKeys.context(nodeId ?? '', filePath ?? ''),
        queryFn: async () => {
            if (!nodeId || !filePath) {
                throw new Error('nodeId and filePath are required');
            }
            const response = await api.get<BlameContextResponse>(
                `/api/nodes/${nodeId}/blame-context/${encodeURIComponent(filePath)}`,
                { params: { contextMessages: 3 } }
            );
            return response.data;
        },
        enabled: Boolean(nodeId && filePath),
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
    });
}

/**
 * Get all tool calls for a specific node.
 */
export function useNodeToolCalls(nodeId: string | null) {
    return useQuery({
        queryKey: blameKeys.toolCalls(nodeId ?? ''),
        queryFn: async () => {
            if (!nodeId) {
                throw new Error('nodeId is required');
            }
            const response = await api.get(`/api/nodes/${nodeId}/tool-calls`);
            return response.data;
        },
        enabled: Boolean(nodeId),
        staleTime: 5 * 60 * 1000,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get blame stats for a file - number of contributors, etc.
 */
export function useBlameStats(
    nodeId: string | null,
    repoPath: string | null,
    commit: string | null,
    filePath: string | null,
    messages: Message[],
    baseCommitSha: string | null
) {
    const { data: blameResult, isLoading, error } = useBlameSummary(nodeId, repoPath, commit, filePath, messages, baseCommitSha);

    const stats = blameResult ? {
        totalLines: blameResult.total_lines,
        contributorCount: new Set(blameResult.entries.map(e => e.author_node_id)).size,
        baseLines: blameResult.entries.filter(e => e.is_base).reduce((sum, e) => sum + (e.line_end - e.line_start + 1), 0),
        modifiedLines: blameResult.entries.filter(e => !e.is_base).reduce((sum, e) => sum + (e.line_end - e.line_start + 1), 0),
        fileExists: blameResult.file_exists,
        isBinary: blameResult.is_binary,
    } : null;

    return { stats, isLoading, error };
}
