import { useQuery } from '@tanstack/react-query';
import { agentClient } from '../lib/agentClient';

/**
 * Resolves a git ref (e.g. 'refs/heads/main') to its tip commit SHA.
 * Returns null if the ref cannot be resolved.
 */
export const useRefTip = (repoPath: string | null, ref: string | null) => {
    return useQuery({
        queryKey: ['refTip', repoPath, ref],
        queryFn: async () => {
            if (!repoPath || !ref) return null;
            try {
                return await agentClient.resolveRefTip(repoPath, ref);
            } catch (_e) {
                return null;
            }
        },
        enabled: !!repoPath && !!ref,
        refetchInterval: 10000,
        staleTime: 5000,
    });
};
