import { AGENT_STATUS } from '@shared/agentStatus';
import type { StartAgentRunIntent } from './agentClient';
import type { ComposerContextManifest } from './composerContext';
import {
  applyComposerPermissionArgs,
  DEFAULT_COMPOSER_PERMISSION_MODE,
  type ComposerPermissionMode,
} from './composerPermissions';
import type { Message } from '../stores/workspaceStore';

export interface OrchestrationLaunchMetadata {
  controlledByNodeId?: string | null;
  orchestrationDecisionId?: string | null;
  orchestrationTemplateId?: string | null;
  nodeKind?: 'normal' | 'orchestrator' | string;
}

export interface CreateAgentNodeMessagesInput {
  workspaceId: string;
  agentId: string;
  agentType: string;
  parentNodeId: string | null;
  contextParentNodeId: string | null;
  baseNodeId: string | null;
  baseCommitSha: string | null;
  prompt: string;
  contextManifest?: ComposerContextManifest | null;
  threadId?: string | null;
  threadOriginId?: string | null;
  agentName?: string | null;
  llmModel?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: ComposerPermissionMode;
  loginProfileId?: string | null;
  orchestration?: OrchestrationLaunchMetadata | null;
  now: string;
  userNodeId: string;
  assistantNodeId: string;
}

export interface AgentNodeMessagePair {
  userNode: Message;
  assistantNode: Message;
}

export const buildAgentNodeExecutionMeta = (
  input: CreateAgentNodeMessagesInput,
): Record<string, unknown> => {
  const contextManifest = input.contextManifest ?? null;
  const contextTextChars = contextManifest?.contextText.trim().length ?? 0;
  const orchestration = input.orchestration ?? null;

  return {
    context_parent_node_id: input.contextParentNodeId,
    context_base_node_id: input.baseNodeId,
    agent_id: input.agentId,
    agentree_context_available_chars: contextTextChars,
    agentree_context_available_estimated_tokens: Math.ceil(contextTextChars / 4),
    agentree_context_manifest_version: contextManifest?.version ?? null,
    agentree_context_manifest_hash: contextManifest?.manifestHash ?? null,
    agentree_context_stable_prefix_hash: contextManifest?.stablePrefixHash ?? null,
    agentree_context_volatile_tail_hash: contextManifest?.volatileTailHash ?? null,
    agentree_context_block_count: contextManifest?.blocks.length ?? 0,
    ...(orchestration ? {
      node_kind: orchestration.nodeKind ?? 'normal',
      ...(orchestration.controlledByNodeId ? { controlled_by_node_id: orchestration.controlledByNodeId } : {}),
      ...(orchestration.orchestrationDecisionId ? { orchestration_decision_id: orchestration.orchestrationDecisionId } : {}),
      ...(orchestration.orchestrationTemplateId ? { orchestration_template_id: orchestration.orchestrationTemplateId } : {}),
    } : {}),
    ...(input.threadOriginId ? { thread_origin_id: input.threadOriginId } : {}),
    ...(input.llmModel ? { provider_model: input.llmModel } : {}),
    ...(input.reasoningEffort ? { provider_reasoning_effort: input.reasoningEffort } : {}),
    ...(input.loginProfileId ? { login_profile_id: input.loginProfileId } : {}),
    provider_run_mode: input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE,
    composer_permission_mode: input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE,
  };
};

export function createAgentNodeMessages(input: CreateAgentNodeMessagesInput): AgentNodeMessagePair {
  const executionMeta = buildAgentNodeExecutionMeta(input);
  const controlledByNodeId = input.orchestration?.controlledByNodeId ?? null;
  const userExecutionMeta = input.orchestration?.nodeKind === 'orchestrator' && !controlledByNodeId
    ? Object.fromEntries(Object.entries(executionMeta).filter(([key]) => key !== 'node_kind'))
    : executionMeta;

  const userNode: Message = {
    id: input.userNodeId,
    role: 'user',
    content: input.prompt,
    parentId: input.parentNodeId,
    workspaceId: input.workspaceId,
    controlled_by_node_id: controlledByNodeId,
    controlledByNodeId: controlledByNodeId,
    attachments: [],
    createdAt: input.now,
    updatedAt: input.now,
    path_ids: input.parentNodeId ? [input.parentNodeId, input.userNodeId] : [input.userNodeId],
    execution_data: {
      meta: userExecutionMeta,
      context_profile: {
        context_parent_node_id: input.contextParentNodeId,
        base_node_id: input.baseNodeId,
        inherited_from_node_id: input.parentNodeId,
      },
    },
  };
  if (input.threadId) {
    userNode.threadId = input.threadId;
    userNode.thread_id = input.threadId;
  }

  const assistantNode: Message = {
    id: input.assistantNodeId,
    role: 'assistant',
    content: '',
    parentId: input.userNodeId,
    workspaceId: input.workspaceId,
    controlled_by_node_id: controlledByNodeId,
    controlledByNodeId: controlledByNodeId,
    attachments: [],
    createdAt: input.now,
    updatedAt: input.now,
    llmProvider: input.agentType,
    llmModel: input.llmModel ?? null,
    agent_id: input.agentId,
    status: AGENT_STATUS.pending,
    path_ids: [...(userNode.path_ids ?? [input.userNodeId]), input.assistantNodeId],
    base_commit_sha: input.baseCommitSha,
    base_selected_from_node_id: input.baseNodeId,
    execution_data: {
      meta: executionMeta,
      context_profile: {
        context_parent_node_id: input.contextParentNodeId,
        base_node_id: input.baseNodeId,
        inherited_from_node_id: input.userNodeId,
      },
    },
  };
  if (input.threadId) {
    assistantNode.threadId = input.threadId;
    assistantNode.thread_id = input.threadId;
  }

  return { userNode, assistantNode };
}

export function buildAgentNodeArgs(input: {
  agentType: string;
  cliArgs?: string | null;
  permissionMode?: ComposerPermissionMode;
  promptFlag?: string | null;
  prompt: string;
}): string[] {
  const args = String(input.cliArgs || '').split(/\s+/).filter(Boolean);
  const argsWithPermissions = applyComposerPermissionArgs(
    args,
    input.agentType,
    input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE,
  );
  if (input.agentType === 'codex' || !input.promptFlag) {
    return [...argsWithPermissions, input.prompt];
  }
  return [...argsWithPermissions, input.promptFlag, input.prompt];
}

export function buildAgentNodeStartIntent(input: {
  runId: string;
  pair: AgentNodeMessagePair;
  workspaceId: string;
  repoPath: string;
  parentCommit: string;
  agentType: string;
  args: string[];
  authToken: string;
  executionData: Record<string, unknown>;
  agentName?: string | null;
  promptFallback?: string | null;
  loginProfileId?: string | null;
}): StartAgentRunIntent {
  return {
    runId: input.runId,
    assistantNodeId: input.pair.assistantNode.id,
    workspaceId: input.workspaceId,
    repoPath: input.repoPath,
    parentCommit: input.parentCommit,
    agentType: input.agentType,
    args: input.args,
    authToken: input.authToken,
    traceId: null,
    loginProfileId: input.loginProfileId ?? null,
    runContext: {
      runId: input.runId,
      executionData: input.executionData,
      gitBranchName: `agentree/${input.pair.assistantNode.id}`,
      repoPath: input.repoPath,
      parentCommit: input.parentCommit,
      authorName: input.agentName ?? null,
      promptFallback: input.promptFallback ?? input.pair.userNode.content,
    },
  };
}
