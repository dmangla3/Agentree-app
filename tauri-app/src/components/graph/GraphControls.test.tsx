// @vitest-environment jsdom
import '../../test/setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../@/components/ui/tooltip';
import { GraphControls, type GraphControlsProps } from './GraphControls';

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
  onResetLayout: vi.fn(),
  isRefreshingGraph: false,
  autoRefreshEligible: false,
  syncStatusItems: [],
  onRefreshSyncItem: vi.fn(),
  threadItems: [],
  onThreadFocus: vi.fn(),
  onThreadHide: vi.fn(),
  onThreadRestore: vi.fn(),
  onHideAllThreads: vi.fn(),
  onRestoreAllHiddenThreads: vi.fn(),
  ...overrides,
});

describe('GraphControls', () => {
  it('keeps graph control styling tokenized without gradient utility classes', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/graph/GraphControls.tsx'), 'utf8');

    expect(source).not.toContain('bg-gradient-');
  });

  it('does not expose scope filtering in the graph controls', () => {
    render(
      <TooltipProvider>
        <GraphControls {...makeProps()} />
      </TooltipProvider>
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Filters0' }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.queryByText('Scopes')).toBeNull();
    expect(screen.queryByPlaceholderText('Search scopes...')).toBeNull();
    expect(screen.queryByText('Frontend')).toBeNull();
  });

  it('shows compact thread navigation in the toolbar dropdown', async () => {
    const onThreadFocus = vi.fn();
    const onThreadHide = vi.fn();
    const onThreadRestore = vi.fn();
    const onHideAllThreads = vi.fn();
    const onRestoreAllHiddenThreads = vi.fn();

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
                current: false,
              },
            ],
            onThreadFocus,
            onThreadHide,
            onThreadRestore,
            onHideAllThreads,
            onRestoreAllHiddenThreads,
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
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Old prompt experiment')).toBeTruthy();
    expect(screen.getByText('Hidden')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Hide all' }));
    expect(onHideAllThreads).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Restore hidden' }));
    expect(onRestoreAllHiddenThreads).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open thread Fix checkout race condition' }));
    expect(onThreadFocus).toHaveBeenCalledWith('thread-active');

    fireEvent.click(screen.getByRole('button', { name: 'Hide thread Fix checkout race condition' }));
    expect(onThreadHide).toHaveBeenCalledWith('thread-active');

    fireEvent.click(screen.getByRole('button', { name: 'Restore thread Old prompt experiment' }));
    expect(onThreadRestore).toHaveBeenCalledWith('thread-hidden');
  });
});
