import { describe, expect, it } from 'vitest';
import { cleanNodeFailureReason, getNodeFailureReason } from './nodeFailureReason';

describe('nodeFailureReason', () => {
  it('unwraps nested provider JSON into a human-readable message', () => {
    const reason = JSON.stringify({
      error: {
        message: JSON.stringify({
          type: 'error',
          status: 400,
          error: {
            type: 'invalid_request_error',
            message: "The 'gpt-5-nano' model is not supported when using Codex with a ChatGPT account.",
          },
        }),
      },
      willRetry: false,
    });

    expect(cleanNodeFailureReason(reason)).toBe(
      "The 'gpt-5-nano' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it('keeps ordinary failure text and honors execution-data precedence', () => {
    expect(getNodeFailureReason({ failure_reason: 'Provider timed out.' }, 'Fallback')).toBe('Provider timed out.');
    expect(cleanNodeFailureReason('  Plain failure  ')).toBe('Plain failure');
  });
});
