import { agentRunManager } from './agentRunManager';
import {
  dispatchAgentRunUsage,
  dispatchProviderStreamEvent,
  dispatchStreamingAssistantText,
  deriveIncrementalText,
  extractMessageText,
  mergeStreamingOutput,
  resolveProviderAssistantOutput,
} from './agentRunStreamDispatch';
import { parseStdoutAgentEvent, summarizeFinalizeAck, summarizeProviderStop } from './agentRunEventIngestor';
import type { AgentRunStatus } from './agentRun.types';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { agentClient, type AgentRunJournalEvent } from '../lib/agentClient';
import { AGENT_STATUS } from '@shared/agentStatus';

export type AgentRunHydrationStatus =
  | 'hydrated'
  | 'already-current'
  | 'no-ledger'
  | 'no-run-id'
  | 'failed';

export interface AgentRunHydrationResult {
  status: AgentRunHydrationStatus;
  assistantNodeId: string;
  runId: string | null;
  replayed: number;
  error?: unknown;
}

type HydrationInput = {
  workspaceId: string | null;
  parentId: string | null;
  role: 'assistant';
  agentId: string | null;
  runId: string;
  status: AgentRunStatus | null;
  executionData: Record<string, any>;
};

const inflightHydrations = new Map<string, Promise<AgentRunHydrationResult>>();

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const cleanStatus = (value: unknown): AgentRunStatus | null => {
  if (typeof value !== 'string') return null;
  return value as AgentRunStatus;
};

const numericSeq = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const readLedgerValue = (ledger: Record<string, any>, camel: string, snake: string = camel) => (
  ledger[camel] ?? ledger[snake]
);

const parseJournalPayload = (row: AgentRunJournalEvent): Record<string, any> => {
  try {
    const parsed = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    // Fall through to a synthetic event below.
  }
  return {
    type: row.eventType || 'agent:lifecycle',
    data: row.payload,
  };
};

const withJournalMetadata = (row: AgentRunJournalEvent, payload: Record<string, any>) => ({
  ...payload,
  run_id: cleanString(payload.run_id) ?? row.runId,
  nodeId: cleanString(payload.nodeId) ?? row.assistantNodeId,
  seq: numericSeq(payload.seq) ?? row.seq,
  timestamp: numericSeq(payload.timestamp) ?? row.timestamp,
  status: payload.status ?? row.status ?? undefined,
  phase: payload.phase ?? row.phase ?? undefined,
});

const baseExecutionData = (input: HydrationInput) => ({
  ...(input.executionData ?? {}),
  current_run_id: input.runId,
});

const getProjection = (nodeId: string) => (
  useAgentRunProjectionStore.getState().projectionsById[nodeId] ?? null
);

const dispatchHydratedStreamEvent = (
  nodeId: string,
  event: Record<string, any>,
  input: HydrationInput,
  state: { output: string; providerItemId: string | null },
) => {
  const agentId = cleanString(event.agent_id) ?? input.agentId;
  const context = {
    nodeId,
    parentId: input.parentId ?? '',
    workspaceId: input.workspaceId ?? '',
    agentId,
    currentOutput: state.output,
    getProjection,
    getAgents: () => [],
    setSetupProgress: (targetNodeId: string, progress: string) => {
      agentRunManager.dispatch(targetNodeId, {
        type: 'setup_progress',
        progress,
        status: 'running',
      }, input);
    },
  };

  agentRunManager.ingest(nodeId, event, {
    ...input,
    content: state.output,
    executionData: baseExecutionData(input),
  });

  if (event.type === 'stdout') {
    const parsed = parseStdoutAgentEvent(event.data);
    if (parsed.kind === 'json') {
      dispatchHydratedStreamEvent(nodeId, parsed.event, input, state);
    } else if (parsed.kind === 'text') {
      dispatchProviderStreamEvent({ type: 'error', content: parsed.text }, context);
    }
    return;
  }

  if (event.type === 'message_delta' && typeof event.delta === 'string') {
    const merged = resolveProviderAssistantOutput(state.output, event.delta, {
      kind: 'delta',
      currentProviderItemId: state.providerItemId,
      nextProviderItemId: cleanString(event.provider_item_id),
    });
    const previousOutput = state.output;
    state.output = merged.output;
    state.providerItemId = merged.providerItemId;
    dispatchStreamingAssistantText(state.output, {
      nodeId,
      parentId: input.parentId ?? '',
      workspaceId: input.workspaceId ?? '',
      agentId,
      appendedText: deriveIncrementalText(previousOutput, state.output),
      timestamp: numericSeq(event.timestamp) ?? Date.now(),
      streamSeq: numericSeq(event.stream_seq),
    });
    return;
  }

  if (event.type === 'message_completed' && typeof event.content === 'string') {
    const merged = resolveProviderAssistantOutput(state.output, event.content, {
      kind: 'snapshot',
      currentProviderItemId: state.providerItemId,
      nextProviderItemId: cleanString(event.provider_item_id),
    });
    const previousOutput = state.output;
    state.output = merged.output;
    state.providerItemId = merged.providerItemId;
    dispatchStreamingAssistantText(state.output, {
      nodeId,
      parentId: input.parentId ?? '',
      workspaceId: input.workspaceId ?? '',
      agentId,
      appendedText: deriveIncrementalText(previousOutput, state.output),
      timestamp: numericSeq(event.timestamp) ?? Date.now(),
      streamSeq: numericSeq(event.stream_seq),
    });
    return;
  }

  if (event.type === 'message') {
    const text = extractMessageText(event);
    if (text) {
      const previousOutput = state.output;
      state.output = mergeStreamingOutput(state.output, text);
      dispatchStreamingAssistantText(state.output, {
        nodeId,
        parentId: input.parentId ?? '',
        workspaceId: input.workspaceId ?? '',
        agentId,
        appendedText: deriveIncrementalText(previousOutput, state.output),
        timestamp: numericSeq(event.timestamp) ?? Date.now(),
        streamSeq: numericSeq(event.stream_seq),
      });
    }
    return;
  }

  if ((event.type === 'usage' || event.type === 'codex_event') && event.usage) {
    dispatchAgentRunUsage(event.usage, {
      nodeId,
      parentId: input.parentId ?? '',
      workspaceId: input.workspaceId ?? '',
      agentId,
    });
    return;
  }

  if (event.type === 'finalize_progress') {
    agentRunManager.dispatch(nodeId, {
      type: 'finalize_progress',
      progress: cleanString(event.message) ?? cleanString(event.progress) ?? 'Finalizing run...',
      phase: cleanString(event.phase),
    }, {
      ...input,
      content: state.output,
      executionData: baseExecutionData(input),
    });
    return;
  }

  if (event.type === 'finalize_ack') {
    const ack = summarizeFinalizeAck(event);
    const currentMeta = ((getProjection(nodeId)?.execution_data as any)?.meta ?? {}) as Record<string, any>;
    agentRunManager.dispatch(nodeId, {
      type: 'finalize_ack',
      status: ack.status as AgentRunStatus,
      outputCommitSha: ack.outputCommitSha,
      gitBranchName: ack.gitBranchName,
      commitCreated: ack.commitCreated,
      persisted: ack.persisted,
      serverAckAt: ack.serverAckAt,
      meta: currentMeta,
    }, {
      ...input,
      content: state.output,
      executionData: baseExecutionData(input),
    });
    return;
  }

  if (event.type === 'stop' || event.type === 'provider_stop') {
    const { providerTerminalStatus, providerStopReason } = summarizeProviderStop(event);
    agentRunManager.dispatch(nodeId, {
      type: 'finalize_progress',
      progress: providerTerminalStatus === AGENT_STATUS.completed
        ? 'Finalizing changes...'
        : 'Finalizing run...',
      phase: providerStopReason,
    }, {
      ...input,
      content: state.output,
      executionData: baseExecutionData(input),
    });
    return;
  }

  if (
    event.type === 'provider_meta' ||
    event.type === 'thinking' ||
    event.type === 'tool_use' ||
    event.type === 'tool_result' ||
    event.type === 'tool_output_delta' ||
    event.type === 'error' ||
    event.type === 'stderr'
  ) {
    dispatchProviderStreamEvent(event, context);
  }
};

