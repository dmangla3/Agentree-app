// @vitest-environment jsdom
import '../test/setup';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageHighlightAnnotation, MessageHighlightRange } from '../stores/workspaceStore';
import { createQueryWrapper } from '../test/queryTestUtils';
import { agentClient } from '../lib/agentClient';
import { messageApplication } from '../application/messages';
import { localNodeKeys, type LocalNodeMessage } from './useLocalNodes';
import { getMessageHighlights } from '../lib/messageHighlights';
import { useAddHighlight, useDeleteHighlight } from './useMessages';

vi.mock('../lib/api', () => ({
  AGENTREE_DATA_PLANE_ENABLED: false,
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
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

vi.mock('../application/messages', () => ({
  messageApplication: {
    updateHighlight: vi.fn(),
  },
}));

const range: MessageHighlightRange = {
  start: 0,
  end: 5,
  exact: 'hello',
  textHash: 'hash',
};

const highlight = (overrides: Partial<MessageHighlightAnnotation> = {}): MessageHighlightAnnotation => ({
  type: 'highlight',
  id: 'highlight-1',
  color: 'yellow',
  range,
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'message-1',
  workspaceId: 'workspace-1',
  role: 'assistant',
  content: 'hello world',
  parentId: 'user-1',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  annotations: [],
  ...overrides,
});

const localNode = (messageValue: Message): LocalNodeMessage => ({
  nodeId: messageValue.id,
  workspaceId: messageValue.workspaceId,
  syncStatus: 'persisted',
  finalizedAt: 1,
  retryAttempt: 0,
  message: messageValue,
});

describe('message highlight mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentClient.hasRuntime).mockReturnValue(true);
  });

  it('optimistically adds highlights to message and local-node caches', async () => {
    let resolveUpdate!: (value: Message) => void;
    const updatePromise = new Promise<Message>((resolve) => {
      resolveUpdate = resolve;
    });
    vi.mocked(messageApplication.updateHighlight).mockReturnValue(updatePromise);

    const { Wrapper, queryClient } = createQueryWrapper();
    const baseMessage = message();
    queryClient.setQueryData<Message[]>(['messages', 'workspace-1'], [baseMessage]);
    queryClient.setQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'), [localNode(baseMessage)]);

    const { result } = renderHook(() => useAddHighlight(), { wrapper: Wrapper });
    let mutationPromise!: Promise<unknown>;
    await act(async () => {
      mutationPromise = result.current.mutateAsync({
        workspaceId: 'workspace-1',
        messageId: 'message-1',
        color: 'yellow',
        range,
        highlight: highlight(),
      });
    });

    await waitFor(() => {
      expect(getMessageHighlights(queryClient.getQueryData<Message[]>(['messages', 'workspace-1'])?.[0]).map((item) => item.id))
        .toEqual(['highlight-1']);
    });
    expect(getMessageHighlights(
      queryClient.getQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'))?.[0].message
    ).map((item) => item.id)).toEqual(['highlight-1']);

    await act(async () => {
      resolveUpdate(message({ annotations: [highlight({ updatedAt: '2026-07-22T00:00:01.000Z' })] }));
      await mutationPromise;
    });
  });

  it('rolls back only the failed optimistic highlight and preserves concurrent cache updates', async () => {
    let rejectUpdate!: (error: Error) => void;
    const updatePromise = new Promise<Message>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    vi.mocked(messageApplication.updateHighlight).mockReturnValue(updatePromise);

    const { Wrapper, queryClient } = createQueryWrapper();
    const baseMessage = message();
    queryClient.setQueryData<Message[]>(['messages', 'workspace-1'], [baseMessage]);
    queryClient.setQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'), [localNode(baseMessage)]);

    const { result } = renderHook(() => useAddHighlight(), { wrapper: Wrapper });
    let mutationPromise!: Promise<unknown>;
    await act(async () => {
      mutationPromise = result.current.mutateAsync({
        workspaceId: 'workspace-1',
        messageId: 'message-1',
        color: 'yellow',
        range,
        highlight: highlight(),
      });
    });

    await waitFor(() => {
      expect(getMessageHighlights(queryClient.getQueryData<Message[]>(['messages', 'workspace-1'])?.[0]))
        .toHaveLength(1);
    });

    const concurrentHighlight = highlight({
      id: 'highlight-2',
      color: 'blue',
      range: {
        start: 6,
        end: 11,
        exact: 'world',
        textHash: 'hash',
      },
    });
    queryClient.setQueryData<Message[]>(['messages', 'workspace-1'], (current) => (
      current?.map((item) => item.id === 'message-1'
        ? { ...item, annotations: [...(item.annotations ?? []), concurrentHighlight] }
        : item)
    ));
    queryClient.setQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'), (current) => (
      current?.map((row) => row.nodeId === 'message-1'
        ? {
            ...row,
            message: {
              ...row.message,
              annotations: [...(row.message.annotations ?? []), concurrentHighlight],
            },
          }
        : row)
    ));

    await act(async () => {
      rejectUpdate(new Error('highlight write failed'));
      await expect(mutationPromise).rejects.toThrow('highlight write failed');
    });

    expect(getMessageHighlights(
      queryClient.getQueryData<Message[]>(['messages', 'workspace-1'])?.[0]
    ).map((item) => item.id)).toEqual(['highlight-2']);
    expect(getMessageHighlights(
      queryClient.getQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'))?.[0].message
    ).map((item) => item.id)).toEqual(['highlight-2']);
  });

  it('optimistically removes highlights from message and local-node caches', async () => {
    let resolveUpdate!: (value: Message) => void;
    const updatePromise = new Promise<Message>((resolve) => {
      resolveUpdate = resolve;
    });
    vi.mocked(messageApplication.updateHighlight).mockReturnValue(updatePromise);

    const { Wrapper, queryClient } = createQueryWrapper();
    const baseMessage = message({ annotations: [highlight()] });
    queryClient.setQueryData<Message[]>(['messages', 'workspace-1'], [baseMessage]);
    queryClient.setQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'), [localNode(baseMessage)]);

    const { result } = renderHook(() => useDeleteHighlight(), { wrapper: Wrapper });
    let mutationPromise!: Promise<unknown>;
    await act(async () => {
      mutationPromise = result.current.mutateAsync({
        workspaceId: 'workspace-1',
        messageId: 'message-1',
        highlightId: 'highlight-1',
      });
    });

    await waitFor(() => {
      expect(getMessageHighlights(queryClient.getQueryData<Message[]>(['messages', 'workspace-1'])?.[0]))
        .toEqual([]);
    });
    expect(getMessageHighlights(
      queryClient.getQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'))?.[0].message
    )).toEqual([]);

    await act(async () => {
      resolveUpdate(message({ annotations: [] }));
      await mutationPromise;
    });
  });
});
