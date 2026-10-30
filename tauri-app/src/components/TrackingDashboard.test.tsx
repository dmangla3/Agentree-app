/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackingDashboardMetrics } from '../domain/trackingDashboardMetrics';
import { useTrackingDashboardData } from '../hooks/useTrackingDashboardData';
import { TrackingDashboard } from './TrackingDashboard';

vi.mock('../hooks/useTrackingDashboardData', () => ({
  useTrackingDashboardData: vi.fn(),
}));

const metrics: TrackingDashboardMetrics = {
  range: '7d',
  startedAt: '2026-08-03T00:00:00.000Z',
  endedAt: '2026-08-09T12:00:00.000Z',
  totals: {
    commits: 3,
    agentCommits: 2,
    mergeCommits: 1,
    manualCommits: 0,
    externalCommits: 0,
    locAdded: 120,
    locDeleted: 30,
    netLoc: 90,
    locKnownCommits: 3,
    locCoveragePercent: 100,
    promptTokens: 1200,
    completionTokens: 300,
    totalTokens: 1500,
    uncachedInputTokens: 900,
    cachedInputTokens: 250,
    cacheCreationInputTokens: 50,
    outputTokens: 300,
    reasoningTokens: 80,
    tokenEligibleRuns: 2,
    tokenKnownRuns: 2,
    tokenCoveragePercent: 100,
    tokensPerCommit: 500,
    tokensPerLocAdded: 12.5,
    estimatedCostUsd: 0.42,
    inputCostUsd: 0.12,
    outputCostUsd: 0.3,
    cacheSavingsUsd: 0.04,
    costEligibleRuns: 2,
    costKnownRuns: 2,
    costCoveragePercent: 100,
    unpricedTokens: 0,
    providerReportedRuns: 1,
    modelPricedRuns: 1,
  },
  buckets: [
    {
      key: '2026-08-08',
      label: 'Aug 8',
      commitCount: 1,
      locAdded: 40,
      locDeleted: 10,
      netLoc: 30,
      promptTokens: 400,
      completionTokens: 100,
      totalTokens: 500,
      inputCostUsd: 0.04,
      outputCostUsd: 0.08,
      costUsd: 0.12,
      cacheSavingsUsd: 0.01,
    },
    {
      key: '2026-08-09',
      label: 'Aug 9',
      commitCount: 2,
      locAdded: 80,
      locDeleted: 20,
      netLoc: 60,
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
      inputCostUsd: 0.08,
      outputCostUsd: 0.22,
      costUsd: 0.3,
      cacheSavingsUsd: 0.03,
    },
  ],
  recentRuns: [
    {
      nodeId: 'run-1',
      label: 'Improve tracking dashboard',
      status: 'completed',
      createdAt: '2026-08-09T10:00:00.000Z',
      commitCount: 2,
      locAdded: 80,
      locDeleted: 20,
      netLoc: 60,
      totalTokens: 1000,
      provider: 'claude',
      model: 'claude-sonnet-5',
      costUsd: 0.3,
      costSource: 'modelPriced',
    },
  ],
  modelUsage: [
    {
      key: 'claude:claude-sonnet-5',
      provider: 'claude',
      model: 'claude-sonnet-5',
      runCount: 2,
      pricedRunCount: 2,
      unpricedRunCount: 0,
      totalTokens: 1500,
      costUsd: 0.42,
      cacheSavingsUsd: 0.04,
      costShare: 1,
    },
  ],
  pricing: {
    status: 'fresh',
    source: 'test-rates',
    fetchedAt: '2026-08-09T12:00:00.000Z',
    knownModels: 1,
  },
  backgroundAttention: {
    totals: {
      runCount: 1,
      candidateCount: 2,
      surfacedCount: 1,
      savedCount: 1,
      archivedCount: 0,
      promptTokens: 200,
      completionTokens: 50,
      totalTokens: 250,
      auditEventCount: 1,
      queuedTriggers: 1,
      ranTriggers: 1,
      skippedTriggers: 0,
      failedTriggers: 0,
      baselineEvents: 0,
    },
    buckets: [
      {
        key: '2026-08-09',
        label: 'Aug 9',
        runCount: 1,
        candidateCount: 2,
        surfacedCount: 1,
        savedCount: 1,
        archivedCount: 0,
        promptTokens: 200,
        completionTokens: 50,
        totalTokens: 250,
        queuedTriggers: 1,
        ranTriggers: 1,
        skippedTriggers: 0,
        failedTriggers: 0,
        baselineEvents: 0,
      },
    ],
    recentAuditEvents: [],
  },
};

describe('TrackingDashboard', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.mocked(useTrackingDashboardData).mockReturnValue({
      metrics,
      isLoading: false,
      isRefreshing: false,
      error: null,
    });
  });

  it('switches the overview between code output and token usage', async () => {
    const user = userEvent.setup();
    render(<TrackingDashboard workspace={null} />);

    expect(screen.getByText('Net code output')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Daily code output' })).toBeTruthy();

    const metricControl = screen.getByRole('group', { name: 'Daily activity metric' });
    await user.click(within(metricControl).getByRole('button', { name: 'Tokens' }));

    expect(screen.getAllByText('Processed tokens')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Daily token usage' })).toBeTruthy();
  });

  it('shows commit-source detail and updates the requested date range', async () => {
    const user = userEvent.setup();
    render(<TrackingDashboard workspace={null} />);

    const breakdownControl = screen.getByRole('group', { name: 'Tracking breakdown' });
    await user.click(within(breakdownControl).getByRole('button', { name: 'Source' }));

    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.getByText('66.7%')).toBeTruthy();

    const rangeControl = screen.getByRole('group', { name: 'Tracking date range' });
    await user.click(within(rangeControl).getByRole('button', { name: '30 days' }));

    expect(useTrackingDashboardData).toHaveBeenLastCalledWith(null, '30d');
  });

  it('shows estimated cost with pricing coverage and a per-model breakdown', async () => {
    const user = userEvent.setup();
    render(<TrackingDashboard workspace={null} />);

    const metricControl = screen.getByRole('group', { name: 'Daily activity metric' });
    await user.click(within(metricControl).getByRole('button', { name: 'Cost' }));

    expect(screen.getByText('Estimated raw cost')).toBeTruthy();
    expect(screen.getByText(/API-equivalent estimate/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Daily estimated cost' })).toBeTruthy();

    const breakdownControl = screen.getByRole('group', { name: 'Tracking breakdown' });
    await user.click(within(breakdownControl).getByRole('button', { name: 'Model' }));

    expect(screen.getByText('claude-sonnet-5')).toBeTruthy();
    expect(screen.getByText('100.0%')).toBeTruthy();
  });

  it('keeps a single-day chart legible without repeating its date', () => {
    vi.mocked(useTrackingDashboardData).mockReturnValue({
      metrics: { ...metrics, buckets: [metrics.buckets[0]!] },
      isLoading: false,
      isRefreshing: false,
      error: null,
    });

    render(<TrackingDashboard workspace={null} />);

    const chart = screen.getByTestId('tracking-throughput-chart');
    expect(within(chart).getAllByText('Aug 8')).toHaveLength(1);
    expect(chart.querySelectorAll('circle')).toHaveLength(2);
  });
});
