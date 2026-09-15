import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { localNodeKeys, type LocalNodeMessage } from '../hooks/useLocalNodes';
import type { Message } from '../stores/workspaceStore';
import {
  buildOrchestrationWaitRunStatuses,
  buildWaitTimeoutSummary,
  buildGraphLiveQuerySummary,
  getOrchestrationRunStartKey,
  getOrStartPendingOrchestrationRun,
  isOrchestrationWaitCondition,
  isOrchestrationWaitSatisfied,
  mergeMessagesWithLiveWaitProjections,
  ORCHESTRATION_WAIT_CONDITIONS,
  ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS,
  ORCHESTRATION_WAIT_MAX_TIMEOUT_MS,
  ORCHESTRATION_WAIT_MIN_TIMEOUT_MS,
  patchOrchestrationWaitMessagesIntoCaches,
  resolveOrchestrationRunLaunchDefaults,
  resolveOrchestrationWaitTimeoutMs,
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

  it('caps wait checkpoints below the provider MCP call timeout', () => {
    expect(resolveOrchestrationWaitTimeoutMs(undefined)).toBe(ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS);
    expect(resolveOrchestrationWaitTimeoutMs(500)).toBe(ORCHESTRATION_WAIT_MIN_TIMEOUT_MS);
    expect(resolveOrchestrationWaitTimeoutMs(30_000)).toBe(30_000);
    expect(resolveOrchestrationWaitTimeoutMs(10 * 60 * 1000)).toBe(ORCHESTRATION_WAIT_MAX_TIMEOUT_MS);
    expect(ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS).toBe(5 * 60 * 1000);
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

  it('includes projection-only child nodes in wait checks', () => {
    const merged = mergeMessagesWithLiveWaitProjections([], {
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
    expect((merged[0].execution_data as any).__local_authority).toEqual({
      source: 'projection',
    });
  });

  it('reports live graph query results from local and projection state', () => {
    const summary = buildGraphLiveQuerySummary({
      filters: { role: 'assistant', status: 'streaming' },
    }, [
      message({ id: 'user', role: 'user', status: null as any }),
      message({
        id: 'child',
        status: 'streaming' as any,
        updatedAt: '2026-06-01T00:01:00.000Z',
        last_event_at: '2026-06-01T00:02:00.000Z',
        output_commit_sha: null,
        execution_data: {
          __local_authority: { source: 'projection' },
        },
      }),
    ], 'workspace-1');

    expect(summary).toMatchObject({
      source: 'live',
      includesLocalAndProjectionState: true,
      total: 1,
      nodes: [{
        nodeId: 'child',
        status: 'streaming',
        active: true,
        lastActivityAt: '2026-06-01T00:02:00.000Z',
        source: 'projection',
      }],
    });
  });

  it('labels elapsed waits as neutral checkpoints and includes child activity', () => {
    const summary = buildWaitTimeoutSummary({
      requestId: 'request-1',
      orchestratorRunId: 'run-orch',
      orchestratorNodeId: 'assistant-orch',
      waitGroupId: 'implementers',
      assistantNodeIds: ['child'],
      decisionIds: [],
      condition: 'all',
      timeoutId: null,
    }, [
      message({
        id: 'child',
        status: 'streaming' as any,
        last_event_at: '2026-06-01T00:02:00.000Z',
      }),
    ]);

    expect(summary).toMatchObject({
      checkpointElapsed: true,
      waitExpired: true,
      timedOut: true,
      conditionSatisfied: false,
      runs: [{
        assistantNodeId: 'child',
        status: 'streaming',
        active: true,
        latestEventAt: '2026-06-01T00:02:00.000Z',
      }],
    });
    expect(JSON.stringify(summary)).not.toContain('content');
  });

  it('prefers compact live run status over stale graph message state', () => {
    const staleMessages = [
      message({
        id: 'child',
        status: 'pending' as any,
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ];
    const liveStatuses = {
      child: {
        assistantNodeId: 'child',
        status: 'streaming',
        terminalStatus: null,
        active: true,
        latestEventAt: '2026-06-01T00:05:00.000Z',
        outputCommitSha: null,
        aiLabel: null,
        source: 'runtime' as const,
      },
    };

    expect(buildOrchestrationWaitRunStatuses({
      assistantNodeIds: ['child'],
    }, staleMessages, liveStatuses)).toEqual([liveStatuses.child]);
    expect(buildWaitTimeoutSummary({
      requestId: 'request-1',
      orchestratorRunId: 'run-orch',
      orchestratorNodeId: 'assistant-orch',
      waitGroupId: 'implementers',
      assistantNodeIds: ['child'],
      decisionIds: [],
      condition: 'all',
      timeoutId: null,
    }, staleMessages, liveStatuses)).toMatchObject({
      runs: [{
        assistantNodeId: 'child',
        status: 'streaming',
        active: true,
        latestEventAt: '2026-06-01T00:05:00.000Z',
        source: 'runtime',
      }],
    });
  });

  it('allows terminal live status to satisfy waits without refreshed graph messages', () => {
    expect(isOrchestrationWaitSatisfied({
      assistantNodeIds: ['child'],
      condition: 'completed',
    }, [
      message({ id: 'child', status: 'streaming' as any }),
    ], {
      child: {
        assistantNodeId: 'child',
        status: 'completed',
        terminalStatus: 'completed',
        active: false,
        latestEventAt: '2026-06-01T00:05:00.000Z',
        outputCommitSha: 'abc123',
        aiLabel: null,
        source: 'runtime',
      },
    })).toBe(true);
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

describe('orchestration MCP run start idempotency helpers', () => {
  it('defaults graph parent to the assistant the user replied to and uses orchestration context metadata', () => {
    const orchestrator = message({
      id: 'assistant-orchestrator',
      role: 'assistant',
      parentId: 'orchestration-user',
      base_selected_from_node_id: 'base-from-assistant',
      execution_data: {
        meta: {
          node_kind: 'orchestrator',
          orchestration_target_node_id: 'parent-assistant',
          orchestration_context_parent_node_id: 'parent-assistant',
          orchestration_base_node_id: 'parent-assistant',
        },
        context_profile: {
          context_parent_node_id: 'legacy-context-parent',
          base_node_id: 'legacy-base',
        },
      },
    });

    expect(resolveOrchestrationRunLaunchDefaults(orchestrator, {})).toEqual({
      parentNodeId: 'parent-assistant',
      contextParentNodeId: 'parent-assistant',
      baseNodeId: 'parent-assistant',
    });
    expect(resolveOrchestrationRunLaunchDefaults(orchestrator, {
      parent_node_id: 'run-parent-assistant-1',
      context_parent_node_id: 'run-parent-assistant-1',
      base_node_id: 'run-parent-assistant-1',
    })).toEqual({
      parentNodeId: 'run-parent-assistant-1',
      contextParentNodeId: 'run-parent-assistant-1',
      baseNodeId: 'run-parent-assistant-1',
    });
  });

  it('defaults new-thread orchestration runs to the thread node instead of the request node', () => {
    const orchestrator = message({
      id: 'assistant-orchestrator',
      role: 'assistant',
      parentId: 'orchestration-user',
      execution_data: {
        meta: {
          node_kind: 'orchestrator',
          thread_origin_id: 'thread-1',
        },
      },
    });

    expect(resolveOrchestrationRunLaunchDefaults(orchestrator, {})).toEqual({
      parentNodeId: 'thread-origin:thread-1',
      contextParentNodeId: 'thread-origin:thread-1',
      baseNodeId: 'thread-origin:thread-1',
    });
  });

  it('does not fall back to the orchestration request when no target or thread node is known', () => {
    const orchestrator = message({
      id: 'assistant-orchestrator',
      role: 'assistant',
      parentId: 'orchestration-user',
      execution_data: {
        meta: {
          node_kind: 'orchestrator',
        },
      },
    });

    expect(resolveOrchestrationRunLaunchDefaults(orchestrator, {})).toEqual({
      parentNodeId: null,
      contextParentNodeId: null,
      baseNodeId: null,
    });
  });

  it('shares an in-flight child start for the same orchestrator and decision id', async () => {
    const pending = new Map();
    let starts = 0;
    const key = getOrchestrationRunStartKey('assistant-orchestrator', 'planner-1');
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
      getOrStartPendingOrchestrationRun(pending, key, start),
      getOrStartPendingOrchestrationRun(pending, key, start),
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

  it('clears failed in-flight orchestration run starts so the decision can be retried', async () => {
    const pending = new Map();
    const key = getOrchestrationRunStartKey('assistant-orchestrator', 'planner-1');
    await expect(getOrStartPendingOrchestrationRun(pending, key, async () => {
      throw new Error('launch failed');
    })).rejects.toThrow('launch failed');

    expect(pending.size).toBe(0);
    const retried = await getOrStartPendingOrchestrationRun(pending, key, async () => ({
      runId: 'run-retry',
      userNodeId: 'user-retry',
      assistantNodeId: 'assistant-retry',
      initialStatus: 'running',
    }));

    expect(retried.assistantNodeId).toBe('assistant-retry');
  });
});
