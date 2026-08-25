// @vitest-environment jsdom
import '../test/setup';
import { invoke } from '@tauri-apps/api/core';
import type { Node } from '@xyflow/react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGraphSnapshot } from '../hooks/useGraphSnapshot';
import { useMessages, useSendMessage, useUpdateTags } from '../hooks/useMessages';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { API_URL } from '../lib/api';
import { agentClient } from '../lib/agentClient';
import { withExplicitReactFlowNodesDimensions } from '../lib/reactFlowNodeDimensions';
import { server } from './node';
import { createQueryWrapper } from '../test/queryTestUtils';
import { messages, sendResponse, workspaceId } from './scenarios/frontendContracts';

const authStoreMock = vi.hoisted(() => ({
  state: {
    user: {
      id: 'contract-user',
      email: 'contract@example.com',
      name: 'Contract User',
    },
    desktopSession: null,
    authErrorReason: null,
  },
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: (state: typeof authStoreMock.state) => unknown) =>
      selector ? selector(authStoreMock.state) : authStoreMock.state,
    {
      getState: () => authStoreMock.state,
      setState: (next: Partial<typeof authStoreMock.state>) => {
        authStoreMock.state = { ...authStoreMock.state, ...next };
      },
    }
  ),
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    hasRuntime: vi.fn(() => false),
    listLocalDeletedWorkspaceIds: vi.fn(async () => ['workspace-deleted-local']),
    processLocalSyncEvents: vi.fn(async () => undefined),
    hydrateLocalNodesFromServer: vi.fn(async () => undefined),
    listLocalNodes: vi.fn(async () => []),
    upsertLocalNode: vi.fn(async () => undefined),
  },
}));

describe('MSW frontend API contracts', () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.mocked(agentClient.hasRuntime).mockReturnValue(false);
    vi.mocked(agentClient.listLocalNodes).mockResolvedValue([]);
    vi.mocked(agentClient.hydrateLocalNodesFromServer).mockResolvedValue(0);
    vi.mocked(agentClient.upsertLocalNode).mockResolvedValue(undefined);
  });

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

  it('seeds the graph snapshot query cache from the native cache', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      version: 2,
      workspaceId,
      generatedAt: '2026-05-19T09:59:00.000Z',
      messages,
      summaries: [],
      commits: [],
      commitParents: [],
      commitObservations: [],
    }));
    const { Wrapper, queryClient } = createQueryWrapper();

    const { result } = renderHook(() => useGraphSnapshot(workspaceId), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<any>(['graph-snapshot', workspaceId])?.messages.map((message: any) => message.id)).toEqual(
      messages.map((message) => message.id),
    );
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

  it('hydrates Tauri local messages from the server when local nodes are missing', async () => {
    vi.mocked(agentClient.hasRuntime).mockReturnValue(true);
    vi.mocked(agentClient.listLocalNodes).mockResolvedValue([]);

    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(() => useMessages(workspaceId), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((message) => message.id)).toEqual(messages.map((message) => message.id));
    expect(agentClient.hydrateLocalNodesFromServer).toHaveBeenCalledWith(workspaceId, messages);
  });

  it('persists the server-updated tag payload into the local runtime cache', async () => {
    vi.mocked(agentClient.hasRuntime).mockReturnValue(true);
    server.use(
      http.post(`${API_URL}/messages/:messageId/tags`, async () => HttpResponse.json({
        ...messages[1],
        content: 'full assistant response from server',
        tags: ['server-tag'],
        updatedAt: '2026-05-19T10:10:00.000Z',
      }))
    );
    const { Wrapper, queryClient } = createQueryWrapper();
    queryClient.setQueryData(['messages', workspaceId], [
      messages[0],
      {
        ...messages[1],
        content: 'full assistant response from cache',
        tags: [],
      },
    ]);

    const { result } = renderHook(() => useUpdateTags(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId,
        messageId: messages[1].id,
        tags: ['draft-tag'],
        action: 'add',
      });
    });

    const cachedMessages = queryClient.getQueryData<typeof messages>(['messages', workspaceId]) ?? [];
    expect(cachedMessages[1]).toMatchObject({
      id: messages[1].id,
      content: 'full assistant response from server',
      tags: ['server-tag'],
    });
    expect(agentClient.upsertLocalNode).toHaveBeenCalledWith(
      workspaceId,
      messages[1].id,
      expect.objectContaining({
        id: messages[1].id,
        content: 'full assistant response from server',
        tags: ['server-tag'],
      })
    );
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

  it('sends selected model using llmModel instead of legacy agentModel', async () => {
    let requestBody: any = null;
    server.use(
      http.post(`${API_URL}/workspaces/:workspaceId/messages`, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json(sendResponse, { status: 201 });
      })
    );
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSendMessage(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId,
        prompt: 'Use the selected model',
        llmModel: 'openai/gpt-5.5-high',
      });
    });

    expect(requestBody).toMatchObject({ llmModel: 'openai/gpt-5.5-high' });
    expect(requestBody).not.toHaveProperty('agentModel');
  });
});
