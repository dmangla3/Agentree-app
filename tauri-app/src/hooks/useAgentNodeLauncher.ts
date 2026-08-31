import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AGENT_STATUS } from '@shared/agentStatus';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { agentClient, type StartAgentRunIntent } from '../lib/agentClient';
import { getAccessToken } from '../lib/authSession';
import { buildAgentRunPrompt } from '../lib/prompts';
import type { ComposerContextManifest } from '../lib/composerContext';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, type LocalNodeMessage } from './useLocalNodes';
import { useWorkspaces } from './useWorkspaces';
import type { Message, Workspace } from '../stores/workspaceStore';

export interface LaunchAgentNodeInput {
  workspaceId: string;
  agentId: string;
  agentType: string;
  parentNodeId: string | null;
  contextParentNodeId: string | null;
  baseNodeId: string | null;
  baseCommitSha: string | null;
  prompt: string;
  contextManifest?: ComposerContextManifest | null;
  flowId: string;
  flowSourceId: string;
  flowSourceVersion: number;
  flowNodeTemplateId: string;
  flowNodeRegistryId?: string | null;
  flowRunId?: string;
  threadOriginId?: string | null;
  agentCliArgs?: string | null;
  agentPromptFlag?: string | null;
  agentName?: string | null;
  llmModel?: string | null;
  reasoningEffort?: string | null;
  repoPath?: string | null;
}

export interface LaunchAgentNodeResult {
  userNodeId: string;
  assistantNodeId: string;
}

export interface CreateFlowNodeMessagesInput extends LaunchAgentNodeInput {
  flowRunId: string;
  now: string;
  userNodeId: string;
  assistantNodeId: string;
}

export interface FlowNodeMessagePair {
  userNode: Message;
  assistantNode: Message;
}

export interface UseAgentNodeLauncherOptions {
  startStreamForNode?: (node: Message, options: { authToken: string; parentId: string | null }) => Promise<void> | void;
}

