// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphThreadTabs, type ThreadNavigationItem } from './GraphControls';
import type { Message } from '../../stores/workspaceStore';
import { useRunStatusStore } from '../../stores/runStatusStore';

vi.mock('../../../@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div data-testid="thread-hover-root">
      <button type="button" onClick={() => onOpenChange?.(true)}>open thread hover</button>
      <button type="button" onClick={() => onOpenChange?.(false)}>close thread hover</button>
      {children}
    </div>
  ),
  HoverCardContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) => (
    <div data-testid="thread-hover-content" {...props}>{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../hooks/useWorkspaceProjection', () => ({
  useWorkspaceProjection: (messages: Message[]) => ({
    entitiesByMessageId: new Map(messages.map((message) => [message.id, {
      entityId: `entity:${message.id}`,
      kind: `${message.role}_message`,
      messageId: message.id,
      focusMessageId: message.id,
      message,
    }])),
  }),
}));

vi.mock('../NodeHoverCardContent', () => ({
  NodeHoverCardContent: ({ entity }: { entity?: { messageId?: string | null } }) => (
    <button type="button">thread hover content {entity?.messageId}</button>
  ),
}));

vi.mock('../../agent-runs/agentRunManager', () => ({
  agentRunManager: {
    watch: vi.fn(),
    unwatch: vi.fn(),
  },
}));

vi.mock('../../agent-runs/agentRunHydration', () => ({
  ensureAgentRunHydrated: vi.fn(() => Promise.resolve({ status: 'hydrated' })),
}));

const makeThread = (overrides: Partial<ThreadNavigationItem> & Pick<ThreadNavigationItem, 'threadRootId' | 'label'>): ThreadNavigationItem => ({
  threadRootId: overrides.threadRootId,
  label: overrides.label,
  turnCount: overrides.turnCount ?? 1,
  commitCount: overrides.commitCount ?? 0,
  baseCommitSha: overrides.baseCommitSha ?? 'abc123456789',
  updatedLabel: overrides.updatedLabel ?? 'now',
  runningCount: overrides.runningCount ?? 0,
  hidden: overrides.hidden ?? false,
  done: overrides.done ?? false,
  current: overrides.current ?? false,
  lastUpdatedAt: overrides.lastUpdatedAt ?? 1,
  unreadCompletedLeafCount: overrides.unreadCompletedLeafCount,
  initialPreviewNodeId: overrides.initialPreviewNodeId,
  previewNodeIds: overrides.previewNodeIds,
});

const makeMessage = (id: string, role: Message['role'] = 'assistant'): Message => ({
  id,
  role,
  content: `${id} content`,
  parentId: null,
  workspaceId: 'workspace-1',
  status: null,
  output_commit_sha: null,
  base_commit_sha: null,
  createdAt: '2026-05-16T00:00:00.000Z',
  updatedAt: '2026-05-16T00:00:00.000Z',
});

const renderTabs = (threadItems: ThreadNavigationItem[], messages: Message[] = []) => render(
  <GraphThreadTabs
    threadItems={threadItems}
    threadHoverProjectionInput={{
      messages,
      summaries: [],
      disabledSummaryIds: new Set(),
    }}
    onThreadFocus={vi.fn()}
    onThreadDoneChange={vi.fn()}
    doneThreadsCollapsed={false}
    onDoneThreadsCollapsedChange={vi.fn()}
    onCreateThread={vi.fn()}
  />
);

