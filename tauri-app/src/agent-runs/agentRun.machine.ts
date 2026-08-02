import { assign, createMachine } from 'xstate';
import type { AgentRunEvent, AgentRunInput, AgentRunSnapshot, AgentRunStatus } from './agentRun.types';

const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled', 'error']);
const RUNNING_OR_LATER_STATUSES = new Set<string>(['running', 'streaming', 'completed', 'failed', 'cancelled', 'error']);
const PRE_RUNNING_STATUSES = new Set<string>(['pending', 'creating', 'initializing']);

const nowIso = () => new Date().toISOString();

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
      return {
        ...updateStatus(snapshot, 'completed', event.commitCreated ? 'Commit generated' : snapshot.progress),
        phase: 'terminal',
        executionData: mergeExecutionData(snapshot.executionData, { meta: event.meta }),
      };
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

export const agentRunMachine = createMachine({
  types: {} as {
    context: { snapshot: AgentRunSnapshot };
    events: AgentRunEvent;
    input: AgentRunInput;
  },
  id: 'agentRun',
  context: ({ input }) => ({
    snapshot: initialSnapshot(input),
  }),
  initial: 'live',
  states: {
    live: {
      on: {
        '*': {
          actions: assign({
            snapshot: ({ context, event }) => reduceAgentRunSnapshot(context.snapshot, event as AgentRunEvent),
          }),
        },
      },
    },
  },
});
