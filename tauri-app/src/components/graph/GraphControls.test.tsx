// @vitest-environment jsdom
import '../../test/setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../@/components/ui/tooltip';
import {
  getThreadPreviewIndexForDisplayStep,
  getThreadPreviewDisplayIndex,
  GraphControls,
  GraphThreadTabs,
  type GraphControlsProps,
} from './GraphControls';

const makeProps = (overrides: Partial<GraphControlsProps> = {}): GraphControlsProps => ({
  viewMode: 'branch',
  onViewModeChange: vi.fn(),
  layoutMode: 'dagre',
  onLayoutModeChange: vi.fn(),
  laneStrategy: 'right',
  onLaneStrategyChange: vi.fn(),
  timePreset: 'all',
  customTimeFrom: '',
  customTimeTo: '',
  onTimePresetChange: vi.fn(),
  onCustomTimeFromChange: vi.fn(),
  onCustomTimeToChange: vi.fn(),
  uniqueAgentIds: [],
  agentLabelsById: new Map(),
  selectedAgentIds: new Set(),
  selectedNodeTypes: new Set(),
  agentOperator: 'any_of',
  onAgentOperatorChange: vi.fn(),
  onAgentFilterChange: vi.fn(),
  onNodeTypeFilterChange: vi.fn(),
  uniqueTags: [],
  selectedFilterTags: new Set(),
  tagOperator: 'has_any',
  onTagOperatorChange: vi.fn(),
  groupOperator: 'and',
  onGroupOperatorChange: vi.fn(),
  keepAncestors: false,
  keepDescendants: false,
  onKeepAncestorsChange: vi.fn(),
  onKeepDescendantsChange: vi.fn(),
  activeFilterCount: 0,
  matchingCount: 0,
  messageNodeCount: 0,
  nodeTypeCounts: {
    thread_link: 0,
    user_message: 0,
    assistant_message: 0,
    commit_message: 0,
  },
  filterButtonText: 'Filters',
  onTagFilterChange: vi.fn(),
  onClearTagFilters: vi.fn(),
  onClearAllFilters: vi.fn(),
  insights: [],
  insightsVisible: false,
  showInsightsInGraph: false,
  onToggleInsightsVisible: vi.fn(),
  onToggleShowInsightsInGraph: vi.fn(),
  leafNodes: [],
  onLeafNodeFocus: vi.fn(),
  mergeSourceCount: 0,
  mergeRunIndicator: 'idle',
  mergeAttentionNonce: 0,
  renderMergePanel: (onClose) => (
    <div>
      <div>Embedded merge panel</div>
      <button type="button" onClick={onClose}>Close embedded merge panel</button>
    </div>
  ),
  onResetLayout: vi.fn(),
  isRefreshingGraph: false,
  autoRefreshEligible: false,
  syncStatusItems: [],
  onRefreshSyncItem: vi.fn(),
  threadItems: [],
  onThreadFocus: vi.fn(),
  onThreadDoneChange: vi.fn(),
  doneThreadsCollapsed: true,
  onDoneThreadsCollapsedChange: vi.fn(),
  ...overrides,
});

