// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphThreadTabs, type ThreadNavigationItem } from './GraphControls';

vi.mock('../../../@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="thread-hover-root">{children}</div>
  ),
  HoverCardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

const renderTabs = (threadItems: ThreadNavigationItem[]) => render(
  <GraphThreadTabs
    threadItems={threadItems}
    threadHoverProjectionInput={{
      messages: [],
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
});
