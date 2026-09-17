import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_RUN_STATUS_RETENTION_MS, useRunStatusStore } from './runStatusStore';

describe('runStatusStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRunStatusStore.getState().clearAllRunStatus();
  });

  afterEach(() => {
    useRunStatusStore.getState().clearAllRunStatus();
    vi.useRealTimers();
  });

  it('does not recreate a pruned terminal overlay from a stale terminal projection', () => {
    useRunStatusStore.getState().setRunStatus('assistant-1', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running',
      progress: 'Running...',
    });
    useRunStatusStore.getState().setRunStatus('assistant-1', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'completed',
      progress: 'Commit generated',
    });

    expect(useRunStatusStore.getState().byNodeId['assistant-1']?.status).toBe('completed');

    vi.advanceTimersByTime(TERMINAL_RUN_STATUS_RETENTION_MS);

    expect(useRunStatusStore.getState().byNodeId['assistant-1']).toBeUndefined();

    useRunStatusStore.getState().setRunStatus('assistant-1', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'completed',
      progress: 'Commit generated',
    });

    expect(useRunStatusStore.getState().byNodeId['assistant-1']).toBeUndefined();
  });
});
