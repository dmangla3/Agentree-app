import { describe, expect, it } from 'vitest';
import {
  createAgentreeFlowNodeRunner,
  type AgentreeFlowNodeLauncher,
  type WaitForAgentreeNode,
} from './agentreeFlowNodeRunner';
import { throwIfFlowCancelled, type FlowNodeLaunchEvent } from './flowExecutor';
import type { FlowNodeValue } from './types';
import type { Message } from '../stores/workspaceStore';

const message = (overrides: Partial<Message> & Pick<Message, 'id'>): Message => ({
  role: 'assistant',
  content: 'done',
  parentId: 'user-1',
  workspaceId: 'workspace-1',
  createdAt: '2026-05-25T08:00:00.000Z',
  updatedAt: '2026-05-25T08:00:10.000Z',
  status: 'completed',
  output_commit_sha: 'commit-1',
  ...overrides,
  id: overrides.id,
});

describe('createAgentreeFlowNodeRunner', () => {
  it('resolves root parent to null and passes interpolated prompt unchanged', async () => {
    const launchCalls: Parameters<AgentreeFlowNodeLauncher>[0][] = [];
    const launcher: AgentreeFlowNodeLauncher = async (input) => {
      launchCalls.push(input);
      return { userNodeId: 'user-1', assistantNodeId: 'assistant-1' };
    };
    let waitOptions: Parameters<WaitForAgentreeNode>[1] | null = null;
    const waitForNode: WaitForAgentreeNode = async (_assistantNodeId, options) => {
      waitOptions = options ?? null;
      return message({ id: 'assistant-1' });
    };
    const runner = createAgentreeFlowNodeRunner({
      workspaceId: 'workspace-1',
      selectedAgentId: 'agent-1',
      selectedAgentType: 'codex',
      baseNodeId: 'base-1',
      baseCommitSha: 'base-commit',
      flowId: 'parallel_review_until_satisfied',
      flowRunId: 'flow-run-1',
      launchAgentNode: launcher,
      waitForAssistantNode: waitForNode,
    });

    const result = await runner.runNode({
      templateId: 'Implementer',
      registryId: 'core.implementer@1',
      parent: 'root',
      prompt: 'Please implement this exact prompt.',
      args: {},
      requiresFinalizedCommit: true,
    });

    expect(launchCalls[0]).toEqual(expect.objectContaining({
      parentNodeId: null,
      contextParentNodeId: null,
      prompt: 'Please implement this exact prompt.',
      flowNodeTemplateId: 'Implementer',
      flowNodeRegistryId: 'core.implementer@1',
    }));
    expect(waitOptions).toEqual({ requireCommit: true });
    expect(result).toEqual<FlowNodeValue>({
      kind: 'node',
      id: 'assistant-1',
      label: 'Implementer',
      status: 'complete',
      message: 'done',
      commit: 'commit-1',
    });
  });

  it('passes a shared thread origin only to root flow nodes', async () => {
    const launchCalls: Parameters<AgentreeFlowNodeLauncher>[0][] = [];
    const launcher: AgentreeFlowNodeLauncher = async (input) => {
      launchCalls.push(input);
      return {
        userNodeId: `user-${launchCalls.length}`,
        assistantNodeId: `assistant-${launchCalls.length}`,
      };
    };
    const waitForNode: WaitForAgentreeNode = async (assistantNodeId) => message({ id: assistantNodeId });
    const runner = createAgentreeFlowNodeRunner({
      workspaceId: 'workspace-1',
      selectedAgentId: 'agent-1',
      selectedAgentType: 'codex',
      baseNodeId: 'base-1',
      baseCommitSha: 'base-commit',
      flowId: 'parallel_review_until_satisfied',
      flowRunId: 'flow-run-1',
      threadOriginId: 'thread-origin-1',
      launchAgentNode: launcher,
      waitForAssistantNode: waitForNode,
    });

    await runner.runNode({
      templateId: 'Implementer',
      parent: 'root',
      prompt: 'Implement first.',
      args: {},
    });
    await runner.runNode({
      templateId: 'Implementer',
      parent: 'root',
      prompt: 'Implement second.',
      args: {},
    });
    await runner.runNode({
      templateId: 'Reviewer',
      parent: { kind: 'node', id: 'assistant-1', label: 'Implementer', status: 'complete' },
      prompt: 'Review first.',
      args: {},
    });

    expect(launchCalls.map((call) => call.threadOriginId)).toEqual([
      'thread-origin-1',
      'thread-origin-1',
      null,
    ]);
  });

  it('attaches root flow nodes to the composer reply parent and selected context parent', async () => {
    const launchCalls: Parameters<AgentreeFlowNodeLauncher>[0][] = [];
    const launcher: AgentreeFlowNodeLauncher = async (input) => {
      launchCalls.push(input);
      return { userNodeId: 'user-1', assistantNodeId: 'assistant-1' };
    };
    const runner = createAgentreeFlowNodeRunner({
      workspaceId: 'workspace-1',
      selectedAgentId: 'agent-1',
      selectedAgentType: 'codex',
      baseNodeId: 'base-1',
      baseCommitSha: 'base-commit',
      flowId: 'parallel_review_until_satisfied',
      flowRunId: 'flow-run-1',
      rootParentNodeId: 'reply-parent',
      rootContextParentNodeId: 'selected-context-parent',
      threadOriginId: 'thread-origin-1',
      launchAgentNode: launcher,
      waitForAssistantNode: async (assistantNodeId) => message({ id: assistantNodeId }),
    });

    await runner.runNode({
      templateId: 'Implementer',
      parent: 'root',
      prompt: 'Implement from selected composer parent.',
      args: {},
    });

    expect(launchCalls[0]).toEqual(expect.objectContaining({
      parentNodeId: 'reply-parent',
      contextParentNodeId: 'selected-context-parent',
      threadOriginId: null,
    }));
  });

  it('resolves node parents to assistant node ids and waits for completion', async () => {
    const launchCalls: Parameters<AgentreeFlowNodeLauncher>[0][] = [];
    let waitedFor: string | null = null;
    const launcher: AgentreeFlowNodeLauncher = async (input) => {
      launchCalls.push(input);
      return { userNodeId: 'user-reviewer', assistantNodeId: 'assistant-reviewer' };
    };
    const waitForNode: WaitForAgentreeNode = async (assistantNodeId) => {
      waitedFor = assistantNodeId;
      return message({
        id: assistantNodeId,
        content: 'verdict: pass',
        output_commit_sha: 'review-commit',
      });
    };
    const parent: FlowNodeValue = {
      kind: 'node',
      id: 'synthesizer-node',
      label: 'Synthesizer',
      status: 'complete',
    };
    const runner = createAgentreeFlowNodeRunner({
      workspaceId: 'workspace-1',
      selectedAgentId: 'agent-1',
      selectedAgentType: 'codex',
      baseNodeId: 'base-1',
      baseCommitSha: 'base-commit',
      flowId: 'parallel_review_until_satisfied',
      flowRunId: 'flow-run-1',
      launchAgentNode: launcher,
      waitForAssistantNode: waitForNode,
    });

    const result = await runner.runNode({
      templateId: 'Reviewer',
      registryId: 'core.reviewer@1',
      parent,
      prompt: 'Review commit.',
      args: {},
      requiresFinalizedCommit: false,
    });

    expect(launchCalls[0]).toEqual(expect.objectContaining({
      parentNodeId: 'synthesizer-node',
      contextParentNodeId: 'synthesizer-node',
    }));
    expect(waitedFor).toBe('assistant-reviewer');
    expect(result).toEqual(expect.objectContaining({
      id: 'assistant-reviewer',
      message: 'verdict: pass',
      status: 'complete',
      commit: 'review-commit',
    }));
  });

  it('maps failed agent nodes to failed flow node values', async () => {
    const runner = createAgentreeFlowNodeRunner({
      workspaceId: 'workspace-1',
      selectedAgentId: 'agent-1',
      selectedAgentType: 'codex',
      baseNodeId: 'base-1',
      baseCommitSha: 'base-commit',
      flowId: 'parallel_review_until_satisfied',
      flowRunId: 'flow-run-1',
      launchAgentNode: async () => ({ userNodeId: 'user-1', assistantNodeId: 'assistant-1' }),
      waitForAssistantNode: async () => message({
        id: 'assistant-1',
        content: 'failed',
        status: 'failed',
        output_commit_sha: null,
      }),
    });

    await expect(runner.runNode({
      templateId: 'Reviewer',
      registryId: 'core.reviewer@1',
      parent: 'root',
      prompt: 'Review',
      args: {},
      requiresFinalizedCommit: false,
    })).resolves.toEqual(expect.objectContaining({
      id: 'assistant-1',
      status: 'failed',
      message: 'failed',
      commit: null,
    }));
  });

  it('reports launched nodes and stops them when the flow is cancelled while waiting', async () => {
    const controller = new AbortController();
    const launchedNodes: FlowNodeLaunchEvent[] = [];
    const stoppedNodeIds: string[] = [];
    const runner = createAgentreeFlowNodeRunner({
      workspaceId: 'workspace-1',
      selectedAgentId: 'agent-1',
      selectedAgentType: 'codex',
      baseNodeId: 'base-1',
      baseCommitSha: 'base-commit',
      flowId: 'parallel_review_until_satisfied',
      flowRunId: 'flow-run-1',
      launchAgentNode: async () => ({ userNodeId: 'user-1', assistantNodeId: 'assistant-1' }),
      waitForAssistantNode: async (_assistantNodeId, options) => {
        controller.abort('User cancelled flow.');
        await Promise.resolve();
        throwIfFlowCancelled(options?.signal);
        return message({ id: 'assistant-1' });
      },
      stopAgentNode: async (assistantNodeId) => {
        stoppedNodeIds.push(assistantNodeId);
      },
    });

    await expect(runner.runNode({
      templateId: 'Implementer',
      registryId: 'core.implementer@1',
      parent: 'root',
      prompt: 'Implement',
      args: {},
      signal: controller.signal,
      onNodeLaunched: (event) => launchedNodes.push(event),
    })).rejects.toMatchObject({
      name: 'FlowExecutionCancelledError',
      message: 'User cancelled flow.',
    });

    expect(launchedNodes).toEqual([{
      templateId: 'Implementer',
      userNodeId: 'user-1',
      assistantNodeId: 'assistant-1',
    }]);
    expect(stoppedNodeIds).toEqual(['assistant-1']);
  });
});
