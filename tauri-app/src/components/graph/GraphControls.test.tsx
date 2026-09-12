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

  it('does not render the debug reset graph or auto-refresh controls', () => {
    render(
      <TooltipProvider>
        <GraphControls {...makeProps()} />
      </TooltipProvider>
    );

    expect(screen.queryByRole('button', { name: /reset graph/i })).toBeNull();
    expect(screen.queryByText(/repo refs/i)).toBeNull();
    expect(screen.queryByText(/automatic graph sync/i)).toBeNull();
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
            viewMode: 'list',
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

  it('switches leaf nodes between all threads and this thread', () => {
    const onLeafNodeFocus = vi.fn();
    render(
      <TooltipProvider>
        <GraphControls
          {...makeProps({
            leafNodes: [
              {
                id: 'current-leaf',
                label: 'Current thread leaf',
                modelLabel: 'Codex',
                statusLabel: 'Done',
                statusTone: 'success',
                timestampLabel: 'now',
              },
            ],
            allLeafNodes: [
              {
                id: 'other-leaf',
                label: 'Other thread leaf',
                modelLabel: 'Claude',
                statusLabel: 'Done',
                statusTone: 'success',
                timestampLabel: '1m ago',
              },
              {
                id: 'current-leaf',
                label: 'Current thread leaf',
                modelLabel: 'Codex',
                statusLabel: 'Done',
                statusTone: 'success',
                timestampLabel: 'now',
              },
            ],
            onLeafNodeFocus,
          })}
        />
      </TooltipProvider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Leaf nodes' }), { button: 0, ctrlKey: false });

    expect(screen.getByText('Other thread leaf')).toBeTruthy();
    expect(screen.getByText('Current thread leaf')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'This thread' }));

    expect(screen.queryByText('Other thread leaf')).toBeNull();
    fireEvent.click(screen.getByText('Current thread leaf'));
    expect(onLeafNodeFocus).toHaveBeenCalledWith('current-leaf');
  });

  it('does not expose a duplicate thread switcher in graph controls', () => {
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

    expect(screen.queryByRole('button', { name: 'Threads (1)' })).toBeNull();
    expect(screen.queryByText('Fix checkout race condition')).toBeNull();
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

  it('keeps the merge workflow closed when merge sources are added', async () => {
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

    await waitFor(() => {
      expect(screen.queryByText('Embedded merge panel')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Merge panel (1 source)' })).toBeTruthy();
  });

  it('leaves closed thread grouping to the workspace navigator', () => {
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
          })}
        />
      </TooltipProvider>
    );

    expect(screen.queryByRole('button', { name: 'Threads (3)' })).toBeNull();
    expect(screen.queryByText('Active checkout fix')).toBeNull();
    expect(screen.queryByText('Done but still running')).toBeNull();
    expect(screen.queryByText('Old completed task')).toBeNull();
  });
});
