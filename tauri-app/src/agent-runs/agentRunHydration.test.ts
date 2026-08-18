import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunManager } from './agentRunManager';
import { ensureAgentRunHydrated, resetAgentRunHydrationForTest } from './agentRunHydration';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { useRunStatusStore } from '../stores/runStatusStore';
import { agentClient } from '../lib/agentClient';

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    getAgentRunState: vi.fn(),
    replayAgentRunEvents: vi.fn(),
  },
}));

const mockAgentClient = vi.mocked(agentClient);

describe('agent run hydration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    resetAgentRunHydrationForTest();
    agentRunManager.clearAll();
    useAgentRunProjectionStore.getState().clearAllProjections();
    useRunStatusStore.getState().clearAllRunStatus();
    mockAgentClient.getAgentRunState.mockReset();
    mockAgentClient.replayAgentRunEvents.mockReset();
  });

  afterEach(() => {
    resetAgentRunHydrationForTest();
    agentRunManager.clearAll();
    useAgentRunProjectionStore.getState().clearAllProjections();
    useRunStatusStore.getState().clearAllRunStatus();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('hydrates a running native journal into the shared actor projection once', async () => {
    mockAgentClient.getAgentRunState.mockResolvedValue({
      running: true,
      pid: 123,
      ledger: {
        runId: 'run-1',
        userNodeId: 'user-1',
        assistantNodeId: 'assistant-1',
        workspaceId: 'workspace-1',
        status: 'running',
        phase: 'running',
        lastSeq: 2,
      },
    });
    mockAgentClient.replayAgentRunEvents.mockResolvedValue([
      {
        runId: 'run-1',
        assistantNodeId: 'assistant-1',
        seq: 1,
        eventType: 'message_delta',
        status: null,
        phase: null,
        payload: JSON.stringify({ type: 'message_delta', delta: 'hello', stream_seq: 1 }),
        timestamp: 1_779_867_200,
      },
      {
        runId: 'run-1',
        assistantNodeId: 'assistant-1',
        seq: 2,
        eventType: 'usage',
        status: null,
        phase: null,
        payload: JSON.stringify({ type: 'usage', usage: { total_tokens: 42 }, stream_seq: 2 }),
        timestamp: 1_779_867_201,
      },
    ]);

    const [first, second] = await Promise.all([
      ensureAgentRunHydrated('assistant-1', 'hover'),
      ensureAgentRunHydrated('assistant-1', 'hover'),
    ]);

    expect(first.status).toBe('hydrated');
    expect(second.status).toBe('hydrated');
    expect(mockAgentClient.getAgentRunState).toHaveBeenCalledTimes(1);
    expect(mockAgentClient.replayAgentRunEvents).toHaveBeenCalledTimes(1);
    expect(mockAgentClient.replayAgentRunEvents).toHaveBeenCalledWith('run-1', 0);
    expect(agentRunManager.snapshot('assistant-1')?.workspaceId).toBe('workspace-1');
    expect(agentRunManager.snapshot('assistant-1')?.parentId).toBe('user-1');
    expect(agentRunManager.snapshot('assistant-1')?.runId).toBe('run-1');
    expect(agentRunManager.snapshot('assistant-1')?.lastSeq).toBe(2);
    expect(agentRunManager.snapshot('assistant-1')?.usage?.total_tokens).toBe(42);
  });

  it('does not replay when the existing actor is already caught up to the ledger', async () => {
    agentRunManager.dispatch('assistant-1', {
      type: 'native_event',
      event: { type: 'usage', seq: 3, usage: { total_tokens: 99 } },
    }, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      runId: 'run-1',
      status: 'running',
    });
    agentRunManager.dispatch('assistant-1', {
      type: 'usage',
      usage: { total_tokens: 99 },
    });
    mockAgentClient.getAgentRunState.mockResolvedValue({
      running: true,
      pid: 123,
      ledger: {
        runId: 'run-1',
        userNodeId: 'user-1',
        assistantNodeId: 'assistant-1',
        workspaceId: 'workspace-1',
        status: 'running',
        phase: 'running',
        lastSeq: 3,
      },
    });

    const result = await ensureAgentRunHydrated('assistant-1', 'hover');

    expect(result.status).toBe('already-current');
    expect(mockAgentClient.replayAgentRunEvents).not.toHaveBeenCalled();
    expect(agentRunManager.snapshot('assistant-1')?.usage?.total_tokens).toBe(99);
  });
});
