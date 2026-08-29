// @vitest-environment jsdom
import '../test/setup';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import { createQueryWrapper } from '../test/queryTestUtils';
import { api } from '../lib/api';
import { agentClient } from '../lib/agentClient';
import { useUpdateTags } from './useMessages';

vi.mock('../lib/api', () => ({
  API_URL: 'http://localhost:3000',
  api: {
    post: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    hasRuntime: vi.fn(() => true),
    upsertLocalNode: vi.fn(async () => undefined),
    listLocalNodes: vi.fn(async () => []),
    hydrateLocalNodesFromServer: vi.fn(async () => 0),
  },
}));

vi.mock('../lib/graphInteractionGate', () => ({
  scheduleMessagesRefreshWhenGraphIdle: vi.fn(),
}));

vi.mock('../lib/perfRecorder', () => ({
  getElapsedSinceAppStartMs: vi.fn(() => 0),
  recordPerfEvent: vi.fn(),
}));

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  workspaceId: 'workspace-1',
  role: 'assistant',
  content: 'Done',
  parentId: 'user-1',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  tags: [],
  ...overrides,
});

describe('useUpdateTags', () => {
  it('updates local cache without waiting for server tag sync in local runtime', async () => {
    vi.mocked(agentClient.hasRuntime).mockReturnValue(true);
    vi.mocked(api.post).mockReturnValue(new Promise(() => undefined) as any);
    const { Wrapper, queryClient } = createQueryWrapper();
    queryClient.setQueryData<Message[]>(['messages', 'workspace-1'], [message()]);

    const { result } = renderHook(() => useUpdateTags(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId: 'workspace-1',
        messageId: 'message-1',
        tags: ['important'],
        action: 'add',
      });
    });

    expect(api.post).toHaveBeenCalledWith('/messages/message-1/tags', { tags: ['important'] });
    expect(queryClient.getQueryData<Message[]>(['messages', 'workspace-1'])?.[0].tags).toEqual(['important']);
    expect(agentClient.upsertLocalNode).toHaveBeenCalledWith(
      'workspace-1',
      'message-1',
      expect.objectContaining({ tags: ['important'] })
    );
  });
});
