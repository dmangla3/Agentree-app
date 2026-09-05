import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isTerminalAgentStatus } from '@shared/agentStatus';
import { createAgentreeFlowNodeRunner } from '../flows/agentreeFlowNodeRunner';
import { executeFlow, throwIfFlowCancelled, type FlowExecutionEvent, type FlowExecutionResult } from '../flows/flowExecutor';
import { buildFlowCatalog, getRunnableFlowDescriptors, type RunnableFlowDescriptor } from '../flows/flowCatalog';
import { buildUserFlowNodeRegistry, useUserFlowNodeDefinitions } from '../flows/userFlowNodeRegistryStore';
import { flowRunManager } from '../flows/flowRunManager';
import { useUserFlowSources } from '../flows/userFlowStore';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';
import type { ComposerContextManifest } from '../lib/composerContext';
import { agentClient } from '../lib/agentClient';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import { localNodeKeys, parseLocalNode, type LocalNodeMessage } from './useLocalNodes';
import { useAgentNodeLauncher, type UseAgentNodeLauncherOptions } from './useAgentNodeLauncher';

const FLOW_ASSISTANT_NODE_WALL_CLOCK_TIMEOUT_MS = 60 * 60 * 1000;
const FLOW_ASSISTANT_REQUIRED_COMMIT_TIMEOUT_MS = 30_000;

export interface UseAgentFlowRunnerInput extends UseAgentNodeLauncherOptions {
  workspaceId: string | null;
  selectedAgentId: string | null;
  selectedAgentType: string | null;
  baseNodeId: string | null;
  baseCommitSha: string | null;
  rootParentNodeId?: string | null;
  rootContextParentNodeId?: string | null;
  rootContextManifest?: ComposerContextManifest | null;
  threadId?: string | null;
  agentCliArgs?: string | null;
  agentPromptFlag?: string | null;
  agentName?: string | null;
  llmModel?: string | null;
  reasoningEffort?: string | null;
  loginProfileId?: string | null;
}

export type AgentFlowDescriptor = RunnableFlowDescriptor;

