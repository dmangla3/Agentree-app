import { beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({ desktop: false }));
const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
const agentClientMock = vi.hoisted(() => ({
  listThreadSessions: vi.fn(),
  localFirstCreateThreadSession: vi.fn(),
  localFirstDeleteThreadSession: vi.fn(),
}));

vi.mock('../hooks/useTauriWorkspace', () => ({
  isTauriEnvironment: () => environment.desktop,
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/agentClient', () => ({ agentClient: agentClientMock }));

import { threadApplication } from './threads';

const thread = {
  id: 'thread-1',
  workspaceId: 'workspace-1',
  title: 'Local thread',
  status: 'active',
  createdAt: '2026-07-22T00:00:00Z',
  updatedAt: '2026-07-22T00:00:00Z',
  baseCommitSha: null,
  firstMessageId: null,
  parentThreadId: null,
  anchorNodeId: null,
  source: 'user',
};

describe('thread application boundary', () => {
  beforeEach(() => {
    environment.desktop = false;
    vi.clearAllMocks();
  });

  it('uses transactional local commands for desktop create and delete', async () => {
    environment.desktop = true;
    agentClientMock.localFirstCreateThreadSession.mockResolvedValue(thread);

    await threadApplication.create(thread);
    await threadApplication.update(thread);
    await threadApplication.remove('workspace-1', 'thread-1');

    expect(agentClientMock.localFirstCreateThreadSession).toHaveBeenCalledTimes(2);
    expect(agentClientMock.localFirstCreateThreadSession).toHaveBeenLastCalledWith(thread);
    expect(agentClientMock.localFirstDeleteThreadSession)
      .toHaveBeenCalledWith('workspace-1', 'thread-1');
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.patch).not.toHaveBeenCalled();
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it('keeps browser operations on the explicit HTTP adapter', async () => {
    apiMock.post.mockResolvedValue({ data: thread });
    apiMock.patch.mockResolvedValue({ data: thread });
    apiMock.delete.mockResolvedValue({ status: 204 });

    await threadApplication.create(thread);
    await threadApplication.update(thread);
    await threadApplication.remove('workspace-1', 'thread-1');

    expect(apiMock.post).toHaveBeenCalledWith('/workspaces/workspace-1/threads', thread);
    expect(apiMock.patch).toHaveBeenCalledWith(
      '/workspaces/workspace-1/threads/thread-1',
      thread,
    );
    expect(apiMock.delete).toHaveBeenCalledWith('/workspaces/workspace-1/threads/thread-1');
  });
});
