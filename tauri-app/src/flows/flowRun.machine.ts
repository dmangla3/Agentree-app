import { assign, setup } from 'xstate';
import type { FlowRunEvent, FlowRunInput, FlowRunSnapshot, FlowRunStatus } from './flowRun.types';

type MachineContext = { snapshot: FlowRunSnapshot };

const TERMINAL_FLOW_STATUSES = new Set<FlowRunStatus>([
  'completed',
  'stopped',
  'failed',
  'cancelled',
]);

const FLOW_RUN_STATUSES: FlowRunStatus[] = [
  'idle',
  'starting',
  'running',
  'cancelling',
  'completed',
  'stopped',
  'failed',
  'cancelled',
];

const nowIso = () => new Date().toISOString();

export const isTerminalFlowRunStatus = (status: unknown): status is FlowRunStatus => (
  typeof status === 'string' && TERMINAL_FLOW_STATUSES.has(status as FlowRunStatus)
);

export const isActiveFlowRunStatus = (status: unknown): boolean => (
  status === 'starting' || status === 'running' || status === 'cancelling'
);

const initialSnapshot = (input: FlowRunInput): FlowRunSnapshot => ({
  flowRunId: input.flowRunId,
  flowId: input.flowId,
  status: input.status ?? 'idle',
  activeNodeIds: [],
  launchedNodeIds: [],
  currentTemplateId: null,
  scope: input.scope ?? {},
  events: [],
  reason: null,
  startedAt: null,
  completedAt: null,
  updatedAt: nowIso(),
});

const uniqueAppend = (values: string[], value: string | null | undefined) => {
  if (!value || values.includes(value)) return values;
  return [...values, value];
};

const removeValue = (values: string[], value: string | null | undefined) => {
  if (!value || !values.includes(value)) return values;
  return values.filter((entry) => entry !== value);
};

const terminalSnapshot = (
  snapshot: FlowRunSnapshot,
  status: FlowRunStatus,
  reason: string | null,
  scope: FlowRunSnapshot['scope'] = snapshot.scope,
): FlowRunSnapshot => ({
  ...snapshot,
  status,
  activeNodeIds: [],
  currentTemplateId: null,
  scope,
  reason,
  completedAt: snapshot.completedAt ?? nowIso(),
  updatedAt: nowIso(),
});

export const reduceFlowRunSnapshot = (
  snapshot: FlowRunSnapshot,
  event: FlowRunEvent,
): FlowRunSnapshot => {
  if (isTerminalFlowRunStatus(snapshot.status) && event.type !== 'cleanup') {
    return snapshot;
  }

  switch (event.type) {
    case 'start':
      return {
        ...snapshot,
        status: 'starting',
        startedAt: event.startedAt ?? snapshot.startedAt ?? nowIso(),
        reason: null,
        updatedAt: nowIso(),
      };
    case 'execution_event': {
      const flowEvent = event.event;
      const events = [...snapshot.events, flowEvent];
      if (flowEvent.type === 'node_started') {
        return {
          ...snapshot,
          status: snapshot.status === 'cancelling' ? 'cancelling' : 'running',
          currentTemplateId: flowEvent.templateId ?? snapshot.currentTemplateId,
          events,
          updatedAt: nowIso(),
        };
      }
      if (flowEvent.type === 'node_launched') {
        return {
          ...snapshot,
          status: snapshot.status === 'cancelling' ? 'cancelling' : 'running',
          activeNodeIds: uniqueAppend(snapshot.activeNodeIds, flowEvent.nodeId),
          launchedNodeIds: uniqueAppend(snapshot.launchedNodeIds, flowEvent.nodeId),
          currentTemplateId: flowEvent.templateId ?? snapshot.currentTemplateId,
          events,
          updatedAt: nowIso(),
        };
      }
      if (flowEvent.type === 'node_completed') {
        const activeNodeIds = removeValue(snapshot.activeNodeIds, flowEvent.nodeId);
        return {
          ...snapshot,
          activeNodeIds,
          currentTemplateId: activeNodeIds.length > 0 ? snapshot.currentTemplateId : null,
          events,
          updatedAt: nowIso(),
        };
      }
      if (flowEvent.type === 'flow_cancelled') {
        return {
          ...snapshot,
          status: 'cancelling',
          reason: flowEvent.message,
          events,
          updatedAt: nowIso(),
        };
      }
      return {
        ...snapshot,
        events,
        updatedAt: nowIso(),
      };
    }
    case 'result':
      return terminalSnapshot(
        snapshot,
        event.result.status,
        event.result.reason ?? null,
        event.result.scope,
      );
    case 'fail':
      return terminalSnapshot(snapshot, 'failed', event.reason);
    case 'cancel':
      return {
        ...snapshot,
        status: 'cancelling',
        reason: event.reason ?? 'Flow cancelled.',
        updatedAt: nowIso(),
      };
    case 'cleanup':
      return {
        ...snapshot,
        activeNodeIds: [],
        currentTemplateId: null,
        updatedAt: nowIso(),
      };
    default:
      return snapshot;
  }
};

const flowRunMachineSetup = setup({
  types: {} as {
    context: MachineContext;
    events: FlowRunEvent;
    input: FlowRunInput;
  },
  actions: {
    assignReducedSnapshot: assign({
      snapshot: ({ context, event }) => reduceFlowRunSnapshot(context.snapshot, event),
    }),
  },
});

const transitionForReducedStatus = (status: FlowRunStatus) => ({
  target: `#flowRun.${status}`,
  guard: ({ context, event }: { context: MachineContext; event: FlowRunEvent }) => (
    reduceFlowRunSnapshot(context.snapshot, event).status === status
  ),
  actions: 'assignReducedSnapshot' as const,
});

const routeByReducedStatus = [
  ...FLOW_RUN_STATUSES.map(transitionForReducedStatus),
  { actions: 'assignReducedSnapshot' as const },
];

const initialStatusTransition = (status: FlowRunStatus) => ({
  target: `#flowRun.${status}`,
  guard: ({ context }: { context: MachineContext }) => context.snapshot.status === status,
});

const routeInitialSnapshotStatus = FLOW_RUN_STATUSES
  .filter((status) => status !== 'idle')
  .map(initialStatusTransition);

const statusState = (status: FlowRunStatus) => ({
  ...(status === 'idle' ? { always: routeInitialSnapshotStatus } : {}),
  on: {
    '*': routeByReducedStatus,
  },
});

export const flowRunMachine = flowRunMachineSetup.createMachine({
  id: 'flowRun',
  context: ({ input }) => ({
    snapshot: initialSnapshot(input),
  }),
  initial: 'idle',
  states: {
    idle: statusState('idle'),
    starting: statusState('starting'),
    running: statusState('running'),
    cancelling: statusState('cancelling'),
    completed: statusState('completed'),
    stopped: statusState('stopped'),
    failed: statusState('failed'),
    cancelled: statusState('cancelled'),
  },
});
