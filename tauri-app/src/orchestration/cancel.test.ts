import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import { cancelOrchestrationTargetIfNeeded } from './cancel';

const message = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  id: input.id,
  role: input.role ?? 'assistant',
  content: '',
  parentId: input.parentId ?? null,
  workspaceId: input.workspaceId ?? 'workspace-1',
  status: input.status ?? null,
  agent_id: input.agent_id ?? 'agent-1',
  llmProvider: input.llmProvider ?? null,
  llmModel: input.llmModel ?? null,
  output_commit_sha: input.output_commit_sha ?? null,
  base_commit_sha: input.base_commit_sha ?? null,
  execution_data: input.execution_data ?? null,
  createdAt: input.createdAt ?? '2026-06-01T00:00:00.000Z',
  updatedAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
  controlled_by_node_id: input.controlled_by_node_id,
  controlledByNodeId: input.controlledByNodeId,
} as Message);

describe('cancelOrchestrationTargetIfNeeded', () => {
  it('records orchestration cancellation and stops only active orchestration runren for orchestrator targets', async () => {
    const recordOrchestrationEvent = vi.fn(async () => 1);
    const stopAgent = vi.fn(async () => undefined);

    const result = await cancelOrchestrationTargetIfNeeded({
      targetNodeId: 'assistant-orchestrator',
      reason: 'User cancelled from graph.',
      messages: [
        message({
          id: 'assistant-orchestrator',
          execution_data: {
            current_run_id: 'run-orchestrator',
            meta: { node_kind: 'orchestrator' },
          },
        }),
        message({
          id: 'assistant-active-child',
          status: 'running',
          controlled_by_node_id: 'assistant-orchestrator',
        }),
        message({
          id: 'assistant-completed-child',
          status: 'completed',
          controlled_by_node_id: 'assistant-orchestrator',
        }),
        message({
          id: 'assistant-other',
          status: 'running',
        }),
      ],
    }, {
      recordOrchestrationEvent,
      stopAgent,
    });

    expect(result).toEqual({
      handled: true,
      stoppedAssistantNodeIds: [
        'assistant-orchestrator',
        'assistant-active-child',
      ],
    });
    expect(stopAgent).toHaveBeenCalledTimes(2);
    expect(stopAgent).toHaveBeenNthCalledWith(1, 'assistant-orchestrator');
    expect(stopAgent).toHaveBeenNthCalledWith(2, 'assistant-active-child');
    expect(recordOrchestrationEvent).toHaveBeenNthCalledWith(
      1,
      'run-orchestrator',
      'assistant-orchestrator',
      'orchestration:cancel_requested',
      {
        reason: 'User cancelled from graph.',
        activeOrchestrationRunAssistantNodeIds: ['assistant-active-child'],
      },
    );
    expect(recordOrchestrationEvent).toHaveBeenNthCalledWith(
      2,
      'run-orchestrator',
      'assistant-orchestrator',
      'orchestration:cancelled',
      {
        reason: 'User cancelled from graph.',
        stoppedAssistantNodeIds: [
          'assistant-orchestrator',
          'assistant-active-child',
        ],
      },
    );
  });

  it('falls through for ordinary assistant targets', async () => {
    const recordOrchestrationEvent = vi.fn(async () => 1);
    const stopAgent = vi.fn(async () => undefined);

    const result = await cancelOrchestrationTargetIfNeeded({
      targetNodeId: 'assistant-normal',
      messages: [message({ id: 'assistant-normal', status: 'running' })],
    }, {
      recordOrchestrationEvent,
      stopAgent,
    });

    expect(result).toEqual({
      handled: false,
      stoppedAssistantNodeIds: [],
    });
    expect(recordOrchestrationEvent).not.toHaveBeenCalled();
    expect(stopAgent).not.toHaveBeenCalled();
  });
});
