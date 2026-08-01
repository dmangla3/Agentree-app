import { describe, expect, it } from 'vitest';
import { normalizeAgentAdapterEventForRun } from './agentRunEventNormalizer';
import { reduceAgentRunSnapshot, resolveAgentRunStatus } from './agentRun.machine';
import type { AgentRunEvent, AgentRunSnapshot } from './agentRun.types';

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
  terminalHoldUntil: null,
  cleanupAt: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
  ...overrides,
});

const reduce = (events: AgentRunEvent[], initial: Partial<AgentRunSnapshot> = {}) => (
  events.reduce((snapshot, event) => reduceAgentRunSnapshot(snapshot, event), baseSnapshot(initial))
);

const message = (overrides: Record<string, any> = {}) => ({
  id: 'assistant-1',
  workspaceId: 'workspace-1',
  parentId: 'user-1',
  role: 'assistant',
  content: '',
  status: 'pending',
  createdAt: '2026-05-06T00:00:00.000Z',
  updatedAt: '2026-05-06T00:00:00.000Z',
  execution_data: {},
  ...overrides,
}) as any;

describe('agentRun.machine', () => {
  it('runs optimistic create to setup, streaming, finalizing, completed, cleanup', () => {
    const snapshot = reduce([
      { type: 'seed', message: message({ status: 'pending' }) },
      { type: 'setup_progress', progress: 'Initializing agent...', status: 'initializing' },
      { type: 'status', status: 'running', progress: 'Running...' },
      { type: 'content', content: 'hello', appendedText: 'hello', streamSeq: 1, timestamp: 1 },
      { type: 'finalize_progress', progress: 'Generating commit...', phase: 'commit' },
      { type: 'terminal', status: 'completed', content: 'hello world', reason: 'done', holdMs: 10 },
      { type: 'cleanup' },
    ]);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.phase).toBe('cleanup');
    expect(snapshot.content).toBe('hello world');
    expect(snapshot.lastStreamSeq).toBe(1);
    expect(snapshot.executionData.last_terminal_status).toBe('completed');
    expect(snapshot.cleanupAt).toEqual(expect.any(Number));
  });

  it('handles failed setup as terminal and blocks status regression', () => {
    const failed = reduce([
      { type: 'setup_progress', progress: 'Preparing worktree...', status: 'initializing' },
      { type: 'terminal', status: 'failed', reason: 'worktree failed' },
      { type: 'status', status: 'running', progress: 'Running...' },
    ]);

    expect(failed.status).toBe('failed');
    expect(failed.phase).toBe('terminal');
    expect(failed.terminalStatus).toBe('failed');
    expect(failed.terminalReason).toBe('worktree failed');
  });

  it('does not let late running progress overwrite terminal progress', () => {
    const snapshot = reduce([
      { type: 'terminal', status: 'completed', content: 'done', reason: 'stop' },
      { type: 'finalize_progress', progress: 'Generating commit...', phase: 'commit' },
      { type: 'status', status: 'running', progress: 'Running...' },
    ], { progress: 'Completed' });

    expect(snapshot.status).toBe('completed');
    expect(snapshot.phase).toBe('terminal');
    expect(snapshot.progress).toBe('Completed');
  });

  it('cancels during setup, running, and finalizing', () => {
    for (const initial of [
      { status: 'initializing', phase: 'setup' },
      { status: 'running', phase: 'running' },
      { status: 'running', phase: 'finalizing' },
    ] satisfies Array<Partial<AgentRunSnapshot>>) {
      const snapshot = reduce([{ type: 'cancel', reason: 'user' }], initial);
      expect(snapshot.status).toBe('cancelled');
      expect(snapshot.phase).toBe('terminal');
      expect(snapshot.progress).toBe('Cancelled');
      expect(snapshot.executionData.last_terminal_status).toBe('cancelled');
    }
  });

  it('uses exit terminal status without regressing later', () => {
    const snapshot = reduce([
      { type: 'native_event', event: { type: 'exit', seq: 10, status: 'failed' } },
      { type: 'status', status: 'running' },
      { type: 'native_event', event: { type: 'message_delta', seq: 11, status: 'running' } },
    ]);

    expect(snapshot.status).toBe('failed');
    expect(snapshot.lastSeq).toBe(11);
  });

  it('ignores payload statuses on non-lifecycle native events', () => {
    const snapshot = reduce([
      { type: 'status', status: 'running', progress: 'Running...' },
      { type: 'content', content: 'partial', appendedText: 'partial', streamSeq: 1, timestamp: 1 },
      normalizeAgentAdapterEventForRun({ type: 'tool_result', seq: 10, status: 'completed' }),
      normalizeAgentAdapterEventForRun({ type: 'stop', seq: 11, status: 'completed' }),
    ]);

    expect(snapshot.status).toBe('streaming');
    expect(snapshot.phase).toBe('streaming');
    expect(snapshot.terminalStatus).toBeNull();
    expect(snapshot.lastSeq).toBe(11);
  });

  it('keeps a run active from provider stop until finalize ack', () => {
    const beforeAck = reduce([
      { type: 'status', status: 'running', progress: 'Running...' },
      { type: 'content', content: 'partial', appendedText: 'partial', streamSeq: 1, timestamp: 1 },
      normalizeAgentAdapterEventForRun({ type: 'tool_result', seq: 10, status: 'completed' }),
      normalizeAgentAdapterEventForRun({ type: 'provider_stop', seq: 11, provider_status: 'completed', final_content: 'final' }),
      { type: 'finalize_progress', progress: 'Finalizing changes...', phase: 'provider_done' },
    ]);
    const snapshot = reduce([
      { type: 'finalize_ack', meta: { output_commit_sha: 'commit-1' }, commitCreated: true },
    ], beforeAck);

    expect(beforeAck.status).toBe('streaming');
    expect(beforeAck.phase).toBe('finalizing');
    expect(beforeAck.terminalStatus).toBeNull();
    expect(beforeAck.executionData.last_agent_event_seq).toBe(11);
    expect(normalizeAgentAdapterEventForRun({ type: 'stop', status: 'completed' })).toMatchObject({
      type: 'native_event',
      event: {
        type: 'provider_stop',
        provider_status: 'completed',
        raw: { type: 'stop', status: 'completed' },
      },
    });

    expect(snapshot.status).toBe('completed');
    expect(snapshot.phase).toBe('terminal');
    expect(snapshot.progress).toBe('Commit generated');
    expect(snapshot.executionData.meta.output_commit_sha).toBe('commit-1');
  });

  it('covers the full adapter lifecycle contract through finalize ack and exit', () => {
    const beforeAck = reduce([
      { type: 'status', status: 'running', progress: 'Running...' },
      { type: 'content', content: 'hello', appendedText: 'hello', streamSeq: 1, timestamp: 1 },
      normalizeAgentAdapterEventForRun({ type: 'tool_result', seq: 10, status: 'completed' }),
      normalizeAgentAdapterEventForRun({ type: 'provider_stop', seq: 11, provider_status: 'completed' }),
      { type: 'finalize_progress', progress: 'Finalizing changes...', phase: 'provider_done' },
    ]);
    const snapshot = reduce([
      { type: 'finalize_ack', meta: { output_commit_sha: 'commit-1' }, commitCreated: true },
      { type: 'terminal', status: 'completed', content: 'hello world', reason: 'completed' },
      normalizeAgentAdapterEventForRun({ type: 'exit', seq: 12, status: 'failed' }),
    ], beforeAck);

    expect(beforeAck.status).toBe('streaming');
    expect(beforeAck.phase).toBe('finalizing');
    expect(beforeAck.terminalStatus).toBeNull();
    expect(snapshot.status).toBe('completed');
    expect(snapshot.phase).toBe('terminal');
    expect(snapshot.content).toBe('hello world');
    expect(snapshot.executionData.meta.output_commit_sha).toBe('commit-1');
  });

  it('does not let late terminal events rewrite a completed run', () => {
    const snapshot = reduce([
      { type: 'terminal', status: 'completed', content: 'done', reason: 'stop' },
      { type: 'native_event', event: { type: 'exit', seq: 10, status: 'failed' } },
      { type: 'terminal', status: 'failed', reason: 'exit' },
    ]);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.progress).toBe('Completed');
    expect(snapshot.terminalReason).toBe('stop');
    expect(snapshot.executionData.last_terminal_status).toBe('completed');
    expect(snapshot.executionData.stop_reason).toBe('stop');
  });

  it('accepts finalize ack before and after terminal stop without reopening a run', () => {
    const ackFirst = reduce([
      { type: 'finalize_ack', meta: { output_commit_sha: 'commit-1' }, commitCreated: true },
      { type: 'terminal', status: 'completed', content: 'done', reason: 'stop' },
    ]);
    const stopFirst = reduce([
      { type: 'terminal', status: 'completed', content: 'done', reason: 'stop' },
      { type: 'finalize_ack', meta: { output_commit_sha: 'commit-1' }, commitCreated: true },
    ]);

    expect(ackFirst.status).toBe('completed');
    expect(ackFirst.phase).toBe('terminal');
    expect(stopFirst.status).toBe('completed');
    expect(stopFirst.phase).toBe('terminal');
    expect(stopFirst.executionData.meta.output_commit_sha).toBe('commit-1');
  });

  it('ignores duplicate and old seq events while replay resumes from newer seq', () => {
    const snapshot = reduce([
      { type: 'native_event', event: { type: 'message_delta', seq: 5, stream_seq: 1 } },
      { type: 'native_event', event: { type: 'message_delta', seq: 5, stream_seq: 2 } },
      { type: 'native_event', event: { type: 'message_delta', seq: 4, stream_seq: 3 } },
      { type: 'native_event', event: { type: 'message_delta', seq: 6, stream_seq: 4 } },
    ]);

    expect(snapshot.lastSeq).toBe(6);
    expect(snapshot.lastStreamSeq).toBe(4);
    expect(snapshot.executionData.last_agent_event_seq).toBe(6);
  });

  it('merges execution data and usage without dropping existing meta', () => {
    const snapshot = reduce([
      { type: 'execution_data', patch: { current_run_id: 'run-1', meta: { a: 1 }, usage: { input_tokens: 2 } } },
      { type: 'execution_data', patch: { meta: { b: 2 }, usage: { output_tokens: 3 } } },
    ]);

    expect(snapshot.runId).toBe('run-1');
    expect(snapshot.executionData.meta).toEqual({ a: 1, b: 2 });
    expect(snapshot.executionData.usage).toEqual({ input_tokens: 2, output_tokens: 3 });
    expect(snapshot.usage).toEqual({ input_tokens: 2, output_tokens: 3 });
  });

  it('keeps terminal status monotonic in the shared resolver', () => {
    expect(resolveAgentRunStatus('completed', 'running')).toBe('completed');
    expect(resolveAgentRunStatus('completed', 'failed')).toBe('completed');
    expect(resolveAgentRunStatus('streaming', 'running')).toBe('streaming');
    expect(resolveAgentRunStatus('running', 'initializing')).toBe('running');
    expect(resolveAgentRunStatus('initializing', 'running')).toBe('running');
  });

  it('records appended content in the actor-owned timeline', () => {
    const snapshot = reduce([
      { type: 'content', content: 'hello', appendedText: 'hello', streamSeq: 1, timestamp: 10 },
      { type: 'content', content: 'hello world', appendedText: ' world', streamSeq: 2, timestamp: 20 },
    ]);

    expect(snapshot.content).toBe('hello world');
    expect(snapshot.timeline).toHaveLength(2);
    expect(snapshot.timeline[0]).toMatchObject({ type: 'message', content: 'hello', timestamp: 10 });
    expect(snapshot.executionData.timeline).toHaveLength(2);
  });

  it('replaces optimistic node ids without losing streamed content', () => {
    const snapshot = reduce([
      { type: 'content', content: 'streamed text' },
      { type: 'replace_node', optimisticNodeId: 'optimistic-assistant', realNode: message({ id: 'assistant-real', content: '' }) },
    ], { nodeId: 'optimistic-assistant' });

    expect(snapshot.nodeId).toBe('assistant-real');
    expect(snapshot.content).toBe('streamed text');
  });
});
