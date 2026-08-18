// @vitest-environment jsdom
import '../test/setup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
  setSelectedFlowId: vi.fn(),
  runFlow: vi.fn(),
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    steerAgentRun: hookMocks.steerAgentRun,
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
    });
  });

  afterEach(() => {
    useRunStatusStore.getState().clearAllRunStatus();
    useWorkspaceStore.getState().clearSelectedWorkspace();
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
});
