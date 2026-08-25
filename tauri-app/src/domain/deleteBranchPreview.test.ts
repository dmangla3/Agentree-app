import { describe, expect, it } from 'vitest';
import {
  collectDeleteBranchMessageIds,
  formatDeleteBranchPreview,
  getDeleteBranchPreview,
  getTopLevelDeleteBranchIds,
} from './deleteBranchPreview';
import type { Message } from '../stores/workspaceStore';

const message = (id: string, role: Message['role'], parentId: string | null, outputCommitSha?: string | null): Message => ({
  id,
  role,
  parentId,
  content: id,
  workspaceId: 'workspace-1',
  status: null,
  agent_id: null,
  execution_data: null,
  output_commit_sha: outputCommitSha ?? null,
  git_branch_name: null,
  createdAt: '2026-05-11T00:00:00.000Z',
  updatedAt: '2026-05-11T00:00:00.000Z',
});

const mapOf = (messages: Message[]) => new Map(messages.map((item) => [item.id, item]));

describe('delete branch preview', () => {
  it('keeps only top-level selected message roots', () => {
    const messages = mapOf([
      message('user-1', 'user', null),
      message('assistant-1', 'assistant', 'user-1'),
      message('user-2', 'user', 'assistant-1'),
    ]);

    expect(getTopLevelDeleteBranchIds(['assistant-1', 'user-2'], messages)).toEqual(['assistant-1']);
  });

  it('collects descendant message ids for selected branch roots', () => {
    const messages = mapOf([
      message('user-1', 'user', null),
      message('assistant-1', 'assistant', 'user-1', 'commit-a'),
      message('user-2', 'user', 'assistant-1'),
      message('assistant-2', 'assistant', 'user-2', 'commit-b'),
      message('sibling', 'assistant', 'user-1', 'commit-c'),
    ]);

    expect(collectDeleteBranchMessageIds(['assistant-1'], messages)).toEqual(
      new Set(['assistant-1', 'user-2', 'assistant-2'])
    );
  });

  it('adds canonical commit count to the delete preview when commit graph removal is selected', () => {
    const messages = mapOf([
      message('user-1', 'user', null),
      message('assistant-1', 'assistant', 'user-1', 'commit-a'),
    ]);

    const preview = getDeleteBranchPreview(['user-1'], messages, 1, {
      extraCommitLabels: ['abc123def456'],
    });

    expect(preview.totalCount).toBe(3);
    expect(preview.userCount).toBe(1);
    expect(preview.assistantCount).toBe(1);
    expect(preview.commitCount).toBe(1);
    expect(preview.typeSummary).toBe('1 user node, 1 assistant node, 1 commit node');
    expect(preview.groups.commit).toEqual([
      { id: 'extra-commit-0', label: 'Commit abc123def456' },
    ]);
  });

  it('includes thread and grouped node names in the delete preview', () => {
    const messages = mapOf([
      message('user-1', 'user', null),
      { ...message('assistant-1', 'assistant', 'user-1'), aiLabel: 'Plan executor' },
      message('user-2', 'user', 'assistant-1'),
    ]);

    const preview = getDeleteBranchPreview(['user-1'], messages, 0, {
      threadLabel: 'Improve graph cleanup',
    });

    expect(preview.threadLabel).toBe('Improve graph cleanup');
    expect(preview.groups.user).toEqual([
      { id: 'user-1', label: 'user-1' },
      { id: 'user-2', label: 'user-2' },
    ]);
    expect(preview.groups.assistant).toEqual([
      { id: 'assistant-1', label: 'Plan executor' },
    ]);
  });

  it('falls back to node ids and truncates long labels in delete details', () => {
    const messages = mapOf([
      {
        ...message('assistant-1', 'assistant', null),
        content: 'This assistant message has a very long generated title that should not take over the delete confirmation dialog.',
      },
    ]);

    const preview = getDeleteBranchPreview(['assistant-1'], messages);

    expect(preview.groups.assistant[0]?.id).toBe('assistant-1');
    expect(preview.groups.assistant[0]?.label).toBe('This assistant message has a very long generated title that...');
    expect(preview.groups.assistant[0]?.label.length).toBeLessThanOrEqual(68);
  });

  it('formats commit-only deletions without selected branch copy', () => {
    const preview = getDeleteBranchPreview([], new Map(), 2);

    expect(formatDeleteBranchPreview(preview)).toBe(
      'This will permanently remove 2 commit nodes from the graph. This action cannot be undone.'
    );
  });
});
