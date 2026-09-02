import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunManager } from './agentRunManager';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';
import { reconcileTerminalAgentRunsFromMessages } from '../lib/agentRunTerminalReconciliation';

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

describe('agentRun projection integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    agentRunManager.clearAll();
    useAgentRunProjectionStore.getState().clearAllProjections();
    useRunStatusStore.getState().clearAllRunStatus();
  });

  afterEach(() => {
    agentRunManager.clearAll();
    useAgentRunProjectionStore.getState().clearAllProjections();
    useRunStatusStore.getState().clearAllRunStatus();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('projects seeded and running actor snapshots into projection and run status stores', () => {
    agentRunManager.seed(message({ status: 'pending', content: '' }), 'run-1');
    agentRunManager.dispatch('assistant-1', { type: 'setup_progress', progress: 'Initializing agent...', status: 'initializing' });
    agentRunManager.dispatch('assistant-1', { type: 'content', content: 'hello', streamSeq: 3 });

    const projection = useAgentRunProjectionStore.getState().projectionsById['assistant-1'];
    const runStatus = useRunStatusStore.getState().byNodeId['assistant-1'];

    expect(projection.content).toBe('hello');
    expect(projection._optimisticStatus).toBe('streaming');
    expect(projection.execution_data?.last_stream_seq).toBe(3);
    expect(runStatus.status).toBe('streaming');
    expect(runStatus.workspaceId).toBe('workspace-1');
  });

  it('keeps exact native seq inside the actor without projecting every invisible delta', () => {
    agentRunManager.seed(message({ status: 'running', content: '' }), 'run-1');
    const initialRevision = useRunStatusStore.getState().revision;

    agentRunManager.dispatch('assistant-1', { type: 'native_event', event: { type: 'message_delta', seq: 1, stream_seq: 1 } });
    agentRunManager.dispatch('assistant-1', { type: 'native_event', event: { type: 'message_delta', seq: 2, stream_seq: 2 } });

    expect(agentRunManager.snapshot('assistant-1')?.lastSeq).toBe(2);
    expect(agentRunManager.snapshot('assistant-1')?.lastStreamSeq).toBe(2);
    expect(useRunStatusStore.getState().revision).toBe(initialRevision);
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.execution_data?.last_agent_event_seq).toBeUndefined();

    agentRunManager.dispatch('assistant-1', { type: 'content', content: 'live text', streamSeq: 2 });

    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.content).toBe('live text');
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.execution_data?.last_agent_event_seq).toBe(2);
  });

  it('ingests raw adapter events at the manager boundary', () => {
    agentRunManager.seed(message({ status: 'running', content: '' }), 'run-1');

    agentRunManager.ingest('assistant-1', {
      type: 'provider_stop',
      seq: 10,
      status: 'completed',
      provider_status: 'completed',
    });

    const afterProviderStop = agentRunManager.snapshot('assistant-1');
    expect(afterProviderStop?.status).toBe('running');
    expect(afterProviderStop?.phase).toBe('running');
    expect(afterProviderStop?.lastSeq).toBe(10);

    agentRunManager.ingest('assistant-1', {
      type: 'exit',
      seq: 11,
      status: 'failed',
    });

    const afterExit = agentRunManager.snapshot('assistant-1');
    expect(afterExit?.status).toBe('failed');
    expect(afterExit?.phase).toBe('terminal');
    expect(useRunStatusStore.getState().byNodeId['assistant-1']?.status).toBe('failed');
  });

  it('does not count optimistic user send progress as a running agent run', () => {
    agentRunManager.seed(message({ id: 'user-1', role: 'user', status: 'pending', content: 'hello' }));
    agentRunManager.dispatch('user-1', { type: 'setup_progress', progress: 'Sending...' });

    expect(useRunStatusStore.getState().byNodeId['user-1']?.status).toBe('pending');
    expect(useRunStatusStore.getState().getRunningCount('workspace-1')).toBe(0);
  });

  it('reconciles stale active actor status from authoritative terminal messages', () => {
    agentRunManager.seed(message({ status: 'pending', content: '' }), 'run-1');
    agentRunManager.dispatch('assistant-1', { type: 'status', status: 'running' });

    expect(useRunStatusStore.getState().getRunningCount('workspace-1')).toBe(1);

    const reconciledCount = reconcileTerminalAgentRunsFromMessages([
      message({
        status: 'completed',
        content: 'done',
        execution_data: { last_terminal_status: 'completed' },
      }),
    ]);

    expect(reconciledCount).toBe(1);
    expect(agentRunManager.snapshot('assistant-1')?.status).toBe('completed');
    expect(agentRunManager.snapshot('assistant-1')?.phase).toBe('terminal');
    expect(useRunStatusStore.getState().byNodeId['assistant-1']?.status).toBe('completed');
    expect(useRunStatusStore.getState().getRunningCount('workspace-1')).toBe(0);
  });

  it('reconciles stale preparing worktree run status from authoritative terminal messages', () => {
    useRunStatusStore.getState().setRunStatus('assistant-1', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'preparing_worktree',
      progress: 'Preparing worktree...',
    });

    expect(useRunStatusStore.getState().getRunningCount('workspace-1')).toBe(1);

    const reconciledCount = reconcileTerminalAgentRunsFromMessages([
      message({
        status: 'completed',
        content: 'done',
        execution_data: { last_terminal_status: 'completed' },
      }),
    ]);

    expect(reconciledCount).toBe(1);
    expect(agentRunManager.snapshot('assistant-1')?.status).toBe('completed');
    expect(useRunStatusStore.getState().byNodeId['assistant-1']?.status).toBe('completed');
    expect(useRunStatusStore.getState().getRunningCount('workspace-1')).toBe(0);
  });

  it('preserves optimistic message metadata needed by chat and graph projections', () => {
    agentRunManager.seed(message({
      id: 'optimistic-user',
      parentId: 'parent-1',
      role: 'user',
      content: 'hello',
      status: 'pending',
      path_ids: ['root-1', 'parent-1', 'optimistic-user'],
      depth: 2,
      _optimistic: true,
      _optimisticStatus: 'pending',
      _optimisticError: null,
      _rollbackOnFail: true,
    }));

    const projection = useAgentRunProjectionStore.getState().projectionsById['optimistic-user'];

    expect(projection).toMatchObject({
      id: 'optimistic-user',
      parentId: 'parent-1',
      role: 'user',
      content: 'hello',
      path_ids: ['root-1', 'parent-1', 'optimistic-user'],
      depth: 2,
      _optimistic: true,
      _optimisticStatus: 'pending',
      _optimisticError: null,
      _rollbackOnFail: true,
    });
  });

  it('moves optimistic actor projection to the real node id', () => {
    agentRunManager.seed(message({ id: 'optimistic-assistant', status: 'pending', content: 'draft' }), 'run-1');
    agentRunManager.replaceNode('optimistic-assistant', message({ id: 'assistant-real', status: 'running', content: '' }));

    expect(useAgentRunProjectionStore.getState().projectionsById['optimistic-assistant']).toBeUndefined();
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-real']?.content).toBe('draft');
    expect(useRunStatusStore.getState().byNodeId['assistant-real']?.status).toBe('pending');
  });

  it('keeps terminal run status while cleanup prunes projected runtime state', () => {
    agentRunManager.seed(message({ status: 'running', content: 'partial' }), 'run-1');
    agentRunManager.dispatch('assistant-1', {
      type: 'terminal',
      status: 'completed',
      content: 'final',
      reason: 'done',
      holdMs: 100,
    });

    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.content).toBe('final');
    expect(useRunStatusStore.getState().byNodeId['assistant-1']?.status).toBe('completed');

    vi.advanceTimersByTime(100);

    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']).toBeUndefined();
    expect(useRunStatusStore.getState().byNodeId['assistant-1']?.status).toBe('completed');
  });

  it('does not let late active progress text overwrite completed run status projection', () => {
    agentRunManager.seed(message({ status: 'running', content: 'partial' }), 'run-1');
    agentRunManager.dispatch('assistant-1', {
      type: 'terminal',
      status: 'completed',
      content: 'final',
      reason: 'done',
      holdMs: 100,
    });
    agentRunManager.dispatch('assistant-1', {
      type: 'finalize_progress',
      progress: 'Generating commit...',
      phase: 'commit',
    });

    const runStatus = useRunStatusStore.getState().byNodeId['assistant-1'];
    expect(runStatus?.status).toBe('completed');
    expect(runStatus?.progress).toBe('Completed');
  });

  it('batches throttled content projections across active runs', () => {
    agentRunManager.seed(message({ id: 'assistant-1', status: 'running', content: '' }), 'run-1');
    agentRunManager.seed(message({ id: 'assistant-2', status: 'running', content: '' }), 'run-2');
    agentRunManager.dispatch('assistant-1', { type: 'content', content: 'a', streamSeq: 1 });
    agentRunManager.dispatch('assistant-2', { type: 'content', content: 'b', streamSeq: 1 });

    agentRunManager.dispatch('assistant-1', { type: 'content', content: 'aa', streamSeq: 2 });
    agentRunManager.dispatch('assistant-2', { type: 'content', content: 'bb', streamSeq: 2 });

    expect(agentRunManager.snapshot('assistant-1')?.content).toBe('aa');
    expect(agentRunManager.snapshot('assistant-2')?.content).toBe('bb');
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.content).toBe('a');
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-2']?.content).toBe('b');

    vi.advanceTimersByTime(140);

    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.content).toBe('aa');
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-2']?.content).toBe('bb');
  });

  it('promotes the latest actor snapshot for watched runs immediately', () => {
    agentRunManager.seed(message({ status: 'running', content: '' }), 'run-1');
    agentRunManager.dispatch('assistant-1', { type: 'content', content: 'first', streamSeq: 1 });
    agentRunManager.dispatch('assistant-1', { type: 'content', content: 'latest', streamSeq: 2 });

    expect(agentRunManager.snapshot('assistant-1')?.content).toBe('latest');
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.content).toBe('first');

    agentRunManager.watch('assistant-1', 'hover');

    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']?.content).toBe('latest');
    agentRunManager.unwatch('assistant-1', 'hover');
  });

  it('notifies when projection watchers transition between zero and nonzero', () => {
    const events: Array<{ nodeId: string; hasWatchers: boolean; reasons: string[] }> = [];
    const unsubscribe = agentRunManager.subscribeProjectionWatchers((event) => {
      events.push({
        nodeId: event.nodeId,
        hasWatchers: event.hasWatchers,
        reasons: event.reasons,
      });
    });

    agentRunManager.watch('assistant-1', 'hover');
    agentRunManager.watch('assistant-1', 'chat-focus');
    agentRunManager.unwatch('assistant-1', 'hover');
    agentRunManager.unwatch('assistant-1', 'chat-focus');
    unsubscribe();
    agentRunManager.watch('assistant-1', 'hover');

    expect(events).toEqual([
      { nodeId: 'assistant-1', hasWatchers: true, reasons: ['hover'] },
      { nodeId: 'assistant-1', hasWatchers: false, reasons: [] },
    ]);
  });

  it('exposes the current projection watcher snapshot', () => {
    agentRunManager.watch('assistant-1', 'hover');
    agentRunManager.watch('assistant-1', 'chat-focus');

    expect(agentRunManager.projectionWatcherSnapshot('assistant-1')).toEqual({
      nodeId: 'assistant-1',
      hasWatchers: true,
      reasons: ['chat-focus', 'hover'],
    });

    agentRunManager.unwatch('assistant-1', 'hover');
    agentRunManager.unwatch('assistant-1', 'chat-focus');

    expect(agentRunManager.projectionWatcherSnapshot('assistant-1')).toEqual({
      nodeId: 'assistant-1',
      hasWatchers: false,
      reasons: [],
    });
  });

  it('keeps unwatched background runs status-only until promoted', () => {
    agentRunManager.dispatch('background-1', { type: 'content', content: 'hidden live text', streamSeq: 1 }, {
      workspaceId: 'workspace-1',
      parentId: 'user-1',
      role: 'assistant',
    });

    expect(agentRunManager.snapshot('background-1')?.content).toBe('hidden live text');
    expect(useRunStatusStore.getState().byNodeId['background-1']?.status).toBe('streaming');
    expect(useAgentRunProjectionStore.getState().projectionsById['background-1']).toBeUndefined();

    agentRunManager.watch('background-1', 'hover');

    expect(useAgentRunProjectionStore.getState().projectionsById['background-1']?.content).toBe('hidden live text');
    agentRunManager.unwatch('background-1', 'hover');
  });

  it('cleans active runtime state and active run status', () => {
    agentRunManager.seed(message({ status: 'running', content: 'partial' }), 'run-1');
    agentRunManager.cleanup('assistant-1');

    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']).toBeUndefined();
    expect(useRunStatusStore.getState().byNodeId['assistant-1']).toBeUndefined();
    expect(agentRunManager.snapshot('assistant-1')).toBeNull();
  });
});
