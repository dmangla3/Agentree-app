import { AGENT_STATUS } from '@shared/agentStatus';
import { buildComposerContextManifest, buildComposerContextSelection } from '../lib/composerContext';
import { buildAgentRunPrompt } from '../lib/prompts';
import type { Message, Workspace } from '../stores/workspaceStore';
import type { Agent } from '../hooks/useAgents';

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
  sendMessage: (input: Record<string, unknown>) => Promise<HeadlessComposerReplyResponse>;
  hasRuntime: () => boolean;
  startAgentRun: (input: Record<string, unknown>) => Promise<unknown>;
  getAccessToken: () => Promise<string | null>;
  seedAgentRun: (message: Message) => void;
  dispatchAgentRun: (nodeId: string, event: Record<string, unknown>) => void;
  onAssistantMessageCreated?: (message: Message) => void;
  createRunId?: () => string;
  nowIso?: () => string;
}

export interface HeadlessComposerMessageInput extends Omit<HeadlessComposerReplyInput, 'replyParentId'> {
  parentMessageId: string | null;
  contextParentId?: string | null;
  contextPolicy?: 'continue' | 'fresh';
  contextStartId?: string | null;
  setupProgress?: string;
  meta?: Record<string, unknown>;
  threadOriginId?: string | null;
}

const splitCliArgs = (value: string | null | undefined): string[] => (
  String(value || '').split(/\s+/).filter(Boolean)
);

export const buildHeadlessComposerAgentArgs = (agent: Agent, prompt: string): string[] => {
  const args = splitCliArgs(agent.cliArgs);
  if (agent.type === 'codex' || !agent.promptFlag) {
    return [...args, prompt];
  }
  return [...args, agent.promptFlag, prompt];
};

export const resolveWorkspaceRepoPath = (workspace: Workspace | null | undefined): string | null => (
  workspace?.git_repo_path?.trim() || workspace?.folderPath?.trim() || null
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
  const response = await input.sendMessage({
    workspaceId: input.workspaceId,
    prompt,
    parentId: input.parentMessageId,
    attachments: [],
    contextIds: [],
    contextMode: 'active',
    contextPolicy: input.contextPolicy ?? 'continue',
    contextParentId: input.contextParentId ?? input.parentMessageId,
    useAgent: true,
    agentId: input.agent.id,
    agentProvider: input.agent.type,
    llmModel: input.agent.model_config?.model ?? null,
    baseCommitSha: input.base.commitSha,
    baseSelectedFromNodeId: input.base.selectedFromNodeId,
    threadOriginId: input.threadOriginId ?? undefined,
  });

  const userMessage = response?.userMessage;
  const assistantMessage = response?.assistantMessages?.[0];
  if (userMessage) input.seedAgentRun(userMessage);
  if (assistantMessage) {
    input.seedAgentRun(assistantMessage);
    input.onAssistantMessageCreated?.(assistantMessage);
    input.dispatchAgentRun(assistantMessage.id, { type: 'status', status: 'initializing' });
    input.dispatchAgentRun(assistantMessage.id, {
      type: 'setup_progress',
      progress: input.setupProgress ?? 'Starting composer run...',
    });
  }

  if (input.hasRuntime() && assistantMessage) {
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
    }).prompt;
    const executionData = {
      ...(assistantMessage.execution_data ?? {}),
      current_run_id: runId,
      workspace_id: input.workspaceId,
      parentId: assistantMessage.parentId,
      started_at: input.nowIso?.() ?? new Date().toISOString(),
      meta: {
        ...(((assistantMessage.execution_data as any)?.meta ?? {}) as Record<string, unknown>),
        base_commit_sha: input.base.commitSha,
        ...(input.meta ?? {}),
        provider: input.agent.type,
        llmModel: input.agent.model_config?.model ?? null,
        provider_model: input.agent.model_config?.model ?? null,
      },
    };

    input.dispatchAgentRun(assistantMessage.id, {
      type: 'execution_data',
      patch: executionData,
    });
    await input.startAgentRun({
      runId,
      assistantNodeId: assistantMessage.id,
      workspaceId: input.workspaceId,
      repoPath,
      parentCommit: input.base.commitSha,
      agentType: input.agent.type,
      args: buildHeadlessComposerAgentArgs(input.agent, effectivePrompt),
      authToken,
      traceId: null,
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
    input.dispatchAgentRun(assistantMessage.id, { type: 'status', status: AGENT_STATUS.running });
  }

  return response;
}
