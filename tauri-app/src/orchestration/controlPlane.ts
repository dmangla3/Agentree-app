import { AGENT_STATUS } from '@shared/agentStatus';
import type { StartAgentRunIntent, StartAgentRunResponse } from '../lib/agentClient';
import {
  buildAgentNodeArgs,
  buildAgentNodeStartIntent,
  createAgentNodeMessages,
} from '../lib/agentNodeLaunch';
import type { ComposerContextManifest } from '../lib/composerContext';
import {
  DEFAULT_COMPOSER_PERMISSION_MODE,
  type ComposerPermissionMode,
} from '../lib/composerPermissions';
import { buildAgentRunLaunchContext } from '../lib/agentRunLaunchContext';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';
import { getSatisfiedActiveWaitGroup, type OrchestrationRecoveryProjection } from './domain';

export interface StartOrchestrationRunInput {
  workspaceId: string;
  repoPath: string;
  authToken: string;
  orchestratorRunId: string;
  orchestratorNodeId: string;
  decisionId: string;
  parentNodeId: string | null;
  contextParentNodeId: string | null;
  baseNodeId: string | null;
  baseCommitSha: string;
  prompt: string;
  agentId: string;
  agentType: string;
  agentCliArgs?: string | null;
  agentPromptFlag?: string | null;
  agentName?: string | null;
  llmModel?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: ComposerPermissionMode;
  loginProfileId?: string | null;
  contextManifest?: ComposerContextManifest | null;
  providerParentMeta?: Record<string, unknown> | null;
  isBranchFromInterior?: boolean;
  threadId?: string | null;
  threadOriginId?: string | null;
  orchestrationTemplateId?: string | null;
  now?: string;
  userNodeId?: string;
  assistantNodeId?: string;
  runId?: string;
  recordChildRequestedEvent?: boolean;
}

export interface RetryOrchestrationChildRunInput extends StartOrchestrationRunInput {
  supersededAssistantNodeId: string;
  retryReason?: string | null;
}

export interface StartOrchestratorRunInput {
  workspaceId: string;
  repoPath: string;
  authToken: string;
  parentNodeId: string | null;
  contextParentNodeId: string | null;
  baseNodeId: string | null;
  baseCommitSha: string;
  prompt: string;
  agentId: string;
  agentType: string;
  agentCliArgs?: string | null;
  agentPromptFlag?: string | null;
  agentName?: string | null;
  llmModel?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: ComposerPermissionMode;
  loginProfileId?: string | null;
  contextManifest?: ComposerContextManifest | null;
  providerParentMeta?: Record<string, unknown> | null;
  isBranchFromInterior?: boolean;
  threadId?: string | null;
  threadOriginId?: string | null;
  now?: string;
  userNodeId?: string;
  assistantNodeId?: string;
  runId?: string;
}

export interface StartOrchestrationRunDeps {
  newId: () => string;
  persistLocalNode: (workspaceId: string, nodeId: string, message: Message) => Promise<void>;
  startAgentRun: (intent: StartAgentRunIntent) => Promise<StartAgentRunResponse>;
  recordOrchestrationEvent: (
    runId: string,
    assistantNodeId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) => Promise<number>;
  seedAgentRun?: (message: AgentRunProjectedMessage) => void;
  dispatchAgentRun?: (nodeId: string, event: Record<string, unknown>) => void;
}

export type StartOrchestratorRunDeps = Pick<
  StartOrchestrationRunDeps,
  'newId' | 'persistLocalNode' | 'startAgentRun' | 'seedAgentRun' | 'dispatchAgentRun'
>;

export interface StartOrchestrationRunResult {
  runId: string;
  userNodeId: string;
  assistantNodeId: string;
  userNode: Message;
  assistantNode: Message;
  startResponse: StartAgentRunResponse;
}

export interface RetryOrchestrationChildRunResult extends StartOrchestrationRunResult {
  supersededAssistantNodeId: string;
}

export interface CompleteSatisfiedWaitInput {
  orchestratorRunId: string;
  orchestratorNodeId: string;
  projection: OrchestrationRecoveryProjection;
}

export interface CompleteSatisfiedWaitResult {
  completedWaitGroupId: string | null;
}

export interface CompleteOrchestrationInput {
  orchestratorRunId: string;
  orchestratorNodeId: string;
  terminalChildAssistantNodeIds: string[];
}

export interface CompleteOrchestrationResult {
  completed: boolean;
}

