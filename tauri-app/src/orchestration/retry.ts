import { isFailureAgentStatus } from '@shared/agentStatus';
import type { AgentRunJournalEvent } from '../lib/agentClient';
import type { Message } from '../stores/workspaceStore';
import {
  type RetryOrchestrationChildRunInput,
} from './controlPlane';
import {
  getControlledByNodeId,
  getNodeKind,
  getOrchestrationDecisionId,
  parseOrchestrationJournalEvent,
  recoverOrchestrationProjection,
} from './domain';
import { getOrchestratorRunId } from './startupRecovery';

export type OrchestrationChildRetryResolveFailure =
  | 'target_not_retryable'
  | 'orchestrator_not_found'
  | 'orchestrator_run_not_found'
  | 'child_prompt_not_found'
  | 'child_runtime_context_not_found'
  | 'child_already_superseded';

export interface OrchestrationChildRetryTarget {
  assistantNodeId: string;
  orchestratorNodeId: string;
  orchestratorRunId: string;
  decisionId: string;
}

export type ResolveOrchestrationChildRetryTargetResult =
  | { ok: true; target: OrchestrationChildRetryTarget }
  | { ok: false; reason: OrchestrationChildRetryResolveFailure };

export type BuildOrchestrationChildRetryInputResult =
  | { ok: true; input: RetryOrchestrationChildRunInput }
  | { ok: false; reason: OrchestrationChildRetryResolveFailure };

const messageMapFrom = (messages: Message[]): Map<string, Message> => (
  new Map(messages.map((message) => [message.id, message]))
);

const readRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const readString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export const resolveOrchestrationChildRetryTarget = (
  messages: Message[],
  assistantNodeId: string,
): ResolveOrchestrationChildRetryTargetResult => {
  const messageMap = messageMapFrom(messages);
  const child = messageMap.get(assistantNodeId) ?? null;
  if (
    !child
    || child.role !== 'assistant'
    || !isFailureAgentStatus(child.status)
  ) {
    return { ok: false, reason: 'target_not_retryable' };
  }

  const orchestratorNodeId = getControlledByNodeId(child);
  const decisionId = getOrchestrationDecisionId(child);
  if (!orchestratorNodeId || !decisionId) {
    return { ok: false, reason: 'target_not_retryable' };
  }

  const orchestrator = messageMap.get(orchestratorNodeId) ?? null;
  if (!orchestrator || orchestrator.role !== 'assistant' || getNodeKind(orchestrator) !== 'orchestrator') {
    return { ok: false, reason: 'orchestrator_not_found' };
  }

  const orchestratorRunId = getOrchestratorRunId(orchestrator);
  if (!orchestratorRunId) {
    return { ok: false, reason: 'orchestrator_run_not_found' };
  }

  return {
    ok: true,
    target: {
      assistantNodeId,
      orchestratorNodeId,
      orchestratorRunId,
      decisionId,
    },
  };
};

export const buildOrchestrationChildRetryInput = (input: {
  messages: Message[];
  target: OrchestrationChildRetryTarget;
  journalEvents: AgentRunJournalEvent[];
  authToken: string;
  retryReason?: string | null;
}): BuildOrchestrationChildRetryInputResult => {
  const events = input.journalEvents
    .map(parseOrchestrationJournalEvent)
    .filter((event): event is NonNullable<typeof event> => Boolean(event));
  const projection = recoverOrchestrationProjection({
    orchestratorNodeId: input.target.orchestratorNodeId,
    events,
    messages: input.messages,
  });

  if (projection.supersededChildIds.has(input.target.assistantNodeId)) {
    return { ok: false, reason: 'child_already_superseded' };
  }

  const messageMap = messageMapFrom(input.messages);
  const failedChild = messageMap.get(input.target.assistantNodeId) ?? null;
  const failedChildUser = failedChild?.parentId ? messageMap.get(failedChild.parentId) ?? null : null;
  if (!failedChild || !failedChildUser || failedChildUser.role !== 'user' || !failedChildUser.content.trim()) {
    return { ok: false, reason: 'child_prompt_not_found' };
  }

  const executionData = readRecord(failedChild.execution_data);
  const meta = readRecord(executionData.meta);
  const contextProfile = readRecord(executionData.context_profile);
  const agentId = failedChild.agent_id ?? readString(meta, 'agent_id');
  const agentType = failedChild.llmProvider ?? readString(meta, 'provider');
  const baseCommitSha = failedChild.base_commit_sha ?? readString(meta, 'base_commit_sha');
  const repoPath = readString(executionData, 'repo_path') ?? readString(meta, 'repo_path');
  if (!agentId || !agentType || !baseCommitSha || !repoPath) {
    return { ok: false, reason: 'child_runtime_context_not_found' };
  }

  const parentNodeId = failedChildUser.parentId ?? null;
  return {
    ok: true,
    input: {
      workspaceId: failedChild.workspaceId,
      repoPath,
      authToken: input.authToken,
      orchestratorRunId: input.target.orchestratorRunId,
      orchestratorNodeId: input.target.orchestratorNodeId,
      decisionId: input.target.decisionId,
      parentNodeId,
      contextParentNodeId: readString(contextProfile, 'context_parent_node_id') ?? parentNodeId,
      baseNodeId: failedChild.base_selected_from_node_id ?? readString(contextProfile, 'base_node_id'),
      baseCommitSha,
      prompt: failedChildUser.content,
      agentId,
      agentType,
      agentCliArgs: readString(meta, 'agent_cli_args'),
      agentPromptFlag: readString(meta, 'agent_prompt_flag'),
      agentName: readString(meta, 'agent_name'),
      llmModel: failedChild.llmModel ?? readString(meta, 'provider_model'),
      reasoningEffort: readString(meta, 'provider_reasoning_effort'),
      permissionMode: readString(meta, 'composer_permission_mode') as RetryOrchestrationChildRunInput['permissionMode'],
      loginProfileId: readString(meta, 'login_profile_id'),
      contextManifest: null,
      threadId: failedChild.threadId ?? failedChild.thread_id ?? null,
      threadOriginId: readString(meta, 'thread_origin_id'),
      orchestrationTemplateId: readString(meta, 'orchestration_template_id'),
      supersededAssistantNodeId: input.target.assistantNodeId,
      retryReason: input.retryReason ?? 'manual_retry',
    },
  };
};
