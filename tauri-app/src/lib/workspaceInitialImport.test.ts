// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { bootstrapWorkspaceInitialGitImport } from './workspaceInitialImport';
import { api } from './api';
import { agentClient } from './agentClient';
import { readCachedTrackedRefs } from '../hooks/useTrackedRefs';

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('./agentClient', () => ({
  agentClient: {
    enqueueLocalCommitGraphSync: vi.fn(),
    hasRuntime: vi.fn(),
    hydrateLocalNodesFromServer: vi.fn(),
    importLocalCommits: vi.fn(),
    listLocalRefs: vi.fn(),
    listMissingCommits: vi.fn(),
    resolveCurrentBranchRef: vi.fn(),
    resolveRefTip: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const mockedAgentClient = vi.mocked(agentClient);

const makeQueryClient = () => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  refetchQueries: vi.fn().mockResolvedValue(undefined),
}) as unknown as QueryClient;

describe('bootstrapWorkspaceInitialGitImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
        removeItem: vi.fn((key: string) => storage.delete(key)),
        clear: vi.fn(() => storage.clear()),
      },
    });
    window.localStorage.clear();
    mockedAgentClient.listLocalRefs.mockResolvedValue([
      { git_ref: 'refs/heads/main', short_name: 'main', commit_sha: 'head-sha' },
    ]);
    mockedAgentClient.resolveRefTip.mockResolvedValue('head-sha');
    mockedAgentClient.resolveCurrentBranchRef.mockResolvedValue('refs/heads/main');
    mockedAgentClient.listMissingCommits.mockResolvedValue([
      {
        sha: 'head-sha',
        parents: ['parent-sha'],
        subject: 'Add feature',
        author_name: 'Ada',
        author_email: 'ada@example.com',
        authored_at: '2026-05-11T00:00:00Z',
        files_changed_count: 3,
        total_additions: 42,
        total_deletions: 7,
      },
    ]);
    mockedAgentClient.importLocalCommits.mockResolvedValue(1);
    mockedAgentClient.enqueueLocalCommitGraphSync.mockResolvedValue(null);
    mockedAgentClient.hydrateLocalNodesFromServer.mockResolvedValue(0);
    mockedApi.post.mockResolvedValue({ data: { id: 'tracked-ref-1', importedCount: 1 } });
    mockedApi.patch.mockResolvedValue({ data: {} });
    mockedApi.get.mockResolvedValue({ data: [] });
  });

  it('imports initial commits into the local commit graph in Tauri runtime', async () => {
    mockedAgentClient.hasRuntime.mockReturnValue(true);

    const result = await bootstrapWorkspaceInitialGitImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      queryClient: makeQueryClient(),
    });

    expect(mockedAgentClient.importLocalCommits).toHaveBeenCalledWith(
      'workspace-1',
      [
        {
          sha: 'head-sha',
          parents: ['parent-sha'],
          subject: 'Add feature',
          authorName: 'Ada',
          authorEmail: 'ada@example.com',
          authoredAt: '2026-05-11T00:00:00Z',
          committedAt: '2026-05-11T00:00:00Z',
          sourceKind: 'external',
          filesChangedCount: 3,
          totalAdditions: 42,
          totalDeletions: 7,
        },
      ],
      'refs/heads/main',
      '/repo'
    );
    expect(mockedAgentClient.enqueueLocalCommitGraphSync).toHaveBeenCalledWith(
      'workspace-1',
      {
        refs: [
          {
            gitRef: 'refs/heads/main',
            tipCommitSha: 'head-sha',
            commits: [
              {
                sha: 'head-sha',
                parents: ['parent-sha'],
                subject: 'Add feature',
                authorName: 'Ada',
                authorEmail: 'ada@example.com',
                authoredAt: '2026-05-11T00:00:00Z',
                filesChangedCount: 3,
                totalAdditions: 42,
                totalDeletions: 7,
              },
            ],
          },
        ],
      },
      'refs/heads/main:head-sha'
    );
    expect(mockedApi.post).toHaveBeenCalledWith('/workspaces/workspace-1/tracked-refs', {
      gitRef: 'refs/heads/main',
      displayName: 'main',
      enabled: true,
      isAcceptanceBranch: true,
    });
    expect(readCachedTrackedRefs('workspace-1')).toEqual([
      expect.objectContaining({
        git_ref: 'refs/heads/main',
        is_acceptance_branch: true,
      }),
    ]);
    expect(mockedApi.post).not.toHaveBeenCalledWith(
      '/workspaces/workspace-1/git-sync/ingest',
      expect.anything()
    );
    expect(result.importedCount).toBe(1);
  });

  it('keeps the server ingest path outside Tauri runtime', async () => {
    mockedAgentClient.hasRuntime.mockReturnValue(false);

    const result = await bootstrapWorkspaceInitialGitImport({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      queryClient: makeQueryClient(),
    });

    expect(mockedAgentClient.importLocalCommits).not.toHaveBeenCalled();
    expect(mockedAgentClient.enqueueLocalCommitGraphSync).not.toHaveBeenCalled();
    expect(mockedApi.post).toHaveBeenCalledWith('/workspaces/workspace-1/tracked-refs', {
      gitRef: 'refs/heads/main',
      displayName: 'main',
      enabled: true,
      isAcceptanceBranch: true,
    });
    expect(mockedApi.post).toHaveBeenCalledWith('/workspaces/workspace-1/git-sync/ingest', {
      refs: [
        {
          gitRef: 'refs/heads/main',
          tipCommitSha: 'head-sha',
          commits: [
            {
              sha: 'head-sha',
              parents: ['parent-sha'],
              subject: 'Add feature',
              authorName: 'Ada',
              authorEmail: 'ada@example.com',
              authoredAt: '2026-05-11T00:00:00Z',
              filesChangedCount: 3,
              totalAdditions: 42,
              totalDeletions: 7,
            },
          ],
        },
      ],
    });
    expect(result.importedCount).toBe(1);
  });
});
