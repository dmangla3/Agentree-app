import { describe, expect, it } from 'vitest';
import type { BranchPointer, CommitEntity, Message, TrackedGitRef } from '../stores/workspaceStore';
import {
  buildComposerCodeBaseOptions,
  filterComposerCodeBaseOptions,
  resolveComposerDefaultCodeBase,
} from './composerCodeBase';

const message = (overrides: Partial<Message>): Message => ({
  id: overrides.id ?? 'message-1',
  workspaceId: overrides.workspaceId ?? 'workspace-1',
  role: overrides.role ?? 'assistant',
  content: overrides.content ?? '',
  parentId: overrides.parentId ?? null,
  createdAt: overrides.createdAt ?? '2026-05-23T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-05-23T00:00:00.000Z',
  ...overrides,
});

const commit = (sha: string, subject: string, overrides: Partial<CommitEntity> = {}): CommitEntity => ({
  sha,
  subject,
  ...overrides,
});

const branch = (name: string, sha: string, overrides: Partial<BranchPointer> = {}): BranchPointer => ({
  id: `branch-${name}`,
  workspace_id: 'workspace-1',
  name,
  node_id: null,
  commit_sha: sha,
  git_ref: `refs/heads/${name}`,
  is_ship_path: false,
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
  ...overrides,
});

const trackedRef = (name: string, sha: string, overrides: Partial<TrackedGitRef> = {}): TrackedGitRef => ({
  id: `tracked-${name}`,
  workspace_id: 'workspace-1',
  git_ref: `refs/heads/${name}`,
  display_name: name,
  enabled: true,
  last_seen_commit_sha: sha,
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
  ...overrides,
});

describe('resolveComposerDefaultCodeBase', () => {
  it('defaults to the reply target assistant output commit', () => {
    const messages = [
      message({ id: 'user-1', role: 'user' }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        output_commit_sha: 'assistant-output-sha',
      }),
    ];

    expect(resolveComposerDefaultCodeBase({
      targetMode: 'reply',
      replyParentMessageId: 'assistant-1',
      selectedNodeMessageId: 'assistant-1',
      focusedCommitSha: 'focused-commit-sha',
      previousCommitSha: 'previous-commit-sha',
      workspaceBaseCommitSha: 'workspace-base-sha',
      messages,
    })).toMatchObject({
      commitSha: 'assistant-output-sha',
      sourceKind: 'reply-target-output',
      producedByNodeId: 'assistant-1',
    });
  });

  it('walks to the nearest assistant ancestor when replying to a user node', () => {
    const messages = [
      message({ id: 'user-1', role: 'user' }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        parentId: 'user-1',
        output_commit_sha: 'ancestor-output-sha',
      }),
      message({ id: 'user-2', role: 'user', parentId: 'assistant-1' }),
    ];

    expect(resolveComposerDefaultCodeBase({
      targetMode: 'reply',
      replyParentMessageId: 'user-2',
      selectedNodeMessageId: 'user-2',
      focusedCommitSha: null,
      previousCommitSha: null,
      workspaceBaseCommitSha: 'workspace-base-sha',
      messages,
    })).toMatchObject({
      commitSha: 'ancestor-output-sha',
      sourceKind: 'ancestor-output',
      producedByNodeId: 'assistant-1',
    });
  });

  it('uses the previous composer commit when starting a new thread', () => {
    expect(resolveComposerDefaultCodeBase({
      targetMode: 'new-thread',
      replyParentMessageId: null,
      selectedNodeMessageId: null,
      focusedCommitSha: 'focused-commit-sha',
      previousCommitSha: 'previous-commit-sha',
      workspaceBaseCommitSha: 'workspace-base-sha',
      messages: [],
    })).toMatchObject({
      commitSha: 'previous-commit-sha',
      sourceKind: 'new-thread-previous',
    });
  });
});

describe('composer code base options', () => {
  it('builds searchable branch and tracked-ref options with hashes kept secondary', () => {
    const options = buildComposerCodeBaseOptions({
      defaultCodeBase: {
        commitSha: 'reply-target-sha',
        sourceKind: 'reply-target-output',
        primaryLabel: 'Default for this target',
        secondaryLabel: 'Reply target output',
        badge: 'default',
        producedByNodeId: 'assistant-1',
      },
      effectiveCommitSha: 'tracked-sha',
      selectedCommit: null,
      ancestorCommits: [commit('ancestor-sha', 'Fix auth regression', { produced_by_node_id: 'assistant-0' })],
      descendantCommits: [commit('descendant-sha', 'Improve graph zoom', { produced_by_node_id: 'assistant-2' })],
      branchPointers: [branch('main', 'tracked-sha'), branch('release', 'release-sha')],
      trackedRefs: [trackedRef('main', 'tracked-sha'), trackedRef('ship', 'ship-sha')],
    });

    expect(options.map((option) => option.primaryLabel)).toContain('main');
    expect(options.find((option) => option.sourceKind === 'tracked-ref' && option.primaryLabel === 'main')).toMatchObject({
      commitSha: 'tracked-sha',
      shortSha: 'tracked-',
      selected: true,
    });

    expect(filterComposerCodeBaseOptions(options, 'zoom').map((option) => option.commitSha)).toEqual(['descendant-sha']);
    expect(filterComposerCodeBaseOptions(options, 'tracked-').map((option) => option.commitSha)[0]).toBe('tracked-sha');
    expect(filterComposerCodeBaseOptions(options, 'ship').map((option) => option.sourceKind)[0]).toBe('tracked-ref');
  });
});
