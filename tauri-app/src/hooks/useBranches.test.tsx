/* @vitest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBranches } from './useBranches';
import { workspaceKeys } from './useWorkspaces';
import { createQueryWrapper } from '../test/queryTestUtils';
import { agentClient } from '../lib/agentClient';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
  },
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    hasRuntime: vi.fn(),
    listBranchPointers: vi.fn(),
  },
}));

describe('useBranches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentClient.hasRuntime).mockReturnValue(true);
    vi.mocked(agentClient.listBranchPointers).mockResolvedValue([
      {
        name: 'ship',
        git_ref: 'refs/agentree/pointers/ship',
        commit_sha: 'ship-sha',
      },
    ]);
  });

  it('reads branch pointers from local git refs in native runtime instead of fetching server branches', async () => {
    const { Wrapper, queryClient } = createQueryWrapper();
    queryClient.setQueryData(workspaceKeys.list('user-1'), [{
      id: 'workspace-1',
      name: 'Workspace',
      userId: 'user-1',
      folderPath: '/repo',
      git_repo_path: '/repo',
      createdAt: '2026-05-19T00:00:00.000Z',
      updatedAt: '2026-05-19T00:00:00.000Z',
    }]);

    const { result } = renderHook(() => useBranches('workspace-1'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.data?.[0]).toEqual(expect.objectContaining({
        id: 'local:workspace-1:refs/agentree/pointers/ship',
        workspace_id: 'workspace-1',
        name: 'ship',
        git_ref: 'refs/agentree/pointers/ship',
        commit_sha: 'ship-sha',
      }));
    });
    expect(agentClient.listBranchPointers).toHaveBeenCalledWith('/repo');
    expect(api.get).not.toHaveBeenCalled();
  });
});
