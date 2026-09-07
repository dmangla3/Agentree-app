import { AGENT_STATUS } from '@shared/agentStatus';
import { buildComposerContextManifest, buildComposerContextSelection } from '../lib/composerContext';
import { buildAgentRunPrompt } from '../lib/prompts';
import type { Message, Workspace } from '../stores/workspaceStore';
import type { Agent } from '../hooks/useAgents';
import type { StartAgentRunIntent, StartAgentRunResponse } from '../lib/agentClient';
import { createSendFlowId, recordSendFlowEvent } from '../perf/sendFlow';
import { getLegacyThreadIdForMessage, getMessageThreadSessionId } from '../lib/threadSessions';
import { resolveLocalWorkspaceRepoPath } from '../lib/workspaceRepoPath';
import {
  applyComposerPermissionArgs,
  DEFAULT_COMPOSER_PERMISSION_MODE,
  type ComposerPermissionMode,
} from '../lib/composerPermissions';
import {
  startOrchestratorRun,
} from '../orchestration/controlPlane';

export interface HeadlessComposerBase {
  commitSha: string;
  selectedFromNodeId: string | null;
}

export interface HeadlessComposerReplyResponse {
  userMessage?: Message;
  assistantMessages?: Message[];
  [key: string]: unknown;
}

export interface HeadlessComposerReplyInput {
  workspaceId: string;
  replyParentId: string;
  prompt: string;
  messages: Message[];
  agent: Agent;
  base: HeadlessComposerBase;
  workspaces: Workspace[];
  startAgentRun: (input: Record<string, unknown>) => Promise<unknown>;
  getAccessToken: () => Promise<string | null>;
  seedAgentRun: (message: Message) => void;
  dispatchAgentRun: (nodeId: string, event: Record<string, unknown>) => void;
  persistLocalNode?: (workspaceId: string, nodeId: string, message: Message) => Promise<unknown>;
  onAssistantMessageCreated?: (message: Message) => void;
  onMessagesCreated?: (messages: Message[]) => void;
  createRunId?: () => string;
  nowIso?: () => string;
  selectedLoginProfileId?: string | null;
}

export interface HeadlessComposerMessageInput extends Omit<HeadlessComposerReplyInput, 'replyParentId'> {
  parentMessageId: string | null;
  contextParentId?: string | null;
  contextPolicy?: 'continue' | 'fresh';
  contextStartId?: string | null;
  perfFlowId?: string;
  perfSource?: string;
  setupProgress?: string;
  meta?: Record<string, unknown>;
  selectedLoginProfileId?: string | null;
  permissionMode?: ComposerPermissionMode;
  threadId?: string | null;
  threadOriginId?: string | null;
  orchestrationMode?: boolean;
}

const splitCliArgs = (value: string | null | undefined): string[] => (
  String(value || '').split(/\s+/).filter(Boolean)
);

const createLocalHeadlessMessages = (input: {
  workspaceId: string;
  parentMessageId: string | null;
  contextParentId: string | null | undefined;
  contextPolicy: 'continue' | 'fresh' | undefined;
  contextStartId: string | null | undefined;
  prompt: string;
  agent: Agent;
  base: HeadlessComposerBase;
  meta?: Record<string, unknown>;
  permissionMode?: ComposerPermissionMode;
  threadId?: string | null;
  threadOriginId?: string | null;
  nowIso: string;
}): { userMessage: Message; assistantMessage: Message } => {
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const contextPolicy = input.contextPolicy ?? 'continue';
  const contextParentId = contextPolicy === 'fresh'
    ? null
    : input.contextParentId ?? input.parentMessageId;
  const sharedMeta = {
    ...(input.meta ?? {}),
    context_policy: contextPolicy,
    context_parent_node_id: contextParentId,
    context_base_node_id: input.parentMessageId,
    context_start_node_id: input.contextStartId ?? null,
    base_commit_sha: input.base.commitSha,
    ...(input.threadOriginId ? { thread_origin_id: input.threadOriginId } : {}),
    provider: input.agent.type,
    provider_run_mode: input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE,
    composer_permission_mode: input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE,
    provider_model: input.agent.model_config?.model ?? null,
    agent_id: input.agent.id,
  };
  const userPathIds = input.parentMessageId
    ? [input.parentMessageId, userMessageId]
    : [userMessageId];
  const userMessage: Message = {
    id: userMessageId,
    role: 'user',
    content: input.prompt,
    parentId: input.parentMessageId,
    workspaceId: input.workspaceId,
    attachments: [],
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    path_ids: userPathIds,
    execution_data: {
      meta: sharedMeta,
      context_profile: {
        context_parent_node_id: contextParentId,
        base_node_id: input.parentMessageId,
        inherited_from_node_id: input.parentMessageId,
      },
    },
  };
  if (input.threadId) {
    userMessage.threadId = input.threadId;
    userMessage.thread_id = input.threadId;
  }
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    parentId: userMessageId,
    workspaceId: input.workspaceId,
    attachments: [],
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    llmProvider: input.agent.type,
    llmModel: input.agent.model_config?.model ?? null,
    agent_id: input.agent.id,
    status: AGENT_STATUS.pending,
    path_ids: [...userPathIds, assistantMessageId],
    base_commit_sha: input.base.commitSha,
    base_selected_from_node_id: input.base.selectedFromNodeId,
    execution_data: {
      meta: sharedMeta,
      context_profile: {
        context_parent_node_id: contextParentId,
        base_node_id: input.parentMessageId,
        inherited_from_node_id: userMessageId,
      },
    },
  };
  if (input.threadId) {
    assistantMessage.threadId = input.threadId;
    assistantMessage.thread_id = input.threadId;
  }

  return { userMessage, assistantMessage };
};

