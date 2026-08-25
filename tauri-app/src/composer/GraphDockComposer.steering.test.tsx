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
  stopAgent: vi.fn(),
  startAgentRun: vi.fn(),
  upsertLocalNode: vi.fn(),
  createThreadSession: vi.fn(),
  listInstalledSkills: vi.fn(),
  setSelectedFlowId: vi.fn(),
  runFlow: vi.fn(),
  flows: [] as Array<{ id: string; label: string; definition: unknown }>,
  selectedFlowId: '',
  scheduleRefresh: vi.fn(),
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    steerAgentRun: hookMocks.steerAgentRun,
    stopAgent: hookMocks.stopAgent,
    hasRuntime: vi.fn(() => true),
    startAgentRun: hookMocks.startAgentRun,
    upsertLocalNode: hookMocks.upsertLocalNode,
    listInstalledSkills: hookMocks.listInstalledSkills,
    listLocalRefs: vi.fn(async () => []),
    listAllCommits: vi.fn(async () => []),
  },
}));

vi.mock('../lib/graphInteractionGate', () => ({
  scheduleMessagesRefreshWhenGraphIdle: hookMocks.scheduleRefresh,
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
      git_repo_path: '/repo',
      base_commit_sha: 'workspace-base',
      createdAt: '2026-05-27T00:00:00.000Z',
      updatedAt: '2026-05-27T00:00:00.000Z',
    } satisfies Workspace],
  }),
}));

vi.mock('../hooks/useMessages', () => ({
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
    flows: hookMocks.flows,
    selectedFlowId: hookMocks.selectedFlowId,
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
    hookMocks.stopAgent.mockReset();
    hookMocks.stopAgent.mockResolvedValue(undefined);
    hookMocks.startAgentRun.mockReset();
    hookMocks.startAgentRun.mockResolvedValue(undefined);
    hookMocks.upsertLocalNode.mockReset();
    hookMocks.upsertLocalNode.mockResolvedValue(undefined);
    hookMocks.listInstalledSkills.mockReset();
    hookMocks.listInstalledSkills.mockResolvedValue([]);
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
    hookMocks.flows = [];
    hookMocks.selectedFlowId = '';
    hookMocks.scheduleRefresh.mockReset();
    hookMocks.scheduleRefresh.mockResolvedValue(undefined);
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

    const composer = screen.getByLabelText('Graph composer prompt') as HTMLTextAreaElement;

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

    const composer = screen.getByLabelText('Graph composer prompt');
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
    expect((composer as HTMLTextAreaElement).value).toBe('');
  });

  it('shows a cancel button for live-running assistant targets', async () => {
    const user = userEvent.setup();
    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Running assistant',
        parentId: 'user-parent',
        status: 'running' as any,
        agent_id: 'codex:test',
        execution_data: { current_run_id: 'run-1' },
      }),
    ]);

    useRunStatusStore.getState().setRunStatus('assistant-live', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running' as any,
      progress: 'Running',
    });

    await user.click(await screen.findByRole('button', { name: 'Cancel running agent' }));

    expect(hookMocks.stopAgent).toHaveBeenCalledWith('assistant-live');
    await waitFor(() => {
      expect(useRunStatusStore.getState().byNodeId['assistant-live']?.status).toBe('cancelled');
    });
    expect(hookMocks.scheduleRefresh).toHaveBeenCalledWith(
      expect.anything(),
      'workspace-1',
      { reason: 'cancel-agent' }
    );
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

    const composer = screen.getByLabelText('Graph composer prompt');
    await user.type(composer, 'Send from keyboard');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(hookMocks.upsertLocalNode).toHaveBeenCalledTimes(2);
      expect(hookMocks.startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
        repoPath: '/repo',
        parentCommit: 'parent-output',
      }));
    });
    const userMessage = hookMocks.upsertLocalNode.mock.calls[0][2] as Message;
    expect(userMessage.content).toBe('Send from keyboard');
    expect(userMessage.parentId).toBe('assistant-live');
  });

  it('does not hold the graph dock send button while a selected flow is running', async () => {
    const user = userEvent.setup();
    let finishFlow = () => {};
    hookMocks.flows = [{ id: 'parallel-review', label: 'Parallel Review', definition: {} }];
    hookMocks.selectedFlowId = 'parallel-review';
    hookMocks.runFlow.mockReturnValue(new Promise<void>((resolve) => {
      finishFlow = resolve;
    }));

    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Previous assistant reply',
        status: 'completed' as any,
        output_commit_sha: 'parent-output',
      }),
    ]);

    const composer = screen.getByLabelText('Graph composer prompt') as HTMLTextAreaElement;
    const sendButton = screen.getByTestId('graph-dock-send-button') as HTMLButtonElement;

    await user.type(composer, 'Run the review flow');
    expect(sendButton.disabled).toBe(false);
    await user.click(sendButton);

    await waitFor(() => {
      expect(hookMocks.runFlow).toHaveBeenCalledWith({ input: 'Run the review flow', count: 3 });
    });
    expect(composer.value).toBe('');

    await user.type(composer, 'Run another flow');
    expect(sendButton.disabled).toBe(false);

    finishFlow?.();
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

    const composer = screen.getByLabelText('Graph composer prompt') as HTMLTextAreaElement;
    await user.type(composer, 'Line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(composer, 'Line two');

    expect(hookMocks.startAgentRun).not.toHaveBeenCalled();
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

    const composer = screen.getByLabelText('Graph composer prompt');
    await user.type(composer, 'Start a separate approach');
    await user.click(screen.getByRole('button', { name: 'Send graph composer message' }));

    await waitFor(() => {
      expect(hookMocks.upsertLocalNode).toHaveBeenCalledTimes(2);
    });
    const userMessage = hookMocks.upsertLocalNode.mock.calls[0][2] as Message;
    const assistantMessage = hookMocks.upsertLocalNode.mock.calls[1][2] as Message;
    expect(userMessage.parentId).toBeNull();
    expect(userMessage.threadId).toBe('pending-thread');
    expect(userMessage.execution_data?.meta?.context_policy).toBe('fresh');
    expect(userMessage.execution_data?.meta?.thread_origin_id).toBe('pending-thread');
    expect(assistantMessage.threadId).toBe('pending-thread');
  });

  it('returns the graph dock composer to reply mode after sending a new thread message', async () => {
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

    act(() => {
      useWorkspaceStore.getState().setThreadComposerTarget({
        workspaceId: 'workspace-1',
        threadId: 'pending-thread',
        reason: 'create-thread',
        nonce: 1,
      });
    });

    expect(await screen.findByText('New thread')).toBeTruthy();

    const composer = screen.getByLabelText('Graph composer prompt');
    await user.type(composer, 'Start a separate approach');
    await user.click(screen.getByRole('button', { name: 'Send graph composer message' }));

    await waitFor(() => {
      expect(hookMocks.upsertLocalNode).toHaveBeenCalledTimes(2);
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

    const composer = await screen.findByLabelText('Graph composer prompt');
    expect((composer as HTMLTextAreaElement).value).toBe('Original prompt to revise');
    expect(screen.getByText('Editing')).toBeTruthy();

    await user.clear(composer);
    await user.type(composer, 'Revised graph prompt');
    await user.click(screen.getByRole('button', { name: 'Send graph composer message' }));

    await waitFor(() => {
      expect(hookMocks.upsertLocalNode).toHaveBeenCalledTimes(2);
    });
    const userMessage = hookMocks.upsertLocalNode.mock.calls[0][2] as Message;
    expect(userMessage.parentId).toBe('assistant-parent');
    expect(userMessage.content).toBe('Revised graph prompt');
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