export async function completeSatisfiedWaitGroup(
  input: CompleteSatisfiedWaitInput,
  deps: Pick<StartOrchestrationRunDeps, 'recordOrchestrationEvent'>,
): Promise<CompleteSatisfiedWaitResult> {
  const waitGroup = getSatisfiedActiveWaitGroup(input.projection);
  if (!waitGroup) return { completedWaitGroupId: null };

  await deps.recordOrchestrationEvent(
    input.orchestratorRunId,
    input.orchestratorNodeId,
    'orchestration:wait_completed',
    {
      waitGroupId: waitGroup.waitGroupId,
      decisionIds: waitGroup.decisionIds,
      condition: waitGroup.condition,
    },
  );

  return { completedWaitGroupId: waitGroup.waitGroupId };
}

export async function completeOrchestration(
  input: CompleteOrchestrationInput,
  deps: Pick<StartOrchestrationRunDeps, 'recordOrchestrationEvent'>,
): Promise<CompleteOrchestrationResult> {
  await deps.recordOrchestrationEvent(
    input.orchestratorRunId,
    input.orchestratorNodeId,
    'orchestration:completed',
    {
      terminalChildAssistantNodeIds: input.terminalChildAssistantNodeIds,
      terminalChildRunCount: input.terminalChildAssistantNodeIds.length,
    },
  );

  return { completed: true };
}

export interface CancelOrchestrationInput {
  orchestratorRunId: string;
  orchestratorNodeId: string;
  activeControlledAssistantNodeIds: string[];
  reason?: string | null;
}

export interface CancelOrchestrationDeps {
  recordOrchestrationEvent: StartOrchestrationRunDeps['recordOrchestrationEvent'];
  stopAgent: (assistantNodeId: string) => Promise<void>;
}

export interface CancelOrchestrationResult {
  stoppedAssistantNodeIds: string[];
  cancelled: boolean;
}

export async function cancelOrchestration(
  input: CancelOrchestrationInput,
  deps: CancelOrchestrationDeps,
): Promise<CancelOrchestrationResult> {
  await deps.recordOrchestrationEvent(
    input.orchestratorRunId,
    input.orchestratorNodeId,
    'orchestration:cancel_requested',
    {
      reason: input.reason ?? 'cancelled',
      activeControlledAssistantNodeIds: input.activeControlledAssistantNodeIds,
    },
  );

  const stopTargets = [
    input.orchestratorNodeId,
    ...input.activeControlledAssistantNodeIds,
  ].filter((nodeId, index, all) => nodeId && all.indexOf(nodeId) === index);

  for (const nodeId of stopTargets) {
    await deps.stopAgent(nodeId);
  }

  await deps.recordOrchestrationEvent(
    input.orchestratorRunId,
    input.orchestratorNodeId,
    'orchestration:cancelled',
    {
      reason: input.reason ?? 'cancelled',
      stoppedAssistantNodeIds: stopTargets,
    },
  );

  return {
    stoppedAssistantNodeIds: stopTargets,
    cancelled: true,
  };
}

