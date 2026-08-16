import { beforeEach, describe, expect, it } from 'vitest';
import { projectBackgroundAgentEvent } from './agentRunBackgroundStream';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useAgentRunProjectionStore } from '../stores/agentRunProjectionStore';

const base = {
  nodeId: 'assistant-1',
  workspaceId: 'workspace-1',
  role: 'assistant',
};

describe('projectBackgroundAgentEvent', () => {
  beforeEach(() => {
    useRunStatusStore.getState().clearAllRunStatus();
    useAgentRunProjectionStore.getState().clearAllProjections();
  });

  it('projects cheap active status without creating full content projection', () => {
    const result = projectBackgroundAgentEvent(base, {
      type: 'message_delta',
      seq: 5,
      stream_seq: 9,
    });

    expect(result).toEqual({ terminalHydration: false });
    expect(useRunStatusStore.getState().byNodeId['assistant-1']).toMatchObject({
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running',
    });
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']).toBeUndefined();
  });

  it('projects finalize progress without full content projection', () => {
    const result = projectBackgroundAgentEvent(base, {
      type: 'finalize_progress',
      message: 'Generating commit...',
    });

    expect(result).toEqual({ terminalHydration: false });
    expect(useRunStatusStore.getState().byNodeId['assistant-1']).toMatchObject({
      status: 'running',
      progress: 'Generating commit...',
    });
  });

  it('requests terminal hydration on finalize ack', () => {
    const result = projectBackgroundAgentEvent(base, {
      type: 'finalize_ack',
      status: 'completed',
      output_commit_sha: 'abc123',
    });

    expect(result).toEqual({ terminalHydration: true });
    expect(useRunStatusStore.getState().byNodeId['assistant-1']).toMatchObject({
      status: 'completed',
    });
    expect(useAgentRunProjectionStore.getState().projectionsById['assistant-1']).toBeUndefined();
  });

  it('requests terminal hydration on native exit', () => {
    const result = projectBackgroundAgentEvent(base, {
      type: 'exit',
      status: 'failed',
    });

    expect(result).toEqual({ terminalHydration: true });
    expect(useRunStatusStore.getState().byNodeId['assistant-1']).toMatchObject({
      status: 'failed',
    });
  });
});
