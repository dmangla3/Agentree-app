import { describe, expect, it } from 'vitest';
import { createFlowNodeMessages } from './useAgentNodeLauncher';

describe('createFlowNodeMessages', () => {
  it('creates local-first user and assistant nodes with flow metadata', () => {
    const pair = createFlowNodeMessages({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      agentType: 'codex',
      parentNodeId: 'parent-1',
      contextParentNodeId: 'context-1',
      baseNodeId: 'base-1',
      baseCommitSha: 'abc123',
      prompt: 'Run the flow node',
      flowId: 'parallel_review_until_satisfied',
      flowSourceId: 'parallel_review_until_satisfied',
      flowSourceVersion: 1,
      flowRunId: 'flow-run-1',
      threadOriginId: 'thread-origin-1',
      flowNodeTemplateId: 'Reviewer',
      flowNodeRegistryId: 'core.reviewer@1',
      llmModel: 'gpt-5.4-mini',
      reasoningEffort: 'high',
      now: '2026-05-25T08:00:00.000Z',
      userNodeId: 'user-1',
      assistantNodeId: 'assistant-1',
    });

    expect(pair.userNode).toEqual(expect.objectContaining({
      id: 'user-1',
      role: 'user',
      content: 'Run the flow node',
      parentId: 'parent-1',
      workspaceId: 'workspace-1',
    }));
    expect(pair.assistantNode).toEqual(expect.objectContaining({
      id: 'assistant-1',
      role: 'assistant',
      parentId: 'user-1',
      workspaceId: 'workspace-1',
      agent_id: 'agent-1',
      llmProvider: 'codex',
      llmModel: 'gpt-5.4-mini',
      base_commit_sha: 'abc123',
    }));
    expect(pair.assistantNode.execution_data?.meta).toEqual(expect.objectContaining({
      context_parent_node_id: 'context-1',
      context_base_node_id: 'base-1',
      agent_id: 'agent-1',
      flow_id: 'parallel_review_until_satisfied',
      flow_source_id: 'parallel_review_until_satisfied',
      flow_source_version: 1,
      flow_run_id: 'flow-run-1',
      flow_node_template_id: 'Reviewer',
      thread_origin_id: 'thread-origin-1',
      flow_node_registry_id: 'core.reviewer@1',
      provider_model: 'gpt-5.4-mini',
      provider_reasoning_effort: 'high',
    }));
  });
});
