// @vitest-environment jsdom
import '../test/setup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { NodeHoverCardContent } from './NodeHoverCardContent';
import { clearHoverQuickReplyDraftsForTest } from './HoverQuickReplyActions';
import { ChatAssistantCard } from './nodes/chat/ChatAssistantCard';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { useWorkspaceStore, type Message } from '../stores/workspaceStore';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { AgentreeSurfaceProvider, publicShareCapabilities } from './graph/surfaceCapabilities';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const quickReplyMocks = vi.hoisted(() => ({
  sendQuickReply: vi.fn(),
  sendSteeringReply: vi.fn(),
  error: null as string | null,
}));
const cancelMocks = vi.hoisted(() => ({
  stopAgent: vi.fn(),
  dispatchAgentRun: vi.fn(),
  scheduleRefresh: vi.fn(),
}));
const highlightMocks = vi.hoisted(() => ({
  selection: vi.fn(),
  hover: vi.fn(),
}));

vi.mock('./NodePreviewRenderer', () => ({
  NodePreviewRenderer: ({ entity }: { entity?: ProjectedNodeEntity }) => (
    <div>
      <div>hover body: {entity?.preview}</div>
      <div>hover content: {entity?.message?.content}</div>
    </div>
  ),
}));

vi.mock('./highlights/MessageHighlightSelectionPopover', () => ({
  MessageHighlightSelectionPopover: () => {
    highlightMocks.selection();
    return <div data-testid="highlight-selection-popover" />;
  },
}));

vi.mock('./highlights/MessageHighlightHoverPopover', () => ({
  MessageHighlightHoverPopover: () => {
    highlightMocks.hover();
    return <div data-testid="highlight-hover-popover" />;
  },
}));

vi.mock('../hooks/useHeadlessQuickReply', () => ({
  useHeadlessQuickReply: () => ({
    sendQuickReply: quickReplyMocks.sendQuickReply,
    sendSteeringReply: quickReplyMocks.sendSteeringReply,
    isSending: false,
    error: quickReplyMocks.error,
  }),
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    stopAgent: cancelMocks.stopAgent,
  },
}));

vi.mock('../agent-runs/agentRunManager', () => ({
  agentRunManager: {
    watch: vi.fn(),
    unwatch: vi.fn(),
    snapshot: vi.fn(() => null),
    dispatch: cancelMocks.dispatchAgentRun,
  },
}));

vi.mock('../lib/graphInteractionGate', () => ({
  scheduleMessagesRefreshWhenGraphIdle: cancelMocks.scheduleRefresh,
}));

const render = (ui: ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return rtlRender(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  );
};

const makeMessage = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: input.content ?? `${input.id} content`,
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  aiLabel: input.aiLabel ?? null,
  llmProvider: input.llmProvider ?? null,
  llmModel: input.llmModel ?? null,
  tags: input.tags ?? [],
  status: input.status ?? null,
  agent_id: input.agent_id ?? null,
  execution_data: input.execution_data ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  createdAt: input.createdAt ?? '2026-05-16T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-05-16T00:00:00.000Z',
});

const makeProjection = (messages: Message[] = []): WorkspaceProjection => ({
  messages,
  summaries: [],
  messageMap: new Map(messages.map((message) => [message.id, message])),
  summaryMap: new Map(),
  entities: [],
  entitiesById: new Map(),
  entitiesByMessageId: new Map(),
  entitiesBySummaryId: new Map(),
  childEntityIdsByParentEntityId: new Map(),
  controlledEntityIdsByControllerMessageId: new Map(),
  commitEntityIdsByAssistantEntityId: new Map(),
  commitBySha: new Map(),
  commitLaneRows: [],
  layoutDerivedCommitGroups: [],
  groupIdByCommitSha: new Map(),
  threadRootIds: [],
  threadRootIdByMessageId: new Map(),
  rootMessageIdByThreadRootId: new Map(),
  turnGroups: [],
  turnGroupById: new Map(),
  originMessage: null,
  originMessageId: null,
  branchPathMessageIds: new Set(),
  focusRoute: { baseNodeId: null, messageIds: [], edges: [] },
  listItems: [],
  chatItems: [],
});

