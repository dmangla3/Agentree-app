import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLocalSyncPause,
  getLocalSyncPauseState,
  reportLocalSyncFailure,
  reportLocalSyncSuccess,
  shouldSkipLocalSync,
  subscribeToLocalSyncPause,
} from './localSyncDiagnostics';

describe('localSyncDiagnostics', () => {
  beforeEach(() => {
    clearLocalSyncPause();
  });

  it('pauses local sync for schema-mismatch failures and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLocalSyncPause(listener);

    reportLocalSyncFailure(new Error('node.delete failed with status 500 Internal Server Error: column "thread_id" does not exist'));

    const state = getLocalSyncPauseState();
    expect(state.paused).toBe(true);
    expect(state.reason).toBe('server_schema_not_ready');
    expect(shouldSkipLocalSync()).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      paused: true,
      reason: 'server_schema_not_ready',
    }));

    unsubscribe();
  });

  it('keeps sync paused after repeated server errors until explicitly cleared', () => {
    reportLocalSyncFailure(new Error('node.delete failed with status 500 Internal Server Error'));
    reportLocalSyncFailure(new Error('node.update_terminal transport error: operation timed out'));
    reportLocalSyncSuccess();

    expect(getLocalSyncPauseState()).toEqual(expect.objectContaining({
      paused: true,
      reason: 'server_timeout',
      failureCount: 2,
    }));

    clearLocalSyncPause();
    expect(shouldSkipLocalSync()).toBe(false);
  });

  it('does not pause local sync after a single retryable timeout', () => {
    reportLocalSyncFailure(new Error('node.update_terminal transport error: operation timed out'));

    expect(getLocalSyncPauseState()).toEqual(expect.objectContaining({
      paused: false,
      reason: 'server_timeout',
      failureCount: 1,
    }));
    expect(shouldSkipLocalSync()).toBe(false);
  });

  it('classifies readiness query timeouts as server timeouts, not missing schema', () => {
    reportLocalSyncFailure(new Error('Server readiness check failed with status 503'), {
      readiness: {
        status: 'not_ready',
        database: { ok: false, error: 'readiness query timed out after 2000ms' },
        missingMigrations: [],
        missingTables: [],
        missingColumns: [],
      },
    });

    expect(getLocalSyncPauseState()).toEqual(expect.objectContaining({
      paused: true,
      reason: 'server_timeout',
      message: 'Local sync is paused because backend requests are timing out.',
      detail: 'database: readiness query timed out after 2000ms',
    }));
  });
});
