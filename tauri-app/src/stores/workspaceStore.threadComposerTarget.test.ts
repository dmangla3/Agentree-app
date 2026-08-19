import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';

describe('workspace thread composer target', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      threadComposerTarget: null,
    });
  });

  it('stores the explicit graph-created thread target outside window events', () => {
    useWorkspaceStore.getState().setThreadComposerTarget({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      reason: 'create-thread',
      nonce: 1,
    });

    expect(useWorkspaceStore.getState().threadComposerTarget).toEqual({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      reason: 'create-thread',
      nonce: 1,
    });
  });

  it('clears the thread composer target after the composer consumes it', () => {
    useWorkspaceStore.getState().setThreadComposerTarget({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      reason: 'create-thread',
      nonce: 1,
    });

    useWorkspaceStore.getState().clearThreadComposerTarget(1);

    expect(useWorkspaceStore.getState().threadComposerTarget).toBeNull();
  });
});