const makeEntity = (
  kind: ProjectedNodeEntity['kind'],
  overrides: Partial<ProjectedNodeEntity> = {}
): ProjectedNodeEntity => ({
  entityId: `${kind}:entity-1`,
  kind,
  messageId: overrides.messageId ?? 'message-1',
  focusMessageId: overrides.focusMessageId ?? 'message-1',
  turnGroupId: 'turn-1',
  sortTs: 1,
  preview: `${kind} preview`,
  shortLabel: 'label',
  status: overrides.status ?? null,
  message: overrides.message ?? makeMessage({ id: 'message-1', content: `${kind} preview` }),
  ...overrides,
});

describe('NodeHoverCardContent', () => {
  beforeEach(() => {
    quickReplyMocks.sendQuickReply.mockReset();
    quickReplyMocks.sendSteeringReply.mockReset();
    quickReplyMocks.sendQuickReply.mockResolvedValue({});
    quickReplyMocks.sendSteeringReply.mockResolvedValue(undefined);
    quickReplyMocks.error = null;
    cancelMocks.stopAgent.mockReset();
    cancelMocks.stopAgent.mockResolvedValue(undefined);
    cancelMocks.dispatchAgentRun.mockReset();
    cancelMocks.scheduleRefresh.mockReset();
    cancelMocks.scheduleRefresh.mockResolvedValue(undefined);
    highlightMocks.selection.mockReset();
    highlightMocks.hover.mockReset();
    useAgentRunProjectionStore.getState().clearAllProjections();
    clearHoverQuickReplyDraftsForTest();
  });

  it('does not show Reply for commit hover cards', async () => {
    render(<NodeHoverCardContent entity={makeEntity('commit_message')} projection={makeProjection()} />);

    expect(await screen.findByText('hover body: commit_message preview')).toBeTruthy();
    expect(screen.queryByText('Reply')).toBeNull();
  });

  it('keeps Reply for non-commit hover cards', async () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    expect(await screen.findByText('hover body: assistant_message preview')).toBeTruthy();
    expect(screen.getByText('Quick Reply')).toBeTruthy();
  });

  it('updates an open assistant hover from the live projection store', async () => {
    const message = makeMessage({
      id: 'assistant-live',
      role: 'assistant',
      content: 'Persisted graph preview',
      status: 'running' as any,
    });

    render(
      <NodeHoverCardContent
        entity={makeEntity('assistant_message', {
          message,
          messageId: message.id,
          focusMessageId: message.id,
          preview: 'assistant live preview',
          status: 'running' as any,
        })}
        projection={makeProjection([message])}
      />
    );

    expect(await screen.findByText('hover content: Persisted graph preview')).toBeTruthy();

    act(() => {
      useAgentRunProjectionStore.getState().setProjectionForNode(message.id, {
        ...message,
        content: 'Live token update',
        status: 'streaming' as any,
        _optimisticStatus: 'streaming' as any,
      });
    });

    expect(await screen.findByText('hover content: Live token update')).toBeTruthy();
  });

  it('uses the shared preview renderer for public hover cards without app-only quick reply actions', () => {
    const message = makeMessage({
      id: 'assistant-public',
      role: 'assistant',
      content: 'Public assistant response',
      aiLabel: 'Review agent',
      llmProvider: 'openai',
      llmModel: 'openai/gpt-5.5',
      base_commit_sha: '1111111111111111111111111111111111111111',
      output_commit_sha: '2222222222222222222222222222222222222222',
      tags: ['review', 'public'],
      execution_data: {
        started_at: '2026-06-04T00:00:00.000Z',
        ended_at: '2026-06-04T00:02:05.000Z',
        usage: {
          input_tokens: 1200,
          output_tokens: 345,
          total_tokens: 1545,
        },
        cache_usage: {
          cached_input_tokens: 512,
        },
        meta: {
          commit_count: 1,
          files_changed_count: 2,
          provider_reasoning_effort: 'high',
          total_additions: 14,
          total_deletions: 3,
        },
        work_logs: [
          {
            id: 'tool-1',
            type: 'tool_use',
            label: 'Bash',
            status: 'started',
            durationMs: 1200,
          },
        ],
        files_changed: [
          { path: 'secret/file.ts', status: 'modified', additions: 14, deletions: 3 },
        ],
        timeline: [
          { type: 'tool_use', toolName: 'Bash', toolInput: { cmd: 'cat secret/file.ts' } },
        ],
      } as any,
    });

    render(
      <NodeHoverCardContent
        entity={makeEntity('assistant_message', {
          message,
          messageId: message.id,
          focusMessageId: message.id,
          status: 'completed' as any,
        })}
        projection={makeProjection([message])}
        surfaceMode="public-share"
        capabilities={publicShareCapabilities}
      />
    );

    expect(screen.getByText('hover body: assistant_message preview')).toBeTruthy();
    expect(screen.queryByText('Quick Reply')).toBeNull();
    expect(highlightMocks.selection).not.toHaveBeenCalled();
    expect(highlightMocks.hover).not.toHaveBeenCalled();
  });

  it('keeps highlight controls on mutable app hover cards', () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    expect(highlightMocks.selection).toHaveBeenCalledOnce();
    expect(highlightMocks.hover).toHaveBeenCalledOnce();
  });

  it('renders public assistant details through the shared chat card without tool-call expansion', () => {
    const message = makeMessage({
      id: 'assistant-public',
      role: 'assistant',
      content: 'Public assistant response with `inline code`',
      aiLabel: 'Review agent',
      llmProvider: 'openai',
      llmModel: 'openai/gpt-5.5',
      promptTokens: 1200,
      completionTokens: 345,
      totalTokens: 1545,
      tags: ['review', 'public'],
      status: 'completed' as any,
      execution_data: {
        meta: {
          provider_reasoning_effort: 'high',
        },
        usage: {
          input_tokens: 1200,
          output_tokens: 345,
          total_tokens: 1545,
          cached_input_tokens: 512,
        },
        work_logs: [
          {
            id: 'tool-1',
            type: 'tool_use',
            label: 'Bash',
            status: 'completed',
            durationMs: 1200,
          },
        ],
        files_changed: [
          { path: 'secret/file.ts', status: 'modified', additions: 14, deletions: 3 },
        ],
      } as any,
    });
    const entity = makeEntity('assistant_message', {
      message,
      messageId: message.id,
      focusMessageId: message.id,
      status: 'completed' as any,
    });

    render(
      <AgentreeSurfaceProvider surfaceMode="public-share" capabilities={publicShareCapabilities}>
        <ChatAssistantCard
          entity={entity}
          isFocused={false}
          isSelected={false}
          layout="chat"
          onFocus={() => {}}
          onSelect={() => {}}
          onContextMenu={() => {}}
        />
      </AgentreeSurfaceProvider>
    );

    expect(screen.getByText('GPT 5.5')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText(/Completed/)).toBeTruthy();
    expect(screen.getByText('Public assistant response with')).toBeTruthy();
    expect(screen.getByText('inline code')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();
    expect(screen.getByText('public')).toBeTruthy();
    expect(screen.getByText('Work logs')).toBeTruthy();
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('1.2s')).toBeTruthy();
    expect(screen.queryByText('secret/file.ts')).toBeNull();
    expect(screen.queryByText('cat secret/file.ts')).toBeNull();
    expect(screen.queryByRole('button', { name: /Bash/i })).toBeNull();
    expect(screen.queryByLabelText('Remove tag: review')).toBeNull();
  });

  it('does not show a standalone persisted failure reason banner in the hover card', async () => {
    const reason = "ImportError: cannot import name 'ParamSpec' from 'typing'";
    const entity = makeEntity('assistant_message');
    entity.status = 'failed' as any;
    entity.message = {
      ...entity.message!,
      status: 'failed' as any,
      execution_data: {
        failure_reason: reason,
      },
    };

    render(<NodeHoverCardContent entity={entity} projection={makeProjection([entity.message])} />);

    expect(await screen.findByText('hover body: assistant_message preview')).toBeTruthy();
    expect(screen.queryByText('Failure reason')).toBeNull();
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('uses app theme surfaces for the hovercard shell', () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    const shell = document.querySelector('[data-agentree-node-hover-card="true"]') as HTMLElement;

    expect(shell.className).toContain('bg-[hsl(var(--app-panel)/0.96)]');
    expect(shell.className).toContain('border-[hsl(var(--app-border)/0.76)]');
    expect(shell.className).not.toContain('rgba(255,255,255');
    expect(shell.className).not.toContain('linear-gradient(180deg,rgba');
  });

  it('shows orchestration-run summary for orchestrator hover cards', () => {
    const orchestratorMessage = makeMessage({
      id: 'orchestrator-1',
      role: 'assistant',
      status: 'running' as any,
    });
    const runningChildMessage = makeMessage({
      id: 'child-running',
      role: 'assistant',
      status: 'running' as any,
      parentId: 'orchestrator-1',
    });
    const completedChildMessage = makeMessage({
      id: 'child-completed',
      role: 'assistant',
      status: 'completed' as any,
      parentId: 'orchestrator-1',
    });
    const failedChildMessage = makeMessage({
      id: 'child-failed',
      role: 'assistant',
      status: 'failed' as any,
      parentId: 'orchestrator-1',
    });
    const runningChild = makeEntity('assistant_message', {
      entityId: 'assistant_message:child-running',
      messageId: runningChildMessage.id,
      focusMessageId: runningChildMessage.id,
      message: runningChildMessage,
      preview: 'Compare implementation options',
      status: 'running' as any,
    });
    const completedChild = makeEntity('assistant_message', {
      entityId: 'assistant_message:child-completed',
      messageId: completedChildMessage.id,
      focusMessageId: completedChildMessage.id,
      message: completedChildMessage,
      preview: 'Write migration notes',
      status: 'completed' as any,
    });
    const failedChild = makeEntity('assistant_message', {
      entityId: 'assistant_message:child-failed',
      messageId: failedChildMessage.id,
      focusMessageId: failedChildMessage.id,
      message: failedChildMessage,
      preview: 'Run verification',
      status: 'failed' as any,
    });
    const orchestrator = makeEntity('assistant_message', {
      entityId: 'assistant_message:orchestrator-1',
      messageId: orchestratorMessage.id,
      focusMessageId: orchestratorMessage.id,
      message: orchestratorMessage,
      nodeKind: 'orchestrator',
      orchestrationSummary: {
        controllerMessageId: orchestratorMessage.id,
        controlledEntityIds: [runningChild.entityId, completedChild.entityId, failedChild.entityId],
        orchestrationRunAssistantEntityIds: [runningChild.entityId, completedChild.entityId, failedChild.entityId],
        totalOrchestrationRuns: 3,
        activeOrchestrationRuns: 1,
        terminalOrchestrationRuns: 2,
        completedOrchestrationRuns: 1,
        failedOrchestrationRuns: 1,
        cancelledOrchestrationRuns: 0,
      },
    });
    const projection = makeProjection([
      orchestratorMessage,
      runningChildMessage,
      completedChildMessage,
      failedChildMessage,
    ]);
    projection.entitiesById = new Map([
      [orchestrator.entityId, orchestrator],
      [runningChild.entityId, runningChild],
      [completedChild.entityId, completedChild],
      [failedChild.entityId, failedChild],
    ]);

    render(<NodeHoverCardContent entity={orchestrator} projection={projection} />);

    expect(screen.getByTestId('orchestration-hover-summary')).toBeTruthy();
    expect(screen.getByText('Orchestration')).toBeTruthy();
    expect(screen.getByText('3 orchestration runs')).toBeTruthy();
    expect(screen.getByText('Compare implementation options')).toBeTruthy();
    expect(screen.getByText('Write migration notes')).toBeTruthy();
    expect(screen.getByText('Run verification')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getAllByText('Failed').length).toBeGreaterThanOrEqual(1);
  });

  it('uses the app action color when ready to send', () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    const input = screen.getByLabelText('Quick reply prompt');
    const button = screen.getByRole('button', { name: 'Quick Reply' });

    expect(button.className).not.toContain('bg-[hsl(var(--app-accent))]');

    fireEvent.change(input, { target: { value: 'Looks good' } });

    expect(button.className).toContain('bg-[hsl(var(--app-accent))]');
    expect(button.className).toContain('border-[hsl(var(--app-accent)/0.48)]');
    expect(button.className).toContain('text-white');
    expect(button.className).not.toContain('bg-foreground');
    expect(button.className).not.toContain('dark:bg-[hsl(var(--app-bg-muted))]');
    expect(button.className).not.toContain('dark:bg-white');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses an autosizing multiline textarea for quick replies', () => {
    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    const input = screen.getByLabelText('Quick reply prompt');

    expect(input.tagName).toBe('TEXTAREA');
    expect(input.className).toContain('resize-none');
    expect(input.className).toContain('max-h-[132px]');
  });

  it('restores an unsent quick reply draft when reopening the same message hover card', async () => {
    const user = userEvent.setup();
    const entity = makeEntity('assistant_message');
    const projection = makeProjection([entity.message!]);
    const { unmount } = render(<NodeHoverCardContent entity={entity} projection={projection} />);

    await user.type(screen.getByLabelText('Quick reply prompt'), 'Keep this draft');
    unmount();

    render(<NodeHoverCardContent entity={entity} projection={projection} />);

    expect((screen.getByLabelText('Quick reply prompt') as HTMLTextAreaElement).value).toBe('Keep this draft');
  });

  it('shares hover card quick reply drafts through the matching target composer draft', async () => {
    const user = userEvent.setup();
    const firstMessage = makeMessage({ id: 'message-1', role: 'assistant' });
    const secondMessage = makeMessage({ id: 'message-2', role: 'assistant' });
    const projection = makeProjection([firstMessage, secondMessage]);
    const firstEntity = makeEntity('assistant_message', {
      message: firstMessage,
      messageId: firstMessage.id,
      focusMessageId: firstMessage.id,
    });
    const secondEntity = makeEntity('assistant_message', {
      message: secondMessage,
      messageId: secondMessage.id,
      focusMessageId: secondMessage.id,
    });
    const { rerender } = render(<NodeHoverCardContent entity={firstEntity} projection={projection} />);

    await user.type(screen.getByLabelText('Quick reply prompt'), 'First node draft');

    expect(useWorkspaceStore.getState().getComposerDraft('workspace-1', 'message-1')).toBe('First node draft');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-1', 'message-2')).toBe('');

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <NodeHoverCardContent entity={secondEntity} projection={projection} />
      </QueryClientProvider>
    );

    expect((screen.getByLabelText('Quick reply prompt') as HTMLTextAreaElement).value).toBe('');

    await user.type(screen.getByLabelText('Quick reply prompt'), 'Second node draft');

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <NodeHoverCardContent entity={firstEntity} projection={projection} />
      </QueryClientProvider>
    );

    expect((screen.getByLabelText('Quick reply prompt') as HTMLTextAreaElement).value).toBe('First node draft');
    expect(useWorkspaceStore.getState().getComposerDraft('workspace-1', 'message-2')).toBe('Second node draft');
  });

  it('reflects composer draft changes in an open hover quick reply', async () => {
    const entity = makeEntity('assistant_message');
    const projection = makeProjection([entity.message!]);

    render(<NodeHoverCardContent entity={entity} projection={projection} />);

    act(() => {
      useWorkspaceStore.getState().setComposerDraft('workspace-1', 'Composer text', 'message-1');
    });

    await waitFor(() => {
      expect((screen.getByLabelText('Quick reply prompt') as HTMLTextAreaElement).value).toBe('Composer text');
    });
  });

  it('does not bubble quick reply input events into graph node focus handlers', () => {
    const onClick = vi.fn();
    const onMouseDown = vi.fn();
    const onPointerDown = vi.fn();
    const onFocus = vi.fn();

    render(
      <div
        onClick={onClick}
        onMouseDown={onMouseDown}
        onPointerDown={onPointerDown}
        onFocus={onFocus}
      >
        <NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />
      </div>
    );

    const input = screen.getByLabelText('Quick reply prompt');
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.click(input);

    expect(onClick).not.toHaveBeenCalled();
    expect(onMouseDown).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('shows steering for running assistant hover cards', async () => {
    const user = userEvent.setup();
    const runningAssistant = makeMessage({
      id: 'assistant-running',
      role: 'assistant',
      status: 'running' as any,
    });
    render(
      <NodeHoverCardContent
        entity={makeEntity('assistant_message', {
          status: 'running' as any,
          message: runningAssistant,
          messageId: runningAssistant.id,
          focusMessageId: runningAssistant.id,
        })}
        projection={makeProjection([runningAssistant])}
      />
    );

    expect(screen.getByText('hover body: assistant_message preview')).toBeTruthy();
    const input = screen.getByLabelText('Steering prompt');
    await user.type(input, 'Focus on tests');
    await user.click(screen.getByRole('button', { name: 'Steer' }));

    expect(quickReplyMocks.sendSteeringReply).toHaveBeenCalledWith({
      assistantNodeId: 'assistant-running',
      prompt: 'Focus on tests',
    });
    expect(quickReplyMocks.sendQuickReply).not.toHaveBeenCalled();
  });

  it('shows a cancel button for running assistant hover cards', async () => {
    const user = userEvent.setup();
    const runningAssistant = makeMessage({
      id: 'assistant-running',
      role: 'assistant',
      status: 'running' as any,
      parentId: 'user-parent',
      agent_id: 'codex:test',
      execution_data: { current_run_id: 'run-1' },
    });
    render(
      <NodeHoverCardContent
        entity={makeEntity('assistant_message', {
          status: 'running' as any,
          message: runningAssistant,
          messageId: runningAssistant.id,
          focusMessageId: runningAssistant.id,
        })}
        projection={makeProjection([runningAssistant])}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Cancel running agent' }));

    expect(cancelMocks.stopAgent).toHaveBeenCalledWith('assistant-running');
    expect(cancelMocks.dispatchAgentRun).toHaveBeenCalledWith(
      'assistant-running',
      { type: 'cancel', reason: 'cancelled' },
      expect.objectContaining({
        workspaceId: 'workspace-1',
        parentId: 'user-parent',
        role: 'assistant',
        agentId: 'codex:test',
      })
    );
    expect(cancelMocks.scheduleRefresh).toHaveBeenCalledWith(
      expect.anything(),
      'workspace-1',
      { reason: 'cancel-agent' }
    );
  });

  it('defaults running agent hover cards to the bottom of the preview', () => {
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(1400);
    const runningAssistant = makeMessage({
      id: 'assistant-running',
      role: 'assistant',
      status: 'running' as any,
    });

    try {
      render(
        <NodeHoverCardContent
          entity={makeEntity('assistant_message', {
            status: 'running' as any,
            message: runningAssistant,
            messageId: runningAssistant.id,
            focusMessageId: runningAssistant.id,
          })}
          projection={makeProjection([runningAssistant])}
        />
      );

      const scrollArea = screen
        .getByText('hover body: assistant_message preview')
        .closest('.overflow-y-auto') as HTMLElement | null;

      expect(scrollArea).toBeTruthy();
      expect(scrollArea!.scrollTop).toBe(1400);
    } finally {
      scrollHeightSpy.mockRestore();
    }
  });

  it('rechecks the running agent preview bottom after the first frame settles layout', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});
    let scrollHeight = 900;
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(() => scrollHeight);
    const runningAssistant = makeMessage({
      id: 'assistant-running',
      role: 'assistant',
      status: 'running' as any,
    });

    try {
      render(
        <NodeHoverCardContent
          entity={makeEntity('assistant_message', {
            status: 'running' as any,
            message: runningAssistant,
            messageId: runningAssistant.id,
            focusMessageId: runningAssistant.id,
          })}
          projection={makeProjection([runningAssistant])}
        />
      );

      const scrollArea = screen
        .getByText('hover body: assistant_message preview')
        .closest('.overflow-y-auto') as HTMLElement | null;

      expect(scrollArea).toBeTruthy();
      expect(scrollArea!.scrollTop).toBe(900);
      expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);

      scrollHeight = 1400;
      rafCallbacks.forEach((callback) => callback(performance.now()));

      expect(scrollArea!.scrollTop).toBe(1400);
    } finally {
      scrollHeightSpy.mockRestore();
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    }
  });

  it('hides quick reply for running non-assistant hover cards', () => {
    const runningUser = makeMessage({
      id: 'user-running',
      role: 'user',
      status: 'running' as any,
    });
    render(
      <NodeHoverCardContent
        entity={makeEntity('user_message', {
          status: 'running' as any,
          message: runningUser,
          messageId: runningUser.id,
          focusMessageId: runningUser.id,
        })}
        projection={makeProjection([runningUser])}
      />
    );

    expect(screen.getByText('hover body: user_message preview')).toBeTruthy();
    expect(screen.queryByText('Quick Reply')).toBeNull();
    expect(screen.queryByText('Steer')).toBeNull();
    expect(screen.queryByLabelText('Quick reply prompt')).toBeNull();
  });

  it('directly sends a quick reply without opening the floating composer', async () => {
    const user = userEvent.setup();
    const messages = [
      makeMessage({ id: 'ancestor', output_commit_sha: 'ancestor-output-sha' }),
      makeMessage({ id: 'message-1', role: 'user', parentId: 'ancestor', base_commit_sha: 'stale-parent-base' }),
    ];
    render(<NodeHoverCardContent entity={makeEntity('user_message')} projection={makeProjection(messages)} />);

    const input = screen.getByLabelText('Quick reply prompt') as HTMLTextAreaElement;
    await user.type(input, 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Quick Reply' }));

    expect(quickReplyMocks.sendQuickReply).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      replyParentId: 'message-1',
      prompt: 'Ship it',
      messages,
    });
    await waitFor(() => {
      expect(input.value).toBe('');
      expect(document.activeElement).toBe(input);
    });
  });

  it('shows quick reply errors visibly in the hover card', () => {
    quickReplyMocks.error = 'The parent does not have a model Agentree can reuse.';

    render(<NodeHoverCardContent entity={makeEntity('assistant_message')} projection={makeProjection()} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The parent does not have a model Agentree can reuse.');
    expect(alert.className).not.toContain('sr-only');
  });

  it('uses the neutral node preview renderer instead of importing chat rendering directly', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/AppNodeHoverPreview.tsx'), 'utf8');

    expect(source).toContain("import { NodePreviewRenderer } from './NodePreviewRenderer';");
    expect(source).not.toContain("import { ChatNodeDispatcher } from './nodes/chat/ChatNodeDispatcher';");
  });
});
