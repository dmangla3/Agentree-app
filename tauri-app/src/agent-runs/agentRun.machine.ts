import { assign, setup } from 'xstate';
import type {
  AgentRunEvent,
  AgentRunFinalizeAck,
  AgentRunInput,
  AgentRunPhase,
  AgentRunSnapshot,
  AgentRunStatus,
} from './agentRun.types';

type MachineContext = { snapshot: AgentRunSnapshot };

const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled', 'error']);
const RUNNING_OR_LATER_STATUSES = new Set<string>(['running', 'streaming', 'completed', 'failed', 'cancelled', 'error']);
const PRE_RUNNING_STATUSES = new Set<string>(['pending', 'creating', 'initializing']);

const nowIso = () => new Date().toISOString();

const cleanString = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const optionalBoolean = (value: unknown): boolean | null => (
  typeof value === 'boolean' ? value : null
);

export const isTerminalAgentRunStatus = (status: unknown) => (
  typeof status === 'string' && TERMINAL_STATUSES.has(status)
);

export const resolveAgentRunStatus = (
  previous: AgentRunStatus | null | undefined,
  next: AgentRunStatus | null | undefined,
): AgentRunStatus | null => {
  if (!next) return previous ?? null;
  if (!previous) return next;
  if (isTerminalAgentRunStatus(previous) && !isTerminalAgentRunStatus(next)) return previous;
  if (isTerminalAgentRunStatus(previous) && isTerminalAgentRunStatus(next)) return previous;
  if (previous === 'streaming' && next === 'running') return previous;
  if (RUNNING_OR_LATER_STATUSES.has(previous) && PRE_RUNNING_STATUSES.has(next)) return previous;
  return next;
};

const phaseForStatus = (status: AgentRunStatus | null, fallback: AgentRunSnapshot['phase']) => {
  if (!status) return fallback;
  if (isTerminalAgentRunStatus(status)) return 'terminal';
  if (status === 'pending' || status === 'creating') return 'optimistic';
  if (status === 'initializing') return 'setup';
  if (status === 'streaming') return 'streaming';
  if (status === 'running') return 'running';
  return fallback;
};

const progressForTerminalStatus = (status: AgentRunStatus) => {
  if (status === 'completed') return 'Completed';
  if (status === 'cancelled') return 'Cancelled';
  return 'Failed';
};

const normalizeFinalizeAck = (
  event: Extract<AgentRunEvent, { type: 'finalize_ack' }>,
): AgentRunFinalizeAck => {
  const meta = event.meta ?? {};
  const status = event.status ?? 'completed';
  const outputCommitSha = cleanString(event.outputCommitSha)
    ?? cleanString(meta.output_commit_sha)
    ?? cleanString(meta.outputCommitSha)
    ?? cleanString(meta.commit_sha);
  const gitBranchName = cleanString(event.gitBranchName)
    ?? cleanString(meta.git_branch_name)
    ?? cleanString(meta.gitBranchName);
  const commitCreated = event.commitCreated
    ?? optionalBoolean(meta.commit_created)
    ?? optionalBoolean(meta.commitCreated)
    ?? (outputCommitSha ? true : null);
  const persisted = event.persisted ?? optionalBoolean(meta.persisted);
  const serverAckAt = cleanString(event.serverAckAt)
    ?? cleanString(meta.server_ack_at)
    ?? cleanString(meta.serverAckAt);
  return {
    status,
    outputCommitSha,
    commitCreated,
    gitBranchName,
    persisted,
    serverAckAt,
  };
};

const finalizeAckMeta = (
  event: Extract<AgentRunEvent, { type: 'finalize_ack' }>,
  ack: AgentRunFinalizeAck,
) => ({
  ...(event.meta ?? {}),
  ...(ack.outputCommitSha ? { output_commit_sha: ack.outputCommitSha } : {}),
  ...(ack.gitBranchName ? { git_branch_name: ack.gitBranchName } : {}),
  ...(ack.commitCreated !== null ? { commit_created: ack.commitCreated } : {}),
  ...(ack.persisted !== null ? { persisted: ack.persisted } : {}),
  ...(ack.serverAckAt ? { server_ack_at: ack.serverAckAt } : {}),
});