export function useAgentFlowRunner(input: UseAgentFlowRunnerInput) {
  const queryClient = useQueryClient();
  const { launchAgentNode } = useAgentNodeLauncher({ startStreamForNode: input.startStreamForNode });
  const userFlowSources = useUserFlowSources(input.workspaceId);
  const userNodeDefinitions = useUserFlowNodeDefinitions();
  const registry = useMemo(() => buildUserFlowNodeRegistry(userNodeDefinitions), [userNodeDefinitions]);
  const catalog = useMemo(() => buildFlowCatalog({ userSources: userFlowSources, registry }), [registry, userFlowSources]);
  const flows = useMemo(() => getRunnableFlowDescriptors(catalog), [catalog]);
  const [selectedFlowId, setSelectedFlowId] = useState('');
  const [events, setEvents] = useState<FlowExecutionEvent[]>([]);

  const waitForAssistantNode = useCallback((assistantNodeId: string, options?: { requireCommit?: boolean; signal?: AbortSignal }) => (
    waitForAssistantNodeCompletion({
      assistantNodeId,
      queryClient,
      workspaceId: input.workspaceId,
      requireCommit: options?.requireCommit ?? false,
      signal: options?.signal,
    })
  ), [input.workspaceId, queryClient]);

  const runFlow = useCallback(async (runInput: { input: string; count: number; signal?: AbortSignal; threadId?: string | null }): Promise<FlowExecutionResult> => {
    if (!input.workspaceId || !input.selectedAgentId || !input.selectedAgentType) {
      throw new Error('Workspace and selected agent are required to run a flow.');
    }
    if (!input.baseCommitSha) {
      throw new Error('Base commit is required to run a flow.');
    }

    const selectedFlow = flows.find((flow) => flow.id === selectedFlowId);
    if (!selectedFlow) {
      throw new Error('Select a flow before running.');
    }

    setEvents([]);
    const flowRunId = crypto.randomUUID();
    const threadId = runInput.threadId?.trim() || input.threadId?.trim() || null;
    const threadOriginId = threadId ?? crypto.randomUUID();
    const controller = new AbortController();
    flowRunManager.start({
      flowRunId,
      flowId: selectedFlow.id,
      abortController: controller,
      stopNode: agentClient.stopAgent,
    });

    const abortFromInputSignal = () => {
      void flowRunManager.cancel(flowRunId, readAbortReason(runInput.signal));
    };
    runInput.signal?.addEventListener('abort', abortFromInputSignal, { once: true });
    if (runInput.signal?.aborted) {
      abortFromInputSignal();
    }

    const runner = createAgentreeFlowNodeRunner({
      workspaceId: input.workspaceId,
      selectedAgentId: input.selectedAgentId,
      selectedAgentType: input.selectedAgentType,
      baseNodeId: input.baseNodeId,
      baseCommitSha: input.baseCommitSha,
      rootParentNodeId: input.rootParentNodeId ?? null,
      rootContextParentNodeId: input.rootContextParentNodeId ?? null,
      rootContextManifest: input.rootContextManifest ?? null,
      flowId: selectedFlow.id,
      flowSourceId: selectedFlow.sourceId,
      flowSourceVersion: selectedFlow.sourceVersion,
      flowRunId,
      threadId,
      threadOriginId,
      agentCliArgs: input.agentCliArgs,
      agentPromptFlag: input.agentPromptFlag,
      agentName: input.agentName,
      llmModel: input.llmModel,
      reasoningEffort: input.reasoningEffort,
      loginProfileId: input.loginProfileId,
      launchAgentNode,
      waitForAssistantNode,
      stopAgentNode: agentClient.stopAgent,
    });

    try {
      const result = await executeFlow({
        definition: selectedFlow.definition,
        inputs: { input: runInput.input, count: runInput.count },
        runner,
        signal: controller.signal,
        onEvent: (event) => {
          flowRunManager.recordExecutionEvent(flowRunId, event);
          setEvents((current) => [...current, event]);
        },
      });
      flowRunManager.finish(flowRunId, result);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Flow execution failed.';
      flowRunManager.fail(flowRunId, reason);
      throw error;
    } finally {
      runInput.signal?.removeEventListener('abort', abortFromInputSignal);
    }
  }, [
    flows,
    input.agentCliArgs,
    input.agentName,
    input.agentPromptFlag,
    input.baseCommitSha,
    input.baseNodeId,
    input.llmModel,
    input.loginProfileId,
    input.reasoningEffort,
    input.rootContextManifest,
    input.rootContextParentNodeId,
    input.rootParentNodeId,
    input.selectedAgentId,
    input.selectedAgentType,
    input.threadId,
    input.workspaceId,
    launchAgentNode,
    selectedFlowId,
    waitForAssistantNode,
  ]);

  return {
    flows,
    selectedFlowId,
    setSelectedFlowId,
    events,
    runFlow,
  };
}

function readAbortReason(signal: AbortSignal | undefined): string {
  if (!signal?.aborted) return 'Flow cancelled.';
  return typeof signal.reason === 'string' && signal.reason.trim()
    ? signal.reason.trim()
    : 'Flow cancelled.';
}

