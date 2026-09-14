import { useCallback, useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { QueryClient } from '@tanstack/react-query';
import { commands as tauriCommands } from '../generated/tauri-bindings';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { getOptionalCloudAuthToken } from '../lib/authSession';
import { agentClient } from '../lib/agentClient';
import { resolveWorkspaceRepoPath } from '../composer/headlessComposerSend';
import { getThreadOriginNodeId } from '../lib/graphThreadRoots';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache } from '../hooks/useLocalNodes';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { useAgentRunProjectionStore, type AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message, Workspace } from '../stores/workspaceStore';
import { startOrchestrationRun } from './controlPlane';
import { findExistingOrchestrationRunLaunch } from './domain';
import { isActiveAgentStatus, isFailureAgentStatus, isTerminalAgentStatus } from '@shared/agentStatus';

interface OrchestrationMcpRequest {
  requestId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
}

interface UseOrchestrationMcpBridgeInput {
  selectedWorkspaceId: string | null;
  messages: Message[];
  workspaces: Workspace[];
  queryClient: QueryClient;
}

export interface PendingWait {
  requestId: string;
  orchestratorRunId: string;
  orchestratorNodeId: string;
  waitGroupId: string;
  assistantNodeIds: string[];
  decisionIds: string[];
  condition: string;
  timeoutId: number | null;
}

interface OrchestrationRunStartResponse {
  runId: string | null;
  userNodeId: string | null;
  assistantNodeId: string;
  initialStatus: string | null;
  existing?: boolean;
}

type PendingOrchestrationRunStartMap = Map<string, Promise<OrchestrationRunStartResponse>>;

export const ORCHESTRATION_WAIT_CONDITIONS = [
  'terminal',
  'all',
  'any',
  'completed',
  'failed',
  'commit_available',
  'any_terminal',
  'any_failed',
] as const;

export type OrchestrationWaitCondition = typeof ORCHESTRATION_WAIT_CONDITIONS[number];

export const ORCHESTRATION_WAIT_MIN_TIMEOUT_MS = 1_000;
export const ORCHESTRATION_WAIT_MAX_TIMEOUT_MS = 100_000;
export const ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS = ORCHESTRATION_WAIT_MAX_TIMEOUT_MS;

export const isOrchestrationWaitCondition = (condition: string): condition is OrchestrationWaitCondition => (
  (ORCHESTRATION_WAIT_CONDITIONS as readonly string[]).includes(condition)
);

export const resolveOrchestrationWaitTimeoutMs = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return ORCHESTRATION_WAIT_DEFAULT_TIMEOUT_MS;
  return Math.max(ORCHESTRATION_WAIT_MIN_TIMEOUT_MS, Math.min(numeric, ORCHESTRATION_WAIT_MAX_TIMEOUT_MS));
};

export const getOrchestrationRunStartKey = (
  orchestratorNodeId: string,
  decisionId: string,
): string => `${orchestratorNodeId}\u001f${decisionId}`;

export const getOrStartPendingOrchestrationRun = async (
  pendingStarts: PendingOrchestrationRunStartMap,
  key: string,
  start: () => Promise<OrchestrationRunStartResponse>,
): Promise<OrchestrationRunStartResponse> => {
  const existing = pendingStarts.get(key);
  if (existing) {
    const response = await existing;
    return {
      ...response,
      existing: true,
    };
  }

  const promise = start().finally(() => {
    pendingStarts.delete(key);
  });
  pendingStarts.set(key, promise);
  return promise;
};

export const mergeMessagesWithLiveWaitProjections = (
  messages: Message[],
  projectionsById: Record<string, AgentRunProjectedMessage>,
): Message[] => {
  if (Object.keys(projectionsById).length === 0) return messages;
  const mergedById = new Map(messages.map((message) => [message.id, message]));
  for (const [nodeId, projection] of Object.entries(projectionsById)) {
    const existing = mergedById.get(nodeId);
    if (!existing) {
      mergedById.set(nodeId, {
        ...projection,
        execution_data: {
          ...((projection.execution_data ?? {}) as Record<string, unknown>),
          __local_authority: {
            source: 'projection',
          },
        },
      } as Message);
      continue;
    }
    mergedById.set(nodeId, {
      ...existing,
      ...projection,
      execution_data: {
        ...((existing.execution_data ?? {}) as Record<string, unknown>),
        ...((projection.execution_data ?? {}) as Record<string, unknown>),
      },
    } as Message);
  }
  return Array.from(mergedById.values());
};