const runStatusFromNativeEvent = (nativeEvent: Record<string, any>): AgentRunStatus | null => {
  // Adapter payloads can describe nested work, e.g. tool_result.status=completed.
  // Only protocol-level exit is allowed to terminalize a run from raw native events.
  const eventType = typeof nativeEvent.type === 'string' ? nativeEvent.type : null;
  const status = typeof nativeEvent.status === 'string' ? nativeEvent.status : null;
  if (eventType !== 'exit' || !isTerminalAgentRunStatus(status)) return null;
  return status as AgentRunStatus;
};

const initialSnapshot = (input: AgentRunInput): AgentRunSnapshot => {
  const executionData = input.executionData ?? {};
  const runId = input.runId
    ?? (typeof executionData.current_run_id === 'string' ? executionData.current_run_id : null);
  const status = input.status ?? null;
  return {
    nodeId: input.nodeId,
    workspaceId: input.workspaceId ?? null,
    parentId: input.parentId ?? null,
    role: input.role ?? null,
    agentId: input.agentId ?? null,
    message: input.message ?? null,
    runId,
    phase: phaseForStatus(status, 'idle'),
    status,
    progress: input.progress ?? null,
    content: input.content ?? '',
    lastSeq: typeof executionData.last_agent_event_seq === 'number' ? executionData.last_agent_event_seq : null,
    lastStreamSeq: typeof executionData.last_stream_seq === 'number' ? executionData.last_stream_seq : null,
    timeline: Array.isArray(executionData.timeline) ? executionData.timeline : [],
    executionData,
    usage: typeof executionData.usage === 'object' && executionData.usage ? executionData.usage : null,
    terminalStatus: isTerminalAgentRunStatus(status) ? status : null,
    terminalReason: typeof executionData.last_terminal_status === 'string' ? executionData.last_terminal_status : null,
    finalizeAck: null,
    terminalHoldUntil: null,
    cleanupAt: null,
    updatedAt: nowIso(),
  };
};

const mergeExecutionData = (current: Record<string, any>, patch: Record<string, any>): Record<string, any> => ({
  ...current,
  ...patch,
  ...((current.meta || patch.meta) ? {
    meta: {
      ...(current.meta || {}),
      ...(patch.meta || {}),
    },
  } : {}),
  ...((current.usage || patch.usage) ? {
    usage: {
      ...(current.usage || {}),
      ...(patch.usage || {}),
    },
  } : {}),
});

const appendTimelineEvent = (timeline: any[], nextEvent: any) => {
  const nextTimeline = [...timeline];
  if (nextEvent?.type === 'tool_output_delta') {
    const toolUseId = nextEvent.toolUseId || nextEvent.tool_use_id || nextEvent.id;
    const delta = typeof nextEvent.delta === 'string' ? nextEvent.delta : '';
    if (!toolUseId || !delta) return nextTimeline;
    const priorIndex = [...nextTimeline].reverse().findIndex((event: any) => (
      event?.type === 'tool_use' &&
      (event.toolUseId || event.tool_use_id || event.id) === toolUseId
    ));
    if (priorIndex === -1) return nextTimeline;
    const index = nextTimeline.length - 1 - priorIndex;
    const prior = nextTimeline[index];
    const existingOutput = typeof prior?.toolOutput === 'string' ? prior.toolOutput : '';
    nextTimeline[index] = {
      ...prior,
      toolOutput: existingOutput ? `${existingOutput}${delta}` : delta,
    };
    return nextTimeline;
  }
  if (nextEvent?.type === 'tool_result') {
    const toolUseId = nextEvent.toolUseId || nextEvent.tool_use_id || nextEvent.id;
    if (toolUseId) {
      const priorIndex = [...nextTimeline].reverse().findIndex((event: any) => (
        event?.type === 'tool_use' &&
        (event.toolUseId || event.tool_use_id || event.id) === toolUseId
      ));
      if (priorIndex !== -1) {
        const index = nextTimeline.length - 1 - priorIndex;
        const prior = nextTimeline[index];
        nextTimeline[index] = {
          ...prior,
          ...(prior?.timestamp && nextEvent.timestamp
            ? { durationMs: nextEvent.timestamp - prior.timestamp }
            : {}),
        };
      }
    }
  }
  nextTimeline.push(nextEvent);
  return nextTimeline;
};