async function waitForAssistantNodeCompletion(input: {
  assistantNodeId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  workspaceId: string | null;
  requireCommit?: boolean;
  signal?: AbortSignal;
}): Promise<Message> {
  const startedAt = Date.now();
  let terminalObservedAt: number | null = null;
  while (Date.now() - startedAt < FLOW_ASSISTANT_NODE_WALL_CLOCK_TIMEOUT_MS) {
    throwIfFlowCancelled(input.signal);
    const message = readAssistantNode(input.assistantNodeId, input.workspaceId, input.queryClient);
    if (isTerminalAgentStatus(message?.status)) {
      if (!input.requireCommit || readMessageCommit(message)) {
        return message;
      }
      terminalObservedAt ??= Date.now();
      const persistedMessage = await readPersistedAssistantNode(input.assistantNodeId, input.workspaceId, input.queryClient);
      if (persistedMessage) {
        if (readMessageCommit(persistedMessage)) {
          return persistedMessage;
        }
      }
      const ledgerCommitSha = await readAgentRunLedgerCommit(input.assistantNodeId);
      if (ledgerCommitSha) {
        return {
          ...message,
          output_commit_sha: ledgerCommitSha,
          execution_data: {
            ...(typeof message.execution_data === 'object' && message.execution_data !== null ? message.execution_data : {}),
            output_commit_sha: ledgerCommitSha,
            meta: {
              ...(typeof message.execution_data === 'object'
                && message.execution_data !== null
                && typeof message.execution_data.meta === 'object'
                && message.execution_data.meta !== null
                ? message.execution_data.meta
                : {}),
              output_commit_sha: ledgerCommitSha,
            },
          },
        };
      }
      if (Date.now() - terminalObservedAt >= FLOW_ASSISTANT_REQUIRED_COMMIT_TIMEOUT_MS) {
        throw new Error(`Assistant node "${input.assistantNodeId}" completed without a finalized commit.`);
      }
    }
    await waitForAssistantNodePoll(input.signal);
  }
  throw new Error(`Timed out waiting for assistant node "${input.assistantNodeId}" to complete.`);
}

function waitForAssistantNodePoll(signal: AbortSignal | undefined): Promise<void> {
  throwIfFlowCancelled(signal);
  return new Promise((resolve, reject) => {
    let timeout: number | null = null;
    let onAbort: (() => void) | null = null;
    const cleanup = () => {
      if (timeout !== null) {
        window.clearTimeout(timeout);
        timeout = null;
      }
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort);
      }
    };
    onAbort = () => {
      cleanup();
      try {
        throwIfFlowCancelled(signal);
      } catch (error) {
        reject(error);
      }
    };
    timeout = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 500);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readMessageCommit(message: Message): string | null {
  return getMessageOutputCommitSha(message);
}

async function readAgentRunLedgerCommit(assistantNodeId: string): Promise<string | null> {
  if (!agentClient.hasRuntime()) {
    return null;
  }
  try {
    const state = await agentClient.getAgentRunState(assistantNodeId);
    const commitSha = state.ledger?.outputCommitSha;
    return typeof commitSha === 'string' && commitSha.trim() ? commitSha.trim() : null;
  } catch {
    return null;
  }
}

async function readPersistedAssistantNode(
  assistantNodeId: string,
  workspaceId: string | null,
  queryClient: ReturnType<typeof useQueryClient>
): Promise<Message | null> {
  if (!workspaceId || !agentClient.hasRuntime()) {
    return null;
  }
  try {
    const rows = await agentClient.listLocalNodes(workspaceId);
    const parsed = rows
      .map(parseLocalNode)
      .filter((row): row is LocalNodeMessage => Boolean(row));
    queryClient.setQueryData<LocalNodeMessage[]>(localNodeKeys.workspace(workspaceId), parsed);
    return (parsed.find((row) => row.nodeId === assistantNodeId)?.message as Message | undefined) ?? null;
  } catch {
    return null;
  }
}

function readAssistantNode(
  assistantNodeId: string,
  workspaceId: string | null,
  queryClient: ReturnType<typeof useQueryClient>
): Message | null {
  const projection = useAgentRunProjectionStore.getState().projectionsById[assistantNodeId];
  if (projection) {
    return projection;
  }
  if (!workspaceId) {
    return null;
  }
  const localRows = queryClient.getQueryData<LocalNodeMessage[]>(localNodeKeys.workspace(workspaceId)) ?? [];
  const localMessage = localRows.find((row) => row.nodeId === assistantNodeId)?.message;
  if (localMessage) {
    return localMessage as Message;
  }
  const messages = queryClient.getQueryData<Message[]>(['messages', workspaceId]) ?? [];
  return messages.find((message) => message.id === assistantNodeId) ?? null;
}
