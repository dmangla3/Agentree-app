import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentClient } from './agentClient';
import { persistMergeCommitGraph } from './mergeCommitGraph';

vi.mock('./agentClient', () => ({
  agentClient: {
    readCommitMetadata: vi.fn(),
    importLocalCommits: vi.fn(),
  },
}));

const mockedAgentClient = vi.mocked(agentClient);

describe('persistMergeCommitGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAgentClient.importLocalCommits.mockResolvedValue(1);
  });

  it('imports merge metadata as an Agentree-owned merge commit', async () => {
    mockedAgentClient.readCommitMetadata.mockResolvedValue({
      sha: 'merge-sha',
      parents: ['agent-parent', 'external-parent'],
      subject: 'Merge external into agent work',
      author_name: 'Agentree',
      author_email: 'agentree@example.com',
      authored_at: '2026-05-10T05:00:00.000Z',
      files_changed_count: 3,
      total_additions: 12,
      total_deletions: 4,
    });

    await persistMergeCommitGraph({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      commitSha: 'merge-sha',
      resultNodeId: 'assistant-merge',
      fallbackParents: ['fallback-parent'],
      fallbackSubject: 'Fallback merge subject',
    });

    expect(mockedAgentClient.importLocalCommits).toHaveBeenCalledWith(
      'workspace-1',
      [{
        sha: 'merge-sha',
        parents: ['agent-parent', 'external-parent'],
        subject: 'Merge external into agent work',
        authorName: 'Agentree',
        authorEmail: 'agentree@example.com',
        authoredAt: '2026-05-10T05:00:00.000Z',
        committedAt: '2026-05-10T05:00:00.000Z',
        sourceKind: 'merge',
        producedByNodeId: 'assistant-merge',
        filesChangedCount: 3,
        totalAdditions: 12,
        totalDeletions: 4,
      }],
      null,
      '/repo',
    );
  });

  it('falls back to merge result data when git metadata is unavailable', async () => {
    mockedAgentClient.readCommitMetadata.mockRejectedValue(new Error('metadata unavailable'));

    await persistMergeCommitGraph({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      commitSha: ' merge-sha ',
      resultNodeId: 'assistant-merge',
      fallbackParents: ['agent-parent', 'external-parent', 'agent-parent', ''],
      fallbackSubject: 'Fallback merge subject',
    });

    expect(mockedAgentClient.importLocalCommits).toHaveBeenCalledWith(
      'workspace-1',
      [expect.objectContaining({
        sha: 'merge-sha',
        parents: ['agent-parent', 'external-parent'],
        subject: 'Fallback merge subject',
        sourceKind: 'merge',
        producedByNodeId: 'assistant-merge',
      })],
      null,
      '/repo',
    );
  });

  it('does not import when the merge commit sha is empty', async () => {
    await persistMergeCommitGraph({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      commitSha: '   ',
      resultNodeId: 'assistant-merge',
      fallbackParents: ['agent-parent'],
      fallbackSubject: 'Fallback merge subject',
    });

    expect(mockedAgentClient.readCommitMetadata).not.toHaveBeenCalled();
    expect(mockedAgentClient.importLocalCommits).not.toHaveBeenCalled();
  });
});
