// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphThreadTabs, type ThreadNavigationItem } from './GraphControls';
import type { Message } from '../../stores/workspaceStore';

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

const makeMessage = (id: string): Message => ({
  id,
  role: 'assistant',
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
});
