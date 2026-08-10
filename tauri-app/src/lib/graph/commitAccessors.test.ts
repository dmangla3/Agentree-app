import { describe, expect, it } from 'vitest';
import * as commitAccessors from './commitAccessors';
import type { BranchPointer } from '../../stores/workspaceStore';

const pointer = (input: Partial<BranchPointer>): BranchPointer => ({
  id: input.id ?? input.name ?? 'pointer',
  workspace_id: input.workspace_id ?? 'workspace',
  name: input.name ?? 'branch',
  node_id: input.node_id ?? null,
  commit_sha: input.commit_sha ?? '',
  git_ref: input.git_ref ?? input.name ?? 'refs/heads/branch',
  is_ship_path: input.is_ship_path ?? false,
  createdAt: input.createdAt ?? '2026-05-19T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-19T00:00:00.000Z',
  commit: input.commit,
  node: input.node,
});

describe('commit accessors', () => {
  it('returns branch names for a commit and falls back to no names for HEAD-only pointers', () => {
    const getBranchPointerNamesForCommit = (commitAccessors as {
      getBranchPointerNamesForCommit?: (commitSha: string, pointers: BranchPointer[]) => string[];
    }).getBranchPointerNamesForCommit;

    expect(typeof getBranchPointerNamesForCommit).toBe('function');
    expect(getBranchPointerNamesForCommit?.('abc123456789', [
      pointer({ name: 'HEAD', commit_sha: 'abc123456789' }),
      pointer({ name: 'refs/heads/main', commit_sha: 'abc123456789' }),
      pointer({ name: 'feature/thread-ui', commit_sha: 'abc123456789' }),
      pointer({ name: 'main', commit_sha: 'abc123456789' }),
      pointer({ name: 'release', commit_sha: '', commit: { sha: 'abc123456789' } as BranchPointer['commit'] }),
      pointer({ name: 'other-commit', commit_sha: 'def987654321' }),
    ])).toEqual(['main', 'feature/thread-ui', 'release']);

    expect(getBranchPointerNamesForCommit?.('abc123456789', [
      pointer({ name: 'HEAD', commit_sha: 'abc123456789' }),
    ])).toEqual([]);
  });
});
