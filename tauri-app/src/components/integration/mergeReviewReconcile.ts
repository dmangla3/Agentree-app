import type { MergeReviewResult, MergeReviewRunStatus, TelemetrySessionSnapshot } from '../../lib/agentClient';

export type MergeReviewTerminalReconciliation =
  | {
      status: 'completed';
      result: MergeReviewResult | null;
      message: string;
    }
  | {
      status: 'failed' | 'cancelled';
      result: null;
      message: string;
    };

const parseMergeReviewResult = (data: string): MergeReviewResult | null => {
  try {
    const parsed = JSON.parse(data);
    return parsed?.type === 'result' && parsed.result ? parsed.result as MergeReviewResult : null;
  } catch {
    return null;
  }
};

export const getMergeReviewTerminalReconciliation = (
  snapshot: TelemetrySessionSnapshot | null,
): MergeReviewTerminalReconciliation | null => {
  const status = snapshot?.status as MergeReviewRunStatus | undefined;
  if (!status || status === 'idle' || status === 'running') return null;

  if (status === 'completed') {
    const result = [...(snapshot?.events ?? [])]
      .reverse()
      .find((event) => event.eventType === 'merge_review:result');
    return {
      status,
      result: result ? parseMergeReviewResult(result.data) : null,
      message: 'Merge review completed while the UI was detached.',
    };
  }

  if (status === 'cancelled') {
    return {
      status,
      result: null,
      message: 'Merge review was cancelled while the UI was detached.',
    };
  }

  return {
    status: 'failed',
    result: null,
    message: 'Merge review stopped before the UI received a terminal event.',
  };
};
