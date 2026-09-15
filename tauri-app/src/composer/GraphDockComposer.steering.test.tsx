// @vitest-environment jsdom
import '../test/setup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphDockComposer } from './GraphDockComposer';
import { useRunStatusStore } from '../stores/runStatusStore';
import { buildComposerDraftKey, type Message, useWorkspaceStore, type Workspace } from '../stores/workspaceStore';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import { useOrchestrationTemplateStore } from '../stores/orchestrationTemplateStore';
import { agentClient } from '../lib/agentClient';
import { TooltipProvider } from '../../@/components/ui/tooltip';

const hookMocks = vi.hoisted(() => ({
  steerAgentRun: vi.fn(),
  stopAgent: vi.fn(),
  startAgentRun: vi.fn(),
  upsertLocalNode: vi.fn(),
  createThreadSession: vi.fn(),
  listProviderSkills: vi.fn(),
  listFilesAtCommit: vi.fn(),
  scheduleRefresh: vi.fn(),
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    steerAgentRun: hookMocks.steerAgentRun,
    stopAgent: hookMocks.stopAgent,
    hasRuntime: vi.fn(() => true),
    startAgentRun: hookMocks.startAgentRun,
    upsertLocalNode: hookMocks.upsertLocalNode,
    listProviderSkills: hookMocks.listProviderSkills,
    listFilesAtCommit: hookMocks.listFilesAtCommit,
    listLocalRefs: vi.fn(async () => []),
    listAllCommits: vi.fn(async () => []),
  },
}));

vi.mock('../generated/tauri-bindings', () => ({
  commands: {
    getOrchestrationUserTemplates: vi.fn(async () => null),
    saveOrchestrationUserTemplates: vi.fn(async () => null),
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
      local_repo_path: '/repo',
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
  threadId: input.threadId,
  thread_id: input.thread_id,
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
    hookMocks.listProviderSkills.mockReset();
    hookMocks.listProviderSkills.mockResolvedValue([]);
    hookMocks.listFilesAtCommit.mockReset();
    hookMocks.listFilesAtCommit.mockResolvedValue([]);
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
    hookMocks.scheduleRefresh.mockReset();
    hookMocks.scheduleRefresh.mockResolvedValue(undefined);
    useRunStatusStore.getState().clearAllRunStatus();
    useOrchestrationTemplateStore.getState().clearUserTemplates();
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
    useLoginProfilesStore.setState({
      profiles: [{
        id: 'codex-profile-1',
        provider: 'codex',
        displayName: 'Codex Profile',
        authType: 'codex_chatgpt_session',
        redactedHint: null,
        config: null,
        status: 'ready',
        statusMessage: null,
        planType: null,
        isDefault: true,
        lastCheckedAt: null,
      }],
      activeRunsByProfile: {},
      isLoading: false,
      isMutating: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useRunStatusStore.getState().clearAllRunStatus();
    useOrchestrationTemplateStore.getState().clearUserTemplates();
    useWorkspaceStore.getState().clearSelectedWorkspace();
    useLoginProfilesStore.setState({
      profiles: [],
      activeRunsByProfile: {},
      isLoading: false,
      isMutating: false,
      error: null,
    });
  });

  it('debounces workspace draft writes while keeping textarea input immediate', async () => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({
      focusedMessageId: null,
      lastFocusSource: 'graph',
      lastFocusMetadata: null,
    });
    renderComposer([]);

    const composer = screen.getByLabelText('Graph composer prompt') as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: 'Local draft' } });

    expect(composer.value).toBe('Local draft');
    const draftKey = buildComposerDraftKey('workspace-1')!;
    expect(useWorkspaceStore.getState().composerDraftByWorkspace[draftKey]).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(useWorkspaceStore.getState().composerDraftByWorkspace[draftKey]).toBe('Local draft');
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

  it('inserts orchestration prompt mentions from # suggestions and enables orchestration', async () => {
    const user = userEvent.setup();
    useOrchestrationTemplateStore.getState().upsertUserTemplate({
      id: '#migration_review',
      kind: 'orchestration',
      label: '#migration_review',
      prompt: 'Create two parallel #planner for {{request}}.',
      source: 'user',
    });
    renderComposer([
      message({
        id: 'assistant-live',
        role: 'assistant',
        content: 'Previous assistant reply',
        status: 'completed' as any,
      }),
    ]);

    const promptInput = screen.getByLabelText('Graph composer prompt') as HTMLTextAreaElement;
    await user.type(promptInput, '#migration');
    await user.click(screen.getByRole('button', { name: /#migration_review/i }));

    expect(promptInput.value).toBe('#migration_review ');
    expect((screen.getByLabelText('Enable orchestration') as HTMLInputElement).checked).toBe(true);
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

    expect(screen.getByText('New thread')).toBeTruthy();
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

  it('stores unsent new-thread drafts by pending thread id', async () => {
    vi.useFakeTimers();
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

    expect(screen.getByText('New thread')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Graph composer prompt'), {
      target: { value: 'Draft for pending thread' },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(useWorkspaceStore.getState().composerDraftByWorkspace['workspace-1::pending-thread']).toBe('Draft for pending thread');
    expect(useWorkspaceStore.getState().composerDraftByWorkspace['workspace-1']).toBeUndefined();
  });

  it('shows an unfocused root send as a thread root target, not a workspace root', async () => {
    useWorkspaceStore.setState({
      focusedMessageId: null,
      lastFocusSource: 'graph',
      lastFocusMetadata: null,
    });

    renderComposer([]);

    expect(await screen.findByText('New thread')).toBeTruthy();
    expect(screen.getByText('Thread root')).toBeTruthy();
    expect(screen.queryByText('Workspace root')).toBeNull();
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

  it('keeps edited root user messages in their original thread', async () => {
    const user = userEvent.setup();
    renderComposer([
      message({
        id: 'user-root',
        role: 'user',
        parentId: null,
        content: 'Original root prompt',
        threadId: 'thread-session-1',
      }),
      message({
        id: 'assistant-root',
        role: 'assistant',
        parentId: 'user-root',
        content: 'Root answer',
        threadId: 'thread-session-1',
      }),
    ]);

    act(() => {
      window.dispatchEvent(new CustomEvent('editUserMessage', {
        detail: { message: message({
          id: 'user-root',
          role: 'user',
          parentId: null,
          content: 'Original root prompt',
          threadId: 'thread-session-1',
        }) },
      }));
    });

    const composer = await screen.findByLabelText('Graph composer prompt');
    await user.clear(composer);
    await user.type(composer, 'Revised root prompt');
    await user.click(screen.getByRole('button', { name: 'Send graph composer message' }));

    await waitFor(() => {
      expect(hookMocks.upsertLocalNode).toHaveBeenCalledTimes(2);
    });
    expect(hookMocks.createThreadSession).not.toHaveBeenCalled();
    const userMessage = hookMocks.upsertLocalNode.mock.calls[0][2] as Message;
    expect(userMessage.parentId).toBeNull();
    expect(userMessage.threadId).toBe('thread-session-1');
    expect(userMessage.execution_data?.meta?.thread_origin_id).toBe('thread-session-1');
    expect(userMessage.content).toBe('Revised root prompt');
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
