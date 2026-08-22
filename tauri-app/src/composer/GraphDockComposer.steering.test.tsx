// @vitest-environment jsdom
import '../test/setup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphDockComposer } from './GraphDockComposer';
import { useRunStatusStore } from '../stores/runStatusStore';
import { type Message, useWorkspaceStore, type Workspace } from '../stores/workspaceStore';
import { agentClient } from '../lib/agentClient';
import { TooltipProvider } from '../../@/components/ui/tooltip';

const hookMocks = vi.hoisted(() => ({
  steerAgentRun: vi.fn(),
  sendMessage: vi.fn(),
  createThreadSession: vi.fn(),
  setSelectedFlowId: vi.fn(),
  runFlow: vi.fn(),
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    steerAgentRun: hookMocks.steerAgentRun,
    hasRuntime: vi.fn(() => false),
    upsertLocalNode: vi.fn(async () => undefined),
    listLocalRefs: vi.fn(async () => []),
    listAllCommits: vi.fn(async () => []),
  },
}));

vi.mock('../hooks/useAgents', () => ({
  useAgents: () => ({
    data: [{
      id: 'codex:test',
      name: 'Codex Test',
      type: 'codex',
      model_config: { model: 'gpt-test' },
      cliArgs: '',
      promptFlag: null,
    }],
  }),
}));

vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    data: [{
      id: 'workspace-1',
      name: 'Workspace',
      userId: 'user-1',
      base_commit_sha: 'workspace-base',
      createdAt: '2026-05-27T00:00:00.000Z',
      updatedAt: '2026-05-27T00:00:00.000Z',
    } satisfies Workspace],
  }),
}));

vi.mock('../hooks/useMessages', () => ({
  useSendMessage: () => ({
    isPending: false,
    mutateAsync: hookMocks.sendMessage,
  }),
  useCommitAncestors: () => ({ data: { commits: [] } }),
  useCommitDescendants: () => ({ data: { commits: [] } }),
}));

vi.mock('../hooks/useThreadSessions', () => ({
  useCreateThreadSession: () => ({
    mutateAsync: hookMocks.createThreadSession,
  }),
}));

vi.mock('../hooks/useAgentFlowRunner', () => ({
  useAgentFlowRunner: () => ({
    flows: [],
    selectedFlowId: '',
    setSelectedFlowId: hookMocks.setSelectedFlowId,
    runFlow: hookMocks.runFlow,
  }),
}));

vi.mock('../hooks/useGitRefSnapshot', () => ({
  getEnabledTrackedGitRefs: vi.fn(() => []),
  useGitRefSnapshot: () => ({ data: null }),
}));

vi.mock('../hooks/useTrackedRefs', () => ({
  useTrackedRefs: () => ({ data: [] }),
}));

vi.mock('../components/UnifiedAgentModelSelector', () => ({
  UnifiedAgentModelSelector: () => <div data-testid="model-selector" />,
}));

const message = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: input.content ?? '',
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  llmProvider: input.llmProvider ?? null,
  llmModel: input.llmModel ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  execution_data: input.execution_data ?? null,
  createdAt: input.createdAt ?? '2026-05-27T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-27T00:00:00.000Z',
});

const renderComposer = (messages: Message[]) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(['messages', 'workspace-1'], messages);

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <GraphDockComposer />
      </TooltipProvider>
    </QueryClientProvider>
  );
};