export const buildHeadlessComposerAgentArgs = (
  agent: Agent,
  prompt: string,
  permissionMode: ComposerPermissionMode = DEFAULT_COMPOSER_PERMISSION_MODE
): string[] => {
  const args = splitCliArgs(agent.cliArgs);
  const argsWithPermissions = applyComposerPermissionArgs(args, agent.type, permissionMode);
  if (agent.type === 'codex' || !agent.promptFlag) {
    return [...argsWithPermissions, prompt];
  }
  return [...argsWithPermissions, agent.promptFlag, prompt];
};

export const resolveWorkspaceRepoPath = (workspace: Workspace | null | undefined): string | null => (
  resolveLocalWorkspaceRepoPath(workspace)
);

export async function sendHeadlessComposerReply(input: HeadlessComposerReplyInput): Promise<HeadlessComposerReplyResponse> {
  return sendHeadlessComposerMessage({
    ...input,
    parentMessageId: input.replyParentId,
    contextParentId: input.replyParentId,
    contextPolicy: 'continue',
    setupProgress: 'Starting quick reply...',
    meta: { quick_reply: true },
  });
}

export async function sendHeadlessComposerMessage(input: HeadlessComposerMessageInput): Promise<HeadlessComposerReplyResponse> {
  const prompt = input.prompt.trim();
  const flowId = input.perfFlowId ?? createSendFlowId();
  const perfSource = input.perfSource ?? 'HeadlessComposer';
  const messageMap = new Map(input.messages.map((message) => [message.id, message]));
  const parentMessage = input.parentMessageId ? messageMap.get(input.parentMessageId) : null;
  const effectiveThreadId = input.threadId
    ?? getMessageThreadSessionId(parentMessage)
    ?? (parentMessage ? getLegacyThreadIdForMessage(parentMessage, messageMap) : null);
  const effectiveThreadOriginId = input.threadOriginId ?? effectiveThreadId;
  recordSendFlowEvent('flow.started', {
    flowId,
    workspaceId: input.workspaceId,
    useAgent: true,
    composerSurface: input.meta?.composer_surface ?? 'headless',
    promptLength: prompt.length,
    parentMessageId: input.parentMessageId,
    contextPolicy: input.contextPolicy ?? 'continue',
    optimisticUserMessageId: null,
    optimisticAssistantMessageId: null,
  }, { source: perfSource });

  if (input.orchestrationMode) {
    if (!input.persistLocalNode) {
      throw new Error('Local node persistence is required for orchestration sends.');
    }
    const workspace = input.workspaces.find((candidate) => candidate.id === input.workspaceId) ?? null;
    const repoPath = resolveWorkspaceRepoPath(workspace);
    if (!repoPath) {
      throw new Error('Workspace repository path is required for composer sends.');
    }

    const nowIso = input.nowIso?.() ?? new Date().toISOString();
    const runId = input.createRunId?.() ?? crypto.randomUUID();
    const userNodeId = crypto.randomUUID();
    const assistantNodeId = crypto.randomUUID();
    const contextParentId = input.contextPolicy === 'fresh'
      ? null
      : input.contextParentId ?? input.parentMessageId;
    const contextSelection = input.contextPolicy === 'fresh' || !input.parentMessageId
      ? { turns: [], defaultSelectedIds: [] }
      : buildComposerContextSelection(
        input.parentMessageId,
        input.messages,
        input.contextParentId ?? input.parentMessageId,
        input.contextPolicy ?? 'continue',
        input.contextStartId ?? null
      );
    const contextManifest = buildComposerContextManifest(
      contextSelection.turns,
      new Set(contextSelection.defaultSelectedIds)
    );
    const authToken = await input.getAccessToken();
    const startResult = await startOrchestratorRun({
      workspaceId: input.workspaceId,
      repoPath,
      authToken: authToken ?? '',
      parentNodeId: input.parentMessageId,
      contextParentNodeId: contextParentId,
      baseNodeId: input.base.selectedFromNodeId,
      baseCommitSha: input.base.commitSha,
      prompt,
      agentId: input.agent.id,
      agentType: input.agent.type,
      agentCliArgs: input.agent.cliArgs,
      agentPromptFlag: input.agent.promptFlag,
      agentName: input.agent.name,
      llmModel: input.agent.model_config?.model ?? null,
      permissionMode: input.permissionMode,
      loginProfileId: input.selectedLoginProfileId ?? null,
      contextManifest,
      threadId: effectiveThreadId,
      threadOriginId: effectiveThreadOriginId,
      now: nowIso,
      userNodeId,
      assistantNodeId,
      runId,
    }, {
      newId: () => crypto.randomUUID(),
      persistLocalNode: async (workspaceId, nodeId, message) => {
        await input.persistLocalNode?.(workspaceId, nodeId, message);
      },
      startAgentRun: async (intent: StartAgentRunIntent): Promise<StartAgentRunResponse> => (
        input.startAgentRun(intent as unknown as Record<string, unknown>) as Promise<StartAgentRunResponse>
      ),
      seedAgentRun: input.seedAgentRun,
      dispatchAgentRun: input.dispatchAgentRun,
    });
    const createdMessages = [startResult.userNode, startResult.assistantNode];
    input.onMessagesCreated?.(createdMessages);
    input.onAssistantMessageCreated?.(startResult.assistantNode);

    return {
      userMessage: startResult.userNode,
      assistantMessages: [startResult.assistantNode],
    };
  }

  const nowIso = input.nowIso?.() ?? new Date().toISOString();
  const localPair = createLocalHeadlessMessages({
    workspaceId: input.workspaceId,
    parentMessageId: input.parentMessageId,
    contextParentId: input.contextParentId,
    contextPolicy: input.contextPolicy,
    contextStartId: input.contextStartId,
    prompt,
    agent: input.agent,
    base: input.base,
    meta: input.meta,
    permissionMode: input.permissionMode,
    threadId: effectiveThreadId,
    threadOriginId: effectiveThreadOriginId,
    nowIso,
  });
  const userMessage = localPair.userMessage;
  const assistantMessage = localPair.assistantMessage;
  const response: HeadlessComposerReplyResponse = {
    userMessage,
    assistantMessages: [assistantMessage],
  };
  recordSendFlowEvent('local-messages.created', {
    flowId,
    workspaceId: input.workspaceId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  }, { source: perfSource });

  const createdMessages = [userMessage, assistantMessage].filter((message): message is Message => Boolean(message));
  if (createdMessages.length > 0) {
    if (input.persistLocalNode) {
      await Promise.all(createdMessages.map((message) => (
        input.persistLocalNode?.(input.workspaceId, message.id, message)
      )));
    }
    input.onMessagesCreated?.(createdMessages);
  }

  if (userMessage) {
    input.seedAgentRun(userMessage);
    recordSendFlowEvent('optimistic.user-created', {
      flowId,
      workspaceId: input.workspaceId,
      messageId: userMessage.id,
      parentId: input.parentMessageId,
    }, { source: perfSource });
  }
  if (assistantMessage) {
    input.seedAgentRun(assistantMessage);
    input.onAssistantMessageCreated?.(assistantMessage);
    input.dispatchAgentRun(assistantMessage.id, { type: 'status', status: 'initializing' });
    input.dispatchAgentRun(assistantMessage.id, {
      type: 'setup_progress',
      progress: input.setupProgress ?? 'Starting composer run...',
    });
    recordSendFlowEvent('optimistic.assistant-created', {
      flowId,
      workspaceId: input.workspaceId,
      messageId: assistantMessage.id,
      parentId: assistantMessage.parentId,
    }, { source: perfSource });
    recordSendFlowEvent('assistant.persisted', {
      flowId,
      workspaceId: input.workspaceId,
      messageId: assistantMessage.id,
      optimisticMessageId: assistantMessage.id,
    }, { source: perfSource });
  }

  if (assistantMessage) {
    const workspace = input.workspaces.find((candidate) => candidate.id === input.workspaceId) ?? null;
    const repoPath = resolveWorkspaceRepoPath(workspace);
    if (!repoPath) {
      throw new Error('Workspace repository path is required for composer sends.');
    }

    const authToken = await input.getAccessToken();
    const runId = input.createRunId?.() ?? crypto.randomUUID();
    const contextSelection = input.contextPolicy === 'fresh' || !input.parentMessageId
      ? { turns: [], defaultSelectedIds: [] }
      : buildComposerContextSelection(
        input.parentMessageId,
        input.messages,
        input.contextParentId ?? input.parentMessageId,
        input.contextPolicy ?? 'continue',
        input.contextStartId ?? null
      );
    const contextManifest = buildComposerContextManifest(
      contextSelection.turns,
      new Set(contextSelection.defaultSelectedIds)
    );
    const effectivePrompt = buildAgentRunPrompt({
      mode: 'agentree_context',
      userPrompt: prompt,
      contextManifest,
      threadTitleMode: !input.parentMessageId && effectiveThreadId ? 'first_thread_message' : 'none',
    }).prompt;
    const executionData = {
      ...(assistantMessage.execution_data ?? {}),
      current_run_id: runId,
      workspace_id: input.workspaceId,
      agent_id: input.agent.id,
      parentId: assistantMessage.parentId,
      started_at: input.nowIso?.() ?? new Date().toISOString(),
      meta: {
        ...(((assistantMessage.execution_data as any)?.meta ?? {}) as Record<string, unknown>),
        base_commit_sha: input.base.commitSha,
        ...(input.meta ?? {}),
        agent_id: input.agent.id,
        provider: input.agent.type,
        provider_run_mode: input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE,
        composer_permission_mode: input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE,
        llmModel: input.agent.model_config?.model ?? null,
        provider_model: input.agent.model_config?.model ?? null,
        login_profile_id: input.selectedLoginProfileId ?? null,
      },
    };

    input.dispatchAgentRun(assistantMessage.id, {
      type: 'execution_data',
      patch: executionData,
    });
    const spawnStartedAt = performance.now();
    recordSendFlowEvent('agent-setup.spawn.requested', {
      flowId,
      workspaceId: input.workspaceId,
      nodeId: assistantMessage.id,
      runId,
      agentType: input.agent.type,
    }, { source: perfSource });
    try {
      await input.startAgentRun({
        runId,
        assistantNodeId: assistantMessage.id,
        workspaceId: input.workspaceId,
        repoPath,
        parentCommit: input.base.commitSha,
        agentType: input.agent.type,
        args: buildHeadlessComposerAgentArgs(
          input.agent,
          effectivePrompt,
          input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE
        ),
        authToken,
        traceId: null,
        loginProfileId: input.selectedLoginProfileId ?? null,
        runContext: {
          runId,
          executionData,
          gitBranchName: `agentree/${assistantMessage.id}`,
          repoPath,
          parentCommit: input.base.commitSha,
          authorName: input.agent.name ?? null,
          promptFallback: prompt,
        },
      });
      recordSendFlowEvent('agent-setup.spawn.returned', {
        flowId,
        workspaceId: input.workspaceId,
        nodeId: assistantMessage.id,
        runId,
        agentType: input.agent.type,
      }, {
        source: perfSource,
        durationMs: Number((performance.now() - spawnStartedAt).toFixed(2)),
      });
    } catch (error) {
      recordSendFlowEvent('agent-setup.spawn.failed', {
        flowId,
        workspaceId: input.workspaceId,
        nodeId: assistantMessage.id,
        runId,
        agentType: input.agent.type,
        errorMessage: error instanceof Error ? error.message : String(error),
      }, {
        source: perfSource,
        durationMs: Number((performance.now() - spawnStartedAt).toFixed(2)),
      });
      recordSendFlowEvent('lifecycle.failed', {
        flowId,
        workspaceId: input.workspaceId,
        nodeId: assistantMessage.id,
        errorType: 'HEADLESS_AGENT_START_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
      }, { source: perfSource });
      throw error;
    }
    input.dispatchAgentRun(assistantMessage.id, { type: 'status', status: AGENT_STATUS.running });
    recordSendFlowEvent('mark', {
      flowId,
      workspaceId: input.workspaceId,
      markName: 'agent_running_dispatched',
      nodeId: assistantMessage.id,
    }, { source: perfSource });
  }

  return response;
}
