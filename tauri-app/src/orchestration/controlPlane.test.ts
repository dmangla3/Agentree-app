import { describe, expect, it, vi } from 'vitest';
import type { StartAgentRunIntent } from '../lib/agentClient';
import {
  cancelOrchestration,
  completeSatisfiedWaitGroup,
  retryOrchestrationRun,
  startOrchestrationRun,
  startOrchestratorRun,
} from './controlPlane';

const startAgentRunResponse = (intent: StartAgentRunIntent) => ({
  runId: intent.runId,
  assistantNodeId: intent.assistantNodeId,
  worktreePath: `/repo/.agentree/worktrees/${intent.assistantNodeId}`,
  branchName: `agentree/${intent.assistantNodeId}`,
  pid: 123,
  initialStatus: 'running',
});

describe('orchestration control plane', () => {
  it('starts orchestrator runs as normal assistant nodes without orchestration run metadata', async () => {
    const persistLocalNode = vi.fn(async () => undefined);
    const startAgentRun = vi.fn(async (intent: StartAgentRunIntent) => startAgentRunResponse(intent));

    const result = await startOrchestratorRun({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      authToken: 'token',
      parentNodeId: 'root-user',
      contextParentNodeId: 'root-user',
      baseNodeId: 'root-user',
      baseCommitSha: 'base-sha',
      prompt: 'Coordinate #planner and #reviewer',
      agentId: 'agent-1',
      agentType: 'codex',
      agentCliArgs: '--sandbox workspace-write',
      agentName: 'Codex',
      now: '2026-06-01T00:00:00.000Z',
      userNodeId: 'user-orchestrator',
      assistantNodeId: 'assistant-orchestrator',
      runId: 'run-orchestrator',
    }, {
      newId: () => 'unused',
      persistLocalNode,
      startAgentRun,
    });

    expect(result.assistantNode.controlled_by_node_id).toBeNull();
    expect(result.assistantNode.execution_data?.meta).toEqual(expect.objectContaining({
      node_kind: 'orchestrator',
      orchestrator_run_id: 'run-orchestrator',
      base_commit_sha: 'base-sha',
      orchestration_target_node_id: 'root-user',
      orchestration_context_parent_node_id: 'root-user',
      orchestration_base_node_id: 'root-user',
    }));
    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-orchestrator',
      assistantNodeId: 'assistant-orchestrator',
      parentCommit: 'base-sha',
    }));
  });

  it('starts orchestration runs and records request/start events', async () => {
    const recordOrchestrationEvent = vi.fn(async () => 1);
    const persistLocalNode = vi.fn(async () => undefined);
    const startAgentRun = vi.fn(async (intent: StartAgentRunIntent) => startAgentRunResponse(intent));

    const result = await startOrchestrationRun({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      authToken: 'token',
      orchestratorRunId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
      decisionId: 'planner-1',
      parentNodeId: 'root-user',
      contextParentNodeId: 'root-user',
      baseNodeId: 'root-user',
      baseCommitSha: 'base-sha',
      prompt: 'Plan carefully',
      agentId: 'agent-1',
      agentType: 'codex',
      agentCliArgs: '--sandbox workspace-write',
      agentName: 'Codex',
      now: '2026-06-01T00:00:00.000Z',
      userNodeId: 'user-child',
      assistantNodeId: 'assistant-child',
      runId: 'run-child',
      orchestrationTemplateId: '@planner',
    }, {
      newId: () => 'unused',
      persistLocalNode,
      startAgentRun,
      recordOrchestrationEvent,
    });

    expect(result.assistantNode.controlled_by_node_id).toBe('assistant-orchestrator');
    expect(result.userNode.parentId).toBe('root-user');
    expect(result.userNode.execution_data?.context_profile).toEqual(expect.objectContaining({
      context_parent_node_id: 'root-user',
      base_node_id: 'root-user',
      inherited_from_node_id: 'root-user',
    }));
    expect(result.assistantNode.execution_data).toEqual(expect.objectContaining({
      repo_path: '/repo',
      meta: expect.objectContaining({
        controlled_by_node_id: 'assistant-orchestrator',
        orchestration_decision_id: 'planner-1',
        orchestration_template_id: '@planner',
        agent_cli_args: '--sandbox workspace-write',
        agent_name: 'Codex',
      }),
    }));
    expect(recordOrchestrationEvent).toHaveBeenNthCalledWith(
      1,
      'run-orchestrator',
      'assistant-orchestrator',
      'orchestration:run_requested',
      expect.objectContaining({
        decisionId: 'planner-1',
        runAssistantNodeId: 'assistant-child',
        agentRunId: 'run-child',
        parentNodeId: 'root-user',
        contextParentNodeId: 'root-user',
        baseNodeId: 'root-user',
      }),
    );
    expect(recordOrchestrationEvent).toHaveBeenNthCalledWith(
      2,
      'run-orchestrator',
      'assistant-orchestrator',
      'orchestration:run_started',
      expect.objectContaining({
        decisionId: 'planner-1',
        runAssistantNodeId: 'assistant-child',
        agentRunId: 'run-child',
        parentNodeId: 'root-user',
        contextParentNodeId: 'root-user',
        baseNodeId: 'root-user',
      }),
    );
  });

  it('does not seed projected orchestration runs when request event recording fails', async () => {
    const recordError = new Error('unsupported orchestration event type');
    const recordOrchestrationEvent = vi.fn(async () => {
      throw recordError;
    });
    const persistLocalNode = vi.fn(async () => undefined);
    const startAgentRun = vi.fn(async (intent: StartAgentRunIntent) => startAgentRunResponse(intent));
    const seedAgentRun = vi.fn();
    const dispatchAgentRun = vi.fn();

    await expect(startOrchestrationRun({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      authToken: 'token',
      orchestratorRunId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
      decisionId: 'planner-1',
      parentNodeId: 'root-user',
      contextParentNodeId: 'root-user',
      baseNodeId: 'root-user',
      baseCommitSha: 'base-sha',
      prompt: 'Plan carefully',
      agentId: 'agent-1',
      agentType: 'codex',
      now: '2026-06-01T00:00:00.000Z',
      userNodeId: 'user-child',
      assistantNodeId: 'assistant-child',
      runId: 'run-child',
    }, {
      newId: () => 'unused',
      persistLocalNode,
      startAgentRun,
      recordOrchestrationEvent,
      seedAgentRun,
      dispatchAgentRun,
    })).rejects.toThrow(recordError);

    expect(recordOrchestrationEvent).toHaveBeenCalledWith(
      'run-orchestrator',
      'assistant-orchestrator',
      'orchestration:run_requested',
      expect.objectContaining({
        decisionId: 'planner-1',
        runAssistantNodeId: 'assistant-child',
        agentRunId: 'run-child',
      }),
    );
    expect(seedAgentRun).not.toHaveBeenCalled();
    expect(dispatchAgentRun).not.toHaveBeenCalled();
    expect(persistLocalNode).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('passes native provider continuation flags to orchestration runs', async () => {
    const recordOrchestrationEvent = vi.fn(async () => 1);
    const persistLocalNode = vi.fn(async () => undefined);
    const startAgentRun = vi.fn(async (intent: StartAgentRunIntent) => startAgentRunResponse(intent));

    await startOrchestrationRun({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      authToken: 'token',
      orchestratorRunId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
      decisionId: 'planner-1',
      parentNodeId: 'assistant-parent',
      contextParentNodeId: 'assistant-parent',
      providerParentMeta: {
        provider: 'claude',
        provider_thread_id: 'claude-thread-1',
        provider_turn_id: 'turn-1',
      },
      baseNodeId: 'assistant-parent',
      baseCommitSha: 'base-sha',
      prompt: 'Plan carefully',
      agentId: 'agent-1',
      agentType: 'claude',
      agentPromptFlag: '--prompt',
      agentName: 'Claude',
      now: '2026-06-01T00:00:00.000Z',
      userNodeId: 'user-child',
      assistantNodeId: 'assistant-child',
      runId: 'run-child',
    }, {
      newId: () => 'unused',
      persistLocalNode,
      startAgentRun,
      recordOrchestrationEvent,
    });

    const intent = startAgentRun.mock.calls[0][0];
    expect(intent.args).toEqual(expect.arrayContaining([
      '--provider-thread-strategy',
      'resume',
      '--provider-thread-id',
      'claude-thread-1',
    ]));
    expect(intent.runContext.executionData.meta).toEqual(expect.objectContaining({
      provider_thread_strategy: 'resume',
      provider_thread_id: 'claude-thread-1',
      provider_context_routing_mode: 'provider_native_only',
    }));
  });

  it('retries an orchestration run by starting a replacement and recording supersession', async () => {
    const recordOrchestrationEvent = vi.fn(async () => 1);
    const persistLocalNode = vi.fn(async () => undefined);
    const startAgentRun = vi.fn(async (intent: StartAgentRunIntent) => startAgentRunResponse(intent));

    const result = await retryOrchestrationRun({
      workspaceId: 'workspace-1',
      repoPath: '/repo',
      authToken: 'token',
      orchestratorRunId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
      decisionId: 'planner-1',
      supersededAssistantNodeId: 'assistant-old',
      retryReason: 'manual_retry',
      parentNodeId: 'root-user',
      contextParentNodeId: 'root-user',
      baseNodeId: 'root-user',
      baseCommitSha: 'base-sha',
      prompt: 'Plan again',
      agentId: 'agent-1',
      agentType: 'codex',
      now: '2026-06-01T00:00:00.000Z',
      userNodeId: 'user-retry',
      assistantNodeId: 'assistant-retry',
      runId: 'run-retry',
    }, {
      newId: () => 'unused',
      persistLocalNode,
      startAgentRun,
      recordOrchestrationEvent,
    });

    expect(result.supersededAssistantNodeId).toBe('assistant-old');
    expect(recordOrchestrationEvent).toHaveBeenLastCalledWith(
      'run-orchestrator',
      'assistant-orchestrator',
      'orchestration:run_superseded',
      expect.objectContaining({
        decisionId: 'planner-1',
        supersededAssistantNodeId: 'assistant-old',
        replacementAssistantNodeId: 'assistant-retry',
      }),
    );
  });

  it('records wait completion only when the active wait group is satisfied', async () => {
    const recordOrchestrationEvent = vi.fn(async () => 1);

    const result = await completeSatisfiedWaitGroup({
      orchestratorRunId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
      projection: {
        status: 'running',
        requestedDecisionIds: new Set(),
        runAssistantNodeIdByDecisionId: new Map(),
        supersededRunIds: new Set(),
        activeWaitGroup: {
          waitGroupId: 'wait-planners',
          decisionIds: ['planner-1', 'planner-2'],
          condition: 'all',
        },
        needsUserActionReason: null,
        lastSeq: 1,
        orchestrationRuns: [
          { assistantNodeId: 'assistant-1', decisionId: 'planner-1', status: 'completed', active: false, terminal: true, outputCommitSha: null },
          { assistantNodeId: 'assistant-2', decisionId: 'planner-2', status: 'completed', active: false, terminal: true, outputCommitSha: null },
        ],
        activeOrchestrationRunAssistantNodeIds: [],
        terminalOrchestrationRuns: [],
        missingDecisionIds: [],
      },
    }, {
      recordOrchestrationEvent,
    });

    expect(result.completedWaitGroupId).toBe('wait-planners');
    expect(recordOrchestrationEvent).toHaveBeenCalledWith(
      'run-orchestrator',
      'assistant-orchestrator',
      'orchestration:wait_completed',
      {
        waitGroupId: 'wait-planners',
        decisionIds: ['planner-1', 'planner-2'],
        condition: 'all',
      },
    );
  });

  it('keeps hierarchical cancellation on normal stop-agent primitives', async () => {
    const recordOrchestrationEvent = vi.fn(async () => 1);
    const stopAgent = vi.fn(async () => undefined);

    const result = await cancelOrchestration({
      orchestratorRunId: 'run-orchestrator',
      orchestratorNodeId: 'assistant-orchestrator',
      activeOrchestrationRunAssistantNodeIds: ['assistant-child'],
      reason: 'user_cancelled',
    }, {
      recordOrchestrationEvent,
      stopAgent,
    });

    expect(result.stoppedAssistantNodeIds).toEqual(['assistant-orchestrator', 'assistant-child']);
    expect(stopAgent).toHaveBeenCalledWith('assistant-orchestrator');
    expect(stopAgent).toHaveBeenCalledWith('assistant-child');
  });
});