const hydrateAgentRun = async (
  assistantNodeId: string,
): Promise<AgentRunHydrationResult> => {
  const state = await agentClient.getAgentRunState(assistantNodeId);
  const ledger = state?.ledger as Record<string, any> | null | undefined;
  if (!ledger) {
    return { status: 'no-ledger', assistantNodeId, runId: null, replayed: 0 };
  }

  const runId = cleanString(readLedgerValue(ledger, 'runId', 'run_id'));
  if (!runId) {
    return { status: 'no-run-id', assistantNodeId, runId: null, replayed: 0 };
  }

  const ledgerLastSeq = numericSeq(readLedgerValue(ledger, 'lastSeq', 'last_seq')) ?? 0;
  const snapshot = agentRunManager.snapshot(assistantNodeId);
  const snapshotSeq = snapshot?.runId === runId ? snapshot.lastSeq ?? 0 : 0;
  if (snapshot?.runId === runId && snapshotSeq >= ledgerLastSeq) {
    return { status: 'already-current', assistantNodeId, runId, replayed: 0 };
  }

  const input: HydrationInput = {
    workspaceId: cleanString(readLedgerValue(ledger, 'workspaceId', 'workspace_id')),
    parentId: cleanString(readLedgerValue(ledger, 'userNodeId', 'user_node_id')),
    role: 'assistant',
    agentId: cleanString(readLedgerValue(ledger, 'agentType', 'agent_type')),
    runId,
    status: cleanStatus(readLedgerValue(ledger, 'status')),
    executionData: {
      current_run_id: runId,
      ...(ledgerLastSeq > 0 ? { ledger_last_agent_event_seq: ledgerLastSeq } : {}),
    },
  };

  agentRunManager.dispatch(assistantNodeId, {
    type: 'status',
    status: input.status ?? (state.running ? 'running' : 'pending'),
  }, input);

  const rows = await agentClient.replayAgentRunEvents(runId, snapshotSeq);
  const streamState = {
    output: snapshot?.runId === runId ? snapshot.content : '',
    providerItemId: null as string | null,
  };

  for (const row of rows) {
    const event = withJournalMetadata(row, parseJournalPayload(row));
    dispatchHydratedStreamEvent(assistantNodeId, event, input, streamState);
  }

  return {
    status: rows.length > 0 ? 'hydrated' : 'already-current',
    assistantNodeId,
    runId,
    replayed: rows.length,
  };
};

export const ensureAgentRunHydrated = (
  assistantNodeId: string,
  _reason: string = 'unknown',
): Promise<AgentRunHydrationResult> => {
  const existing = inflightHydrations.get(assistantNodeId);
  if (existing) return existing;

  const hydration = hydrateAgentRun(assistantNodeId)
    .catch((error): AgentRunHydrationResult => ({
      status: 'failed',
      assistantNodeId,
      runId: null,
      replayed: 0,
      error,
    }))
    .finally(() => {
      if (inflightHydrations.get(assistantNodeId) === hydration) {
        inflightHydrations.delete(assistantNodeId);
      }
    });

  inflightHydrations.set(assistantNodeId, hydration);
  return hydration;
};

export const resetAgentRunHydrationForTest = () => {
  inflightHydrations.clear();
};
