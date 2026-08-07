import { describe, expect, it } from 'vitest';
import { mapLocalCommitToCommitEntity } from './localCommitGraphProjection';

describe('mapLocalCommitToCommitEntity', () => {
  it('preserves the selected workspace id for local canonical commit hover actions', () => {
    const commit = mapLocalCommitToCommitEntity({
      sha: '8bd427268ab5748653dc08576ce9fbf45ef3e3fc',
      subject: 'Merge into main',
      authorName: 'Agentree',
      authorEmail: 'agentree@local',
      authoredAt: '2026-05-16T01:19:04+05:30',
      committedAt: '2026-05-16T01:19:04+05:30',
      sourceKind: 'external',
      producedByNodeId: null,
      firstParentSha: 'a39b31fa087732199301005fd8f55d0b1ff651a6',
      filesChangedCount: 7,
      totalAdditions: 457,
      totalDeletions: 52,
    }, 'workspace-1');

    expect(commit.workspace_id).toBe('workspace-1');
    expect(commit.sha).toBe('8bd427268ab5748653dc08576ce9fbf45ef3e3fc');
    expect(commit.subject).toBe('Merge into main');
    expect(commit.author_name).toBe('Agentree');
    expect(commit.first_parent_sha).toBe('a39b31fa087732199301005fd8f55d0b1ff651a6');
    expect(commit.files_changed_count).toBe(7);
  });
});
