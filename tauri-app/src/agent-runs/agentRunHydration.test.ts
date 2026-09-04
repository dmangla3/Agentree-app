import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunManager } from './agentRunManager';
import {
  ensureAgentRunHydrated,
  ingestAgentRunStreamEvent,
  resetAgentRunHydrationForTest,
} from './agentRunHydration';
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

  it('applies provider stop final content as authoritative during hydration', async () => {
    agentRunManager.watch('assistant-1', 'hover');
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
        lastSeq: 4,
      },
    });
    mockAgentClient.replayAgentRunEvents.mockResolvedValue([
      {
        runId: 'run-1',
        assistantNodeId: 'assistant-1',
        seq: 1,
        eventType: 'message_completed',
        status: null,
        phase: null,
        payload: JSON.stringify({ type: 'message_completed', content: 'Working on the fix.', stream_seq: 1 }),
        timestamp: 1_779_867_200,
      },
      {
        runId: 'run-1',
        assistantNodeId: 'assistant-1',
        seq: 2,
        eventType: 'tool_use',
        status: null,
        phase: null,
        payload: JSON.stringify({ type: 'tool_use', name: 'shell', id: 'tool-1', stream_seq: 2 }),
        timestamp: 1_779_867_201,
      },
      {
        runId: 'run-1',
        assistantNodeId: 'assistant-1',
        seq: 3,
        eventType: 'message_completed',
        status: null,
        phase: null,
        payload: JSON.stringify({ type: 'message_completed', content: 'Working on the fix. Checking tests.', stream_seq: 3 }),
        timestamp: 1_779_867_202,
      },
      {
        runId: 'run-1',
        assistantNodeId: 'assistant-1',
        seq: 4,
        eventType: 'provider_stop',
        status: null,
        phase: null,
        payload: JSON.stringify({
          type: 'provider_stop',
          provider_status: 'completed',
          provider_stop_reason: 'end_turn',
          provider_thread_id: 'thread-1',
          provider_turn_id: 'turn-1',
          final_content: 'Implemented.\n\nVerification passed.',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          stream_seq: 3,
        }),
        timestamp: 1_779_867_203,
      },
    ]);

    await ensureAgentRunHydrated('assistant-1', 'hover');

    const snapshot = agentRunManager.snapshot('assistant-1');
    const projection = useAgentRunProjectionStore.getState().projectionsById['assistant-1'];
    const messageEvents = snapshot?.timeline.filter((event: any) => event?.type === 'message') ?? [];
    const toolEvents = snapshot?.timeline.filter((event: any) => event?.type === 'tool_use') ?? [];

    expect(snapshot?.content).toBe('Implemented.\n\nVerification passed.');
    expect(projection?.content).toBe('Implemented.\n\nVerification passed.');
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0].content).toBe('Implemented.\n\nVerification passed.');
    expect(toolEvents).toHaveLength(1);
    expect(snapshot?.lastSeq).toBe(4);
    expect(snapshot?.lastStreamSeq).toBe(3);
    expect(snapshot?.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(snapshot?.executionData).toMatchObject({
      provider_terminal_status: 'completed',
      provider_stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      meta: {
        provider_thread_id: 'thread-1',
        provider_turn_id: 'turn-1',
      },
    });
  });

  it('keeps provider item deltas and completions from duplicating live transcript rows', () => {
    const input = {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant' as const,
      agentId: 'codex',
      runId: 'run-1',
      status: 'running' as const,
      executionData: { current_run_id: 'run-1' },
    };
    const streamState = {
      output: '',
      providerItemId: null,
    };

    ingestAgentRunStreamEvent('assistant-1', {
      type: 'message_delta',
      delta: 'First line.',
      provider_item_id: 'msg-1',
      stream_seq: 1,
    }, input, streamState);
    ingestAgentRunStreamEvent('assistant-1', {
      type: 'message_completed',
      content: 'First line.',
      provider_item_id: 'msg-1',
      stream_seq: 2,
    }, input, streamState);
    ingestAgentRunStreamEvent('assistant-1', {
      type: 'tool_use',
      id: 'tool-1',
      name: 'commandExecution',
      stream_seq: 3,
    }, input, streamState);
    ingestAgentRunStreamEvent('assistant-1', {
      type: 'message_delta',
      delta: 'I',
      provider_item_id: 'msg-2',
      stream_seq: 4,
    }, input, streamState);
    ingestAgentRunStreamEvent('assistant-1', {
      type: 'message_delta',
      delta: ' will continue.',
      provider_item_id: 'msg-2',
      stream_seq: 5,
    }, input, streamState);
    ingestAgentRunStreamEvent('assistant-1', {
      type: 'message_completed',
      content: 'I will continue.',
      provider_item_id: 'msg-2',
      stream_seq: 6,
    }, input, streamState);

    const snapshot = agentRunManager.snapshot('assistant-1');
    const messageEvents = snapshot?.timeline.filter((event: any) => event?.type === 'message') ?? [];

    expect(snapshot?.content).toBe('First line.I will continue.');
    expect(messageEvents.map((event: any) => event.content)).toEqual([
      'First line.',
      'I will continue.',
    ]);
  });

  it('ignores stale finalize acks before they can mutate the current run', () => {
    agentRunManager.dispatch('assistant-1', {
      type: 'status',
      status: 'running',
    }, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      agentId: 'codex',
      runId: 'run-current',
      status: 'running',
      executionData: { current_run_id: 'run-current' },
    });

    ingestAgentRunStreamEvent('assistant-1', {
      type: 'finalize_ack',
      run_id: 'run-old',
      status: 'completed',
      output_commit_sha: 'old-commit',
    }, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      agentId: 'codex',
      runId: 'run-old',
      status: 'running',
      executionData: { current_run_id: 'run-old' },
    }, {
      output: 'current output',
      providerItemId: null,
    });

    const staleSnapshot = agentRunManager.snapshot('assistant-1');
    expect(staleSnapshot?.runId).toBe('run-current');
    expect(staleSnapshot?.status).toBe('running');
    expect(staleSnapshot?.finalizeAck).toBeNull();
    expect(staleSnapshot?.executionData.meta?.output_commit_sha).toBeUndefined();

    ingestAgentRunStreamEvent('assistant-1', {
      type: 'finalize_ack',
      run_id: 'run-current',
      status: 'completed',
      output_commit_sha: 'current-commit',
    }, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
      agentId: 'codex',
      runId: 'run-current',
      status: 'running',
      executionData: { current_run_id: 'run-current' },
    }, {
      output: 'current output',
      providerItemId: null,
    });

    const currentSnapshot = agentRunManager.snapshot('assistant-1');
    expect(currentSnapshot?.runId).toBe('run-current');
    expect(currentSnapshot?.status).toBe('completed');
    expect(currentSnapshot?.finalizeAck?.outputCommitSha).toBe('current-commit');
  });

  it('hydrates thinking and steering journal events into the timeline', async () => {
    agentRunManager.watch('assistant-1', 'hover');
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
        eventType: 'thinking',
        status: null,
        phase: null,
        payload: JSON.stringify({ type: 'thinking', content: 'Reading the runtime.', stream_seq: 1 }),
        timestamp: 1_779_867_200,
      },
      {
        runId: 'run-1',
        assistantNodeId: 'assistant-1',
        seq: 2,
        eventType: 'user_steer_requested',
        status: null,
        phase: null,
        payload: JSON.stringify({
          type: 'user_steer_requested',
          content: 'Use the cached result.',
          idempotency_key: 'steer-1',
          stream_seq: 2,
        }),
        timestamp: 1_779_867_201,
      },
    ]);

    await ensureAgentRunHydrated('assistant-1', 'hover');

    expect(agentRunManager.snapshot('assistant-1')?.timeline).toEqual([
      expect.objectContaining({
        type: 'thinking',
        content: 'Reading the runtime.',
      }),
      expect.objectContaining({
        type: 'user_steer_requested',
        content: 'Use the cached result.',
        idempotencyKey: 'steer-1',
      }),
    ]);
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.execution_data?.timeline).toEqual(
      agentRunManager.snapshot('assistant-1')?.timeline,
    );
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
