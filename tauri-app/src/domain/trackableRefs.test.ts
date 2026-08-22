import { describe, expect, it } from 'vitest';
import { sortTrackableRefsByRecentCommit } from './trackableRefs';

describe('sortTrackableRefsByRecentCommit', () => {
  it('orders untracked branches by newest tip commit time before branch name', () => {
    const refs = [
      {
        git_ref: 'refs/heads/alpha',
        short_name: 'alpha',
        commit_sha: 'older-tip',
        committed_at: '2026-05-01T12:00:00+00:00',
      },
      {
        git_ref: 'refs/heads/zulu',
        short_name: 'zulu',
        commit_sha: 'newer-tip',
        committed_at: '2026-05-30T12:00:00+00:00',
      },
      {
        git_ref: 'refs/heads/middle',
        short_name: 'middle',
        commit_sha: 'middle-tip',
        committed_at: '2026-05-15T12:00:00+00:00',
      },
    ];

    expect(sortTrackableRefsByRecentCommit(refs).map((ref) => ref.short_name)).toEqual([
      'zulu',
      'middle',
      'alpha',
    ]);
  });

  it('falls back to branch name when commit times are missing or equal', () => {
    const refs = [
      { git_ref: 'refs/heads/zulu', short_name: 'zulu', commit_sha: 'zulu-tip' },
      { git_ref: 'refs/heads/alpha', short_name: 'alpha', commit_sha: 'alpha-tip' },
    ];

    expect(sortTrackableRefsByRecentCommit(refs).map((ref) => ref.short_name)).toEqual([
      'alpha',
      'zulu',
    ]);
  });
});
