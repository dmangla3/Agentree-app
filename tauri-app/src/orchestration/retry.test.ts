import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import {
  buildOrchestrationChildRetryInput,
  resolveOrchestrationChildRetryTarget,
} from './retry';

const message = (input: Partial<Message> & { id: string; role: Message['role'] }): Message => ({
  content: '',
  parentId: null,
  workspaceId: 'workspace-1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...input,
} as Message);

describe('orchestration child retry resolution', () => {
  it('builds replacement retry input from the failed child user prompt and metadata', () => {
    const messages = [
      message({ id: 'root-user', role: 'user' }),
      message({
        id: 'assistant-orchestrator',
        role: 'assistant',
        parentId: 'root-user',
        execution_data: {
          current_run_id: 'run-orchestrator',
          meta: { node_kind: 'orchestrator' },
        },
      }),
      message({
        id: 'child-user',
        role: 'user',
        parentId: 'root-user',
        content: 'Plan feature carefully',
        controlled_by_node_id: 'assistant-orchestrator',
      }),
      message({
        id: 'child-assistant',
        role: 'assistant',
        parentId: 'child-user',
        status: 'failed_runtime' as any,
        controlled_by_node_id: 'assistant-orchestrator',
        agent_id: 'agent-1',
        llmProvider: 'codex',
        llmModel: 'gpt-5',
        base_commit_sha: 'base-sha',
        base_selected_from_node_id: 'root-user',
        threadId: 'thread-1',
        execution_data: {
          repo_path: '/repo',
          context_profile: {
            context_parent_node_id: 'root-user',
            base_node_id: 'root-user',
          },
          meta: {
            controlled_by_node_id: 'assistant-orchestrator',
            orchestration_decision_id: 'planner-1',
            orchestration_template_id: '@planner',
            agent_cli_args: '--sandbox workspace-write',
            agent_name: 'Codex',
            composer_permission_mode: 'default',
            login_profile_id: 'login-1',
            thread_origin_id: 'thread-1',
          },
        },
      }),
    ];

    const target = resolveOrchestrationChildRetryTarget(messages, 'child-assistant');
    expect(target).toEqual({
      ok: true,
      target: {
        assistantNodeId: 'child-assistant',
        orchestratorNodeId: 'assistant-orchestrator',
        orchestratorRunId: 'run-orchestrator',
        decisionId: 'planner-1',
      },
    });
    if (!target.ok) throw new Error('expected retry target');

    const result = buildOrchestrationChildRetryInput({
      messages,
      target: target.target,
      authToken: 'token',
      journalEvents: [],
      retryReason: 'manual_retry',
    });

    expect(result).toEqual({
      ok: true,
      input: expect.objectContaining({
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
        prompt: 'Plan feature carefully',
        agentId: 'agent-1',
        agentType: 'codex',
        agentCliArgs: '--sandbox workspace-write',
        agentName: 'Codex',
        llmModel: 'gpt-5',
        loginProfileId: 'login-1',
        threadId: 'thread-1',
        threadOriginId: 'thread-1',
        orchestrationTemplateId: '@planner',
        supersededAssistantNodeId: 'child-assistant',
      }),
    });
  });

  it('rejects retry when the child has already been superseded', () => {
    const messages = [
      message({
        id: 'assistant-orchestrator',
        role: 'assistant',
        execution_data: {
          current_run_id: 'run-orchestrator',
          meta: { node_kind: 'orchestrator' },
        },
      }),
      message({
        id: 'child-user',
        role: 'user',
        content: 'Plan feature',
      }),
      message({
        id: 'child-assistant',
        role: 'assistant',
        parentId: 'child-user',
        status: 'failed_runtime' as any,
        controlled_by_node_id: 'assistant-orchestrator',
        execution_data: {
          meta: {
            orchestration_decision_id: 'planner-1',
          },
        },
      }),
    ];

    const target = resolveOrchestrationChildRetryTarget(messages, 'child-assistant');
    if (!target.ok) throw new Error('expected retry target');

    const result = buildOrchestrationChildRetryInput({
      messages,
      target: target.target,
      authToken: 'token',
      journalEvents: [{
        runId: 'run-orchestrator',
        assistantNodeId: 'assistant-orchestrator',
        seq: 1,
        eventType: 'orchestration:child_superseded',
        payload: JSON.stringify({
          decisionId: 'planner-1',
          supersededAssistantNodeId: 'child-assistant',
          replacementAssistantNodeId: 'child-retry',
        }),
        timestamp: 1,
      }],
    });

    expect(result).toEqual({ ok: false, reason: 'child_already_superseded' });
  });
});
