import { describe, expect, it } from 'vitest';
import type { ProjectedCommitEntity } from '../../../domain/workspaceProjection';
import { createCommitHoverEntity } from './commitHoverEntity';

const makeCommit = (): ProjectedCommitEntity => ({
  entityId: 'commit:abc123456789',
  kind: 'imported_commit',
  sha: 'abc123456789',
  shortSha: 'abc12345',
  subject: 'Imported canonical commit',
  sourceKind: 'external',
  ownerKind: 'external',
  placement: 'commit_lineage',
  producedByNodeId: null,
  visualOwnerNodeId: null,
  parentShas: ['parent123'],
  parentRows: [{ child_sha: 'abc123456789', parent_sha: 'parent123', parent_index: 0 }],
  isMerge: false,
  isProminentMerge: false,
  layoutParentSha: 'parent123',
  secondaryParentShas: [],
  observations: [
    { commit_sha: 'abc123456789', git_ref: 'refs/heads/main', source_kind: 'external' },
  ],
  sortTs: Date.parse('2026-05-12T00:00:00.000Z'),
  commit: {
    sha: 'abc123456789',
    workspace_id: 'workspace-1',
    subject: 'Imported canonical commit',
    source_kind: 'external',
    produced_by_node_id: null,
    first_parent_sha: 'parent123',
    author_name: 'Ada',
    files_changed_count: 3,
    total_additions: 10,
    total_deletions: 4,
    committed_at: '2026-05-12T00:00:00.000Z',
    authored_at: '2026-05-12T00:00:00.000Z',
  } as ProjectedCommitEntity['commit'],
});

describe('createCommitHoverEntity', () => {
  it('adapts a canonical commit into the commit_message entity shape used by ChatCommitCard', () => {
    const entity = createCommitHoverEntity(makeCommit());

    expect(entity.kind).toBe('commit_message');
    expect(entity.entityId).toBe('commit_message:abc123456789:hover');
    expect(entity.preview).toBe('Imported canonical commit');
    expect(entity.shortSha).toBe('abc12345');
    expect(entity.authorName).toBe('Ada');
    expect(entity.parentShas).toEqual(['parent123']);
    expect(entity.message?.output_commit_sha).toBe('abc123456789');
    expect(entity.message?.commit?.sha).toBe('abc123456789');
    expect(entity.message?.commit?.parents).toEqual([
      { child_sha: 'abc123456789', parent_sha: 'parent123', parent_index: 0 },
    ]);
    expect(entity.message?.branchPointers).toEqual([]);
    expect(entity.message?.execution_data?.meta?.files_changed_count).toBe(3);
    expect(entity.message?.execution_data?.meta?.total_additions).toBe(10);
    expect(entity.message?.execution_data?.meta?.total_deletions).toBe(4);
  });
});
