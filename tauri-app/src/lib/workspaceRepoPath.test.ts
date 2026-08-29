import { describe, expect, it } from 'vitest';
import { resolveLocalWorkspaceRepoPath } from './workspaceRepoPath';
import type { Workspace } from '../stores/workspaceStore';

const workspace = (overrides: Partial<Workspace>): Workspace => ({
  id: 'workspace-1',
  name: 'Workspace',
  userId: 'user-1',
  createdAt: '1',
  updatedAt: '1',
  ...overrides,
});

describe('resolveLocalWorkspaceRepoPath', () => {
  it('returns the trusted local path for connected workspaces', () => {
    expect(resolveLocalWorkspaceRepoPath(workspace({
      connectionStatus: 'connected',
      localRepoPath: ' /repo ',
      git_repo_path: '/server/repo',
      folderPath: '/server/folder',
    }))).toBe('/repo');
  });

  it('does not fall back to server-era path fields', () => {
    expect(resolveLocalWorkspaceRepoPath(workspace({
      connectionStatus: 'connected',
      git_repo_path: '/server/repo',
      folderPath: '/server/folder',
    }))).toBeNull();
  });

  it('does not return paths for unconnected workspaces', () => {
    expect(resolveLocalWorkspaceRepoPath(workspace({
      connectionStatus: 'remote_unconnected',
      localRepoPath: '/repo',
    }))).toBeNull();
  });
});

