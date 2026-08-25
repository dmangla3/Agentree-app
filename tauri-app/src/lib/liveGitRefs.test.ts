import { describe, expect, it } from 'vitest';
import type { GitLocalRefInfo, GitRefSnapshot } from './agentClient';
import {
  buildLiveGitRefs,
  getComposerBaseSnapshotGitRefs,
} from './liveGitRefs';
import type { TrackedGitRef } from '../stores/workspaceStore';

const localRef = (input: Partial<GitLocalRefInfo> & Pick<GitLocalRefInfo, 'git_ref' | 'commit_sha'>): GitLocalRefInfo => ({
  git_ref: input.git_ref,
  short_name: input.short_name ?? input.git_ref.replace(/^refs\/heads\//, ''),
  commit_sha: input.commit_sha,
  committed_at: input.committed_at ?? null,
});

const trackedRef = (input: Partial<TrackedGitRef> & Pick<TrackedGitRef, 'git_ref'>): TrackedGitRef => ({
  id: input.id ?? `tracked-${input.git_ref}`,
  workspace_id: input.workspace_id ?? 'workspace-1',
  git_ref: input.git_ref,
  display_name: input.display_name ?? input.git_ref.replace(/^refs\/heads\//, ''),
  enabled: input.enabled ?? true,
  last_seen_commit_sha: input.last_seen_commit_sha ?? null,
  createdAt: input.createdAt ?? '2026-05-27T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-27T00:00:00.000Z',
});

const snapshot = (input: Partial<GitRefSnapshot>): GitRefSnapshot => ({
  head_sha: input.head_sha ?? null,
  current_branch_ref: input.current_branch_ref ?? null,
  refs: input.refs ?? [],
});

describe('getComposerBaseSnapshotGitRefs', () => {
  it('always includes main and de-duplicates tracked refs', () => {
    expect(getComposerBaseSnapshotGitRefs([
      'refs/heads/release',
      'refs/heads/main',
      'refs/heads/release',
      '',
      ' refs/heads/feature ',
    ])).toEqual([
      'refs/heads/feature',
      'refs/heads/main',
      'refs/heads/release',
    ]);
  });
});

describe('buildLiveGitRefs', () => {
  it('overlays a fresh main tip from the snapshot onto stale local refs', () => {
    const result = buildLiveGitRefs({
      refs: [
        localRef({ git_ref: 'refs/heads/main', short_name: 'main', commit_sha: 'old-main' }),
        localRef({ git_ref: 'refs/heads/feature', short_name: 'feature', commit_sha: 'feature-tip' }),
      ],
      trackedRefs: [],
      snapshot: snapshot({
        head_sha: 'fresh-head',
        refs: [{ git_ref: 'refs/heads/main', commit_sha: 'fresh-main', error: null }],
      }),
    });

    expect(result.headSha).toBe('fresh-head');
    expect(result.refs.find((ref) => ref.git_ref === 'refs/heads/main')?.commit_sha).toBe('fresh-main');
    expect(result.refs[0]).toEqual({ git_ref: 'HEAD', short_name: 'HEAD', commit_sha: 'fresh-head' });
    expect(result.refs.find((ref) => ref.git_ref === 'refs/heads/feature')?.commit_sha).toBe('feature-tip');
  });

  it('adds a snapshot-only tracked ref and mirrors the fresh tip into tracked refs without mutating inputs', () => {
    const refs = [localRef({ git_ref: 'refs/heads/main', commit_sha: 'main-tip' })];
    const trackedRefs = [
      trackedRef({ git_ref: 'refs/heads/release', last_seen_commit_sha: 'old-release' }),
      trackedRef({ git_ref: 'refs/heads/disabled', enabled: false, last_seen_commit_sha: 'old-disabled' }),
    ];

    const result = buildLiveGitRefs({
      refs,
      trackedRefs,
      snapshot: snapshot({
        refs: [
          { git_ref: 'refs/heads/release', commit_sha: 'fresh-release', error: null },
          { git_ref: 'refs/heads/disabled', commit_sha: 'fresh-disabled', error: null },
        ],
      }),
    });

    expect(result.refs.find((ref) => ref.git_ref === 'refs/heads/release')).toEqual({
      git_ref: 'refs/heads/release',
      short_name: 'release',
      commit_sha: 'fresh-release',
    });
    expect(result.trackedRefs.find((ref) => ref.git_ref === 'refs/heads/release')?.last_seen_commit_sha).toBe('fresh-release');
    expect(result.trackedRefs.find((ref) => ref.git_ref === 'refs/heads/disabled')?.last_seen_commit_sha).toBe('old-disabled');
    expect(trackedRefs[0].last_seen_commit_sha).toBe('old-release');
  });

  it('ignores blank snapshot tips and preserves committed_at metadata from local refs', () => {
    const result = buildLiveGitRefs({
      refs: [
        localRef({
          git_ref: 'refs/heads/main',
          short_name: 'main',
          commit_sha: 'local-main',
          committed_at: '2026-06-02T10:00:00.000Z',
        }),
      ],
      trackedRefs: [],
      snapshot: snapshot({
        refs: [{ git_ref: 'refs/heads/main', commit_sha: '', error: 'missing' }],
      }),
    });

    expect(result.refs).toEqual([
      {
        git_ref: 'refs/heads/main',
        short_name: 'main',
        commit_sha: 'local-main',
        committed_at: '2026-06-02T10:00:00.000Z',
      },
    ]);
  });
});