describe('GraphDockComposer steering behavior', () => {
  beforeEach(() => {
    hookMocks.steerAgentRun.mockReset();
    hookMocks.steerAgentRun.mockResolvedValue(undefined);
    hookMocks.sendMessage.mockReset();
    hookMocks.createThreadSession.mockReset();
    hookMocks.createThreadSession.mockResolvedValue({
      id: 'created-thread',
      workspaceId: 'workspace-1',
      title: null,
      status: 'active',
      createdAt: '2026-05-27T00:00:00.000Z',
      updatedAt: '2026-05-27T00:00:00.000Z',
      baseCommitSha: null,
      firstMessageId: null,
      source: 'user',
    });
    hookMocks.setSelectedFlowId.mockReset();
    hookMocks.runFlow.mockReset();
    useRunStatusStore.getState().clearAllRunStatus();
    useWorkspaceStore.setState({
      selectedWorkspaceId: 'workspace-1',
      focusedMessageId: 'assistant-live',
      lastFocusSource: 'graph',
      lastFocusMetadata: null,
      selectedAgentId: null,
      composerDraftByWorkspace: {},
      composerBaseCommitOverride: null,
      composerContextPreview: null,
      threadComposerTarget: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useRunStatusStore.getState().clearAllRunStatus();
    useWorkspaceStore.getState().clearSelectedWorkspace();
  });

  it('debounces workspace draft writes while keeping textarea input immediate', async () => {
    vi.useFakeTimers();
    renderComposer([]);

    const composer = screen.getByPlaceholderText('Ask anything...') as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: 'Local draft' } });

    expect(composer.value).toBe('Local draft');
    expect(useWorkspaceStore.getState().composerDraftByWorkspace['workspace-1']).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(useWorkspaceStore.getState().composerDraftByWorkspace['workspace-1']).toBe('Local draft');
  });

  it('routes live-running assistant submissions through steering even when persisted status is stale', async () => {
    const user = userEvent.setup();
    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Running assistant',
        status: 'completed' as any,
      }),
    ]);

    useRunStatusStore.getState().setRunStatus('assistant-live', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running' as any,
      progress: 'Running',
    });

    const sendButton = await screen.findByRole('button', { name: 'Steer running agent' });
    expect((screen.getByRole('button', { name: 'Select model' }) as HTMLButtonElement).disabled).toBe(true);
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);

    const composer = screen.getByPlaceholderText('Ask anything...');
    await user.type(composer, 'Focus on the failing tests');

    expect((sendButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(sendButton);

    await waitFor(() => {
      expect(agentClient.steerAgentRun).toHaveBeenCalledWith(
        'assistant-live',
        'Focus on the failing tests',
        expect.any(String)
      );
    });
    expect(hookMocks.sendMessage).not.toHaveBeenCalled();
    expect((composer as HTMLTextAreaElement).value).toBe('');
  });

  it('sends the graph dock composer message on Enter', async () => {
    const user = userEvent.setup();
    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Previous assistant reply',
        status: 'completed' as any,
        output_commit_sha: 'parent-output',
      }),
    ]);

    const composer = screen.getByPlaceholderText('Ask anything...');
    await user.type(composer, 'Send from keyboard');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(hookMocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        prompt: 'Send from keyboard',
      }));
    });
  });

  it('keeps Shift+Enter as a newline in the graph dock composer', async () => {
    const user = userEvent.setup();
    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Previous assistant reply',
        status: 'completed' as any,
        output_commit_sha: 'parent-output',
      }),
    ]);

    const composer = screen.getByPlaceholderText('Ask anything...') as HTMLTextAreaElement;
    await user.type(composer, 'Line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(composer, 'Line two');

    expect(hookMocks.sendMessage).not.toHaveBeenCalled();
    expect(composer.value).toBe('Line one\nLine two');
  });

  it('switches the graph dock composer to a fresh root target when the graph selects a thread target', async () => {
    const user = userEvent.setup();
    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Running assistant',
        status: 'completed' as any,
        output_commit_sha: 'parent-output',
      }),
    ]);

    act(() => {
      useWorkspaceStore.getState().setThreadComposerTarget({
        workspaceId: 'workspace-1',
        threadId: 'pending-thread',
        reason: 'create-thread',
        nonce: 1,
      });
    });

    expect(await screen.findByText('New thread')).toBeTruthy();
    expect(screen.getByText('Thread root')).toBeTruthy();

    const composer = screen.getByPlaceholderText('Ask anything...');
    await user.type(composer, 'Start a separate approach');
    await user.click(screen.getByRole('button', { name: 'Send graph composer message' }));

    await waitFor(() => {
      expect(hookMocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        parentId: null,
        contextPolicy: 'fresh',
        threadId: 'pending-thread',
        threadOriginId: 'pending-thread',
      }));
    });
  });

  it('returns the graph dock composer to reply mode after sending a new thread message', async () => {
    const user = userEvent.setup();
    hookMocks.sendMessage.mockResolvedValue({
      userMessage: message({ id: 'user-root', role: 'user', parentId: null }),
      assistantMessages: [message({ id: 'assistant-root', role: 'assistant', parentId: 'user-root' })],
    });
    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Previous assistant reply',
        status: 'completed' as any,
        output_commit_sha: 'parent-output',
      }),
    ]);

    act(() => {
      useWorkspaceStore.getState().setThreadComposerTarget({
        workspaceId: 'workspace-1',
        threadId: 'pending-thread',
        reason: 'create-thread',
        nonce: 1,
      });
    });

    expect(await screen.findByText('New thread')).toBeTruthy();

    const composer = screen.getByPlaceholderText('Ask anything...');
    await user.type(composer, 'Start a separate approach');
    await user.click(screen.getByRole('button', { name: 'Send graph composer message' }));

    await waitFor(() => {
      expect(hookMocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'pending-thread',
      }));
    });
    await waitFor(() => {
      expect(screen.getByText('Reply to')).toBeTruthy();
      expect(screen.queryByText('New thread')).toBeNull();
    });
  });

  it('loads edited user messages into the graph composer and sends from the original parent', async () => {
    const user = userEvent.setup();
    renderComposer([
      message({
        id: 'assistant-parent',
        role: 'assistant',
        content: 'Prior assistant reply',
        output_commit_sha: 'parent-output',
      }),
      message({
        id: 'user-original',
        role: 'user',
        parentId: 'assistant-parent',
        content: 'Original prompt to revise',
      }),
      message({
        id: 'assistant-current',
        role: 'assistant',
        parentId: 'user-original',
        content: 'Current branch focus',
      }),
    ]);

    act(() => {
      window.dispatchEvent(new CustomEvent('editUserMessage', {
        detail: { message: message({
          id: 'user-original',
          role: 'user',
          parentId: 'assistant-parent',
          content: 'Original prompt to revise',
        }) },
      }));
    });

    const composer = await screen.findByPlaceholderText('Ask anything...');
    expect((composer as HTMLTextAreaElement).value).toBe('Original prompt to revise');
    expect(screen.getByText('Editing')).toBeTruthy();

    await user.clear(composer);
    await user.type(composer, 'Revised graph prompt');
    await user.click(screen.getByRole('button', { name: 'Send graph composer message' }));

    await waitFor(() => {
      expect(hookMocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        parentId: 'assistant-parent',
        prompt: 'Revised graph prompt',
      }));
    });
  });

  it('keeps the fresh root target when thread creation also clears graph focus', async () => {
    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Previous assistant reply',
        status: 'completed' as any,
        output_commit_sha: 'parent-output',
      }),
    ]);

    act(() => {
      useWorkspaceStore.getState().setThreadComposerTarget({
        workspaceId: 'workspace-1',
        threadId: 'pending-thread',
        reason: 'create-thread',
        nonce: 1,
      });
    });

    expect(await screen.findByText('New thread')).toBeTruthy();

    act(() => {
      useWorkspaceStore.getState().dispatchFocus({
        messageId: null,
        source: 'graph',
        metadata: { reason: 'create-thread', threadRootId: 'pending-thread' },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('New thread')).toBeTruthy();
      expect(screen.queryByText('Reply to')).toBeNull();
    });
  });
});