const appendAssistantTimelineMessage = (
  timeline: any[],
  appendedText: string | null | undefined,
  timestamp: number | null | undefined,
) => {
  if (!appendedText) return timeline;
  return appendTimelineEvent(timeline, {
    type: 'message',
    timestamp: timestamp ?? Date.now(),
    content: appendedText,
  });
};

const updateStatus = (
  snapshot: AgentRunSnapshot,
  status: AgentRunStatus | null | undefined,
  progress?: string | null,
) => {
  const resolved = resolveAgentRunStatus(snapshot.status, status);
  const ignoredNonTerminalRegression = Boolean(
    isTerminalAgentRunStatus(snapshot.status) &&
    status &&
    !isTerminalAgentRunStatus(status) &&
    resolved === snapshot.status
  );
  const ignoredTerminalTransition = Boolean(
    isTerminalAgentRunStatus(snapshot.status) &&
    status &&
    isTerminalAgentRunStatus(status) &&
    status !== snapshot.status &&
    resolved === snapshot.status
  );
  const terminalStatus = isTerminalAgentRunStatus(resolved) ? resolved : snapshot.terminalStatus;
  return {
    ...snapshot,
    status: resolved,
    phase: resolved ? phaseForStatus(resolved, snapshot.phase) : snapshot.phase,
    terminalStatus,
    progress: (ignoredNonTerminalRegression || ignoredTerminalTransition) ? snapshot.progress : progress ?? snapshot.progress,
    updatedAt: nowIso(),
  };
};

const hasOlderStreamSeq = (
  snapshot: AgentRunSnapshot,
  streamSeq: number | null | undefined,
) => (
  typeof streamSeq === 'number' &&
  typeof snapshot.lastStreamSeq === 'number' &&
  streamSeq < snapshot.lastStreamSeq
);

const shouldAcceptContentEvent = (
  snapshot: AgentRunSnapshot,
  event: Extract<AgentRunEvent, { type: 'content' }>,
) => {
  if (hasOlderStreamSeq(snapshot, event.streamSeq)) return false;
  if (
    typeof event.streamSeq === 'number' &&
    typeof snapshot.lastStreamSeq === 'number' &&
    event.streamSeq === snapshot.lastStreamSeq &&
    event.content.length < snapshot.content.length
  ) {
    return false;
  }
  if (!isTerminalAgentRunStatus(snapshot.status)) return true;
  if (
    typeof event.streamSeq === 'number' &&
    typeof snapshot.lastStreamSeq === 'number' &&
    event.streamSeq > snapshot.lastStreamSeq
  ) {
    return true;
  }
  return event.content.length > snapshot.content.length;
};