const readString = (record: Record<string, unknown> | null | undefined, key: string): string | null => {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const readRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const readStringArray = (record: Record<string, unknown>, key: string): string[] => (
  Array.isArray(record[key])
    ? (record[key] as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
);

const resolveMeta = (message: Message): Record<string, unknown> => (
  readRecord(readRecord(message.execution_data).meta)
);

const resolveContextProfile = (message: Message): Record<string, unknown> => (
  readRecord(readRecord(message.execution_data).context_profile)
);

const resolveThreadOriginParentNodeId = (message: Message, meta: Record<string, unknown>): string | null => {
  const threadOriginId = readString(meta, 'thread_origin_id')
    ?? (typeof message.threadId === 'string' && message.threadId.trim() ? message.threadId.trim() : null)
    ?? (typeof message.thread_id === 'string' && message.thread_id.trim() ? message.thread_id.trim() : null);
  return threadOriginId ? getThreadOriginNodeId(threadOriginId) : null;
};

const resolveBaseCommitSha = (message: Message, args: Record<string, unknown>): string | null => (
  readString(args, 'base_commit_sha')
  ?? (typeof message.base_commit_sha === 'string' && message.base_commit_sha.trim() ? message.base_commit_sha.trim() : null)
  ?? readString(resolveMeta(message), 'base_commit_sha')
);

const resolveAgentType = (message: Message, args: Record<string, unknown>): string => (
  readString(args, 'agent_type')
  ?? (typeof message.llmProvider === 'string' && message.llmProvider.trim() ? message.llmProvider.trim() : null)
  ?? readString(resolveMeta(message), 'provider')
  ?? 'codex'
);

const resolveAgentId = (message: Message, args: Record<string, unknown>, agentType: string): string => (
  readString(args, 'agent_id')
  ?? (typeof message.agent_id === 'string' && message.agent_id.trim() ? message.agent_id.trim() : null)
  ?? readString(resolveMeta(message), 'agent_id')
  ?? agentType
);

export const resolveOrchestrationRunLaunchDefaults = (
  orchestrator: Message,
  args: Record<string, unknown>,
): {
  parentNodeId: string | null;
  contextParentNodeId: string | null;
  baseNodeId: string | null;
} => {
  const meta = resolveMeta(orchestrator);
  const contextProfile = resolveContextProfile(orchestrator);
  const parentNodeId = readString(args, 'parent_node_id')
    ?? readString(meta, 'orchestration_target_node_id')
    ?? resolveThreadOriginParentNodeId(orchestrator, meta);
  const contextParentNodeId = readString(args, 'context_parent_node_id')
    ?? readString(meta, 'orchestration_context_parent_node_id')
    ?? readString(contextProfile, 'context_parent_node_id')
    ?? parentNodeId;
  const baseNodeId = readString(args, 'base_node_id')
    ?? readString(meta, 'orchestration_base_node_id')
    ?? readString(contextProfile, 'base_node_id')
    ?? (typeof orchestrator.base_selected_from_node_id === 'string' ? orchestrator.base_selected_from_node_id : null)
    ?? parentNodeId;

  return {
    parentNodeId,
    contextParentNodeId,
    baseNodeId,
  };
};

const respond = async (requestId: string, response: Record<string, unknown> | null, error: string | null) => {
  await tauriCommands.resolveOrchestrationMcpRequest(
    requestId,
    response ? JSON.stringify(response) : null,
    error,
  );
};

const respondSafely = async (requestId: string, response: Record<string, unknown> | null, error: string | null) => {
  try {
    await respond(requestId, response, error);
  } catch (caught) {
    console.warn('[OrchestrationMcpBridge] Dropped orchestration response for abandoned request:', {
      requestId,
      error: caught instanceof Error ? caught.message : String(caught),
    });
  }
};

const getMessageTerminalStatus = (message: Message | null): string | null => {
  const status = typeof message?.status === 'string' ? message.status : null;
  const lastTerminal = readString(readRecord(message?.execution_data), 'last_terminal_status');
  return status && isTerminalAgentStatus(status)
    ? status
    : lastTerminal && isTerminalAgentStatus(lastTerminal)
      ? lastTerminal
      : null;
};

const getMessageLastActivityAt = (message: Message | null): string | null => {
  if (!message) return null;
  return message.heartbeat_at
    ?? message.last_event_at
    ?? message.updatedAt
    ?? message.createdAt
    ?? null;
};

export const isOrchestrationWaitSatisfied = (wait: Pick<PendingWait, 'assistantNodeIds' | 'condition'>, messages: Message[]): boolean => {
  const runs = wait.assistantNodeIds.map((id) => messages.find((message) => message.id === id) ?? null);
  if (runs.length === 0 || runs.some((message) => !message)) return false;

  switch (wait.condition) {
    case 'any':
    case 'any_terminal':
      return runs.some((message) => Boolean(getMessageTerminalStatus(message)));
    case 'failed':
    case 'any_failed':
      return runs.some((message) => isFailureAgentStatus(getMessageTerminalStatus(message)));
    case 'completed':
      return runs.every((message) => getMessageTerminalStatus(message) === 'completed');
    case 'commit_available':
      return runs.every((message) => Boolean(message?.output_commit_sha));
    case 'all':
    case 'terminal':
    default:
      return runs.every((message) => Boolean(getMessageTerminalStatus(message)));
  }
};

const buildWaitSummary = (wait: PendingWait, messages: Message[]): Record<string, unknown> => ({
  waitGroupId: wait.waitGroupId,
  condition: wait.condition,
  runs: wait.assistantNodeIds.map((assistantNodeId) => {
    const message = messages.find((candidate) => candidate.id === assistantNodeId) ?? null;
    const status = typeof message?.status === 'string' ? message.status : null;
    return {
      assistantNodeId,
      status,
      terminalStatus: getMessageTerminalStatus(message),
      active: isActiveAgentStatus(status),
      lastActivityAt: getMessageLastActivityAt(message),
      outputCommitSha: message?.output_commit_sha ?? null,
      aiLabel: message?.aiLabel ?? null,
      source: readString(readRecord(readRecord(message?.execution_data).__local_authority), 'source') ?? 'persisted',
    };
  }),
});

export const buildWaitTimeoutSummary = (wait: PendingWait, messages: Message[]): Record<string, unknown> => ({
  ...buildWaitSummary(wait, messages),
  checkpointElapsed: true,
  waitExpired: true,
  // Deprecated compatibility alias. This means the wait checkpoint elapsed, not that a child run timed out.
  timedOut: true,
  conditionSatisfied: false,
});

const matchesGraphLiveFilter = (message: Message, filters: Record<string, unknown>): boolean => {
  for (const [key, expected] of Object.entries(filters)) {
    if (expected === undefined || expected === null || expected === '') continue;
    const actual = key === 'id' || key === 'node_id' || key === 'nodeId'
      ? message.id
      : key === 'status'
        ? message.status
        : key === 'role'
          ? message.role
          : key === 'workspace_id' || key === 'workspaceId'
            ? message.workspaceId
            : key === 'parent_id' || key === 'parentId'
              ? message.parentId
              : readRecord(message as unknown as Record<string, unknown>)[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
};

export const buildGraphLiveQuerySummary = (
  args: Record<string, unknown>,
  messages: Message[],
  selectedWorkspaceId: string | null,
): Record<string, unknown> => {
  const workspaceId = readString(args, 'workspace_id') ?? readString(args, 'workspaceId') ?? selectedWorkspaceId;
  const filters = readRecord(args.filters);
  const nodeId = readString(args, 'node_id') ?? readString(args, 'nodeId');
  const limitValue = Number(args.limit);
  const offsetValue = Number(args.offset);
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : 20;
  const offset = Number.isFinite(offsetValue) && offsetValue > 0 ? offsetValue : 0;
  const filtered = messages
    .filter((message) => !workspaceId || message.workspaceId === workspaceId)
    .filter((message) => !nodeId || message.id === nodeId)
    .filter((message) => matchesGraphLiveFilter(message, filters));
  const page = filtered.slice(offset, offset + limit);

  return {
    source: 'live',
    includesLocalAndProjectionState: true,
    workspaceId,
    filters,
    total: filtered.length,
    offset,
    limit,
    nodes: page.map((message) => {
      const status = typeof message.status === 'string' ? message.status : null;
      return {
        nodeId: message.id,
        role: message.role,
        status,
        active: isActiveAgentStatus(status),
        lastActivityAt: getMessageLastActivityAt(message),
        terminalStatus: getMessageTerminalStatus(message),
        parentId: message.parentId ?? null,
        workspaceId: message.workspaceId ?? null,
        outputCommitSha: message.output_commit_sha ?? null,
        aiLabel: message.aiLabel ?? null,
        source: readString(readRecord(readRecord(message.execution_data).__local_authority), 'source') ?? 'persisted-or-local-cache',
      };
    }),
  };
};

export const patchOrchestrationWaitMessagesIntoCaches = (
  queryClient: QueryClient,
  wait: Pick<PendingWait, 'assistantNodeIds'>,
  currentMessages: Message[],
) => {
  const messagesByWorkspace = new Map<string, Message[]>();
  for (const assistantNodeId of wait.assistantNodeIds) {
    const message = currentMessages.find((candidate) => candidate.id === assistantNodeId);
    if (!message?.workspaceId) continue;
    const existing = messagesByWorkspace.get(message.workspaceId) ?? [];
    existing.push(message);
    messagesByWorkspace.set(message.workspaceId, existing);
  }

  for (const [workspaceId, waitedMessages] of messagesByWorkspace) {
    const waitedIds = new Set(waitedMessages.map((message) => message.id));
    queryClient.setQueryData<Message[]>(['messages', workspaceId], (current) => {
      const existing = current ?? [];
      return [...existing.filter((message) => !waitedIds.has(message.id)), ...waitedMessages]
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    });
    queryClient.setQueryData(
      localNodeKeys.workspace(workspaceId),
      (current) => upsertMessagesIntoLocalNodeCache(current as any, workspaceId, waitedMessages, {
        finalizedAt: Math.floor(Date.now() / 1000),
      }),
    );
  }
};

export function useOrchestrationMcpBridge({
  selectedWorkspaceId,
  messages,
  workspaces,
  queryClient,
}: UseOrchestrationMcpBridgeInput) {
  const pendingWaitsRef = useRef(new Map<string, PendingWait>());
  const pendingOrchestrationRunStartsRef = useRef<PendingOrchestrationRunStartMap>(new Map());
  const latestMessagesRef = useRef(messages);
  const latestProjectionsRef = useRef(useAgentRunProjectionStore.getState().projectionsById);

  const getCurrentWaitMessages = useCallback(() => (
    mergeMessagesWithLiveWaitProjections(latestMessagesRef.current, latestProjectionsRef.current)
  ), []);

  useEffect(() => {
    latestMessagesRef.current = messages;
  }, [messages]);

  const tryResolveWait = useCallback(async (wait: PendingWait, currentMessages: Message[]): Promise<boolean> => {
    if (!isOrchestrationWaitSatisfied(wait, currentMessages)) return false;
    pendingWaitsRef.current.delete(wait.requestId);
    if (wait.timeoutId !== null) window.clearTimeout(wait.timeoutId);
    await agentClient.recordOrchestrationEvent(
      wait.orchestratorRunId,
      wait.orchestratorNodeId,
      'orchestration:wait_completed',
      buildWaitSummary(wait, currentMessages),
    );
    patchOrchestrationWaitMessagesIntoCaches(queryClient, wait, currentMessages);
    await respondSafely(wait.requestId, buildWaitSummary(wait, currentMessages), null);
    return true;
  }, [queryClient]);

  useEffect(() => {
    const currentMessages = getCurrentWaitMessages();
    for (const wait of Array.from(pendingWaitsRef.current.values())) {
      void tryResolveWait(wait, currentMessages);
    }
  }, [getCurrentWaitMessages, messages, tryResolveWait]);

  useEffect(() => {
    const unsubscribe = useAgentRunProjectionStore.subscribe((state) => {
      latestProjectionsRef.current = state.projectionsById;
      const currentMessages = getCurrentWaitMessages();
      for (const wait of Array.from(pendingWaitsRef.current.values())) {
        void tryResolveWait(wait, currentMessages);
      }
    });
    return unsubscribe;
  }, [getCurrentWaitMessages, tryResolveWait]);

  useEffect(() => () => {
    for (const wait of pendingWaitsRef.current.values()) {
      if (wait.timeoutId !== null) window.clearTimeout(wait.timeoutId);
      void respondSafely(wait.requestId, null, 'Orchestration MCP bridge unmounted before wait completed.');
    }
    pendingWaitsRef.current.clear();
    pendingOrchestrationRunStartsRef.current.clear();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    const install = async () => {
      const nextUnlisten = await listen<OrchestrationMcpRequest>('agentree://orchestration-mcp-request', async (event) => {
        const request = event.payload;
        const requestId = request?.requestId;
        if (!requestId) return;

        try {
	          if (request.toolName === 'wait_for_runs') {
            const args = readRecord(request.arguments);
            const orchestratorRunId = readString(args, 'orchestrator_run_id');
            const orchestratorNodeId = readString(args, 'orchestrator_node_id');
            const assistantNodeIds = readStringArray(args, 'assistant_node_ids');
            if (!orchestratorRunId || !orchestratorNodeId || assistantNodeIds.length === 0) {
              await respond(requestId, null, 'orchestrator_run_id, orchestrator_node_id, and assistant_node_ids are required.');
              return;
            }

            const wait: PendingWait = {
              requestId,
              orchestratorRunId,
              orchestratorNodeId,
              waitGroupId: readString(args, 'wait_group_id') ?? crypto.randomUUID(),
              assistantNodeIds,
              decisionIds: readStringArray(args, 'decision_ids'),
              condition: readString(args, 'condition') ?? 'terminal',
              timeoutId: null,
            };

            if (!isOrchestrationWaitCondition(wait.condition)) {
              await respond(requestId, null, `condition must be one of: ${ORCHESTRATION_WAIT_CONDITIONS.join(', ')}.`);
              return;
            }

            await agentClient.recordOrchestrationEvent(orchestratorRunId, orchestratorNodeId, 'orchestration:wait_started', {
              waitGroupId: wait.waitGroupId,
              assistantNodeIds: wait.assistantNodeIds,
              decisionIds: wait.decisionIds,
              condition: wait.condition,
            });

            if (await tryResolveWait(wait, getCurrentWaitMessages())) return;

            const timeoutMs = resolveOrchestrationWaitTimeoutMs(args.timeout_ms);
            wait.timeoutId = window.setTimeout(() => {
              pendingWaitsRef.current.delete(requestId);
              void respondSafely(requestId, buildWaitTimeoutSummary(wait, getCurrentWaitMessages()), null);
            }, timeoutMs);
            pendingWaitsRef.current.set(requestId, wait);
	            return;
	          }

          if (request.toolName === 'graph_live_query') {
            const args = readRecord(request.arguments);
            await respond(requestId, buildGraphLiveQuerySummary(args, getCurrentWaitMessages(), selectedWorkspaceId), null);
            return;
          }

          if (request.toolName === 'control_run') {
            const args = readRecord(request.arguments);
            const assistantNodeId = readString(args, 'assistant_node_id');
            const action = readString(args, 'action');
            if (!assistantNodeId || !action) {
              await respond(requestId, null, 'assistant_node_id and action are required.');
              return;
            }
            if (action === 'steer') {
              const content = readString(args, 'content');
              if (!content) {
                await respond(requestId, null, 'content is required when action is steer.');
                return;
              }
              const idempotencyKey = readString(args, 'idempotency_key') ?? crypto.randomUUID();
              await agentClient.steerAgentRun(assistantNodeId, content, idempotencyKey);
              await respond(requestId, {
                controlled: true,
                action,
                assistantNodeId,
                idempotencyKey,
              }, null);
              return;
            }
            if (action === 'stop') {
              const currentMessages = getCurrentWaitMessages();
              const target = currentMessages.find((message) => message.id === assistantNodeId) ?? null;
              const status = typeof target?.status === 'string' ? target.status : null;
              const active = isActiveAgentStatus(status);
              const force = args.force === true;
              const reason = readString(args, 'reason');
              if (active && (!force || !reason)) {
                await respond(requestId, {
                  controlled: false,
                  blocked: true,
                  action,
                  assistantNodeId,
                  status,
                  reasonRequired: true,
                  forceRequired: true,
                  message: 'Run is still active. Pass force=true and reason to stop an active orchestration run.',
                }, null);
                return;
              }
              await agentClient.stopAgent(assistantNodeId);
              await respond(requestId, {
                controlled: true,
                action,
                assistantNodeId,
                status,
                reason: reason ?? null,
              }, null);
              return;
            }
            await respond(requestId, null, 'action must be steer or stop.');
            return;
          }

          if (request.toolName !== 'start_orchestration_run') {
            await respond(requestId, null, `Unsupported orchestration MCP tool: ${request.toolName ?? 'unknown'}`);
            return;
          }

          const args = readRecord(request.arguments);
          const currentMessages = latestMessagesRef.current;
          const orchestratorRunId = readString(args, 'orchestrator_run_id');
          const orchestratorNodeId = readString(args, 'orchestrator_node_id');
          const decisionId = readString(args, 'decision_id');
          const prompt = readString(args, 'prompt');
          if (!orchestratorRunId || !orchestratorNodeId || !decisionId || !prompt) {
            await respond(requestId, null, 'orchestrator_run_id, orchestrator_node_id, decision_id, and prompt are required.');
            return;
          }

          const existingLaunch = findExistingOrchestrationRunLaunch(currentMessages, orchestratorNodeId, decisionId);
          if (existingLaunch) {
            await respond(requestId, {
              runId: existingLaunch.runId,
              userNodeId: existingLaunch.userNodeId,
              assistantNodeId: existingLaunch.assistantNodeId,
              initialStatus: existingLaunch.status,
              existing: true,
            }, null);
            return;
          }

          const orchestrationRunStartResponse = await getOrStartPendingOrchestrationRun(
            pendingOrchestrationRunStartsRef.current,
            getOrchestrationRunStartKey(orchestratorNodeId, decisionId),
            async () => {
              const orchestrator = latestMessagesRef.current.find((message) => message.id === orchestratorNodeId) ?? null;
              if (!orchestrator) {
                throw new Error(`Orchestrator node ${orchestratorNodeId} is not loaded in the current graph.`);
              }

              const workspaceId = orchestrator.workspaceId ?? selectedWorkspaceId;
              const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
              const repoPath = resolveWorkspaceRepoPath(workspace);
              const baseCommitSha = resolveBaseCommitSha(orchestrator, args);
              if (!workspaceId || !repoPath || !baseCommitSha) {
                throw new Error('Could not resolve workspace, repo path, or base commit for orchestration run launch.');
              }

              const meta = resolveMeta(orchestrator);
              const agentType = resolveAgentType(orchestrator, args);
              const agentId = resolveAgentId(orchestrator, args, agentType);
              const authToken = await getOptionalCloudAuthToken();
              const launchDefaults = resolveOrchestrationRunLaunchDefaults(orchestrator, args);
              const parentNodeId = launchDefaults.parentNodeId;
              const parentNode = latestMessagesRef.current.find((message) => message.id === parentNodeId) ?? null;
              const parentNodeMeta = (parentNode?.execution_data as { meta?: Record<string, unknown> } | null | undefined)?.meta ?? null;
              const parentHasChildren = parentNodeId
                ? latestMessagesRef.current.some((message) => message.parentId === parentNodeId)
                : false;
              const result = await startOrchestrationRun({
                orchestratorRunId,
                orchestratorNodeId,
                decisionId,
                orchestrationTemplateId: readString(args, 'template_id'),
                workspaceId,
                repoPath,
                authToken,
                agentId,
                agentType,
                agentName: readString(args, 'agent_name') ?? readString(meta, 'agent_name'),
                llmModel: readString(args, 'model')
                  ?? (typeof orchestrator.llmModel === 'string' ? orchestrator.llmModel : null)
                  ?? readString(meta, 'provider_model'),
                agentCliArgs: readString(args, 'cli_args') ?? readString(meta, 'agent_cli_args') ?? '',
                agentPromptFlag: readString(args, 'prompt_flag') ?? readString(meta, 'agent_prompt_flag'),
                permissionMode: (readString(args, 'permission_mode') ?? readString(meta, 'composer_permission_mode') ?? undefined) as any,
                loginProfileId: readString(args, 'login_profile_id') ?? readString(meta, 'login_profile_id'),
                parentNodeId,
                contextParentNodeId: launchDefaults.contextParentNodeId,
                providerParentMeta: parentNodeMeta,
                isBranchFromInterior: parentHasChildren,
                baseNodeId: launchDefaults.baseNodeId,
                baseCommitSha,
                prompt,
                threadId: orchestrator.threadId ?? orchestrator.thread_id ?? null,
                threadOriginId: readString(meta, 'thread_origin_id'),
              }, {
                newId: () => crypto.randomUUID(),
                persistLocalNode: (workspaceId, nodeId, message) => agentClient.upsertLocalNode(workspaceId, nodeId, message),
                startAgentRun: (payload) => agentClient.startAgentRun(payload as any),
                recordOrchestrationEvent: (runId, assistantNodeId, eventType, payload) => (
                  agentClient.recordOrchestrationEvent(runId, assistantNodeId, eventType, payload)
                ),
                seedAgentRun: (message) => agentRunManager.seed(message),
                dispatchAgentRun: (nodeId, event) => agentRunManager.dispatch(nodeId, event as any),
              });

              const createdMessages = [result.userNode, result.assistantNode];
              const createdIds = new Set(createdMessages.map((message) => message.id));
              latestMessagesRef.current = [
                ...latestMessagesRef.current.filter((message) => !createdIds.has(message.id)),
                ...createdMessages,
              ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
              queryClient.setQueryData<Message[]>(['messages', workspaceId], (current) => {
                const existing = current ?? [];
                return [...existing.filter((message) => !createdIds.has(message.id)), ...createdMessages]
                  .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
              });
              queryClient.setQueryData(
                localNodeKeys.workspace(workspaceId),
                (current) => upsertMessagesIntoLocalNodeCache(current as any, workspaceId, createdMessages, {
                  syncStatus: 'local_only',
                  finalizedAt: Math.floor(Date.now() / 1000),
                })
              );
              void queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
              void scheduleMessagesRefreshWhenGraphIdle(queryClient, workspaceId, { reason: 'mcp-orchestration-run' });

              return {
                runId: result.runId,
                userNodeId: result.userNodeId,
                assistantNodeId: result.assistantNodeId,
                initialStatus: result.startResponse?.initialStatus ?? null,
              };
            },
          );

          await respond(requestId, { ...orchestrationRunStartResponse }, null);
        } catch (error) {
          await respond(requestId, null, error instanceof Error ? error.message : String(error));
        }
      });
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    };

    void install().catch((error) => {
      console.error('[OrchestrationMcpBridge] Failed to install listener:', error);
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [queryClient, selectedWorkspaceId, tryResolveWait, workspaces]);
}
