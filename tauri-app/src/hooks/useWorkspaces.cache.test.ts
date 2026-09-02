import { describe, expect, it } from 'vitest';
import type { Workspace } from '../stores/workspaceStore';
import {
  mergeWorkspaceIntoCachedWorkspaces,
  renameWorkspaceInCachedWorkspaces,
  suggestWorkspaceNameForRepo,
  workspaceKeys,
} from './useWorkspaces';

const workspace = (id: string, name = id): Workspace => ({
  id,
  name,
  userId: 'user-1',
  folderPath: '/tmp/repo',
  repo_path: '/tmp/repo',
  git_repo_path: '/tmp/repo',
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

describe('workspaceKeys', () => {
  it('scopes the workspace list cache by user id', () => {
    expect(workspaceKeys.list('user-1')).toEqual(['workspaces', 'user-1']);
    expect(workspaceKeys.list('user-2')).toEqual(['workspaces', 'user-2']);
  });
});

describe('suggestWorkspaceNameForRepo', () => {
  it('uses the repo basename and first NATO suffix for a new repo', () => {
    expect(suggestWorkspaceNameForRepo('/Users/example/work/Agentree', [])).toBe('Agentree Alpha');
  });

  it('advances the NATO suffix for workspaces under the same repo', () => {
    const first = workspace('workspace-1', 'repo Alpha');
    const second = workspace('workspace-2', 'repo Bravo');

    expect(suggestWorkspaceNameForRepo('/tmp/repo', [first, second])).toBe('repo Charlie');
  });

  it('ignores matching names from other repositories', () => {
    const otherRepoWorkspace = {
      ...workspace('workspace-1', 'repo Alpha'),
      folderPath: '/tmp/other',
      repo_path: '/tmp/other',
      git_repo_path: '/tmp/other',
    };

    expect(suggestWorkspaceNameForRepo('/tmp/repo', [otherRepoWorkspace])).toBe('repo Alpha');
  });
});

describe('renameWorkspaceInCachedWorkspaces', () => {
  it('updates the renamed workspace without changing unrelated rows', () => {
    const first = workspace('workspace-1', 'Old name');
    const second = workspace('workspace-2', 'Other');

    expect(renameWorkspaceInCachedWorkspaces([first, second], 'workspace-1', 'New name')).toEqual([
      { ...first, name: 'New name' },
      second,
    ]);
  });

  it('keeps the requested name even when the server returns a stale workspace name', () => {
    const existing = workspace('workspace-1', 'Old name');
    const staleServerWorkspace = workspace('workspace-1', 'Old name');

    expect(
      renameWorkspaceInCachedWorkspaces([existing], 'workspace-1', 'New name', staleServerWorkspace)
    ).toEqual([{ ...staleServerWorkspace, name: 'New name' }]);
  });
});
