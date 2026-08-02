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

    const preview = getDeleteBranchPreview(['user-1'], messages, 1);

    expect(preview.totalCount).toBe(3);
    expect(preview.userCount).toBe(1);
    expect(preview.assistantCount).toBe(1);
    expect(preview.commitCount).toBe(1);
    expect(preview.typeSummary).toBe('1 user node, 1 assistant node, 1 commit node');
  });

  it('formats commit-only deletions without selected branch copy', () => {
    const preview = getDeleteBranchPreview([], new Map(), 2);

    expect(formatDeleteBranchPreview(preview)).toBe(
      'This will permanently remove 2 commit nodes from the graph. This action cannot be undone.'
    );
  });
});