describe('GraphThreadTabs hover cards', () => {
  afterEach(() => {
    vi.clearAllMocks();
    useRunStatusStore.getState().clearAllRunStatus();
  });

  it('does not wrap the current thread tab in a hover card', () => {
    renderTabs([
      makeThread({
        threadRootId: 'thread-current',
        label: 'Current thread',
        current: true,
        lastUpdatedAt: 2,
        previewNodeIds: ['node-current'],
      }),
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        previewNodeIds: ['node-other'],
      }),
    ]);

    expect(screen.getByRole('tab', { name: 'Open thread Current thread' }).closest('[data-testid="thread-hover-root"]')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Open thread Other thread' }).closest('[data-testid="thread-hover-root"]')).toBeTruthy();
  });

  it('does not close a thread hover card from focus churn while the pointer remains inside it', () => {
    renderTabs([
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        previewNodeIds: ['node-other'],
      }),
    ], [makeMessage('node-other')]);

    fireEvent.click(screen.getByText('open thread hover'));
    const content = screen.getByTestId('thread-hover-content');
    fireEvent.pointerEnter(content);
    fireEvent.blur(screen.getByText('thread hover content node-other'), { relatedTarget: document.body });
    fireEvent.click(screen.getByText('close thread hover'));

    expect(screen.getByText('thread hover content node-other')).toBeTruthy();

    fireEvent.pointerLeave(content);
    fireEvent.click(screen.getByText('close thread hover'));

    expect(screen.queryByText('thread hover content node-other')).toBeNull();
  });

  it('only shows assistant previews in thread hover cards', () => {
    renderTabs([
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        initialPreviewNodeId: 'user-newer',
        previewNodeIds: ['user-newer', 'assistant-older'],
      }),
    ], [
      makeMessage('user-newer', 'user'),
      makeMessage('assistant-older', 'assistant'),
    ]);

    fireEvent.click(screen.getByText('open thread hover'));

    expect(screen.getByText('thread hover content assistant-older')).toBeTruthy();
    expect(screen.queryByText('thread hover content user-newer')).toBeNull();
    expect(screen.queryByText('1 / 2')).toBeNull();
  });

  it('closes a thread hover card when the pointer leaves content without retained focus', () => {
    renderTabs([
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        previewNodeIds: ['node-other'],
      }),
    ], [makeMessage('node-other')]);

    fireEvent.click(screen.getByText('open thread hover'));
    const content = screen.getByTestId('thread-hover-content');
    fireEvent.pointerEnter(content);
    fireEvent.click(screen.getByText('close thread hover'));

    expect(screen.getByText('thread hover content node-other')).toBeTruthy();

    fireEvent.pointerLeave(content);

    expect(screen.queryByText('thread hover content node-other')).toBeNull();
  });

  it('closes a thread hover card for graph viewport interaction', () => {
    renderTabs([
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        previewNodeIds: ['node-other'],
      }),
    ], [makeMessage('node-other')]);

    fireEvent.click(screen.getByText('open thread hover'));
    expect(screen.getByText('thread hover content node-other')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent('agentree:graph-viewport-interaction-start'));
    });

    expect(screen.queryByText('thread hover content node-other')).toBeNull();
  });

  it('closes a thread hover card when the document is hidden', () => {
    renderTabs([
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        previewNodeIds: ['node-other'],
      }),
    ], [makeMessage('node-other')]);

    fireEvent.click(screen.getByText('open thread hover'));
    expect(screen.getByText('thread hover content node-other')).toBeTruthy();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(screen.queryByText('thread hover content node-other')).toBeNull();
  });

  it('hydrates the active preview node only while the thread hover card is open', async () => {
    const { agentRunManager } = await import('../../agent-runs/agentRunManager');
    const { ensureAgentRunHydrated } = await import('../../agent-runs/agentRunHydration');

    renderTabs([
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        previewNodeIds: ['node-other'],
      }),
    ], [{ ...makeMessage('node-other'), status: 'running' }]);

    fireEvent.click(screen.getByText('open thread hover'));

    await waitFor(() => {
      expect(agentRunManager.watch).toHaveBeenCalledWith('node-other', 'hover');
    });
    expect(ensureAgentRunHydrated).toHaveBeenCalledWith('node-other', 'hover');

    fireEvent.click(screen.getByText('close thread hover'));

    await waitFor(() => {
      expect(agentRunManager.unwatch).toHaveBeenCalledWith('node-other', 'hover');
    });
  });

  it('does not hydrate a persisted completed preview node', async () => {
    const { agentRunManager } = await import('../../agent-runs/agentRunManager');
    const { ensureAgentRunHydrated } = await import('../../agent-runs/agentRunHydration');

    renderTabs([
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        previewNodeIds: ['node-other'],
      }),
    ], [{ ...makeMessage('node-other'), status: 'completed' }]);

    fireEvent.click(screen.getByText('open thread hover'));

    expect(screen.getByText('thread hover content node-other')).toBeTruthy();
    expect(agentRunManager.watch).not.toHaveBeenCalled();
    expect(ensureAgentRunHydrated).not.toHaveBeenCalled();
  });

  it('hydrates a completed preview node when live run status is active', async () => {
    const { agentRunManager } = await import('../../agent-runs/agentRunManager');
    const { ensureAgentRunHydrated } = await import('../../agent-runs/agentRunHydration');
    useRunStatusStore.getState().setRunStatus('node-other', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running',
    });

    renderTabs([
      makeThread({
        threadRootId: 'thread-other',
        label: 'Other thread',
        previewNodeIds: ['node-other'],
      }),
    ], [{ ...makeMessage('node-other'), status: 'completed' }]);

    fireEvent.click(screen.getByText('open thread hover'));

    await waitFor(() => {
      expect(agentRunManager.watch).toHaveBeenCalledWith('node-other', 'hover');
    });
    expect(ensureAgentRunHydrated).toHaveBeenCalledWith('node-other', 'hover');
  });
});
