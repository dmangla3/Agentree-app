import { describe, expect, it } from 'vitest';
import { buildPreferredRefNameBySha } from './useCommits';
import type { GitLocalRefInfo } from '../lib/agentClient';
import type { TrackedGitRef } from '../stores/workspaceStore';

const localRef = (
  gitRef: string,
  shortName: string,
  commitSha = 'commit-a'
): GitLocalRefInfo => ({
  git_ref: gitRef,
  short_name: shortName,
  commit_sha: commitSha,
});

const trackedRef = (gitRef: string): TrackedGitRef => ({
  id: gitRef,
  workspace_id: 'workspace-1',
  git_ref: gitRef,
  display_name: gitRef.replace('refs/heads/', ''),
  enabled: true,
  last_seen_commit_sha: null,
  createdAt: '2026-05-19T00:00:00.000Z',
  updatedAt: '2026-05-19T00:00:00.000Z',
});

describe('buildPreferredRefNameBySha', () => {
  it('prefers tracked human refs over earlier internal Agentree refs on the same commit', () => {
    const refNameBySha = buildPreferredRefNameBySha(
      [
        localRef('refs/heads/agentree/70f6b27c', 'agentree/70f6b27c'),
        localRef('refs/heads/main', 'main'),
      ],
      [trackedRef('refs/heads/main')]
    );

    expect(refNameBySha.get('commit-a')).toBe('main');
  });

  it('prefers human branch refs over internal Agentree refs even when neither is tracked', () => {
    const refNameBySha = buildPreferredRefNameBySha([
      localRef('refs/heads/agentree/70f6b27c', 'agentree/70f6b27c'),
      localRef('refs/heads/feature/payment-flow', 'feature/payment-flow'),
    ]);

    expect(refNameBySha.get('commit-a')).toBe('feature/payment-flow');
  });

  it('prefers tracked human refs when multiple human refs point at the same commit', () => {
    const refNameBySha = buildPreferredRefNameBySha(
      [
        localRef('refs/heads/feature/payment-flow', 'feature/payment-flow'),
        localRef('refs/heads/main', 'main'),
      ],
      [trackedRef('refs/heads/main')]
    );

    expect(refNameBySha.get('commit-a')).toBe('main');
  });
});
