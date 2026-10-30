/* @vitest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCommitAcceptanceRefreshKey,
  getEnabledAcceptanceGitRefs,
  useCommitAcceptanceRefresh,
} from './useCommitAcceptance';
import type { TrackedGitRef } from '../stores/workspaceStore';
import { agentClient } from '../lib/agentClient';
import { createQueryWrapper } from '../test/queryTestUtils';

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    hasRuntime: vi.fn(() => true),
    refreshLocalCommitAcceptance: vi.fn(),
  },
}));

const trackedRef = (gitRef: string, overrides: Partial<TrackedGitRef> = {}): TrackedGitRef => ({
  id: gitRef,
  workspace_id: 'workspace-1',
  git_ref: gitRef,
  display_name: gitRef,
  enabled: true,
  last_seen_commit_sha: null,
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
  ...overrides,
});

describe('commit acceptance refresh', () => {
  it('defaults main and master to acceptance branches but never HEAD', () => {
    expect(getEnabledAcceptanceGitRefs([
      trackedRef('HEAD', { is_acceptance_branch: true }),
      trackedRef('refs/heads/main'),
      trackedRef('refs/heads/master'),
      trackedRef('refs/heads/development'),
    ])).toEqual(['refs/heads/main', 'refs/heads/master']);
  });

  it('includes explicitly enabled development branches', () => {
    expect(getEnabledAcceptanceGitRefs([
      trackedRef('refs/heads/main', { is_acceptance_branch: false }),
      trackedRef('refs/heads/development', { is_acceptance_branch: true }),
    ])).toEqual(['refs/heads/development']);
  });

  it('changes its key when an external Git process moves an acceptance branch', () => {
    const input = {
      acceptedGitRefs: ['refs/heads/main'],
      agentCommitShas: ['agent-sha'],
    };
    const before = buildCommitAcceptanceRefreshKey({
      ...input,
      refSnapshot: { head_sha: null, current_branch_ref: null, refs: [{ git_ref: 'refs/heads/main', commit_sha: 'tip-a', error: null }] },
    });
    const after = buildCommitAcceptanceRefreshKey({
      ...input,
      refSnapshot: { head_sha: null, current_branch_ref: null, refs: [{ git_ref: 'refs/heads/main', commit_sha: 'tip-b', error: null }] },
    });

    expect(after).not.toBe(before);
  });

  it('automatically rechecks when an external process moves an acceptance branch', async () => {
    vi.mocked(agentClient.refreshLocalCommitAcceptance).mockResolvedValue({
      changed: false,
      mergedCommitShas: [],
      checkedRefs: [],
      skippedRefs: [],
      errors: [],
      durationMs: 1,
    });
    const main = trackedRef('refs/heads/main');
    const snapshot = (sha: string) => ({
      head_sha: null,
      current_branch_ref: null,
      refs: [{ git_ref: 'refs/heads/main', commit_sha: sha, error: null }],
    });
    const { Wrapper } = createQueryWrapper();
    const { rerender } = renderHook(
      ({ tip }) => useCommitAcceptanceRefresh({
        workspaceId: 'workspace-1',
        repoPath: '/repo',
        trackedRefs: [main],
        refSnapshot: snapshot(tip),
        agentCommitShas: ['agent-sha'],
        enabled: true,
      }),
      { wrapper: Wrapper, initialProps: { tip: 'tip-a' } }
    );

    await waitFor(() => {
      expect(agentClient.refreshLocalCommitAcceptance).toHaveBeenCalledTimes(1);
    });
    rerender({ tip: 'tip-b' });
    await waitFor(() => {
      expect(agentClient.refreshLocalCommitAcceptance).toHaveBeenCalledTimes(2);
    });
    expect(agentClient.refreshLocalCommitAcceptance).toHaveBeenLastCalledWith(
      'workspace-1',
      '/repo',
      ['refs/heads/main']
    );
  });
});
