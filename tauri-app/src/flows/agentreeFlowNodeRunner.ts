import type { FlowNodeRunner } from './flowExecutor';
import type { FlowNodeValue, FlowRuntimeValue, FlowNodeStatus } from './types';
import type { LaunchAgentNodeInput, LaunchAgentNodeResult } from '../hooks/useAgentNodeLauncher';
import type { Message } from '../stores/workspaceStore';

export type AgentreeFlowNodeLauncher = (input: LaunchAgentNodeInput) => Promise<LaunchAgentNodeResult>;
export type WaitForAgentreeNode = (
  assistantNodeId: string,
  options?: { requireCommit?: boolean }
) => Promise<Message>;

export interface AgentreeFlowNodeRunnerInput {
  workspaceId: string;
  selectedAgentId: string;
  selectedAgentType: string;
  baseNodeId: string | null;
  baseCommitSha: string | null;
  flowId: string;
  flowRunId: string;
  threadOriginId?: string | null;
  agentCliArgs?: string | null;
  agentPromptFlag?: string | null;
  agentName?: string | null;
  llmModel?: string | null;
  reasoningEffort?: string | null;
  launchAgentNode: AgentreeFlowNodeLauncher;
  waitForAssistantNode: WaitForAgentreeNode;
}

export function createAgentreeFlowNodeRunner(input: AgentreeFlowNodeRunnerInput): FlowNodeRunner {
  return {
    async runNode(runInput) {
      const parentNodeId = resolveParentNodeId(runInput.parent);
      const launchResult = await input.launchAgentNode({
        workspaceId: input.workspaceId,
        agentId: input.selectedAgentId,
        agentType: input.selectedAgentType,
        parentNodeId,
        contextParentNodeId: parentNodeId,
        baseNodeId: input.baseNodeId,
        baseCommitSha: input.baseCommitSha,
        prompt: runInput.prompt,
        flowId: input.flowId,
        flowRunId: input.flowRunId,
        threadOriginId: parentNodeId ? null : input.threadOriginId ?? null,
        flowNodeTemplateId: runInput.templateId,
        agentCliArgs: input.agentCliArgs,
        agentPromptFlag: input.agentPromptFlag,
        agentName: input.agentName,
        llmModel: input.llmModel,
        reasoningEffort: input.reasoningEffort,
      });
      const completedMessage = await input.waitForAssistantNode(launchResult.assistantNodeId, {
        requireCommit: requiresFinalizedCommit(runInput.templateId),
      });
      return messageToFlowNode(completedMessage, runInput.templateId);
    },
  };
}

function requiresFinalizedCommit(templateId: string): boolean {
  return templateId === 'Implementer' || templateId === 'Fixer';
}

export function messageToFlowNode(message: Message, templateId: string): FlowNodeValue {
  return {
    kind: 'node',
    id: message.id,
    label: templateId,
    status: mapMessageStatus(message.status),
    message: message.content ?? '',
    commit: message.output_commit_sha ?? message.commit?.sha ?? null,
  };
}

function resolveParentNodeId(parent: FlowRuntimeValue): string | null {
  if (parent === null || parent === 'root') {
    return null;
  }
  if (typeof parent === 'string') {
    return parent;
  }
  if (isFlowNodeValue(parent)) {
    return parent.id;
  }
  return null;
}

function mapMessageStatus(status: Message['status']): FlowNodeStatus {
  if (status === 'completed') {
    return 'complete';
  }
  if (status === 'failed' || status === 'error') {
    return 'failed';
  }
  if (status === 'cancelled') {
    return 'cancelled';
  }
  if (status === 'pending') {
    return 'pending';
  }
  return 'running';
}

function isFlowNodeValue(value: FlowRuntimeValue): value is FlowNodeValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && value.kind === 'node';
}