export function createFlowNodeMessages(input: CreateFlowNodeMessagesInput): FlowNodeMessagePair {
  const contextManifest = input.contextManifest ?? null;
  const contextTextChars = contextManifest?.contextText.trim().length ?? 0;
  const executionMeta = {
    context_parent_node_id: input.contextParentNodeId,
    context_base_node_id: input.baseNodeId,
    agentree_context_available_chars: contextTextChars,
    agentree_context_available_estimated_tokens: Math.ceil(contextTextChars / 4),
    agentree_context_manifest_version: contextManifest?.version ?? null,
    agentree_context_manifest_hash: contextManifest?.manifestHash ?? null,
    agentree_context_stable_prefix_hash: contextManifest?.stablePrefixHash ?? null,
    agentree_context_volatile_tail_hash: contextManifest?.volatileTailHash ?? null,
    agentree_context_block_count: contextManifest?.blocks.length ?? 0,
    flow_id: input.flowId,
    flow_source_id: input.flowSourceId,
    flow_source_version: input.flowSourceVersion,
    flow_run_id: input.flowRunId,
    flow_node_template_id: input.flowNodeTemplateId,
    ...(input.threadOriginId ? { thread_origin_id: input.threadOriginId } : {}),
    ...(input.flowNodeRegistryId ? { flow_node_registry_id: input.flowNodeRegistryId } : {}),
    ...(input.llmModel ? { provider_model: input.llmModel } : {}),
    ...(input.reasoningEffort ? { provider_reasoning_effort: input.reasoningEffort } : {}),
  };

  const userNode: Message = {
    id: input.userNodeId,
    role: 'user',
    content: input.prompt,
    parentId: input.parentNodeId,
    workspaceId: input.workspaceId,
    attachments: [],
    createdAt: input.now,
    updatedAt: input.now,
    path_ids: input.parentNodeId ? [input.parentNodeId, input.userNodeId] : [input.userNodeId],
    execution_data: {
      meta: executionMeta,
      context_profile: {
        context_parent_node_id: input.contextParentNodeId,
        base_node_id: input.baseNodeId,
        inherited_from_node_id: input.parentNodeId,
      },
    },
  };

  const assistantNode: Message = {
    id: input.assistantNodeId,
    role: 'assistant',
    content: '',
    parentId: input.userNodeId,
    workspaceId: input.workspaceId,
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

  return { userNode, assistantNode };
}

export function useAgentNodeLauncher(options: UseAgentNodeLauncherOptions = {}) {
  const queryClient = useQueryClient();
  const { data: workspacesData } = useWorkspaces();
  const workspaceById = useMemo(() => {
    const map = new Map<string, Workspace>();
    for (const workspace of workspacesData ?? []) {
      map.set(workspace.id, workspace as Workspace);
    }
    return map;
  }, [workspacesData]);

  const launchAgentNode = useCallback(async (input: LaunchAgentNodeInput): Promise<LaunchAgentNodeResult> => {
    const flowRunId = input.flowRunId ?? crypto.randomUUID();
    const userNodeId = crypto.randomUUID();
    const assistantNodeId = crypto.randomUUID();
    const now = new Date().toISOString();
    const pair = createFlowNodeMessages({
      ...input,
      flowRunId,
      userNodeId,
      assistantNodeId,
      now,
    });

    const workspace = workspaceById.get(input.workspaceId);
    const repoPath = input.repoPath?.trim() || workspace?.git_repo_path?.trim() || workspace?.folderPath?.trim() || null;
    if (!repoPath) {
      throw new Error('Workspace repository path is required to launch a flow node.');
    }
    if (!input.baseCommitSha) {
      throw new Error('Base commit is required to launch a flow node.');
    }

    agentRunManager.seed(pair.userNode);
    agentRunManager.seed(pair.assistantNode);
    agentRunManager.dispatch(pair.assistantNode.id, { type: 'status', status: 'initializing' as any });
    agentRunManager.dispatch(pair.assistantNode.id, { type: 'setup_progress', progress: 'Initializing agent...' });

    await Promise.all([
      agentClient.upsertLocalNode(input.workspaceId, pair.userNode.id, pair.userNode),
      agentClient.upsertLocalNode(input.workspaceId, pair.assistantNode.id, pair.assistantNode),
    ]);
    queryClient.setQueryData<Message[]>(['messages', input.workspaceId], (current) => {
      const existing = current ?? [];
      const ids = new Set([pair.userNode.id, pair.assistantNode.id]);
      return [...existing.filter((message) => !ids.has(message.id)), pair.userNode, pair.assistantNode]
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    });
    queryClient.setQueryData<LocalNodeMessage[]>(
      localNodeKeys.workspace(input.workspaceId),
      (current) => upsertMessagesIntoLocalNodeCache(current, input.workspaceId, [pair.userNode, pair.assistantNode], {
        syncStatus: 'local_only',
        finalizedAt: Math.floor(Date.now() / 1000),
      })
    );
    void queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(input.workspaceId) });

    const authToken = await getAccessToken();
    await options.startStreamForNode?.(pair.assistantNode, {
      authToken,
      parentId: pair.userNode.id,
    });

    const effectivePrompt = buildAgentRunPrompt({
      mode: 'flow',
      userPrompt: input.prompt,
      contextManifest: input.contextManifest ?? undefined,
      threadTitleMode: 'none',
    }).prompt;
    const runId = crypto.randomUUID();
    const executionData = {
      ...(pair.assistantNode.execution_data ?? {}),
      current_run_id: runId,
      workspace_id: input.workspaceId,
      parentId: pair.assistantNode.parentId,
      started_at: new Date().toISOString(),
      meta: {
        ...((pair.assistantNode.execution_data?.meta ?? {}) as Record<string, unknown>),
        base_commit_sha: input.baseCommitSha,
        flow_id: input.flowId,
        flow_source_id: input.flowSourceId,
        flow_source_version: input.flowSourceVersion,
        flow_run_id: flowRunId,
        flow_node_template_id: input.flowNodeTemplateId,
        ...(input.flowNodeRegistryId ? { flow_node_registry_id: input.flowNodeRegistryId } : {}),
      },
    };
    agentRunManager.dispatch(pair.assistantNode.id, { type: 'execution_data', patch: executionData });

    const startIntent: StartAgentRunIntent = {
      runId,
      assistantNodeId: pair.assistantNode.id,
      workspaceId: input.workspaceId,
      repoPath,
      parentCommit: input.baseCommitSha,
      agentType: input.agentType,
      args: buildFlowAgentArgs({
        agentType: input.agentType,
        cliArgs: input.agentCliArgs,
        promptFlag: input.agentPromptFlag,
        prompt: effectivePrompt,
      }),
      authToken,
      traceId: null,
      runContext: {
        runId,
        executionData,
        gitBranchName: `agentree/${pair.assistantNode.id}`,
        repoPath,
        parentCommit: input.baseCommitSha,
        authorName: input.agentName ?? null,
        promptFallback: input.prompt,
      },
    };
    await agentClient.startAgentRun(startIntent);
    agentRunManager.dispatch(pair.assistantNode.id, { type: 'status', status: AGENT_STATUS.running });

    return {
      userNodeId: pair.userNode.id,
      assistantNodeId: pair.assistantNode.id,
    };
  }, [options, queryClient, workspaceById]);

  return { launchAgentNode };
}

function buildFlowAgentArgs(input: {
  agentType: string;
  cliArgs?: string | null;
  promptFlag?: string | null;
  prompt: string;
}): string[] {
  const args = String(input.cliArgs || '').split(/\s+/).filter(Boolean);
  if (input.agentType === 'codex' || !input.promptFlag) {
    return [...args, input.prompt];
  }
  return [...args, input.promptFlag, input.prompt];
}
