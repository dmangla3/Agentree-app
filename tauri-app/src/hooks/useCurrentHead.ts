import { useMemo } from 'react';
import { useGitRefSnapshot } from './useGitRefSnapshot';

export const useCurrentHead = (repoPath: string | null) => {
    const gitRefs = useMemo(() => [], []);
    const snapshotQuery = useGitRefSnapshot(repoPath, gitRefs);

    return {
        ...snapshotQuery,
        data: snapshotQuery.data?.head_sha ?? null,
    };
};
