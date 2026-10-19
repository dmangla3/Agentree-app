import { describe, expect, it } from 'vitest';
import { presentTimelineError } from './errorPresentation';

describe('presentTimelineError', () => {
  it('turns Codex reconnect payloads into a readable retry notice', () => {
    const presentation = presentTimelineError(JSON.stringify({
      error: {
        additionalDetails: 'unexpected status 503 Service Unavailable: Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: a20ad5df7b714bda-DEL, auth error: 503, auth error code: biscuit_baker_service_me_circuit_open',
        codexErrorInfo: {
          responseStreamDisconnected: { httpStatusCode: 503 },
        },
        message: 'Reconnecting... 3/5',
      },
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
    }));

    expect(presentation).toEqual(expect.objectContaining({
      title: 'Connection interrupted',
      message: 'The service is temporarily unavailable. Agentree will keep trying automatically.',
      isRetrying: true,
      retryAttempt: 3,
      retryLimit: 5,
      httpStatus: 503,
      errorCode: 'biscuit_baker_service_me_circuit_open',
    }));
    expect(presentation.technicalDetails).toContain('"threadId": "thread-1"');
  });

  it('keeps a useful high-demand explanation while formatting retry progress', () => {
    const presentation = presentTimelineError({
      error: {
        additionalDetails: "We're currently experiencing high demand, which may cause temporary errors.",
        codexErrorInfo: {
          responseStreamDisconnected: { httpStatusCode: null },
        },
        message: 'Reconnecting... 4/5',
      },
      willRetry: true,
    });

    expect(presentation.message).toBe(
      "We're currently experiencing high demand, which may cause temporary errors.",
    );
    expect(presentation.retryAttempt).toBe(4);
    expect(presentation.retryLimit).toBe(5);
  });

  it('unwraps nested provider errors and preserves plain text failures', () => {
    const nested = presentTimelineError(JSON.stringify({
      error: {
        message: JSON.stringify({
          status: 400,
          error: {
            type: 'invalid_request_error',
            message: 'This model is not supported.',
          },
        }),
      },
      willRetry: false,
    }));

    expect(nested).toEqual(expect.objectContaining({
      title: 'Request failed',
      message: 'This model is not supported.',
      isRetrying: false,
      httpStatus: 400,
      errorCode: 'invalid_request_error',
    }));
    expect(presentTimelineError('Provider timed out.')).toEqual(expect.objectContaining({
      title: 'Error',
      message: 'Provider timed out.',
      technicalDetails: null,
    }));
  });
});
