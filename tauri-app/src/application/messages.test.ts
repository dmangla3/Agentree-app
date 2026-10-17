import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHighlightAnnotation } from '../stores/workspaceStore';

const environment = vi.hoisted(() => ({ desktop: false }));
const apiMock = vi.hoisted(() => ({
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
const agentClientMock = vi.hoisted(() => ({
  localFirstUpdateNodeTags: vi.fn(),
  localFirstUpdateNodeHighlight: vi.fn(),
  localFirstSetNodeCollapsed: vi.fn(),
}));

vi.mock('../hooks/useTauriWorkspace', () => ({
  isTauriEnvironment: () => environment.desktop,
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/agentClient', () => ({ agentClient: agentClientMock }));

import { messageApplication } from './messages';

const highlight: MessageHighlightAnnotation = {
  type: 'highlight',
  id: 'highlight-1',
  color: 'yellow',
  range: { start: 0, end: 5, exact: 'hello', textHash: 'hash' },
  createdAt: '2026-07-22T00:00:00Z',
  updatedAt: '2026-07-22T00:00:00Z',
};

describe('message application boundary', () => {
  beforeEach(() => {
    environment.desktop = false;
    vi.clearAllMocks();
  });

  it('uses the transactional local command for desktop highlights', async () => {
    environment.desktop = true;
    agentClientMock.localFirstUpdateNodeHighlight.mockResolvedValue({
      id: 'message-1',
      annotations: [highlight],
    });

    await messageApplication.updateHighlight({
      workspaceId: 'workspace-1',
      messageId: 'message-1',
      action: 'add',
      highlight,
    });

    expect(agentClientMock.localFirstUpdateNodeHighlight).toHaveBeenCalledWith(
      'workspace-1',
      'message-1',
      'add',
      highlight,
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('uses the explicit HTTP adapter for browser highlights', async () => {
    apiMock.patch.mockResolvedValue({ data: { id: 'message-1' } });

    await messageApplication.updateHighlight({
      workspaceId: 'workspace-1',
      messageId: 'message-1',
      action: 'update',
      highlightId: 'highlight/1',
      color: 'blue',
    });

    expect(apiMock.patch).toHaveBeenCalledWith(
      '/messages/message-1/highlights/highlight%2F1',
      { color: 'blue' },
    );
    expect(agentClientMock.localFirstUpdateNodeHighlight).not.toHaveBeenCalled();
  });

  it('sets desktop collapse state through the local command', async () => {
    environment.desktop = true;
    agentClientMock.localFirstSetNodeCollapsed.mockResolvedValue({
      id: 'message-1',
      collapsed: true,
    });

    await messageApplication.setCollapsed({
      workspaceId: 'workspace-1',
      messageId: 'message-1',
      collapsed: true,
    });

    expect(agentClientMock.localFirstSetNodeCollapsed)
      .toHaveBeenCalledWith('workspace-1', 'message-1', true);
    expect(apiMock.patch).not.toHaveBeenCalled();
  });
});
