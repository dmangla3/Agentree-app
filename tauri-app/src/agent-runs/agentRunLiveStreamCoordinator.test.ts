// @vitest-environment jsdom
import '../test/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunManager } from './agentRunManager';
import {
  startAgentRunLiveStreamCoordinator,
  trackAgentRunLiveStreamMessage,
} from './agentRunLiveStreamCoordinator';
import { agentClient } from '../lib/agentClient';

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    onEvent: vi.fn(),
  },
}));

describe('agent run live stream coordinator', () => {
  let listener: ((payload: { nodeId: string; event: Record<string, any> }) => void) | null = null;
  let unlisten: (() => void) & { mock: ReturnType<typeof vi.fn>['mock'] };

  beforeEach(() => {
    listener = null;
    unlisten = vi.fn() as any;
    vi.mocked(agentClient.onEvent).mockImplementation(async (nextListener: any) => {
      listener = nextListener;
      return unlisten;
    });
    agentRunManager.clearAll();
  });

  afterEach(() => {
    agentRunManager.clearAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('subscribes once and ingests live content without ChatInput mounted', async () => {
    const stop = startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => 'workspace-1',
    });
    await Promise.resolve();

    trackAgentRunLiveStreamMessage({
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      parentId: 'user-1',
      workspaceId: 'workspace-1',
      agent_id: 'codex',
      status: 'running',
      execution_data: { current_run_id: 'run-1' },
    } as any);

    listener?.({
      nodeId: 'assistant-1',
      event: {
        type: 'message_delta',
        delta: 'hello',
        run_id: 'run-1',
        stream_seq: 1,
        timestamp: 1,
      },
    });

    expect(agentRunManager.snapshot('assistant-1')?.content).toBe('hello');
    expect(agentClient.onEvent).toHaveBeenCalledTimes(1);

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('restores a completed provider item to the timeline after reconnecting with loaded content', async () => {
    const stop = startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => 'workspace-1',
    });
    await Promise.resolve();

    trackAgentRunLiveStreamMessage({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Auditing compatibility now.',
      parentId: 'user-1',
      workspaceId: 'workspace-1',
      agent_id: 'codex',
      status: 'running',
      execution_data: {
        current_run_id: 'run-1',
        timeline: [{
          type: 'tool_use',
          toolName: 'commandExecution',
          toolUseId: 'tool-1',
          timestamp: 10,
        }],
      },
    } as any);

    listener?.({
      nodeId: 'assistant-1',
      event: {
        type: 'message_completed',
        content: 'Auditing compatibility now.',
        provider_item_id: 'msg-1',
        run_id: 'run-1',
        stream_seq: 2,
        timestamp: 20,
      },
    });

    expect(agentRunManager.snapshot('assistant-1')?.timeline).toEqual([
      expect.objectContaining({ type: 'tool_use', toolUseId: 'tool-1' }),
      expect.objectContaining({
        type: 'message',
        provider_item_id: 'msg-1',
        content: 'Auditing compatibility now.',
      }),
    ]);

    stop();
  });

  it('shares one native subscription across multiple coordinator mounts', async () => {
    const stopA = startAgentRunLiveStreamCoordinator({ getSelectedWorkspaceId: () => 'workspace-1' });
    const stopB = startAgentRunLiveStreamCoordinator({ getSelectedWorkspaceId: () => 'workspace-1' });
    await Promise.resolve();

    expect(agentClient.onEvent).toHaveBeenCalledTimes(1);

    stopA();
    expect(unlisten).not.toHaveBeenCalled();
    stopB();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('surfaces a generated commit landing warning from finalization', async () => {
    const onLandingWarning = vi.fn();
    const stop = startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => 'workspace-1',
      onLandingWarning,
    });
    await Promise.resolve();

    listener?.({
      nodeId: 'assistant-landing-warning',
      event: {
        type: 'finalize_ack',
        run_id: 'run-1',
        status: 'completed',
        commit_created: true,
        output_commit_sha: '4a5b11e3ef6b78ec',
        landing_warning: 'Target branch main moved while the merge was running.',
      },
    });

    expect(onLandingWarning).toHaveBeenCalledWith({
      nodeId: 'assistant-landing-warning',
      message: 'Target branch main moved while the merge was running.',
      outputCommitSha: '4a5b11e3ef6b78ec',
    });

    stop();
  });

  it('retries a transient subscription failure and ingests the next event', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(agentClient.onEvent).mockRejectedValueOnce(new Error('transient failure'));

    const stop = startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => 'workspace-1',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(agentClient.onEvent).toHaveBeenCalledTimes(1);

    await vi.runOnlyPendingTimersAsync();

    expect(agentClient.onEvent).toHaveBeenCalledTimes(2);

    listener?.({
      nodeId: 'assistant-retry',
      event: {
        type: 'message_delta',
        delta: 'recovered',
        run_id: 'run-1',
        stream_seq: 1,
        timestamp: 1,
      },
    });

    expect(agentRunManager.snapshot('assistant-retry')?.content).toBe('recovered');

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('cancels a scheduled subscription retry when the last coordinator stops', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(agentClient.onEvent).mockRejectedValueOnce(new Error('transient failure'));

    const stop = startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => 'workspace-1',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(1);

    stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(agentClient.onEvent).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated subscription failures', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(agentClient.onEvent).mockRejectedValue(new Error('persistent failure'));

    const stop = startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => 'workspace-1',
    });
    await Promise.resolve();
    await Promise.resolve();

    await vi.runAllTimersAsync();

    expect(agentClient.onEvent).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);

    stop();

    vi.mocked(agentClient.onEvent).mockImplementation(async (nextListener: any) => {
      listener = nextListener;
      return unlisten;
    });
    const stopFreshMount = startAgentRunLiveStreamCoordinator({
      getSelectedWorkspaceId: () => 'workspace-1',
    });
    await Promise.resolve();

    expect(agentClient.onEvent).toHaveBeenCalledTimes(5);

    stopFreshMount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