describe('GraphControls', () => {
  it('numbers newest-first thread hover previews by chronological position', () => {
    expect(getThreadPreviewDisplayIndex(0, 4)).toBe(4);
    expect(getThreadPreviewDisplayIndex(1, 4)).toBe(3);
    expect(getThreadPreviewDisplayIndex(3, 4)).toBe(1);
    expect(getThreadPreviewDisplayIndex(99, 4)).toBe(1);
    expect(getThreadPreviewDisplayIndex(-1, 4)).toBe(4);
  });

  it('maps thread hover arrows to visible counter direction', () => {
    expect(getThreadPreviewIndexForDisplayStep(0, 4, -1)).toBe(1);
    expect(getThreadPreviewDisplayIndex(getThreadPreviewIndexForDisplayStep(0, 4, -1), 4)).toBe(3);

    expect(getThreadPreviewIndexForDisplayStep(1, 4, 1)).toBe(0);
    expect(getThreadPreviewDisplayIndex(getThreadPreviewIndexForDisplayStep(1, 4, 1), 4)).toBe(4);

    expect(getThreadPreviewIndexForDisplayStep(3, 4, -1)).toBe(3);
    expect(getThreadPreviewIndexForDisplayStep(0, 4, 1)).toBe(0);
  });

  it('keeps graph control styling tokenized without gradient utility classes', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/graph/GraphControls.tsx'), 'utf8');

    expect(source).not.toContain('bg-gradient-');
  });

  it('shows a workspace execution timeline popover from any view mode', () => {
    const onExecutionTimelineOpenChange = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            executionTimelineOpen: false,
            onExecutionTimelineOpenChange,
            renderExecutionTimelinePanel: () => <div>Workspace execution timeline panel</div>,
          })}
        />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open execution timeline' }));
    expect(onExecutionTimelineOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            viewMode: 'timeline',
            executionTimelineOpen: true,
            onExecutionTimelineOpenChange,
            renderExecutionTimelinePanel: () => <div>Workspace execution timeline panel</div>,
          })}
        />
      </TooltipProvider>
    );

    expect(screen.getByRole('button', { name: 'Close execution timeline' })).toBeTruthy();
    expect(screen.getByText('Workspace execution timeline panel')).toBeTruthy();
  });

  it('shows a create-thread action in thread tabs', () => {
    const onCreateThread = vi.fn();
    const onThreadFocus = vi.fn();

    render(
      <TooltipProvider>
        <GraphThreadTabs
          threadItems={[
            {
              threadRootId: 'thread-active',
              label: 'Fix checkout race condition',
              turnCount: 8,
              commitCount: 3,
              updatedLabel: '12m ago',
              runningCount: 0,
              hidden: false,
              done: false,
              current: true,
            },
          ]}
          onThreadFocus={onThreadFocus}
          onThreadDoneChange={vi.fn()}
          doneThreadsCollapsed={true}
          onDoneThreadsCollapsedChange={vi.fn()}
          onCreateThread={onCreateThread}
        />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start new thread' }));

    expect(onCreateThread).toHaveBeenCalledTimes(1);
    expect(onThreadFocus).not.toHaveBeenCalled();
  });

  it('shows unread completed leaf counts on thread tabs', () => {
    render(
      <TooltipProvider>
        <GraphThreadTabs
          threadItems={[
            {
              threadRootId: 'thread-unread',
              label: 'Review finished implementation',
              turnCount: 5,
              commitCount: 2,
              updatedLabel: 'now',
              runningCount: 0,
              hidden: false,
              done: false,
              current: false,
              unreadCompletedLeafCount: 3,
            },
          ]}
          onThreadFocus={vi.fn()}
          onThreadDoneChange={vi.fn()}
          doneThreadsCollapsed={true}
          onDoneThreadsCollapsedChange={vi.fn()}
          onCreateThread={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByLabelText('3 completed leaf nodes since last visit').textContent).toBe('3');
  });

  it('places the vertical create-thread action below the thread header', () => {
    render(
      <TooltipProvider>
        <GraphThreadTabs
          orientation="vertical"
          threadItems={[
            {
              threadRootId: 'thread-active',
              label: 'Fix checkout race condition',
              turnCount: 8,
              commitCount: 3,
              updatedLabel: '12m ago',
              runningCount: 0,
              hidden: false,
              done: false,
              current: true,
            },
          ]}
          onThreadFocus={vi.fn()}
          onThreadDoneChange={vi.fn()}
          doneThreadsCollapsed={true}
          onDoneThreadsCollapsedChange={vi.fn()}
          onCreateThread={vi.fn()}
        />
      </TooltipProvider>
    );

    const railContent = screen.getByText('Threads').parentElement?.parentElement;
    expect(railContent?.children[0]?.textContent).toContain('Threads');
    expect(railContent?.children[1]?.getAttribute('aria-label')).toBe('Start new thread');
    expect(railContent?.children[2]?.getAttribute('role')).toBe('tablist');
  });

  it('collapses vertical thread tabs into a compact rail control', () => {
    const onThreadBarCollapsedChange = vi.fn();

    render(
      <TooltipProvider>
        <GraphThreadTabs
          orientation="vertical"
          threadItems={[
            {
              threadRootId: 'thread-active',
              label: 'Fix checkout race condition',
              turnCount: 8,
              commitCount: 3,
              updatedLabel: '12m ago',
              runningCount: 1,
              hidden: false,
              done: false,
              current: true,
            },
            {
              threadRootId: 'thread-done',
              label: 'Old completed task',
              turnCount: 2,
              commitCount: 1,
              updatedLabel: 'yesterday',
              runningCount: 0,
              hidden: false,
              done: true,
              current: false,
            },
          ]}
          onThreadFocus={vi.fn()}
          onThreadDoneChange={vi.fn()}
          doneThreadsCollapsed={true}
          onDoneThreadsCollapsedChange={vi.fn()}
          threadBarCollapsed={true}
          onThreadBarCollapsedChange={onThreadBarCollapsedChange}
          onCreateThread={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.queryByRole('tablist', { name: 'Graph threads' })).toBeNull();
    expect(screen.getByLabelText('Graph threads (2)')).toBeTruthy();
    expect(screen.getByLabelText('Running threads (1)')).toBeTruthy();
    expect(screen.getByLabelText('Done threads (1)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand threads bar' }));

    expect(onThreadBarCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('shows compact thread navigation in the toolbar dropdown', async () => {
    const onThreadFocus = vi.fn();
    const onThreadDoneChange = vi.fn();
    const onDoneThreadsCollapsedChange = vi.fn();

    render(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            threadItems: [
              {
                threadRootId: 'thread-active',
                label: 'Fix checkout race condition',
                turnCount: 8,
                commitCount: 3,
                updatedLabel: '12m ago',
                runningCount: 1,
                hidden: false,
                done: false,
                current: true,
              },
              {
                threadRootId: 'thread-hidden',
                label: 'Old prompt experiment',
                turnCount: 2,
                commitCount: 1,
                updatedLabel: 'yesterday',
                runningCount: 0,
                hidden: true,
                done: true,
                current: false,
              },
            ],
            onThreadFocus,
            onThreadDoneChange,
            onDoneThreadsCollapsedChange,
          })}
        />
      </TooltipProvider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Threads (2)' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByText('Fix checkout race condition')).toBeTruthy();
    expect(screen.getByText('8 turns · 3 commits · 12m ago')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByText('Done threads')).toBeTruthy();
    expect(screen.queryByText('Old prompt experiment')).toBeNull();
    expect(screen.getByRole('button', { name: 'All 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Active 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Done 1' }));
    expect(screen.queryByText('Fix checkout race condition')).toBeNull();
    expect(screen.getByText('Old prompt experiment')).toBeTruthy();
    expect(onThreadFocus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Active 1' }));
    expect(screen.getByText('Fix checkout race condition')).toBeTruthy();
    expect(screen.queryByText('Old prompt experiment')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All 2' }));
    expect(screen.getByText('Fix checkout race condition')).toBeTruthy();
    expect(screen.queryByText('Old prompt experiment')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show done threads' }));
    expect(onDoneThreadsCollapsedChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Mark done Fix checkout race condition' }));
    expect(onThreadDoneChange).toHaveBeenCalledWith('thread-active', true);

    fireEvent.click(screen.getByRole('button', { name: 'Open thread Fix checkout race condition' }));
    expect(onThreadFocus).toHaveBeenCalledWith('thread-active');
    await waitFor(() => {
      expect(screen.queryByText('Fix checkout race condition')).toBeNull();
    });
  });

  it('does not lock background scroll while thread dropdown is open', async () => {
    render(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            threadItems: [
              {
                threadRootId: 'thread-active',
                label: 'Fix checkout race condition',
                turnCount: 8,
                commitCount: 3,
                updatedLabel: '12m ago',
                runningCount: 0,
                hidden: false,
                done: false,
                current: true,
              },
            ],
          })}
        />
      </TooltipProvider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Threads (1)' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByText('Fix checkout race condition')).toBeTruthy();
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('opens the merge workflow from the graph toolbar dropdown', async () => {
    render(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            mergeSourceCount: 2,
          })}
        />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Merge panel (2 sources)' }));

    expect(await screen.findByText('Embedded merge panel')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close embedded merge panel' }));
    await waitFor(() => {
      expect(screen.queryByText('Embedded merge panel')).toBeNull();
    });
  });

  it('opens the merge workflow when merge sources are added', async () => {
    const { rerender } = render(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            mergeSourceCount: 0,
            mergeAttentionNonce: 0,
          })}
        />
      </TooltipProvider>
    );

    expect(screen.queryByText('Embedded merge panel')).toBeNull();

    rerender(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            mergeSourceCount: 1,
            mergeAttentionNonce: 1,
          })}
        />
      </TooltipProvider>
    );

    expect(await screen.findByText('Embedded merge panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge panel (1 source)' })).toBeTruthy();
  });

  it('groups done threads at the bottom and keeps running done threads visible', async () => {
    const onThreadDoneChange = vi.fn();
    render(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            threadItems: [
              {
                threadRootId: 'thread-open',
                label: 'Active checkout fix',
                turnCount: 4,
                commitCount: 2,
                updatedLabel: '5m ago',
                runningCount: 0,
                hidden: false,
                done: false,
                current: true,
                lastUpdatedAt: 5,
              },
              {
                threadRootId: 'thread-done-running',
                label: 'Done but still running',
                turnCount: 2,
                commitCount: 1,
                updatedLabel: '2m ago',
                runningCount: 1,
                hidden: false,
                done: true,
                current: false,
                lastUpdatedAt: 7,
              },
              {
                threadRootId: 'thread-done',
                label: 'Old completed task',
                turnCount: 1,
                commitCount: 1,
                updatedLabel: 'yesterday',
                runningCount: 0,
                hidden: false,
                done: true,
                current: false,
                lastUpdatedAt: 1,
              },
            ],
            onThreadDoneChange,
          })}
        />
      </TooltipProvider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Threads (3)' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByText('Active checkout fix')).toBeTruthy();
    expect(screen.getByText('Done but still running')).toBeTruthy();
    expect(screen.getByText('Done threads')).toBeTruthy();
    expect(screen.queryByText('Old completed task')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show done threads' }));
    expect(screen.getByText('Old completed task')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mark done Active checkout fix' }));
    expect(onThreadDoneChange).toHaveBeenCalledWith('thread-open', true);

    fireEvent.click(screen.getByRole('button', { name: 'Reopen thread Old completed task' }));
    expect(onThreadDoneChange).toHaveBeenCalledWith('thread-done', false);
  });
});
