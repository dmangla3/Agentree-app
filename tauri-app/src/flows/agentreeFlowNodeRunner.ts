import {
  isFlowExecutionCancelledError,
  throwIfFlowCancelled,
  type FlowNodeRunner,
} from './flowExecutor';
import type { FlowNodeValue, FlowRuntimeValue, FlowNodeStatus } from './types';
import type { LaunchAgentNodeInput, LaunchAgentNodeResult } from '../hooks/useAgentNodeLauncher';
import type { ComposerContextManifest } from '../lib/composerContext';
import type { Message } from '../stores/workspaceStore';

export type AgentreeFlowNodeLauncher = (input: LaunchAgentNodeInput) => Promise<LaunchAgentNodeResult>;
export type WaitForAgentreeNode = (
  assistantNodeId: string,
  options?: { requireCommit?: boolean; signal?: AbortSignal }
) => Promise<Message>;
export type StopAgentreeNode = (assistantNodeId: string) => Promise<void>;

export interface AgentreeFlowNodeRunnerInput {
  workspaceId: string;
  selectedAgentId: string;
  selectedAgentType: string;
  baseNodeId: string | null;
  baseCommitSha: string | null;
  rootParentNodeId?: string | null;
  rootContextParentNodeId?: string | null;
  rootContextManifest?: ComposerContextManifest | null;
  flowId: string;
  flowSourceId: string;
  flowSourceVersion: number;
  flowRunId: string;
  threadOriginId?: string | null;
  agentCliArgs?: string | null;
  agentPromptFlag?: string | null;
  agentName?: string | null;
  llmModel?: string | null;
  reasoningEffort?: string | null;
  launchAgentNode: AgentreeFlowNodeLauncher;
  waitForAssistantNode: WaitForAgentreeNode;
  stopAgentNode?: StopAgentreeNode;
}

export function createAgentreeFlowNodeRunner(input: AgentreeFlowNodeRunnerInput): FlowNodeRunner {
  return {
    async runNode(runInput) {
      throwIfFlowCancelled(runInput.signal);
      const isRootNode = isRootParent(runInput.parent);
      const parentNodeId = resolveParentNodeId(runInput.parent, input.rootParentNodeId ?? null);
      const contextParentNodeId = isRootNode
        ? input.rootContextParentNodeId ?? parentNodeId
        : parentNodeId;
      const launchResult = await input.launchAgentNode({
        workspaceId: input.workspaceId,
        agentId: input.selectedAgentId,
        agentType: input.selectedAgentType,
        parentNodeId,
        contextParentNodeId,
        baseNodeId: input.baseNodeId,
        baseCommitSha: input.baseCommitSha,
        prompt: runInput.prompt,
        contextManifest: isRootNode ? input.rootContextManifest ?? null : null,
        flowId: input.flowId,
        flowSourceId: input.flowSourceId,
        flowSourceVersion: input.flowSourceVersion,
        flowRunId: input.flowRunId,
        threadOriginId: parentNodeId ? null : input.threadOriginId ?? null,
        flowNodeTemplateId: runInput.templateId,
        flowNodeRegistryId: runInput.registryId,
        agentCliArgs: input.agentCliArgs,
        agentPromptFlag: input.agentPromptFlag,
        agentName: input.agentName,
        llmModel: input.llmModel,
        reasoningEffort: input.reasoningEffort,
      });
      runInput.onNodeLaunched?.({
        templateId: runInput.templateId,
        userNodeId: launchResult.userNodeId,
        assistantNodeId: launchResult.assistantNodeId,
      });

      let stopPromise: Promise<void> | null = null;
      const stopLaunchedNode = () => {
        if (!input.stopAgentNode) return null;
        stopPromise ??= input.stopAgentNode(launchResult.assistantNodeId).catch(() => undefined);
        return stopPromise;
      };
      const abortListener = () => {
        void stopLaunchedNode();
      };

      if (runInput.signal?.aborted) {
        await stopLaunchedNode();
        throwIfFlowCancelled(runInput.signal);
      }

      runInput.signal?.addEventListener('abort', abortListener, { once: true });
      try {
        const completedMessage = await input.waitForAssistantNode(launchResult.assistantNodeId, {
          requireCommit: runInput.requiresFinalizedCommit ?? false,
          ...(runInput.signal ? { signal: runInput.signal } : {}),
        });
        throwIfFlowCancelled(runInput.signal);
        return messageToFlowNode(completedMessage, runInput.templateId);
      } catch (error) {
        if (isFlowExecutionCancelledError(error)) {
          await stopLaunchedNode();
        }
        throw error;
      } finally {
        runInput.signal?.removeEventListener('abort', abortListener);
      }
    },
  };
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

function isRootParent(parent: FlowRuntimeValue): boolean {
  if (parent === null || parent === 'root') {
    return true;
  }
  return false;
}

function resolveParentNodeId(parent: FlowRuntimeValue, rootParentNodeId: string | null = null): string | null {
  if (isRootParent(parent)) {
    return rootParentNodeId;
  }
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
