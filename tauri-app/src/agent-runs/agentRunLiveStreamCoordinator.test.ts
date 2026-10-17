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
});
