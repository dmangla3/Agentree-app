import { useQuery } from '@tanstack/react-query';
import { agentClient, DiffResult, FileDiff } from '../lib/agentClient';
import { filterDiffResult } from '../lib/diffFilters';

// ═══════════════════════════════════════════════════════════════════════════
// QUERY KEYS
// ═══════════════════════════════════════════════════════════════════════════

export const diffKeys = {
    all: ['diff'] as const,
    parent: (repoPath: string, parentCommit: string, nodeCommit: string, includeContent: boolean) =>
        [...diffKeys.all, 'parent', repoPath, parentCommit, nodeCommit, includeContent] as const,
    nodes: (repoPath: string, fromCommit: string, toCommit: string, includeContent: boolean) =>
        [...diffKeys.all, 'nodes', repoPath, fromCommit, toCommit, includeContent] as const,
    file: (repoPath: string, fromCommit: string, toCommit: string, filePath: string) =>
        [...diffKeys.all, 'file', repoPath, fromCommit, toCommit, filePath] as const,
};

// ═══════════════════════════════════════════════════════════════════════════
// DIFF QUERIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get diff between a node and its parent.
 * Useful for showing "what changed in this turn".
 */
export function useDiffParent(
    repoPath: string | null,
    parentCommit: string | null,
    nodeCommit: string | null,
    includeContent: boolean = false
) {
    return useQuery<DiffResult, Error>({
        queryKey: diffKeys.parent(repoPath ?? '', parentCommit ?? '', nodeCommit ?? '', includeContent),
        queryFn: async () => {
            if (!repoPath || !parentCommit || !nodeCommit) {
                throw new Error('repoPath, parentCommit, and nodeCommit are required');
            }
            const result = await agentClient.diffCommits(repoPath, parentCommit, nodeCommit, includeContent);
            return filterDiffResult(result);
        },
        enabled: Boolean(repoPath && parentCommit && nodeCommit),
        staleTime: 5 * 60 * 1000, // 5 minutes - commit diffs are stable once created
        gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
    });
}

/**
 * Get diff between any two nodes.
 * Handles parent-child, ancestor-descendant, siblings, and unrelated nodes.
 */
export function useDiffNodes(
    repoPath: string | null,
    fromCommit: string | null,
    toCommit: string | null,
    includeContent: boolean = false
) {
    return useQuery<DiffResult, Error>({
        queryKey: diffKeys.nodes(repoPath ?? '', fromCommit ?? '', toCommit ?? '', includeContent),
        queryFn: async () => {
            if (!repoPath || !fromCommit || !toCommit) {
                throw new Error('repoPath, fromCommit, and toCommit are required');
            }
            const result = await agentClient.diffCommits(repoPath, fromCommit, toCommit, includeContent);
            return filterDiffResult(result);
        },
        enabled: Boolean(repoPath && fromCommit && toCommit),
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
    });
}

/**
 * Get diff for a single file between two nodes.
 * Use this for on-demand loading of file diffs when user expands a file.
 */
export function useDiffFile(
    repoPath: string | null,
    fromCommit: string | null,
    toCommit: string | null,
    filePath: string | null,
) {
    return useQuery<FileDiff, Error>({
        queryKey: diffKeys.file(repoPath ?? '', fromCommit ?? '', toCommit ?? '', filePath ?? ''),
        queryFn: async () => {
            if (!repoPath || !fromCommit || !toCommit || !filePath) {
                throw new Error('repoPath, fromCommit, toCommit, and filePath are required');
            }
            return await agentClient.diffFileBetweenCommits(repoPath, fromCommit, toCommit, filePath);
        },
        enabled: Boolean(repoPath && fromCommit && toCommit && filePath),
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get just the diff stats (without content) for quick display in hover cards.
 * Uses the parent diff with includeContent=false for efficiency.
 */
export function useDiffStats(repoPath: string | null, parentCommit: string | null, nodeCommit: string | null) {
    const { data, isLoading, error } = useDiffParent(repoPath, parentCommit, nodeCommit, false);

    return {
        stats: data?.stats ?? null,
        fileCount: data?.files.length ?? 0,
        isLoading,
        error,
    };
}

/**
 * Check if a node has any file changes compared to its parent.
 * Useful for showing badges on nodes.
 */
export function useHasFileChanges(repoPath: string | null, parentCommit: string | null, nodeCommit: string | null) {
    const { stats, isLoading, error } = useDiffStats(repoPath, parentCommit, nodeCommit);

    const hasChanges = stats
        ? stats.files_added + stats.files_modified + stats.files_deleted > 0
        : false;

    return {
        hasChanges,
        changeCount: stats
            ? stats.files_added + stats.files_modified + stats.files_deleted
            : 0,
        isLoading,
        error,
    };
}
