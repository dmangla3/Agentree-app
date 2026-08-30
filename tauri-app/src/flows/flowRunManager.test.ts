import { afterEach, describe, expect, it } from 'vitest';
import { flowRunManager } from './flowRunManager';

describe('flowRunManager', () => {
  afterEach(() => {
    flowRunManager.resetForTests();
  });

  it('tracks active flow ownership for launched assistant nodes', () => {
    const controller = new AbortController();
    flowRunManager.start({
      flowRunId: 'flow-run-1',
      flowId: 'parallel_review_until_satisfied',
      abortController: controller,
    });
    flowRunManager.recordExecutionEvent('flow-run-1', {
      type: 'node_launched',
      templateId: 'Implementer',
      userNodeId: 'user-1',
      nodeId: 'assistant-1',
      message: 'Launched Implementer.',
    });

    expect(flowRunManager.isNodeOwnedByActiveFlow('assistant-1')).toBe(true);
    expect(flowRunManager.snapshotForNode('assistant-1')).toEqual(expect.objectContaining({
      flowRunId: 'flow-run-1',
      status: 'running',
      activeNodeIds: ['assistant-1'],
    }));
  });

  it('aborts the flow and stops active nodes on cancel', async () => {
    const controller = new AbortController();
    const stoppedNodeIds: string[] = [];
    flowRunManager.start({
      flowRunId: 'flow-run-1',
      flowId: 'parallel_review_until_satisfied',
      abortController: controller,
      stopNode: async (nodeId) => {
        stoppedNodeIds.push(nodeId);
      },
    });
    flowRunManager.recordExecutionEvent('flow-run-1', {
      type: 'node_launched',
      templateId: 'Implementer',
      userNodeId: 'user-1',
      nodeId: 'assistant-1',
      message: 'Launched Implementer.',
    });

    const snapshot = await flowRunManager.cancel('flow-run-1', 'User cancelled flow.');

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('User cancelled flow.');
    expect(stoppedNodeIds).toEqual(['assistant-1']);
    expect(snapshot).toEqual(expect.objectContaining({
      status: 'cancelling',
      reason: 'User cancelled flow.',
      activeNodeIds: ['assistant-1'],
    }));
  });
});
