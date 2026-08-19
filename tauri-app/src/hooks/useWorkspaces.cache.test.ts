import { describe, expect, it } from 'vitest';
import type { Workspace } from '../stores/workspaceStore';
import { mergeWorkspaceIntoCachedWorkspaces } from './useWorkspaces';

const workspace = (id: string, name = id): Workspace => ({
  id,
  name,
  userId: 'user-1',
  createdAt: '2026-05-28T00:00:00.000Z',
  updatedAt: '2026-05-28T00:00:00.000Z',
});

describe('mergeWorkspaceIntoCachedWorkspaces', () => {
  it('puts a newly created workspace into a stale workspace list immediately', () => {
    const existing = workspace('workspace-1');
    const created = workspace('workspace-2');

    expect(mergeWorkspaceIntoCachedWorkspaces([existing], created)).toEqual([created, existing]);
  });

  it('replaces an existing cached workspace instead of duplicating it', () => {
    const existing = workspace('workspace-1', 'Old name');
    const updated = workspace('workspace-1', 'Updated name');

    expect(mergeWorkspaceIntoCachedWorkspaces([existing], updated)).toEqual([updated]);
  });
});
