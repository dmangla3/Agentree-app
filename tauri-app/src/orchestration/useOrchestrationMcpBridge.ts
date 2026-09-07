import { useCallback, useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { QueryClient } from '@tanstack/react-query';
import { commands as tauriCommands } from '../generated/tauri-bindings';
import { agentRunManager } from '../agent-runs/agentRunManager';
import { getAccessToken } from '../lib/authSession';
import { agentClient } from '../lib/agentClient';
import { resolveWorkspaceRepoPath } from '../composer/headlessComposerSend';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache } from '../hooks/useLocalNodes';
import { scheduleMessagesRefreshWhenGraphIdle } from '../lib/graphInteractionGate';
import { useAgentRunProjectionStore, type AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message, Workspace } from '../stores/workspaceStore';
import { startOrchestrationChildRun } from './controlPlane';
import { findExistingOrchestrationChildLaunch } from './domain';
import { isFailureAgentStatus, isTerminalAgentStatus } from '@shared/agentStatus';

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

interface PendingWait {
  requestId: string;
  orchestratorRunId: string;
  orchestratorNodeId: string;
  waitGroupId: string;
  assistantNodeIds: string[];
  decisionIds: string[];
  condition: string;
  timeoutId: number | null;
}

interface OrchestrationChildStartResponse {
  runId: string | null;
  userNodeId: string | null;
  assistantNodeId: string;
  initialStatus: string | null;
  existing?: boolean;
}

type PendingChildStartMap = Map<string, Promise<OrchestrationChildStartResponse>>;

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

export const isOrchestrationWaitCondition = (condition: string): condition is OrchestrationWaitCondition => (
  (ORCHESTRATION_WAIT_CONDITIONS as readonly string[]).includes(condition)
);

export const getOrchestrationChildStartKey = (
  orchestratorNodeId: string,
  decisionId: string,
): string => `${orchestratorNodeId}\u001f${decisionId}`;

export const getOrStartPendingOrchestrationChild = async (
  pendingStarts: PendingChildStartMap,
  key: string,
  start: () => Promise<OrchestrationChildStartResponse>,
): Promise<OrchestrationChildStartResponse> => {
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
    if (!existing) continue;
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

const respond = async (requestId: string, response: Record<string, unknown> | null, error: string | null) => {
  await tauriCommands.resolveOrchestrationMcpRequest(
    requestId,
    response ? JSON.stringify(response) : null,
    error,
  );
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

export const isOrchestrationWaitSatisfied = (wait: Pick<PendingWait, 'assistantNodeIds' | 'condition'>, messages: Message[]): boolean => {
  const children = wait.assistantNodeIds.map((id) => messages.find((message) => message.id === id) ?? null);
  if (children.length === 0 || children.some((message) => !message)) return false;

  switch (wait.condition) {
    case 'any':
    case 'any_terminal':
      return children.some((message) => Boolean(getMessageTerminalStatus(message)));
    case 'failed':
    case 'any_failed':
      return children.some((message) => isFailureAgentStatus(getMessageTerminalStatus(message)));
    case 'completed':
      return children.every((message) => getMessageTerminalStatus(message) === 'completed');
    case 'commit_available':
      return children.every((message) => Boolean(message?.output_commit_sha));
    case 'all':
    case 'terminal':
    default:
      return children.every((message) => Boolean(getMessageTerminalStatus(message)));
  }
};

const buildWaitSummary = (wait: PendingWait, messages: Message[]): Record<string, unknown> => ({
  waitGroupId: wait.waitGroupId,
  condition: wait.condition,
  runs: wait.assistantNodeIds.map((assistantNodeId) => {
    const message = messages.find((candidate) => candidate.id === assistantNodeId) ?? null;
    return {
      assistantNodeId,
      status: message?.status ?? null,
      terminalStatus: getMessageTerminalStatus(message),
      outputCommitSha: message?.output_commit_sha ?? null,
      aiLabel: message?.aiLabel ?? null,
    };
  }),
});

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
  const pendingChildStartsRef = useRef<PendingChildStartMap>(new Map());
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
    await respond(wait.requestId, buildWaitSummary(wait, currentMessages), null);
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
      void respond(wait.requestId, null, 'Orchestration MCP bridge unmounted before wait completed.');
    }
    pendingWaitsRef.current.clear();
    pendingChildStartsRef.current.clear();
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

            const timeoutMsValue = Number(args.timeout_ms);
            const timeoutMs = Number.isFinite(timeoutMsValue) && timeoutMsValue > 0
              ? Math.min(timeoutMsValue, 30 * 60 * 1000)
              : 10 * 60 * 1000;
            wait.timeoutId = window.setTimeout(() => {
              pendingWaitsRef.current.delete(requestId);
              void respond(requestId, null, `Timed out waiting for ${assistantNodeIds.length} run(s).`);
            }, timeoutMs);
            pendingWaitsRef.current.set(requestId, wait);
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
              await agentClient.stopAgent(assistantNodeId);
              await respond(requestId, {
                controlled: true,
                action,
                assistantNodeId,
              }, null);
              return;
            }
            await respond(requestId, null, 'action must be steer or stop.');
            return;
          }

          if (request.toolName !== 'start_orchestration_child') {
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

          const existingLaunch = findExistingOrchestrationChildLaunch(currentMessages, orchestratorNodeId, decisionId);
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

          const childStartResponse = await getOrStartPendingOrchestrationChild(
            pendingChildStartsRef.current,
            getOrchestrationChildStartKey(orchestratorNodeId, decisionId),
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
                throw new Error('Could not resolve workspace, repo path, or base commit for orchestration child launch.');
              }

              const meta = resolveMeta(orchestrator);
              const contextProfile = resolveContextProfile(orchestrator);
              const agentType = resolveAgentType(orchestrator, args);
              const agentId = resolveAgentId(orchestrator, args, agentType);
              const authToken = await getAccessToken();
              const parentNodeId = readString(args, 'parent_node_id') ?? orchestratorNodeId;
              const parentNode = latestMessagesRef.current.find((message) => message.id === parentNodeId) ?? null;
              const parentNodeMeta = (parentNode?.execution_data as { meta?: Record<string, unknown> } | null | undefined)?.meta ?? null;
              const parentHasChildren = latestMessagesRef.current.some((message) => message.parentId === parentNodeId);
              const result = await startOrchestrationChildRun({
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
                contextParentNodeId: readString(contextProfile, 'context_parent_node_id') ?? parentNodeId,
                providerParentMeta: parentNodeMeta,
                isBranchFromInterior: parentHasChildren,
                baseNodeId: readString(contextProfile, 'base_node_id')
                  ?? (typeof orchestrator.base_selected_from_node_id === 'string' ? orchestrator.base_selected_from_node_id : null)
                  ?? parentNodeId,
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
              void scheduleMessagesRefreshWhenGraphIdle(queryClient, workspaceId, { reason: 'mcp-orchestration-child' });

              return {
                runId: result.runId,
                userNodeId: result.userNodeId,
                assistantNodeId: result.assistantNodeId,
                initialStatus: result.startResponse?.initialStatus ?? null,
              };
            },
          );

          await respond(requestId, { ...childStartResponse }, null);
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