export async function startOrchestratorRun(
  input: StartOrchestratorRunInput,
  deps: StartOrchestratorRunDeps,
): Promise<StartOrchestrationRunResult> {
  const now = input.now ?? new Date().toISOString();
  const userNodeId = input.userNodeId ?? deps.newId();
  const assistantNodeId = input.assistantNodeId ?? deps.newId();
  const runId = input.runId ?? deps.newId();
  const permissionMode = input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE;
  const launchContext = buildAgentRunLaunchContext({
    agentType: input.agentType,
    userPrompt: input.prompt,
    contextPolicy: input.contextParentNodeId ? 'continue' : 'fresh',
    contextParentMessageId: input.contextParentNodeId,
    baseMessageId: input.parentNodeId,
    contextManifest: input.contextManifest ?? null,
    providerParentMeta: input.providerParentMeta ?? null,
    isBranchFromInterior: input.isBranchFromInterior,
    targetNodeId: input.parentNodeId,
    nodeId: assistantNodeId,
    threadTitleMode: 'none',
    orchestrationLabelMode: 'orchestrator',
    orchestrationControl: {
      orchestratorRunId: runId,
      orchestratorNodeId: assistantNodeId,
    },
  });

  const pair = createAgentNodeMessages({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    agentType: input.agentType,
    parentNodeId: input.parentNodeId,
    contextParentNodeId: input.contextParentNodeId,
    baseNodeId: input.baseNodeId,
    baseCommitSha: input.baseCommitSha,
    prompt: input.prompt,
    contextManifest: launchContext.contextManifest,
    threadId: input.threadId ?? null,
    threadOriginId: input.threadOriginId ?? null,
    agentName: input.agentName ?? null,
    llmModel: input.llmModel ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    permissionMode,
    loginProfileId: input.loginProfileId ?? null,
    orchestration: {
      nodeKind: 'orchestrator',
    },
    now,
    userNodeId,
    assistantNodeId,
  });

  deps.seedAgentRun?.(pair.userNode as AgentRunProjectedMessage);
  deps.seedAgentRun?.(pair.assistantNode as AgentRunProjectedMessage);
  deps.dispatchAgentRun?.(pair.assistantNode.id, { type: 'status', status: 'initializing' });
  deps.dispatchAgentRun?.(pair.assistantNode.id, { type: 'setup_progress', progress: 'Initializing agent...' });

  await Promise.all([
    deps.persistLocalNode(input.workspaceId, pair.userNode.id, pair.userNode),
    deps.persistLocalNode(input.workspaceId, pair.assistantNode.id, pair.assistantNode),
  ]);

  const effectivePrompt = launchContext.prompt;

  const executionData = {
    ...(pair.assistantNode.execution_data ?? {}),
    current_run_id: runId,
    workspace_id: input.workspaceId,
    repo_path: input.repoPath,
    agent_id: input.agentId,
    parentId: pair.assistantNode.parentId,
    started_at: now,
    meta: {
      ...((pair.assistantNode.execution_data?.meta ?? {}) as Record<string, unknown>),
      base_commit_sha: input.baseCommitSha,
      ...launchContext.meta,
      orchestrator_run_id: runId,
      ...(input.agentCliArgs ? { agent_cli_args: input.agentCliArgs } : {}),
      ...(input.agentPromptFlag ? { agent_prompt_flag: input.agentPromptFlag } : {}),
      ...(input.agentName ? { agent_name: input.agentName } : {}),
    },
  };
  deps.dispatchAgentRun?.(pair.assistantNode.id, { type: 'execution_data', patch: executionData });

  const assistantNode = {
    ...pair.assistantNode,
    execution_data: executionData,
  };
  await deps.persistLocalNode(input.workspaceId, assistantNode.id, assistantNode);

  const startIntent = buildAgentNodeStartIntent({
    runId,
    pair: { ...pair, assistantNode },
    workspaceId: input.workspaceId,
    repoPath: input.repoPath,
    parentCommit: input.baseCommitSha,
    agentType: input.agentType,
    args: buildAgentNodeArgs({
      agentType: input.agentType,
      cliArgs: input.agentCliArgs,
      permissionMode,
      providerInternalArgs: launchContext.providerInternalArgs,
      promptFlag: input.agentPromptFlag,
      prompt: effectivePrompt,
    }),
    authToken: input.authToken,
    executionData,
    agentName: input.agentName ?? null,
    promptFallback: input.prompt,
    loginProfileId: input.loginProfileId ?? null,
  });
  const startResponse = await deps.startAgentRun(startIntent);

  deps.dispatchAgentRun?.(assistantNode.id, { type: 'status', status: AGENT_STATUS.running });

  return {
    runId,
    userNodeId: pair.userNode.id,
    assistantNodeId: assistantNode.id,
    userNode: pair.userNode,
    assistantNode,
    startResponse,
  };
}

export async function retryOrchestrationChildRun(
  input: RetryOrchestrationChildRunInput,
  deps: StartOrchestrationRunDeps,
): Promise<RetryOrchestrationChildRunResult> {
  await deps.recordOrchestrationEvent(
    input.orchestratorRunId,
    input.orchestratorNodeId,
    'orchestration:retry_requested',
    {
      decisionId: input.decisionId,
      supersededAssistantNodeId: input.supersededAssistantNodeId,
      reason: input.retryReason ?? 'retry_requested',
    },
  );

  const replacement = await startOrchestrationChildRun(input, deps);

  await deps.recordOrchestrationEvent(
    input.orchestratorRunId,
    input.orchestratorNodeId,
    'orchestration:child_superseded',
    {
      decisionId: input.decisionId,
      supersededAssistantNodeId: input.supersededAssistantNodeId,
      replacementAssistantNodeId: replacement.assistantNodeId,
      replacementRunId: replacement.runId,
      reason: input.retryReason ?? 'retry_requested',
    },
  );

  return {
    ...replacement,
    supersededAssistantNodeId: input.supersededAssistantNodeId,
  };
}

