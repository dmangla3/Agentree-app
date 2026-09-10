import { describe, expect, it } from 'vitest';
import { createAgentNodeMessages } from './agentNodeLaunch';

describe('createAgentNodeMessages', () => {
  it('marks orchestrator nodes without orchestration run metadata', () => {
    const pair = createAgentNodeMessages({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      agentType: 'codex',
      parentNodeId: 'parent-1',
      contextParentNodeId: 'context-1',
      baseNodeId: 'base-1',
      baseCommitSha: 'abc123',
      prompt: 'Orchestrate the work',
      orchestration: {
        nodeKind: 'orchestrator',
      },
      now: '2026-05-25T08:00:00.000Z',
      userNodeId: 'user-orchestrator',
      assistantNodeId: 'assistant-orchestrator',
    });

    expect(pair.userNode).toEqual(expect.objectContaining({
      id: 'user-orchestrator',
      controlled_by_node_id: null,
      controlledByNodeId: null,
      parentId: 'parent-1',
    }));
    expect(pair.assistantNode).toEqual(expect.objectContaining({
      id: 'assistant-orchestrator',
      controlled_by_node_id: null,
      controlledByNodeId: null,
      parentId: 'user-orchestrator',
    }));

    const userMeta = pair.userNode.execution_data?.meta as Record<string, unknown>;
    expect(userMeta.node_kind).toBeUndefined();

    const meta = pair.assistantNode.execution_data?.meta as Record<string, unknown>;
    expect(meta).toEqual(expect.objectContaining({
      node_kind: 'orchestrator',
    }));
    expect(meta.controlled_by_node_id).toBeUndefined();
    expect(meta.orchestration_decision_id).toBeUndefined();
    expect(Object.keys(meta).filter((key) => key.startsWith('flow_'))).toEqual([]);
  });

  it('creates normal controlled orchestration runs without flow metadata', () => {
    const pair = createAgentNodeMessages({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      agentType: 'codex',
      parentNodeId: 'parent-1',
      contextParentNodeId: 'context-1',
      baseNodeId: 'base-1',
      baseCommitSha: 'abc123',
      prompt: 'Run @planner from here',
      threadId: 'thread-1',
      threadOriginId: 'thread-origin-1',
      llmModel: 'gpt-5.4-mini',
      reasoningEffort: 'high',
      orchestration: {
        controlledByNodeId: 'assistant-orchestrator',
        orchestrationDecisionId: 'planner-1',
        orchestrationTemplateId: '@planner',
      },
      now: '2026-05-25T08:00:00.000Z',
      userNodeId: 'user-1',
      assistantNodeId: 'assistant-1',
    });

    expect(pair.userNode).toEqual(expect.objectContaining({
      id: 'user-1',
      controlled_by_node_id: 'assistant-orchestrator',
      controlledByNodeId: 'assistant-orchestrator',
      parentId: 'parent-1',
    }));
    expect(pair.assistantNode).toEqual(expect.objectContaining({
      id: 'assistant-1',
      controlled_by_node_id: 'assistant-orchestrator',
      controlledByNodeId: 'assistant-orchestrator',
      parentId: 'user-1',
      base_commit_sha: 'abc123',
      base_selected_from_node_id: 'base-1',
    }));

    const meta = pair.assistantNode.execution_data?.meta as Record<string, unknown>;
    expect(meta).toEqual(expect.objectContaining({
      node_kind: 'normal',
      controlled_by_node_id: 'assistant-orchestrator',
      orchestration_decision_id: 'planner-1',
      orchestration_template_id: '@planner',
      thread_origin_id: 'thread-origin-1',
      provider_model: 'gpt-5.4-mini',
      provider_reasoning_effort: 'high',
    }));
    expect(Object.keys(meta).filter((key) => key.startsWith('flow_'))).toEqual([]);
  });
});
