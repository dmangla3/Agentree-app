import { describe, expect, it } from 'vitest';
import { isActiveFlowRunStatus, reduceFlowRunSnapshot } from './flowRun.machine';
import type { FlowRunEvent, FlowRunSnapshot } from './flowRun.types';

const baseSnapshot = (overrides: Partial<FlowRunSnapshot> = {}): FlowRunSnapshot => ({
  flowRunId: 'flow-run-1',
  flowId: 'parallel_review_until_satisfied',
  status: 'idle',
  activeNodeIds: [],
  launchedNodeIds: [],
  currentTemplateId: null,
  scope: {},
  events: [],
  reason: null,
  startedAt: null,
  completedAt: null,
  updatedAt: '2026-06-09T00:00:00.000Z',
  ...overrides,
});

const reduce = (events: FlowRunEvent[], initial: Partial<FlowRunSnapshot> = {}) => (
  events.reduce((snapshot, event) => reduceFlowRunSnapshot(snapshot, event), baseSnapshot(initial))
);

describe('flowRun.machine', () => {
  it('tracks start, launched nodes, completion, and terminal result', () => {
    const snapshot = reduce([
      { type: 'start', startedAt: '2026-06-09T01:00:00.000Z' },
      {
        type: 'execution_event',
        event: { type: 'node_started', templateId: 'Implementer', message: 'Started Implementer.' },
      },
      {
        type: 'execution_event',
        event: {
          type: 'node_launched',
          templateId: 'Implementer',
          userNodeId: 'user-1',
          nodeId: 'assistant-1',
          message: 'Launched Implementer.',
        },
      },
      {
        type: 'execution_event',
        event: {
          type: 'node_completed',
          templateId: 'Implementer',
          nodeId: 'assistant-1',
          message: 'Completed Implementer.',
        },
      },
      {
        type: 'result',
        result: {
          status: 'completed',
          scope: { implementation: { kind: 'node', id: 'assistant-1', status: 'complete' } },
          events: [],
        },
      },
    ]);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.startedAt).toBe('2026-06-09T01:00:00.000Z');
    expect(snapshot.activeNodeIds).toEqual([]);
    expect(snapshot.launchedNodeIds).toEqual(['assistant-1']);
    expect(snapshot.currentTemplateId).toBeNull();
    expect(snapshot.scope.implementation).toEqual(expect.objectContaining({ id: 'assistant-1' }));
    expect(snapshot.completedAt).toEqual(expect.any(String));
  });

  it('marks cancel intent without losing active node ownership', () => {
    const snapshot = reduce([
      { type: 'start' },
      {
        type: 'execution_event',
        event: {
          type: 'node_launched',
          templateId: 'Implementer',
          userNodeId: 'user-1',
          nodeId: 'assistant-1',
          message: 'Launched Implementer.',
        },
      },
      { type: 'cancel', reason: 'User cancelled flow.' },
    ]);

    expect(snapshot.status).toBe('cancelling');
    expect(snapshot.reason).toBe('User cancelled flow.');
    expect(snapshot.activeNodeIds).toEqual(['assistant-1']);
    expect(isActiveFlowRunStatus(snapshot.status)).toBe(true);
  });

  it('finalizes cancellation and prevents terminal regression', () => {
    const cancelled = reduce([
      { type: 'start' },
      {
        type: 'execution_event',
        event: {
          type: 'node_launched',
          templateId: 'Implementer',
          userNodeId: 'user-1',
          nodeId: 'assistant-1',
          message: 'Launched Implementer.',
        },
      },
      { type: 'cancel', reason: 'User cancelled flow.' },
      {
        type: 'result',
        result: {
          status: 'cancelled',
          reason: 'User cancelled flow.',
          scope: {},
          events: [],
        },
      },
      {
        type: 'result',
        result: {
          status: 'completed',
          scope: {},
          events: [],
        },
      },
    ]);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reason).toBe('User cancelled flow.');
    expect(cancelled.activeNodeIds).toEqual([]);
  });
});
