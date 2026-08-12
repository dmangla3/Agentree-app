import { describe, expect, it } from 'vitest';
import type { TelemetrySessionSnapshot } from '../../lib/agentClient';
import { getMergeReviewTerminalReconciliation } from './mergeReviewReconcile';

const snapshot = (
  status: TelemetrySessionSnapshot['status'],
  events: TelemetrySessionSnapshot['events'] = [],
): TelemetrySessionSnapshot => ({
  sessionId: 'review-run',
  status,
  createdAt: 1,
  events,
});

describe('getMergeReviewTerminalReconciliation', () => {
  it('ignores non-terminal snapshots', () => {
    expect(getMergeReviewTerminalReconciliation(null)).toBeNull();
    expect(getMergeReviewTerminalReconciliation(snapshot('running'))).toBeNull();
  });

  it('reconstructs a completed result from persisted merge review events', () => {
    const result = {
      summary: {
        overallVerdict: 'safe' as const,
        summaryText: 'Looks safe.',
        riskLevel: 'low' as const,
        changedFilesCount: 2,
        riskyFilesCount: 0,
      },
      issues: [],
    };

    expect(getMergeReviewTerminalReconciliation(snapshot('completed', [
      {
        eventType: 'merge_review:result',
        data: JSON.stringify({ type: 'result', result }),
        timestamp: 2,
      },
    ]))).toEqual({
      status: 'completed',
      result,
      message: 'Merge review completed while the UI was detached.',
    });
  });

  it('reports cancelled snapshots as terminal without a result', () => {
    expect(getMergeReviewTerminalReconciliation(snapshot('cancelled'))).toEqual({
      status: 'cancelled',
      result: null,
      message: 'Merge review was cancelled while the UI was detached.',
    });
  });
});
