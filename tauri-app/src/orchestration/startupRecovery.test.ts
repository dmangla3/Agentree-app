import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import {
  applyOrchestrationRecoveryAction,
  findRecoverableOrchestratorRuns,
  recoverOrchestrationsFromMessages,
} from './startupRecovery';
import type { OrchestrationRecoveryProjection } from './domain';

const message = (input: Partial<Message> & { id: string; role: Message['role'] }): Message => ({
  content: '',
  parentId: null,
  workspaceId: 'workspace-1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...input,
} as Message);

const baseProjection = (overrides: Partial<OrchestrationRecoveryProjection> = {}): OrchestrationRecoveryProjection => ({
  status: 'running',
  requestedDecisionIds: new Set(),
  requestedChildLaunchByDecisionId: new Map(),
  childAssistantNodeIdByDecisionId: new Map(),
  supersededChildIds: new Set(),
  activeWaitGroup: null,
  needsUserActionReason: null,
  lastSeq: 0,
  controlledChildren: [],
  activeControlledAssistantNodeIds: [],
  terminalChildren: [],
  missingDecisionIds: [],
  ...overrides,
});

describe('orchestration startup recovery', () => {
  it('finds persisted orchestrator runs from normal assistant nodes', () => {
    const runs = findRecoverableOrchestratorRuns([
      message({
        id: 'assistant-orchestrator',
        role: 'assistant',
        execution_data: {
          current_run_id: 'run-orchestrator',
          meta: { node_kind: 'orchestrator' },
        },
      }),
      message({
        id: 'assistant-normal',
        role: 'assistant',
        execution_data: { meta: { node_kind: 'normal' } },
      }),
    ]);

    expect(runs).toEqual([{
      runId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
    }]);
  });

  it('applies cancel recovery by stopping active controlled children', async () => {
    const stopAgent = vi.fn(async () => undefined);
    const recordOrchestrationEvent = vi.fn(async () => 1);

    const result = await applyOrchestrationRecoveryAction({
      orchestratorRunId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
      projection: baseProjection({
        status: 'cancelling',
        activeControlledAssistantNodeIds: ['assistant-child'],
      }),
    }, {
      stopAgent,
      recordOrchestrationEvent,
    });

    expect(result.action).toBe('stop_active_children');
    expect(stopAgent).toHaveBeenCalledWith('assistant-child');
    expect(recordOrchestrationEvent).not.toHaveBeenCalled();
  });

  it('records wait completion during recovery when children satisfy the active wait group', async () => {
    const stopAgent = vi.fn(async () => undefined);
    const recordOrchestrationEvent = vi.fn(async () => 1);

    const result = await applyOrchestrationRecoveryAction({
      orchestratorRunId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
      projection: baseProjection({
        activeWaitGroup: {
          waitGroupId: 'wait-planners',
          decisionIds: ['planner-1'],
          condition: 'all',
        },
        controlledChildren: [
          { assistantNodeId: 'assistant-child', decisionId: 'planner-1', status: 'completed', active: false, terminal: true, outputCommitSha: null },
        ],
      }),
    }, {
      stopAgent,
      recordOrchestrationEvent,
    });

    expect(result.action).toBe('complete_wait');
    expect(result.completedWaitGroupId).toBe('wait-planners');
    expect(recordOrchestrationEvent).toHaveBeenCalledWith(
      'run-orchestrator',
      'assistant-orchestrator',
      'orchestration:wait_completed',
      {
        waitGroupId: 'wait-planners',
        decisionIds: ['planner-1'],
        condition: 'all',
      },
    );
  });

  it('does not resume missing children from a host-built preview on startup', async () => {
    const recordOrchestrationEvent = vi.fn(async () => 1);
    const stopAgent = vi.fn(async () => undefined);

    const results = await recoverOrchestrationsFromMessages([
      message({
        id: 'assistant-orchestrator',
        role: 'assistant',
        execution_data: {
          current_run_id: 'run-orchestrator',
          meta: { node_kind: 'orchestrator' },
        },
      }),
    ], {
      replayAgentRunEvents: async () => [{
        runId: 'run-orchestrator',
        assistantNodeId: 'assistant-orchestrator',
        seq: 1,
        eventType: 'orchestration:child_requested',
        payload: JSON.stringify({
          decisionId: 'planner-1',
        }),
        timestamp: 1,
      }],
      recordOrchestrationEvent,
      stopAgent,
    });

    expect(results[0]).toEqual(expect.objectContaining({
      action: 'needs_user_action',
      skippedReason: null,
    }));
    expect(stopAgent).not.toHaveBeenCalled();
  });
});
