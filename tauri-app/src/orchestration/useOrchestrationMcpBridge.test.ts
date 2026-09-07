import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { localNodeKeys, type LocalNodeMessage } from '../hooks/useLocalNodes';
import type { Message } from '../stores/workspaceStore';
import {
  getOrchestrationChildStartKey,
  getOrStartPendingOrchestrationChild,
  isOrchestrationWaitCondition,
  isOrchestrationWaitSatisfied,
  mergeMessagesWithLiveWaitProjections,
  ORCHESTRATION_WAIT_CONDITIONS,
  patchOrchestrationWaitMessagesIntoCaches,
} from './useOrchestrationMcpBridge';

const message = (input: Partial<Message> & { id: string; role?: Message['role'] }): Message => ({
  role: 'assistant',
  content: '',
  parentId: null,
  workspaceId: 'workspace-1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...input,
} as Message);

describe('orchestration MCP wait helpers', () => {
  it('keeps bridge wait conditions aligned with the orchestrator tool vocabulary', () => {
    expect(ORCHESTRATION_WAIT_CONDITIONS).toEqual([
      'terminal',
      'all',
      'any',
      'completed',
      'failed',
      'commit_available',
      'any_terminal',
      'any_failed',
    ]);
    expect(isOrchestrationWaitCondition('all')).toBe(true);
    expect(isOrchestrationWaitCondition('any')).toBe(true);
    expect(isOrchestrationWaitCondition('failed')).toBe(true);
    expect(isOrchestrationWaitCondition('pending')).toBe(false);
  });

  it('supports all/any/failed aliases when checking child run completion', () => {
    const messages = [
      message({ id: 'done-child', status: 'completed' as any }),
      message({ id: 'failed-child', status: 'failed_runtime' as any }),
      message({ id: 'running-child', status: 'running' as any }),
    ];

    expect(isOrchestrationWaitSatisfied({
      assistantNodeIds: ['done-child', 'failed-child'],
      condition: 'all',
    }, messages)).toBe(true);
    expect(isOrchestrationWaitSatisfied({
      assistantNodeIds: ['done-child', 'running-child'],
      condition: 'all',
    }, messages)).toBe(false);
    expect(isOrchestrationWaitSatisfied({
      assistantNodeIds: ['running-child', 'done-child'],
      condition: 'any',
    }, messages)).toBe(true);
    expect(isOrchestrationWaitSatisfied({
      assistantNodeIds: ['running-child', 'failed-child'],
      condition: 'failed',
    }, messages)).toBe(true);
  });

  it('lets live run projections satisfy waits before persisted messages refresh', () => {
    const persisted = [
      message({
        id: 'child',
        status: 'running' as any,
        execution_data: { last_terminal_status: null },
      }),
    ];
    const merged = mergeMessagesWithLiveWaitProjections(persisted, {
      child: message({
        id: 'child',
        status: 'completed' as any,
        execution_data: { last_terminal_status: 'completed' },
      }) as any,
    });

    expect(isOrchestrationWaitSatisfied({
      assistantNodeIds: ['child'],
      condition: 'completed',
    }, merged)).toBe(true);
  });

  it('patches waited terminal child messages into graph-facing query caches', () => {
    const queryClient = new QueryClient();
    const staleChild = message({
      id: 'child',
      status: 'running' as any,
      execution_data: { last_terminal_status: null },
    });
    const completedChild = message({
      ...staleChild,
      status: 'completed' as any,
      content: 'done',
      execution_data: { last_terminal_status: 'completed' },
    });
    queryClient.setQueryData<Message[]>(['messages', 'workspace-1'], [staleChild]);
    queryClient.setQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'), [{
      nodeId: 'child',
      workspaceId: 'workspace-1',
      syncStatus: 'local_only',
      finalizedAt: 1,
      retryAttempt: 0,
      message: staleChild,
    }]);

    patchOrchestrationWaitMessagesIntoCaches(queryClient, {
      assistantNodeIds: ['child'],
    }, [completedChild]);

    expect(queryClient.getQueryData<Message[]>(['messages', 'workspace-1'])?.[0]).toMatchObject({
      id: 'child',
      status: 'completed',
      content: 'done',
      execution_data: { last_terminal_status: 'completed' },
    });
    expect(queryClient.getQueryData<LocalNodeMessage[]>(localNodeKeys.workspace('workspace-1'))?.[0].message).toMatchObject({
      id: 'child',
      status: 'completed',
      content: 'done',
      execution_data: { last_terminal_status: 'completed' },
    });
  });
});

describe('orchestration MCP child start idempotency helpers', () => {
  it('shares an in-flight child start for the same orchestrator and decision id', async () => {
    const pending = new Map();
    let starts = 0;
    const key = getOrchestrationChildStartKey('assistant-orchestrator', 'planner-1');
    const start = async () => {
      starts += 1;
      await Promise.resolve();
      return {
        runId: 'run-child',
        userNodeId: 'user-child',
        assistantNodeId: 'assistant-child',
        initialStatus: 'running',
      };
    };

    const [first, second] = await Promise.all([
      getOrStartPendingOrchestrationChild(pending, key, start),
      getOrStartPendingOrchestrationChild(pending, key, start),
    ]);

    expect(starts).toBe(1);
    expect(first).toEqual({
      runId: 'run-child',
      userNodeId: 'user-child',
      assistantNodeId: 'assistant-child',
      initialStatus: 'running',
    });
    expect(second).toEqual({
      ...first,
      existing: true,
    });
    expect(pending.size).toBe(0);
  });

  it('clears failed in-flight child starts so the decision can be retried', async () => {
    const pending = new Map();
    const key = getOrchestrationChildStartKey('assistant-orchestrator', 'planner-1');
    await expect(getOrStartPendingOrchestrationChild(pending, key, async () => {
      throw new Error('launch failed');
    })).rejects.toThrow('launch failed');

    expect(pending.size).toBe(0);
    const retried = await getOrStartPendingOrchestrationChild(pending, key, async () => ({
      runId: 'run-retry',
      userNodeId: 'user-retry',
      assistantNodeId: 'assistant-retry',
      initialStatus: 'running',
    }));

    expect(retried.assistantNodeId).toBe('assistant-retry');
  });
});
