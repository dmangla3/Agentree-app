import { describe, expect, it } from 'vitest';
import {
  buildComposerCommitPickerChipItems,
  buildComposerCommitPickerItems,
  resolveComposerDefaultBaseCommit,
  type ComposerBaseMessage,
  type ComposerCommitPickerCommit,
  type ComposerCommitPickerRef,
  type ComposerCommitPickerTrackedRef,
} from './composerBaseCommit';

const message = (input: Partial<ComposerBaseMessage> & Pick<ComposerBaseMessage, 'id'>): ComposerBaseMessage => ({
  id: input.id,
  parentId: input.parentId ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
});

const trackedRef = (input: Partial<ComposerCommitPickerTrackedRef> & Pick<ComposerCommitPickerTrackedRef, 'git_ref'>): ComposerCommitPickerTrackedRef => ({
  git_ref: input.git_ref,
  display_name: input.display_name ?? input.git_ref.replace(/^refs\/heads\//, ''),
  enabled: input.enabled ?? true,
  last_seen_commit_sha: input.last_seen_commit_sha ?? null,
  createdAt: input.createdAt ?? '2026-05-27T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-27T00:00:00.000Z',
} as ComposerCommitPickerTrackedRef);

describe('resolveComposerDefaultBaseCommit', () => {
  it('uses the reply parent generated commit before the parent base commit', () => {
    const messages = [
      message({ id: 'root', output_commit_sha: 'root-generated' }),
      message({
        id: 'reply-parent',
        parentId: 'root',
        output_commit_sha: 'parent-generated',
        base_commit_sha: 'parent-base',
      }),
    ];

    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'reply',
      replyParentMessageId: 'reply-parent',
      selectedNodeId: 'reply-parent',
      messages,
      refs: [],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'parent-generated',
      source: 'reply-parent-output',
      selectedFromNodeId: 'reply-parent',
    });
  });

  it('falls back from reply parent base commit to latest ancestor generated commit', () => {
    const messages = [
      message({ id: 'root', output_commit_sha: 'root-generated' }),
      message({ id: 'middle', parentId: 'root' }),
      message({ id: 'reply-parent', parentId: 'middle', base_commit_sha: 'parent-base' }),
    ];

    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'reply',
      replyParentMessageId: 'reply-parent',
      selectedNodeId: 'reply-parent',
      messages,
      refs: [],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'parent-base',
      source: 'reply-parent-base',
      selectedFromNodeId: 'reply-parent',
    });

    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'reply',
      replyParentMessageId: 'middle',
      selectedNodeId: 'middle',
      messages,
      refs: [],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'root-generated',
      source: 'latest-ancestor-output',
      selectedFromNodeId: 'root',
    });
  });

  it('uses main for new threads before the current thread first message base', () => {
    const messages = [
      message({ id: 'thread-root', base_commit_sha: 'thread-root-base' }),
      message({ id: 'selected', parentId: 'thread-root' }),
    ];
    const refs: ComposerCommitPickerRef[] = [
      { git_ref: 'refs/heads/feature/work', short_name: 'feature/work', commit_sha: 'feature-tip' },
      { git_ref: 'refs/heads/main', short_name: 'main', commit_sha: 'main-tip' },
    ];

    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'new-thread',
      replyParentMessageId: null,
      selectedNodeId: 'selected',
      messages,
      refs,
      trackedRefs: [],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'main-tip',
      source: 'main-ref',
      selectedFromNodeId: null,
    });
  });

  it('uses a tracked ref for new threads when main does not exist', () => {
    const messages = [
      message({ id: 'thread-root', base_commit_sha: 'thread-root-base' }),
      message({ id: 'selected', parentId: 'thread-root' }),
    ];

    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'new-thread',
      replyParentMessageId: null,
      selectedNodeId: 'selected',
      messages,
      refs: [{ git_ref: 'refs/heads/feature/work', short_name: 'feature/work', commit_sha: 'feature-tip' }],
      trackedRefs: [trackedRef({ git_ref: 'refs/heads/feature/work', last_seen_commit_sha: 'stale-feature-tip' })],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'feature-tip',
      source: 'tracked-ref',
      selectedFromNodeId: null,
    });
  });

  it('uses HEAD for root targets when main does not exist', () => {
    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'new-thread',
      replyParentMessageId: null,
      selectedNodeId: null,
      messages: [],
      refs: [{ git_ref: 'HEAD', short_name: 'HEAD', commit_sha: 'head-tip' }],
      trackedRefs: [trackedRef({ git_ref: 'refs/heads/release', last_seen_commit_sha: 'release-tip' })],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'head-tip',
      source: 'head-ref',
      selectedFromNodeId: null,
    });
  });

  it('uses tracked ref last-seen commits before falling back to workspace base', () => {
    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'new-thread',
      replyParentMessageId: null,
      selectedNodeId: null,
      messages: [],
      refs: [],
      trackedRefs: [trackedRef({ git_ref: 'refs/heads/release', last_seen_commit_sha: 'release-tip' })],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'release-tip',
      source: 'tracked-ref',
      selectedFromNodeId: null,
    });
  });

  it('uses main for parentless reply targets such as root message edits', () => {
    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'reply',
      replyParentMessageId: null,
      selectedNodeId: null,
      messages: [message({ id: 'root-user', base_commit_sha: 'workspace-base' })],
      refs: [{ git_ref: 'refs/heads/main', short_name: 'main', commit_sha: 'main-tip' }],
      trackedRefs: [],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'main-tip',
      source: 'main-ref',
      selectedFromNodeId: null,
    });
  });

  it('falls back to the workspace base for new threads when main, HEAD, and tracked refs do not exist', () => {
    expect(resolveComposerDefaultBaseCommit({
      targetMode: 'new-thread',
      replyParentMessageId: null,
      selectedNodeId: null,
      messages: [message({ id: 'thread-root', base_commit_sha: 'thread-root-base' })],
      refs: [],
      trackedRefs: [],
      workspaceBaseCommitSha: 'workspace-base',
    })).toEqual({
      sha: 'workspace-base',
      source: 'workspace-base',
      selectedFromNodeId: null,
    });
  });
});