export async function startOrchestrationChildRun(
  input: StartOrchestrationRunInput,
  deps: StartOrchestrationRunDeps,
): Promise<StartOrchestrationRunResult> {
  const now = input.now ?? new Date().toISOString();
  const userNodeId = input.userNodeId ?? deps.newId();
  const assistantNodeId = input.assistantNodeId ?? deps.newId();
  const runId = input.runId ?? deps.newId();
  const permissionMode = input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE;
  const launchContext = buildAgentRunLaunchContext({
    agentType: input.agentType,
    userPrompt: input.prompt,
    contextPolicy: input.contextParentNodeId ? 'continue' : 'fresh',
    contextParentMessageId: input.contextParentNodeId,
    baseMessageId: input.parentNodeId,
    contextManifest: input.contextManifest ?? null,
    providerParentMeta: input.providerParentMeta ?? null,
    isBranchFromInterior: input.isBranchFromInterior,
    targetNodeId: input.parentNodeId,
    nodeId: assistantNodeId,
    threadTitleMode: 'none',
  });

  const pair = createAgentNodeMessages({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    agentType: input.agentType,
    parentNodeId: input.parentNodeId,
    contextParentNodeId: input.contextParentNodeId,
    baseNodeId: input.baseNodeId,
    baseCommitSha: input.baseCommitSha,
    prompt: input.prompt,
    contextManifest: launchContext.contextManifest,
    threadId: input.threadId ?? null,
    threadOriginId: input.threadOriginId ?? null,
    agentName: input.agentName ?? null,
    llmModel: input.llmModel ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    permissionMode,
    loginProfileId: input.loginProfileId ?? null,
    orchestration: {
      controlledByNodeId: input.orchestratorNodeId,
      orchestrationDecisionId: input.decisionId,
      orchestrationTemplateId: input.orchestrationTemplateId ?? null,
      nodeKind: 'normal',
    },
    now,
    userNodeId,
    assistantNodeId,
  });

  deps.seedAgentRun?.(pair.userNode as AgentRunProjectedMessage);
  deps.seedAgentRun?.(pair.assistantNode as AgentRunProjectedMessage);
  deps.dispatchAgentRun?.(pair.assistantNode.id, { type: 'status', status: 'initializing' });
  deps.dispatchAgentRun?.(pair.assistantNode.id, { type: 'setup_progress', progress: 'Initializing agent...' });

  if (input.recordChildRequestedEvent !== false) {
    await deps.recordOrchestrationEvent(
      input.orchestratorRunId,
      input.orchestratorNodeId,
      'orchestration:child_requested',
      {
        decisionId: input.decisionId,
        childUserNodeId: pair.userNode.id,
        childAssistantNodeId: pair.assistantNode.id,
        childRunId: runId,
        parentNodeId: input.parentNodeId,
        orchestrationTemplateId: input.orchestrationTemplateId ?? null,
      },
    );
  }

  await Promise.all([
    deps.persistLocalNode(input.workspaceId, pair.userNode.id, pair.userNode),
    deps.persistLocalNode(input.workspaceId, pair.assistantNode.id, pair.assistantNode),
  ]);

  const effectivePrompt = launchContext.prompt;

  const executionData = {
    ...(pair.assistantNode.execution_data ?? {}),
    current_run_id: runId,
    workspace_id: input.workspaceId,
    repo_path: input.repoPath,
    agent_id: input.agentId,
    parentId: pair.assistantNode.parentId,
    started_at: now,
    meta: {
      ...((pair.assistantNode.execution_data?.meta ?? {}) as Record<string, unknown>),
      base_commit_sha: input.baseCommitSha,
      ...launchContext.meta,
      child_run_id: runId,
      ...(input.agentCliArgs ? { agent_cli_args: input.agentCliArgs } : {}),
      ...(input.agentPromptFlag ? { agent_prompt_flag: input.agentPromptFlag } : {}),
      ...(input.agentName ? { agent_name: input.agentName } : {}),
    },
  };
  deps.dispatchAgentRun?.(pair.assistantNode.id, { type: 'execution_data', patch: executionData });

  const assistantNode = {
    ...pair.assistantNode,
    execution_data: executionData,
  };
  await deps.persistLocalNode(input.workspaceId, assistantNode.id, assistantNode);

  const startIntent = buildAgentNodeStartIntent({
    runId,
    pair: { ...pair, assistantNode },
    workspaceId: input.workspaceId,
    repoPath: input.repoPath,
    parentCommit: input.baseCommitSha,
    agentType: input.agentType,
    args: buildAgentNodeArgs({
      agentType: input.agentType,
      cliArgs: input.agentCliArgs,
      permissionMode,
      providerInternalArgs: launchContext.providerInternalArgs,
      promptFlag: input.agentPromptFlag,
      prompt: effectivePrompt,
    }),
    authToken: input.authToken,
    executionData,
    agentName: input.agentName ?? null,
    promptFallback: input.prompt,
    loginProfileId: input.loginProfileId ?? null,
  });
  const startResponse = await deps.startAgentRun(startIntent);

  deps.dispatchAgentRun?.(assistantNode.id, { type: 'status', status: AGENT_STATUS.running });
  await deps.recordOrchestrationEvent(
    input.orchestratorRunId,
    input.orchestratorNodeId,
    'orchestration:child_started',
    {
      decisionId: input.decisionId,
      childUserNodeId: pair.userNode.id,
      childAssistantNodeId: assistantNode.id,
      childRunId: runId,
    },
  );

  return {
    runId,
    userNodeId: pair.userNode.id,
    assistantNodeId: assistantNode.id,
    userNode: pair.userNode,
    assistantNode,
    startResponse,
  };
}