export const reduceAgentRunSnapshot = (
  snapshot: AgentRunSnapshot,
  event: AgentRunEvent,
): AgentRunSnapshot => {
  switch (event.type) {
    case 'seed': {
      const executionData = (event.message.execution_data ?? {}) as Record<string, any>;
      const seeded = {
        ...snapshot,
        nodeId: event.message.id,
        workspaceId: event.message.workspaceId ?? snapshot.workspaceId,
        parentId: event.message.parentId ?? snapshot.parentId,
        role: event.message.role ?? snapshot.role,
        agentId: event.message.agent_id ?? snapshot.agentId,
        message: { ...(snapshot.message ?? {}), ...event.message },
        runId: event.runId ?? (typeof executionData.current_run_id === 'string' ? executionData.current_run_id : snapshot.runId),
        content: event.message.content ?? snapshot.content,
        executionData: mergeExecutionData(snapshot.executionData, executionData),
        timeline: Array.isArray(executionData.timeline) ? executionData.timeline : snapshot.timeline,
        updatedAt: nowIso(),
      };
      return updateStatus(seeded, event.message.status as AgentRunStatus | null, snapshot.progress);
    }
    case 'replace_node':
      return {
        ...snapshot,
        nodeId: event.realNode.id,
        workspaceId: event.realNode.workspaceId ?? snapshot.workspaceId,
        parentId: event.realNode.parentId ?? snapshot.parentId,
        role: event.realNode.role ?? snapshot.role,
        agentId: event.realNode.agent_id ?? snapshot.agentId,
        message: { ...(snapshot.message ?? {}), ...event.realNode, _optimistic: false },
        content: snapshot.content || event.realNode.content || '',
        executionData: mergeExecutionData((event.realNode.execution_data ?? {}) as Record<string, any>, snapshot.executionData),
        updatedAt: nowIso(),
      };
    case 'setup_progress':
      return updateStatus(snapshot, event.status ?? snapshot.status ?? 'initializing', event.progress);
    case 'status':
      return updateStatus(snapshot, event.status, event.progress);
    case 'native_event': {
      const nativeEvent = event.event;
      const seq = typeof nativeEvent.seq === 'number' ? nativeEvent.seq : null;
      if (seq !== null && snapshot.lastSeq !== null && seq <= snapshot.lastSeq) return snapshot;
      const status = runStatusFromNativeEvent(nativeEvent) ?? snapshot.status;
      const runId = typeof nativeEvent.run_id === 'string' ? nativeEvent.run_id : snapshot.runId;
      const lastStreamSeq = typeof nativeEvent.stream_seq === 'number' ? nativeEvent.stream_seq : snapshot.lastStreamSeq;
      return updateStatus({
        ...snapshot,
        runId,
        lastSeq: seq ?? snapshot.lastSeq,
        lastStreamSeq,
        executionData: mergeExecutionData(snapshot.executionData, {
          ...(seq !== null ? { last_agent_event_seq: seq } : {}),
          ...(typeof lastStreamSeq === 'number' ? { last_stream_seq: lastStreamSeq } : {}),
        }),
      }, status, snapshot.progress);
    }
    case 'content':
      {
        if (!shouldAcceptContentEvent(snapshot, event)) return snapshot;
        const timeline = appendAssistantTimelineMessage(snapshot.timeline, event.appendedText, event.timestamp);
        return {
        ...updateStatus(snapshot, 'streaming', snapshot.progress),
        content: event.content,
        lastStreamSeq: typeof event.streamSeq === 'number' ? event.streamSeq : snapshot.lastStreamSeq,
        executionData: mergeExecutionData(snapshot.executionData, {
          ...(timeline !== snapshot.timeline ? { timeline } : {}),
          ...(typeof event.streamSeq === 'number' ? { last_stream_seq: event.streamSeq } : {}),
        }),
        timeline,
      };
      }
    case 'timeline_event':
      {
        const timeline = appendTimelineEvent(snapshot.timeline, event.event);
      return {
        ...updateStatus(snapshot, 'streaming', snapshot.progress),
        timeline,
        executionData: mergeExecutionData(snapshot.executionData, {
          timeline,
        }),
      };
      }
    case 'execution_data': {
      const executionData = mergeExecutionData(snapshot.executionData, event.patch);
      return {
        ...snapshot,
        runId: typeof executionData.current_run_id === 'string' ? executionData.current_run_id : snapshot.runId,
        lastSeq: typeof executionData.last_agent_event_seq === 'number' ? executionData.last_agent_event_seq : snapshot.lastSeq,
        lastStreamSeq: typeof executionData.last_stream_seq === 'number' ? executionData.last_stream_seq : snapshot.lastStreamSeq,
        timeline: Array.isArray(executionData.timeline) ? executionData.timeline : snapshot.timeline,
        usage: typeof executionData.usage === 'object' && executionData.usage ? executionData.usage : snapshot.usage,
        executionData,
        updatedAt: nowIso(),
      };
    }
    case 'usage':
      return {
        ...updateStatus(snapshot, 'streaming', snapshot.progress),
        usage: event.usage,
        executionData: mergeExecutionData(snapshot.executionData, { usage: event.usage }),
      };
    case 'finalize_progress':
      return {
        ...updateStatus(snapshot, 'running', event.progress),
        phase: 'finalizing',
        executionData: mergeExecutionData(snapshot.executionData, {
          meta: { finalize_phase: event.phase ?? null },
        }),
      };
    case 'finalize_ack':
      {
        const ack = normalizeFinalizeAck(event);
      return {
        ...updateStatus(snapshot, ack.status, ack.commitCreated ? 'Commit generated' : snapshot.progress),
        phase: 'terminal',
        finalizeAck: ack,
        executionData: mergeExecutionData(snapshot.executionData, { meta: finalizeAckMeta(event, ack) }),
      };
      }
    case 'terminal': {
      const nextSnapshot = updateStatus(snapshot, event.status, progressForTerminalStatus(event.status));
      const acceptedTerminalStatus = nextSnapshot.status === event.status;
      const content = typeof event.content === 'string' && (
        acceptedTerminalStatus ||
        event.content.length > snapshot.content.length
      ) ? event.content : snapshot.content;
      return {
        ...nextSnapshot,
        phase: 'terminal',
        content,
        terminalReason: acceptedTerminalStatus ? event.reason ?? snapshot.terminalReason : snapshot.terminalReason,
        terminalHoldUntil: Date.now() + (event.holdMs ?? 3000),
        executionData: mergeExecutionData(snapshot.executionData, {
          last_terminal_status: acceptedTerminalStatus ? event.status : snapshot.terminalStatus ?? snapshot.status,
          ...(acceptedTerminalStatus && event.reason ? { stop_reason: event.reason } : {}),
        }),
      };
    }
    case 'cancel':
      return {
        ...updateStatus(snapshot, 'cancelled', 'Cancelled'),
        phase: 'terminal',
        terminalReason: event.reason ?? 'cancelled',
        terminalHoldUntil: Date.now() + 3000,
        executionData: mergeExecutionData(snapshot.executionData, {
          last_terminal_status: 'cancelled',
          stop_reason: event.reason ?? 'cancelled',
        }),
      };
    case 'cleanup':
      return {
        ...snapshot,
        phase: 'cleanup',
        cleanupAt: Date.now(),
        updatedAt: nowIso(),
      };
    case 'remove':
      return {
        ...snapshot,
        phase: 'cleanup',
        cleanupAt: Date.now(),
        updatedAt: nowIso(),
      };
    default:
      return snapshot;
  }
};

