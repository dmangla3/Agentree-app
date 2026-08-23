import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';

describe('workspace focus dispatch', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      selectedWorkspaceId: 'workspace-a',
      focusedMessageId: null,
      lastFocusSource: null,
      lastFocusMetadata: null,
      focusNonce: 0,
      lastFocusedMessageByWorkspace: {},
      recentFocusedMessageIdsByWorkspace: {},
      activeSendFlowFocus: null,
    });
  });

  it('does not churn focus state for repeated system fallback focus', () => {
    useWorkspaceStore.getState().dispatchFocus({
      messageId: 'message-a',
      source: 'system',
      metadata: { reason: 'restore-workspace-focus' },
    });
    const afterFirstFocus = useWorkspaceStore.getState();

    useWorkspaceStore.getState().dispatchFocus({
      messageId: 'message-a',
      source: 'system',
      metadata: { reason: 'restore-workspace-focus' },
    });
    const afterRepeatedFocus = useWorkspaceStore.getState();

    expect(afterRepeatedFocus).toBe(afterFirstFocus);
    expect(afterRepeatedFocus.focusedMessageId).toBe('message-a');
  });

  it('still allows explicit graph refocus on the same node to refresh focus nonce', () => {
    useWorkspaceStore.getState().dispatchFocus({
      messageId: 'message-a',
      source: 'graph',
      metadata: { via: 'react-flow-node-click' },
    });
    const firstNonce = useWorkspaceStore.getState().focusNonce;

    useWorkspaceStore.getState().dispatchFocus({
      messageId: 'message-a',
      source: 'graph',
      metadata: { via: 'react-flow-node-click' },
    });

    expect(useWorkspaceStore.getState().focusedMessageId).toBe('message-a');
    expect(useWorkspaceStore.getState().focusNonce).toBeGreaterThanOrEqual(firstNonce);
  });
});
