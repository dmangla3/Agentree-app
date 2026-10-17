import { beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({ desktop: false }));
const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
const agentClientMock = vi.hoisted(() => ({
  listLocalWorkspaces: vi.fn(),
  mergeServerWorkspaces: vi.fn(),
  listLocalDeletedWorkspaceIds: vi.fn(),
  localFirstRenameWorkspace: vi.fn(),
  localFirstDeleteWorkspace: vi.fn(),
}));

vi.mock('../hooks/useTauriWorkspace', () => ({
  isTauriEnvironment: () => environment.desktop,
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/agentClient', () => ({ agentClient: agentClientMock }));

import { workspaceApplication } from './workspaces';

const localWorkspace = {
  id: 'workspace-1',
  name: 'Local workspace',
  userId: 'local-user',
  localRepoPath: '/repo',
  connectionStatus: 'connected',
  syncStatus: 'local_only',
  cloudBackupEnabled: false,
  cloudAccountId: null,
  baseCommitSha: 'abc123',
  createdAt: '2026-07-22T00:00:00Z',
  updatedAt: '2026-07-22T00:00:00Z',
};

describe('workspace application boundary', () => {
  beforeEach(() => {
    environment.desktop = false;
    vi.clearAllMocks();
    agentClientMock.listLocalDeletedWorkspaceIds.mockResolvedValue([]);
  });

  it('filters local deletion tombstones from the browser adapter', async () => {
    apiMock.get.mockResolvedValue({
      data: [
        { id: 'workspace-1', name: 'Visible' },
        { id: 'workspace-deleted', name: 'Deleted locally' },
      ],
    });
    agentClientMock.listLocalDeletedWorkspaceIds.mockResolvedValue(['workspace-deleted']);

    const workspaces = await workspaceApplication.list({
      cloudAccountId: 'cloud-user',
      cloudConnected: true,
    });

    expect(workspaces.map((workspace) => workspace.id)).toEqual(['workspace-1']);
  });

  it('uses the server adapter for browser deletion', async () => {
    apiMock.delete.mockResolvedValue({ status: 204 });

    await workspaceApplication.remove('workspace-1');

    expect(apiMock.delete).toHaveBeenCalledWith('/workspaces/workspace-1');
    expect(agentClientMock.localFirstDeleteWorkspace).not.toHaveBeenCalled();
  });

  it('uses the local domain command for desktop rename', async () => {
    environment.desktop = true;
    agentClientMock.localFirstRenameWorkspace.mockResolvedValue(localWorkspace);

    const renamed = await workspaceApplication.rename('workspace-1', 'Local workspace');

    expect(renamed).toMatchObject({
      id: 'workspace-1',
      name: 'Local workspace',
      git_repo_path: '/repo',
    });
    expect(agentClientMock.localFirstRenameWorkspace)
      .toHaveBeenCalledWith('workspace-1', 'Local workspace');
    expect(apiMock.patch).not.toHaveBeenCalled();
  });
});
