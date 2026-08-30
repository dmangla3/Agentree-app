import { afterEach, describe, expect, it } from 'vitest';
import { flowRunManager } from './flowRunManager';
import { readNodeFlowRunId, resolveActiveFlowCancelTarget } from './flowRunSelectors';

describe('flowRunSelectors', () => {
  afterEach(() => {
    flowRunManager.resetForTests();
  });

  it('reads flow run ids from execution metadata', () => {
    expect(readNodeFlowRunId({
      execution_data: {
        meta: {
          flow_run_id: 'flow-run-1',
        },
      },
    })).toBe('flow-run-1');
  });

  it('resolves active flow cancel targets for launched nodes', () => {
    flowRunManager.start({
      flowRunId: 'flow-run-1',
      flowId: 'parallel_review_until_satisfied',
    });
    flowRunManager.recordExecutionEvent('flow-run-1', {
      type: 'node_launched',
      templateId: 'Implementer',
      userNodeId: 'user-1',
      nodeId: 'assistant-1',
      message: 'Launched Implementer.',
    });

    expect(resolveActiveFlowCancelTarget({
      nodeId: 'assistant-1',
      node: {
        id: 'assistant-1',
        execution_data: {
          meta: {
            flow_run_id: 'flow-run-1',
          },
        },
      },
    })).toEqual(expect.objectContaining({
      flowRunId: 'flow-run-1',
      flowId: 'parallel_review_until_satisfied',
      activeNodeIds: ['assistant-1'],
    }));
  });

  it('does not resolve terminal flow runs as cancel targets', () => {
    flowRunManager.start({
      flowRunId: 'flow-run-1',
      flowId: 'parallel_review_until_satisfied',
    });
    flowRunManager.recordExecutionEvent('flow-run-1', {
      type: 'node_launched',
      templateId: 'Implementer',
      userNodeId: 'user-1',
      nodeId: 'assistant-1',
      message: 'Launched Implementer.',
    });
    flowRunManager.finish('flow-run-1', {
      status: 'completed',
      scope: {},
      events: [],
    });

    expect(resolveActiveFlowCancelTarget({
      nodeId: 'assistant-1',
      node: {
        id: 'assistant-1',
        execution_data: {
          meta: {
            flow_run_id: 'flow-run-1',
          },
        },
      },
    })).toBeNull();
  });
});
