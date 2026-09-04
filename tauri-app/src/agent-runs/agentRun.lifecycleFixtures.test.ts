import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';
import { normalizeAgentAdapterEventForRun } from './agentRunEventNormalizer';
import { agentRunMachine, reduceAgentRunSnapshot } from './agentRun.machine';
import type { AgentRunEvent, AgentRunInput, AgentRunSnapshot } from './agentRun.types';

const baseSnapshot = (overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot => ({
  nodeId: 'assistant-1',
  workspaceId: 'workspace-1',
  parentId: 'user-1',
  role: 'assistant',
  agentId: 'agent-1',
  message: null,
  runId: null,
  phase: 'idle',
  status: null,
  progress: null,
  content: '',
  lastSeq: null,
  lastStreamSeq: null,
  timeline: [],
  executionData: {},
  usage: null,
  terminalStatus: null,
  terminalReason: null,
  finalizeAck: null,
  terminalHoldUntil: null,
  cleanupAt: null,
  updatedAt: '2026-05-16T00:00:00.000Z',
  ...overrides,
});

const baseInput = (overrides: Partial<AgentRunInput> = {}): AgentRunInput => ({
  nodeId: 'assistant-1',
  workspaceId: 'workspace-1',
  parentId: 'user-1',
  role: 'assistant',
  agentId: 'agent-1',
  status: null,
  content: '',
  executionData: {},
  ...overrides,
});

const message = (overrides: Record<string, any> = {}) => ({
  id: 'assistant-1',
  workspaceId: 'workspace-1',
  parentId: 'user-1',
  role: 'assistant',
  content: '',
  status: 'pending',
  createdAt: '2026-05-16T00:00:00.000Z',
  updatedAt: '2026-05-16T00:00:00.000Z',
  execution_data: {},
  ...overrides,
}) as any;

type LifecycleFixture = {
  name: string;
  initial?: Partial<AgentRunSnapshot>;
  input?: Partial<AgentRunInput>;
  events: AgentRunEvent[];
  expected: {
    phase?: AgentRunSnapshot['phase'];
    status?: AgentRunSnapshot['status'];
    terminalStatus?: AgentRunSnapshot['terminalStatus'];
    terminalReason?: AgentRunSnapshot['terminalReason'];
    progress?: AgentRunSnapshot['progress'];
    content?: string;
    runId?: string | null;
    lastSeq?: number | null;
    lastStreamSeq?: number | null;
    timelineTypes?: string[];
    timelineLength?: number;
    executionData?: Record<string, any>;
    usage?: Record<string, any> | null;
  };
};

const reduceFixture = (fixture: LifecycleFixture) => (
  fixture.events.reduce(
    (snapshot, event) => reduceAgentRunSnapshot(snapshot, event),
    baseSnapshot(fixture.initial),
  )
);

const runMachineFixture = (fixture: LifecycleFixture) => {
  const actor = createActor(agentRunMachine, { input: baseInput(fixture.input) });
  actor.start();
  for (const event of fixture.events) {
    actor.send(event as any);
  }
  const actorSnapshot = actor.getSnapshot();
  const snapshot = actorSnapshot.context.snapshot;
  const stateValue = String(actorSnapshot.value);
  actor.stop();
  return { snapshot, stateValue };
};

const comparableSnapshot = (snapshot: AgentRunSnapshot) => ({
  nodeId: snapshot.nodeId,
  workspaceId: snapshot.workspaceId,
  parentId: snapshot.parentId,
  role: snapshot.role,
  agentId: snapshot.agentId,
  runId: snapshot.runId,
  phase: snapshot.phase,
  status: snapshot.status,
  progress: snapshot.progress,
  content: snapshot.content,
  lastSeq: snapshot.lastSeq,
  lastStreamSeq: snapshot.lastStreamSeq,
  timeline: snapshot.timeline,
  executionData: snapshot.executionData,
  usage: snapshot.usage,
  terminalStatus: snapshot.terminalStatus,
  terminalReason: snapshot.terminalReason,
});

const expectFixture = (fixture: LifecycleFixture, snapshot: AgentRunSnapshot) => {
  const { expected } = fixture;
  if ('phase' in expected) expect(snapshot.phase).toBe(expected.phase);
  if ('status' in expected) expect(snapshot.status).toBe(expected.status);
  if ('terminalStatus' in expected) expect(snapshot.terminalStatus).toBe(expected.terminalStatus);
  if ('terminalReason' in expected) expect(snapshot.terminalReason).toBe(expected.terminalReason);
  if ('progress' in expected) expect(snapshot.progress).toBe(expected.progress);
  if ('content' in expected) expect(snapshot.content).toBe(expected.content);
  if ('runId' in expected) expect(snapshot.runId).toBe(expected.runId);
  if ('lastSeq' in expected) expect(snapshot.lastSeq).toBe(expected.lastSeq);
  if ('lastStreamSeq' in expected) expect(snapshot.lastStreamSeq).toBe(expected.lastStreamSeq);
  if (expected.timelineTypes) {
    expect(snapshot.timeline.map((event: any) => event.type)).toEqual(expected.timelineTypes);
  }
  if ('timelineLength' in expected) expect(snapshot.timeline).toHaveLength(expected.timelineLength ?? 0);
  if ('usage' in expected) expect(snapshot.usage).toEqual(expected.usage);
  if (expected.executionData) {
    expect(snapshot.executionData).toMatchObject(expected.executionData);
  }
};

const fixtures: LifecycleFixture[] = [
  {
    name: 'normal run with commit finalizes after provider stop',
    events: [
      { type: 'seed', message: message({ status: 'pending' }), runId: 'run-1' },
      { type: 'setup_progress', progress: 'Initializing agent...', status: 'initializing' },
      { type: 'status', status: 'running', progress: 'Running...' },
      { type: 'content', content: 'hello', appendedText: 'hello', streamSeq: 1, timestamp: 10 },
      normalizeAgentAdapterEventForRun({ type: 'provider_stop', seq: 2, provider_status: 'completed' }),
      { type: 'finalize_progress', progress: 'Finalizing changes...', phase: 'provider_done' },
      { type: 'finalize_ack', meta: { output_commit_sha: 'commit-1' }, commitCreated: true },
      { type: 'terminal', status: 'completed', content: 'hello world', reason: 'completed', holdMs: 10 },
    ],
    expected: {
      phase: 'terminal',
      status: 'completed',
      terminalStatus: 'completed',
      terminalReason: 'completed',
      progress: 'Completed',
      content: 'hello world',
      runId: 'run-1',
      lastSeq: 2,
      lastStreamSeq: 1,
      timelineTypes: ['message'],
      executionData: {
        last_agent_event_seq: 2,
        last_stream_seq: 1,
        last_terminal_status: 'completed',
        stop_reason: 'completed',
        meta: { finalize_phase: 'provider_done', output_commit_sha: 'commit-1' },
      },
    },
  },
  {
    name: 'read-only no-change run completes without commit metadata',
    events: [
      { type: 'status', status: 'running', progress: 'Running...' },
      { type: 'content', content: 'summary', appendedText: 'summary', streamSeq: 1, timestamp: 10 },
      { type: 'finalize_progress', progress: 'Finalizing changes...', phase: 'provider_done' },
      { type: 'finalize_ack', meta: { commit_created: false }, commitCreated: false },
      { type: 'terminal', status: 'completed', content: 'summary', reason: 'completed', holdMs: 10 },
    ],
    expected: {
      phase: 'terminal',
      status: 'completed',
      terminalStatus: 'completed',
      progress: 'Completed',
      content: 'summary',
      timelineTypes: ['message'],
      executionData: {
        last_terminal_status: 'completed',
        meta: { finalize_phase: 'provider_done', commit_created: false },
      },
    },
  },
  {
    name: 'exit terminalizes when no finalize ack has closed the run',
    events: [
      { type: 'status', status: 'running', progress: 'Running...' },
      normalizeAgentAdapterEventForRun({ type: 'exit', seq: 5, status: 'failed' }),
    ],
    expected: {
      phase: 'terminal',
      status: 'failed',
      terminalStatus: 'failed',
      lastSeq: 5,
      executionData: { last_agent_event_seq: 5 },
    },
  },
  {
    name: 'completed terminal status wins over later failed exit',
    events: [
      { type: 'terminal', status: 'completed', content: 'done', reason: 'stop', holdMs: 10 },
      normalizeAgentAdapterEventForRun({ type: 'exit', seq: 6, status: 'failed' }),
      { type: 'terminal', status: 'failed', reason: 'exit', holdMs: 10 },
    ],
    expected: {
      phase: 'terminal',
      status: 'completed',
      terminalStatus: 'completed',
      terminalReason: 'stop',
      progress: 'Completed',
      content: 'done',
      lastSeq: 6,
      executionData: {
        last_terminal_status: 'completed',
        stop_reason: 'stop',
      },
    },
  },
  {
    name: 'late running progress does not reopen terminal run',
    events: [
      { type: 'terminal', status: 'completed', content: 'done', reason: 'completed', holdMs: 10 },
      { type: 'finalize_progress', progress: 'Generating commit...', phase: 'commit' },
      { type: 'status', status: 'running', progress: 'Running...' },
    ],
    expected: {
      phase: 'terminal',
      status: 'completed',
      terminalStatus: 'completed',
      progress: 'Completed',
      content: 'done',
      executionData: {
        last_terminal_status: 'completed',
        stop_reason: 'completed',
        meta: { finalize_phase: 'commit' },
      },
    },
  },
  {
    name: 'newer content after terminal updates content without reopening run',
    events: [
      { type: 'content', content: 'partial', appendedText: 'partial', streamSeq: 1, timestamp: 10 },
      { type: 'terminal', status: 'completed', content: 'partial', reason: 'completed', holdMs: 10 },
      { type: 'content', content: 'final answer', appendedText: ' final answer', streamSeq: 2, timestamp: 20 },
    ],
    expected: {
      phase: 'terminal',
      status: 'completed',
      terminalStatus: 'completed',
      content: 'final answer',
      lastStreamSeq: 2,
      timelineTypes: ['message'],
      executionData: {
        last_stream_seq: 2,
        last_terminal_status: 'completed',
      },
    },
  },
  {
    name: 'stale content after terminal is ignored',
    events: [
      { type: 'content', content: 'final answer', appendedText: 'final answer', streamSeq: 2, timestamp: 20 },
      { type: 'terminal', status: 'completed', content: 'final answer', reason: 'completed', holdMs: 10 },
      { type: 'content', content: 'partial', appendedText: 'partial', streamSeq: 1, timestamp: 10 },
    ],
    expected: {
      phase: 'terminal',
      status: 'completed',
      content: 'final answer',
      lastStreamSeq: 2,
      timelineTypes: ['message'],
    },
  },
  {
    name: 'duplicate native seq is ignored but newer seq is accepted',
    events: [
      normalizeAgentAdapterEventForRun({ type: 'message_delta', seq: 5, stream_seq: 1 }),
      normalizeAgentAdapterEventForRun({ type: 'message_delta', seq: 5, stream_seq: 2 }),
      normalizeAgentAdapterEventForRun({ type: 'message_delta', seq: 4, stream_seq: 3 }),
      normalizeAgentAdapterEventForRun({ type: 'message_delta', seq: 6, stream_seq: 4 }),
    ],
    expected: {
      lastSeq: 6,
      lastStreamSeq: 4,
      executionData: {
        last_agent_event_seq: 6,
        last_stream_seq: 4,
      },
    },
  },
  {
    name: 'tool output deltas merge into matching tool use',
    events: [
      {
        type: 'timeline_event',
        event: {
          type: 'tool_use',
          timestamp: 10,
          toolName: 'commandExecution',
          toolUseId: 'tool-1',
          toolInput: { command: 'cat package.json' },
        },
      },
      { type: 'timeline_event', event: { type: 'tool_output_delta', timestamp: 20, toolUseId: 'tool-1', delta: 'a\n' } },
      { type: 'timeline_event', event: { type: 'tool_output_delta', timestamp: 30, toolUseId: 'tool-1', delta: 'b\n' } },
      {
        type: 'timeline_event',
        event: {
          type: 'tool_result',
          timestamp: 40,
          toolName: 'commandExecution',
          toolUseId: 'tool-1',
          toolOutput: 'a\nb\n',
        },
      },
    ],
    expected: {
      phase: 'streaming',
      status: 'streaming',
      timelineTypes: ['tool_use', 'tool_result'],
      executionData: {
        timeline: [
          expect.objectContaining({ type: 'tool_use', toolOutput: 'a\nb\n' }),
          expect.objectContaining({ type: 'tool_result', toolOutput: 'a\nb\n' }),
        ],
      },
    },
  },
  {
    name: 'usage merges before and after content',
    events: [
      { type: 'usage', usage: { input_tokens: 10 } },
      { type: 'content', content: 'hello', appendedText: 'hello', streamSeq: 1, timestamp: 10 },
      { type: 'execution_data', patch: { usage: { output_tokens: 5, total_tokens: 15 } } },
    ],
    expected: {
      phase: 'streaming',
      status: 'streaming',
      content: 'hello',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      executionData: {
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  },
  {
    name: 'optimistic node replacement preserves streamed content',
    initial: { nodeId: 'optimistic-assistant', content: '' },
    input: { nodeId: 'optimistic-assistant' },
    events: [
      { type: 'content', content: 'streamed text', appendedText: 'streamed text', streamSeq: 1, timestamp: 10 },
      { type: 'replace_node', optimisticNodeId: 'optimistic-assistant', realNode: message({ id: 'assistant-real', status: 'running', content: '' }) },
    ],
    expected: {
      phase: 'streaming',
      status: 'streaming',
      content: 'streamed text',
      lastStreamSeq: 1,
    },
  },
  {
    name: 'cancel during finalizing terminalizes the run',
    initial: { phase: 'finalizing', status: 'running', progress: 'Finalizing changes...' },
    input: { status: 'running', progress: 'Finalizing changes...' },
    events: [
      { type: 'cancel', reason: 'user_cancelled' },
    ],
    expected: {
      phase: 'terminal',
      status: 'cancelled',
      terminalStatus: 'cancelled',
      terminalReason: 'user_cancelled',
      progress: 'Cancelled',
      executionData: {
        last_terminal_status: 'cancelled',
        stop_reason: 'user_cancelled',
      },
    },
  },
];

describe('agent run lifecycle fixtures', () => {
  it.each(fixtures)('preserves current lifecycle contract: $name', (fixture) => {
    const reducerSnapshot = reduceFixture(fixture);
    const { snapshot: machineSnapshot, stateValue } = runMachineFixture(fixture);

    expect(comparableSnapshot(machineSnapshot)).toEqual(comparableSnapshot(reducerSnapshot));
    expect(stateValue).toBe(machineSnapshot.phase);
    expectFixture(fixture, machineSnapshot);
  });
});
