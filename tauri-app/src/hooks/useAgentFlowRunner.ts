import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TERMINAL_STATUSES } from '@shared/agentStatus';
import { createAgentreeFlowNodeRunner } from '../flows/agentreeFlowNodeRunner';
import { executeFlow, type FlowExecutionEvent, type FlowExecutionResult } from '../flows/flowExecutor';
import { parseFlowYaml } from '../flows/parseFlowYaml';
import { PREDEFINED_FLOW_SOURCES } from '../flows/predefinedFlows';
import type { FlowDefinition } from '../flows/types';
import { validateFlowDefinition } from '../flows/validateFlow';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';
import { agentClient } from '../lib/agentClient';
import { localNodeKeys, parseLocalNode, type LocalNodeMessage } from './useLocalNodes';
import { useAgentNodeLauncher, type UseAgentNodeLauncherOptions } from './useAgentNodeLauncher';

export interface UseAgentFlowRunnerInput extends UseAgentNodeLauncherOptions {
  workspaceId: string | null;
  selectedAgentId: string | null;
  selectedAgentType: string | null;
  baseNodeId: string | null;
  baseCommitSha: string | null;
  agentCliArgs?: string | null;
  agentPromptFlag?: string | null;
  agentName?: string | null;
  llmModel?: string | null;
  reasoningEffort?: string | null;
}

export interface PredefinedFlowDescriptor {
  id: string;
  label: string;
  definition: FlowDefinition;
}

export function useAgentFlowRunner(input: UseAgentFlowRunnerInput) {
  const queryClient = useQueryClient();
  const { launchAgentNode } = useAgentNodeLauncher({ startStreamForNode: input.startStreamForNode });
  const flows = useMemo(() => compilePredefinedFlows(), []);
  const [selectedFlowId, setSelectedFlowId] = useState(flows[0]?.id ?? '');
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<FlowExecutionEvent[]>([]);
  const cancelledRef = useRef(false);

  const waitForAssistantNode = useCallback((assistantNodeId: string, options?: { requireCommit?: boolean }) => (
    waitForAssistantNodeCompletion({
      assistantNodeId,
      queryClient,
      workspaceId: input.workspaceId,
      isCancelled: () => cancelledRef.current,
      requireCommit: options?.requireCommit ?? false,
    })
  ), [input.workspaceId, queryClient]);

  const runFlow = useCallback(async (runInput: { input: string; count: number }): Promise<FlowExecutionResult> => {
    if (!input.workspaceId || !input.selectedAgentId || !input.selectedAgentType) {
      throw new Error('Workspace and selected agent are required to run a flow.');
    }
    if (!input.baseCommitSha) {
      throw new Error('Base commit is required to run a flow.');
    }

    const selectedFlow = flows.find((flow) => flow.id === selectedFlowId) ?? flows[0];
    if (!selectedFlow) {
      throw new Error('No predefined flow is available.');
    }

    cancelledRef.current = false;
    setIsRunning(true);
    setEvents([]);
    const flowRunId = crypto.randomUUID();
    const threadOriginId = crypto.randomUUID();
    const runner = createAgentreeFlowNodeRunner({
      workspaceId: input.workspaceId,
      selectedAgentId: input.selectedAgentId,
      selectedAgentType: input.selectedAgentType,
      baseNodeId: input.baseNodeId,
      baseCommitSha: input.baseCommitSha,
      flowId: selectedFlow.id,
      flowRunId,
      threadOriginId,
      agentCliArgs: input.agentCliArgs,
      agentPromptFlag: input.agentPromptFlag,
      agentName: input.agentName,
      llmModel: input.llmModel,
      reasoningEffort: input.reasoningEffort,
      launchAgentNode,
      waitForAssistantNode,
    });

    try {
      return await executeFlow({
        definition: selectedFlow.definition,
        inputs: { input: runInput.input, count: runInput.count },
        runner,
        onEvent: (event) => setEvents((current) => [...current, event]),
      });
    } finally {
      setIsRunning(false);
    }
  }, [
    flows,
    input.agentCliArgs,
    input.agentName,
    input.agentPromptFlag,
    input.baseCommitSha,
    input.baseNodeId,
    input.llmModel,
    input.reasoningEffort,
    input.selectedAgentId,
    input.selectedAgentType,
    input.workspaceId,
    launchAgentNode,
    selectedFlowId,
    waitForAssistantNode,
  ]);

  const cancelFlow = useCallback(() => {
    cancelledRef.current = true;
    setIsRunning(false);
  }, []);

  return {
    flows,
    selectedFlowId,
    setSelectedFlowId,
    isRunning,
    events,
    runFlow,
    cancelFlow,
  };
}

function compilePredefinedFlows(): PredefinedFlowDescriptor[] {
  return PREDEFINED_FLOW_SOURCES.map((source) => {
    const result = validateFlowDefinition(parseFlowYaml(source.source));
    if (!result.definition || result.issues.length > 0) {
      throw new Error(`Invalid predefined flow "${source.id}": ${JSON.stringify(result.issues)}`);
    }
    return {
      id: source.id,
      label: source.label,
      definition: result.definition,
    };
  });
}

async function waitForAssistantNodeCompletion(input: {
  assistantNodeId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  workspaceId: string | null;
  isCancelled: () => boolean;
  requireCommit?: boolean;
}): Promise<Message> {
  const startedAt = Date.now();
  let terminalObservedAt: number | null = null;
  let latestTerminalMessage: Message | null = null;
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    if (input.isCancelled()) {
      throw new Error('Flow run was cancelled.');
    }
    const message = readAssistantNode(input.assistantNodeId, input.workspaceId, input.queryClient);
    if (message?.status && TERMINAL_STATUSES.includes(message.status as never)) {
      latestTerminalMessage = message;
      if (!input.requireCommit || readMessageCommit(message)) {
        return message;
      }
      terminalObservedAt ??= Date.now();
      const persistedMessage = await readPersistedAssistantNode(input.assistantNodeId, input.workspaceId, input.queryClient);
      if (persistedMessage) {
        latestTerminalMessage = persistedMessage;
        if (readMessageCommit(persistedMessage)) {
          return persistedMessage;
        }
      }
      if (Date.now() - terminalObservedAt >= 45_000) {
        return latestTerminalMessage;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for assistant node "${input.assistantNodeId}" to complete.`);
}

function readMessageCommit(message: Message): string | null {
  return message.output_commit_sha ?? message.commit?.sha ?? null;
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
