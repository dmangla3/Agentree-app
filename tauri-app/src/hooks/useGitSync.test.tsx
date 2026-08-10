/* @vitest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGitSync } from './useGitSync';
import { trackedRefKeys } from './useTrackedRefs';
import { createQueryWrapper } from '../test/queryTestUtils';
import { agentClient } from '../lib/agentClient';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../lib/authSession', () => ({
  getAccessToken: vi.fn(async () => 'mock-token'),
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    enqueueLocalCommitGraphSync: vi.fn(),
    hasRuntime: vi.fn(),
    importLocalCommits: vi.fn(),
    listLocalCommitGraph: vi.fn(),
    listMissingCommits: vi.fn(),
    processLocalSyncEvents: vi.fn(),
    resolveRefTip: vi.fn(),
  },
}));

const mockedAgentClient = vi.mocked(agentClient);

describe('useGitSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAgentClient.hasRuntime.mockReturnValue(true);
    mockedAgentClient.resolveRefTip.mockResolvedValue('tip-sha');
    mockedAgentClient.listLocalCommitGraph.mockResolvedValue({
      commits: [],
      commitParents: [],
      commitObservations: [],
    });
    mockedAgentClient.listMissingCommits.mockResolvedValue([
      {
        sha: 'tip-sha',
        parents: ['parent-sha'],
        subject: 'Latest commit',
        author_name: 'Ada',
        author_email: 'ada@example.com',
        authored_at: '2026-05-13T00:00:00Z',
        files_changed_count: 2,
        total_additions: 10,
        total_deletions: 1,
      },
    ]);
    mockedAgentClient.importLocalCommits.mockResolvedValue(1);
    mockedAgentClient.enqueueLocalCommitGraphSync.mockResolvedValue(null);
  });

  it('imports the tracked ref tip when lastSeen already equals the tip but local graph is missing it', async () => {
    const { Wrapper, queryClient } = createQueryWrapper();
    queryClient.setQueryData(trackedRefKeys.workspace('workspace-1'), [
      {
        id: 'tracked-main',
        workspace_id: 'workspace-1',
        git_ref: 'refs/heads/main',
        display_name: 'main',
        enabled: true,
        last_seen_commit_sha: 'tip-sha',
        createdAt: '2026-05-13T00:00:00Z',
        updatedAt: '2026-05-13T00:00:00Z',
      },
    ]);

    const { result } = renderHook(() => useGitSync('workspace-1', '/repo'), { wrapper: Wrapper });
    const syncResult = await result.current.runSync();

    await waitFor(() => {
      expect(mockedAgentClient.listMissingCommits).toHaveBeenCalledWith('/repo', null, 'tip-sha');
    });
    expect(mockedAgentClient.importLocalCommits).toHaveBeenCalledWith(
      'workspace-1',
      [
        expect.objectContaining({
          sha: 'tip-sha',
          sourceKind: 'external',
        }),
      ],
      'refs/heads/main',
      '/repo'
    );
    expect(mockedAgentClient.enqueueLocalCommitGraphSync).toHaveBeenCalled();
    expect(mockedAgentClient.processLocalSyncEvents).toHaveBeenCalledWith('mock-token');
    expect(syncResult?.didSync).toBe(true);
    expect(syncResult?.importedCount).toBe(1);
  });

  it('leaves graph refresh ownership to the caller after importing commits', async () => {
    const { Wrapper, queryClient } = createQueryWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    queryClient.setQueryData(trackedRefKeys.workspace('workspace-1'), [
      {
        id: 'tracked-main',
        workspace_id: 'workspace-1',
        git_ref: 'refs/heads/main',
        display_name: 'main',
        enabled: true,
        last_seen_commit_sha: 'parent-sha',
        createdAt: '2026-05-13T00:00:00Z',
        updatedAt: '2026-05-13T00:00:00Z',
      },
    ]);

    const { result } = renderHook(() => useGitSync('workspace-1', '/repo'), { wrapper: Wrapper });
    await result.current.runSync();

    await waitFor(() => {
      expect(mockedAgentClient.importLocalCommits).toHaveBeenCalled();
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ['graph-snapshot', 'workspace-1'],
    }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ['local-commit-graph', 'workspace-1'],
    }));
  });
});
