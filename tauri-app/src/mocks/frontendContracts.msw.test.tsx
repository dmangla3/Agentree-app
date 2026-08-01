// @vitest-environment jsdom
import '../test/setup';
import type { Node } from '@xyflow/react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useGraphSnapshot } from '../hooks/useGraphSnapshot';
import { useMessages, useSendMessage } from '../hooks/useMessages';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { agentClient } from '../lib/agentClient';
import { withExplicitReactFlowNodesDimensions } from '../lib/reactFlowNodeDimensions';
import { createQueryWrapper } from '../test/queryTestUtils';
import { messages, sendResponse, workspaceId } from './scenarios/frontendContracts';

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    hasRuntime: vi.fn(() => false),
    listLocalDeletedWorkspaceIds: vi.fn(async () => ['workspace-deleted-local']),
    processLocalSyncEvents: vi.fn(async () => undefined),
    hydrateLocalNodesFromServer: vi.fn(async () => undefined),
    listLocalNodes: vi.fn(async () => []),
  },
}));

describe('MSW frontend API contracts', () => {
  it('loads workspaces through MSW and applies local deletion filtering', async () => {
    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(() => useWorkspaces(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((workspace) => workspace.id)).toEqual([workspaceId]);
    expect(agentClient.listLocalDeletedWorkspaceIds).toHaveBeenCalledOnce();
  });

  it('loads a graph snapshot through MSW', async () => {
    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(() => useGraphSnapshot(workspaceId), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.messages.map((message) => message.id)).toEqual([
      'msg-user-1',
      'msg-assistant-1',
    ]);
  });

  it('keeps MSW snapshot graph nodes drawable by the React Flow minimap before DOM measurement', async () => {
    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(() => useGraphSnapshot(workspaceId), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const styleOnlyDimensionNodes: Node<any>[] = result.current.data!.messages.map((message, index) => ({
      id: message.id,
      type: message.role === 'user' ? 'user_message' : 'assistant_message',
      position: { x: index * 240, y: index * 120 },
      data: { message },
      style: {
        width: 220,
        height: message.role === 'user' ? 100 : '130px',
      },
    }));

    expect(styleOnlyDimensionNodes.every((node) => node.width === undefined && node.height === undefined)).toBe(true);

    const minimapDrawableNodes = withExplicitReactFlowNodesDimensions(styleOnlyDimensionNodes);

    expect(minimapDrawableNodes.map((node) => [node.id, node.width, node.height])).toEqual([
      ['msg-user-1', 220, 100],
      ['msg-assistant-1', 220, 130],
    ]);
  });

  it('loads messages through the API when no local Tauri runtime is present', async () => {
    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(() => useMessages(workspaceId), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((message) => message.id)).toEqual(messages.map((message) => message.id));
  });

  it('updates the browser/API-backed message cache after a mocked send', async () => {
    const { Wrapper, queryClient } = createQueryWrapper();
    queryClient.setQueryData(['messages', workspaceId], messages);

    const { result } = renderHook(() => useSendMessage(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId,
        prompt: 'Does cache update after a mocked send?',
        parentId: 'msg-assistant-1',
      });
    });

    const cachedMessages = queryClient.getQueryData<typeof messages>(['messages', workspaceId]) ?? [];
    expect(cachedMessages.map((message) => message.id)).toEqual([
      ...messages.map((message) => message.id),
      sendResponse.userMessage.id,
      sendResponse.assistantMessages[0].id,
    ]);
  });
});