const AGENT_RUN_PHASES: AgentRunPhase[] = [
  'idle',
  'optimistic',
  'setup',
  'running',
  'streaming',
  'finalizing',
  'terminal',
  'cleanup',
];

const agentRunMachineSetup = setup({
  types: {} as {
    context: MachineContext;
    events: AgentRunEvent;
    input: AgentRunInput;
  },
  actions: {
    assignReducedSnapshot: assign({
      snapshot: ({ context, event }) => reduceAgentRunSnapshot(context.snapshot, event),
    }),
  },
});

const transitionForReducedPhase = (phase: AgentRunPhase) => ({
  target: `#agentRun.${phase}`,
  guard: ({ context, event }: { context: MachineContext; event: AgentRunEvent }) => (
    reduceAgentRunSnapshot(context.snapshot, event).phase === phase
  ),
  actions: 'assignReducedSnapshot' as const,
});

const routeByReducedPhase = [
  ...AGENT_RUN_PHASES.map(transitionForReducedPhase),
  { actions: 'assignReducedSnapshot' as const },
];

const initialPhaseTransition = (phase: AgentRunPhase) => ({
  target: `#agentRun.${phase}`,
  guard: ({ context }: { context: MachineContext }) => context.snapshot.phase === phase,
});

const routeInitialSnapshotPhase = AGENT_RUN_PHASES
  .filter((phase) => phase !== 'idle')
  .map(initialPhaseTransition);

const phaseState = (phase: AgentRunPhase) => ({
  ...(phase === 'idle' ? { always: routeInitialSnapshotPhase } : {}),
  on: {
    '*': routeByReducedPhase,
  },
});

export const agentRunMachine = agentRunMachineSetup.createMachine({
  id: 'agentRun',
  context: ({ input }) => ({
    snapshot: initialSnapshot(input),
  }),
  initial: 'idle',
  states: {
    idle: phaseState('idle'),
    optimistic: phaseState('optimistic'),
    setup: phaseState('setup'),
    running: phaseState('running'),
    streaming: phaseState('streaming'),
    finalizing: phaseState('finalizing'),
    terminal: phaseState('terminal'),
    cleanup: phaseState('cleanup'),
  },
});