describe('buildComposerCommitPickerItems', () => {
  const commit = (sha: string, subject: string): ComposerCommitPickerCommit => ({
    sha,
    subject,
    parents: [],
  });

  it('prioritizes tracked ref chips and searches by branch, subject, and sha without exposing agentree refs', () => {
    const refs: ComposerCommitPickerRef[] = [
      { git_ref: 'refs/heads/agentree/generated', short_name: 'agentree/generated', commit_sha: 'internal-tip' },
      { git_ref: 'refs/heads/main', short_name: 'main', commit_sha: 'main-tip' },
      { git_ref: 'refs/heads/feature/search', short_name: 'feature/search', commit_sha: 'feature-tip' },
    ];
    const commits = [
      commit('main-tip', 'Update landing copy'),
      commit('feature-tip', 'Improve code base picker'),
      commit('internal-tip', 'Agentree checkpoint'),
    ];

    const items = buildComposerCommitPickerItems({
      defaultSha: 'main-tip',
      effectiveSha: 'main-tip',
      commits,
      refs,
      trackedRefs: [{ git_ref: 'refs/heads/feature/search', display_name: 'Picker branch', enabled: true }],
      query: 'picker',
    });

    expect(items.map((item) => item.sha)).toEqual(['feature-tip']);
    expect(items[0].primaryLabel).toBe('Picker branch');
    expect(items[0].refNames).toEqual(['Picker branch', 'feature/search']);
    expect(items[0].searchText).toContain('improve code base picker');
    expect(items.some((item) => item.primaryLabel.includes('agentree'))).toBe(false);
  });

  it('orders non-tracked branch and commit choices by commit recency', () => {
    const refs: ComposerCommitPickerRef[] = [
      { git_ref: 'refs/heads/alpha', short_name: 'alpha', commit_sha: 'older-branch' },
      { git_ref: 'refs/heads/zulu', short_name: 'zulu', commit_sha: 'newer-branch' },
    ];
    const commits = [
      { ...commit('older-branch', 'Older branch'), authored_at: '2024-01-01T00:00:00Z' },
      { ...commit('newer-branch', 'Newer branch'), authored_at: '2024-03-01T00:00:00Z' },
      { ...commit('bare-commit', 'Bare commit'), authored_at: '2024-02-01T00:00:00Z' },
    ];

    const items = buildComposerCommitPickerItems({
      defaultSha: null,
      effectiveSha: null,
      commits,
      refs,
      trackedRefs: [],
    });

    expect(items.map((item) => item.sha)).toEqual(['newer-branch', 'bare-commit', 'older-branch']);
  });

  it('orders chips as tracked refs, HEAD, then other refs by commit recency', () => {
    const refs: ComposerCommitPickerRef[] = [
      { git_ref: 'refs/heads/older', short_name: 'older', commit_sha: 'older-tip' },
      { git_ref: 'refs/heads/newer', short_name: 'newer', commit_sha: 'newer-tip' },
      { git_ref: 'refs/heads/tracked', short_name: 'tracked', commit_sha: 'tracked-tip' },
      { git_ref: 'HEAD', short_name: 'HEAD', commit_sha: 'head-tip' },
    ];
    const commits = [
      { ...commit('older-tip', 'Older ref'), authored_at: '2024-01-01T00:00:00Z' },
      { ...commit('newer-tip', 'Newer ref'), authored_at: '2024-03-01T00:00:00Z' },
      { ...commit('tracked-tip', 'Tracked ref'), authored_at: '2024-02-01T00:00:00Z' },
      { ...commit('head-tip', 'Head ref'), authored_at: '2024-01-15T00:00:00Z' },
    ];
    const items = buildComposerCommitPickerItems({
      defaultSha: null,
      effectiveSha: null,
      commits,
      refs,
      trackedRefs: [{
        git_ref: 'refs/heads/tracked',
        display_name: 'Tracked branch',
        enabled: true,
        updatedAt: '2024-01-01T00:00:00Z',
      }],
    });
    const recencyBySha = new Map(
      commits.map((entry) => [entry.sha, Date.parse(entry.authored_at ?? '')])
    );

    const chips = buildComposerCommitPickerChipItems({
      items,
      refs,
      trackedRefs: [{
        git_ref: 'refs/heads/tracked',
        display_name: 'Tracked branch',
        enabled: true,
        updatedAt: '2024-01-01T00:00:00Z',
      }],
      headSha: 'head-tip',
      commitRecencyBySha: recencyBySha,
    });

    expect(chips.map((chip) => chip.label)).toEqual(['Tracked branch', 'HEAD', 'newer', 'older']);
  });
});
