import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import {
  clampGraphZoom,
  GRAPH_MIN_ZOOM,
  getGraphNodeNavigationIds,
  getThreadDraftPreviewText,
  resolveDirectionalGraphNavigationTarget,
  resolveBlockingEmptyThreadRootId,
  resolveThreadDeletePlan,
  resolveThreadScopedDefaultFocus,
  resolveThreadDropdownSelection,
  resolveLeafNodeFocusThreadRootId,
  resolveReactFlowNodeClickFocusMessageId,
  resolveReactFlowNodeClickFocusTarget,
  shouldDispatchGraphFocusSynchronously,
  shouldClampViewportDuringMove,
  shouldRestoreViewportAfterGraphNodeCountChange,
  shouldSkipActiveGraphClickCentering,
  shouldTreatGraphMoveAsViewportInteraction,
} from './GraphView';

const makeMessage = (
  id: string,
  role: Message['role'],
  parentId: string | null,
  createdAt: string,
  outputCommitSha: string | null = null,
): Message => ({
  id,
  parentId,
  role,
  content: id,
  workspaceId: 'workspace-1',
  status: null,
  agent_id: null,
  output_commit_sha: outputCommitSha,
  execution_data: null,
  createdAt,
  updatedAt: createdAt,
});

describe('shouldTreatGraphMoveAsViewportInteraction', () => {
  it('ignores graph node pointer moves', () => {
    expect(shouldTreatGraphMoveAsViewportInteraction({
      eventType: 'mousedown',
      eventTargetIsNode: true,
      programmaticFocusCenterActive: false,
    })).toBe(false);
  });

  it('ignores programmatic focus-center movement', () => {
    expect(shouldTreatGraphMoveAsViewportInteraction({
      eventType: 'mousedown',
      eventTargetIsNode: false,
      programmaticFocusCenterActive: true,
    })).toBe(false);
  });

  it('still treats wheel movement as viewport interaction during focus center', () => {
    expect(shouldTreatGraphMoveAsViewportInteraction({
      eventType: 'wheel',
      eventTargetIsNode: false,
      programmaticFocusCenterActive: true,
    })).toBe(true);
  });

  it('still treats touch gestures as user viewport interaction during focus center', () => {
    expect(shouldTreatGraphMoveAsViewportInteraction({
      eventType: 'touchstart',
      eventTargetIsNode: false,
      programmaticFocusCenterActive: true,
    })).toBe(true);
  });

  it('ignores programmatic viewport movement without a browser event', () => {
    expect(shouldTreatGraphMoveAsViewportInteraction({
      eventType: undefined,
      eventTargetIsNode: false,
      programmaticFocusCenterActive: false,
    })).toBe(false);
  });
});

describe('getGraphNodeNavigationIds', () => {
  it('returns assistant messages only in chronological order', () => {
    const messages = [
      makeMessage('user-root', 'user', null, '2026-05-19T00:00:00.000Z'),
      makeMessage('assistant-b', 'assistant', 'user-followup', '2026-05-19T00:03:00.000Z'),
      makeMessage('user-followup', 'user', 'assistant-a', '2026-05-19T00:02:00.000Z'),
      makeMessage('assistant-a', 'assistant', 'user-root', '2026-05-19T00:01:00.000Z'),
    ];

    expect(getGraphNodeNavigationIds(messages)).toEqual(['assistant-a', 'assistant-b']);
  });
});

describe('resolveDirectionalGraphNavigationTarget', () => {
  const graphNode = (id: string, x: number, y: number) => ({
    id,
    type: 'assistant_message',
    position: { x, y },
    width: 100,
    height: 80,
    data: {
      entity: {
        kind: 'assistant_message',
        messageId: id,
        focusMessageId: id,
      },
    },
  });

  it('moves to the nearest node in the requested spatial direction', () => {
    const nodes = [
      graphNode('current', 100, 100),
      graphNode('right-near', 260, 110),
      graphNode('right-far', 620, 100),
      graphNode('down', 100, 260),
    ];

    expect(resolveDirectionalGraphNavigationTarget({
      direction: 'right',
      nodes,
      focusedMessageId: 'current',
      fallbackPoint: { x: 0, y: 0 },
    })?.messageId).toBe('right-near');

    expect(resolveDirectionalGraphNavigationTarget({
      direction: 'down',
      nodes,
      focusedMessageId: 'current',
      fallbackPoint: { x: 0, y: 0 },
    })?.messageId).toBe('down');
  });

  it('uses the viewport fallback point when no node is focused', () => {
    const nodes = [
      graphNode('left', 100, 100),
      graphNode('right', 500, 100),
    ];

    expect(resolveDirectionalGraphNavigationTarget({
      direction: 'right',
      nodes,
      focusedMessageId: null,
      fallbackPoint: { x: 250, y: 140 },
    })?.messageId).toBe('right');
  });
});

describe('shouldClampViewportDuringMove', () => {
  it('does not clamp while a pointer drag is actively moving the viewport', () => {
    expect(shouldClampViewportDuringMove({
      eventType: 'mousemove',
      isViewportInteracting: true,
    })).toBe(false);

    expect(shouldClampViewportDuringMove({
      eventType: 'touchmove',
      isViewportInteracting: true,
    })).toBe(false);
  });

  it('still allows non-drag viewport changes to be clamped during move', () => {
    expect(shouldClampViewportDuringMove({
      eventType: 'wheel',
      isViewportInteracting: true,
    })).toBe(true);

    expect(shouldClampViewportDuringMove({
      eventType: undefined,
      isViewportInteracting: false,
    })).toBe(true);
  });
});

describe('shouldRestoreViewportAfterGraphNodeCountChange', () => {
  it('does not restore the saved thread viewport while the user is dragging', () => {
    expect(shouldRestoreViewportAfterGraphNodeCountChange({
      activeGraphRenderHold: false,
      graphRenderMode: 'full',
      isViewportInteracting: true,
    })).toBe(false);
  });

  it('does not restore while active-run render hold is controlling the visible node window', () => {
    expect(shouldRestoreViewportAfterGraphNodeCountChange({
      activeGraphRenderHold: true,
      graphRenderMode: 'hold-visible',
      isViewportInteracting: false,
    })).toBe(false);
  });

  it('allows idle full-graph node count changes to restore the saved thread viewport', () => {
    expect(shouldRestoreViewportAfterGraphNodeCountChange({
      activeGraphRenderHold: false,
      graphRenderMode: 'full',
      isViewportInteracting: false,
    })).toBe(true);
  });
});

describe('shouldDispatchGraphFocusSynchronously', () => {
  it('keeps idle graph focus dispatch deferred', () => {
    expect(shouldDispatchGraphFocusSynchronously({
      activeRunCount: 0,
      activeSendFlowWorkspaceId: null,
      selectedWorkspaceId: 'workspace-1',
    })).toBe(false);
  });

  it('dispatches immediately while a run is active', () => {
    expect(shouldDispatchGraphFocusSynchronously({
      activeRunCount: 1,
      activeSendFlowWorkspaceId: null,
      selectedWorkspaceId: 'workspace-1',
    })).toBe(true);
  });

  it('dispatches immediately during active send focus for the selected workspace', () => {
    expect(shouldDispatchGraphFocusSynchronously({
      activeRunCount: 0,
      activeSendFlowWorkspaceId: 'workspace-1',
      selectedWorkspaceId: 'workspace-1',
    })).toBe(true);
  });

  it('does not dispatch immediately for another workspace send focus', () => {
    expect(shouldDispatchGraphFocusSynchronously({
      activeRunCount: 0,
      activeSendFlowWorkspaceId: 'workspace-2',
      selectedWorkspaceId: 'workspace-1',
    })).toBe(false);
  });
});

describe('shouldSkipActiveGraphClickCentering', () => {
  it('skips recentering visible graph-node clicks while a run is active', () => {
    expect(shouldSkipActiveGraphClickCentering({
      activeRunCount: 1,
      activeSendFlowWorkspaceId: null,
      selectedWorkspaceId: 'workspace-1',
      triggerVia: 'react-flow-node-click',
    })).toBe(true);
  });

  it('keeps composer and idle graph focus centering enabled', () => {
    expect(shouldSkipActiveGraphClickCentering({
      activeRunCount: 1,
      activeSendFlowWorkspaceId: null,
      selectedWorkspaceId: 'workspace-1',
      triggerVia: 'composer',
    })).toBe(false);
    expect(shouldSkipActiveGraphClickCentering({
      activeRunCount: 0,
      activeSendFlowWorkspaceId: null,
      selectedWorkspaceId: 'workspace-1',
      triggerVia: 'react-flow-node-click',
    })).toBe(false);
  });
});

describe('clampGraphZoom', () => {
  it('allows minimal overview without extreme zoom-out hitches in the main viewport', () => {
    expect(GRAPH_MIN_ZOOM).toBe(0.2);
    expect(clampGraphZoom(0.01)).toBe(0.2);
  });
});

describe('GraphView canvas focus', () => {
  it('uses projected focus targets for React Flow user node clicks', () => {
    expect(resolveReactFlowNodeClickFocusMessageId({
      nodeType: 'user_message',
      nodeId: 'user-a',
      entity: {
        messageId: 'user-a',
        focusMessageId: 'assistant-a',
      },
    })).toBe('assistant-a');

    expect(resolveReactFlowNodeClickFocusMessageId({
      nodeType: 'user_message',
      nodeId: 'user-a',
      entity: {
        messageId: 'user-a',
        focusMessageId: null,
      },
    })).toBeNull();
  });

  it('centers the clicked user node when its focus redirects to an assistant', () => {
    expect(resolveReactFlowNodeClickFocusTarget({
      nodeType: 'user_message',
      nodeId: 'user-a',
      entity: {
        messageId: 'user-a',
        focusMessageId: 'assistant-a',
      },
    })).toEqual({
      messageId: 'assistant-a',
      centerMessageId: 'user-a',
      redirectedFromMessageId: 'user-a',
    });

    expect(resolveReactFlowNodeClickFocusTarget({
      nodeType: 'assistant_message',
      nodeId: 'assistant-a',
      entity: {
        messageId: 'assistant-a',
        focusMessageId: 'assistant-a',
      },
    })).toEqual({
      messageId: 'assistant-a',
      centerMessageId: 'assistant-a',
      redirectedFromMessageId: null,
    });
  });

});

describe('resolveThreadDropdownSelection', () => {
  it('resolves only the latest thread message focus target', () => {
    const messages = [
      makeMessage('thread-a', 'user', null, '2026-05-19T00:00:00.000Z'),
      makeMessage('assistant-a', 'assistant', 'thread-a', '2026-05-19T00:01:00.000Z'),
      makeMessage('thread-a-followup', 'user', 'assistant-a', '2026-05-19T00:02:00.000Z'),
    ];

    expect(resolveThreadDropdownSelection({
      threadRootId: 'thread-a',
      messages,
    })).toBe('thread-a-followup');
  });

  it('prefers the most recently updated thread node over the newest created user node', () => {
    const messages = [
      makeMessage('thread-a', 'user', null, '2026-05-19T00:00:00.000Z'),
      {
        ...makeMessage('assistant-running', 'assistant', 'thread-a', '2026-05-19T00:01:00.000Z'),
        status: 'running' as const,
        updatedAt: '2026-05-19T00:04:00.000Z',
      },
      makeMessage('thread-a-followup', 'user', 'assistant-running', '2026-05-19T00:03:00.000Z'),
    ];

    expect(resolveThreadDropdownSelection({
      threadRootId: 'thread-a',
      messages,
    })).toBe('assistant-running');
  });

  it('does not focus an empty first-class thread session as a message node', () => {
    expect(resolveThreadDropdownSelection({
      threadRootId: 'empty-thread-session',
      messages: [],
    })).toBeNull();
  });
});

describe('resolveThreadScopedDefaultFocus', () => {
  it('clears stale workspace focus when the active thread has no messages', () => {
    expect(resolveThreadScopedDefaultFocus({
      focusedMessageId: 'assistant-from-other-thread',
      lastFocusSource: 'system',
      lastFocusMetadata: { reason: 'restore-workspace-focus' },
      rememberedFocusId: 'assistant-from-other-thread',
      messages: [],
    })).toEqual({
      messageId: null,
      reason: 'clear-thread-focus',
    });
  });

  it('restores remembered focus only when it belongs to the active thread scope', () => {
    const messages = [
      makeMessage('thread-a', 'user', null, '2026-05-19T00:00:00.000Z'),
      makeMessage('assistant-a', 'assistant', 'thread-a', '2026-05-19T00:01:00.000Z'),
    ];

    expect(resolveThreadScopedDefaultFocus({
      focusedMessageId: 'assistant-from-other-thread',
      lastFocusSource: 'system',
      lastFocusMetadata: null,
      rememberedFocusId: 'assistant-from-other-thread',
      messages,
    })).toEqual({
      messageId: 'assistant-a',
      reason: 'default-workspace-focus',
    });
  });
});

describe('resolveLeafNodeFocusThreadRootId', () => {
  it('returns the owning thread for leaf nodes across the full graph', () => {
    const lookup = new Map([
      ['current-leaf', 'thread-current'],
      ['other-leaf', 'thread-other'],
    ]);

    expect(resolveLeafNodeFocusThreadRootId({
      leafNodeId: 'other-leaf',
      focusedThreadRootLookup: lookup,
    })).toBe('thread-other');
  });

  it('returns null when the leaf node is not in the thread lookup', () => {
    expect(resolveLeafNodeFocusThreadRootId({
      leafNodeId: 'missing-leaf',
      focusedThreadRootLookup: new Map(),
    })).toBeNull();
  });
});

describe('resolveThreadDeletePlan', () => {
  it('deletes the thread session directly when the thread has no messages', () => {
    expect(resolveThreadDeletePlan({
      threadRootId: 'empty-thread',
      threadMessageIds: new Set(),
    })).toEqual({
      kind: 'thread-session',
      threadRootId: 'empty-thread',
    });
  });

  it('deletes message branches and the thread session when the thread has messages', () => {
    expect(resolveThreadDeletePlan({
      threadRootId: 'thread-a',
      threadMessageIds: new Set(['thread-a', 'assistant-a']),
    })).toEqual({
      kind: 'message-branch',
      threadRootId: 'thread-a',
      messageIds: ['thread-a', 'assistant-a'],
    });
  });
});

describe('resolveBlockingEmptyThreadRootId', () => {
  it('returns the first active thread without messages', () => {
    expect(resolveBlockingEmptyThreadRootId({
      threadRootIds: ['thread-a', 'thread-empty', 'thread-b'],
      messageIdsByThreadRootId: new Map([
        ['thread-a', new Set(['message-a'])],
        ['thread-empty', new Set()],
        ['thread-b', new Set()],
      ]),
      doneThreadRootIds: new Set(['thread-b']),
    })).toBe('thread-empty');
  });

  it('ignores done empty threads', () => {
    expect(resolveBlockingEmptyThreadRootId({
      threadRootIds: ['thread-empty'],
      messageIdsByThreadRootId: new Map([
        ['thread-empty', new Set()],
      ]),
      doneThreadRootIds: new Set(['thread-empty']),
    })).toBeNull();
  });

  it('does not block on empty threads that have meaningful drafts', () => {
    expect(resolveBlockingEmptyThreadRootId({
      threadRootIds: ['thread-empty'],
      messageIdsByThreadRootId: new Map([
        ['thread-empty', new Set()],
      ]),
      doneThreadRootIds: new Set(),
      draftThreadRootIds: new Set(['thread-empty']),
    })).toBeNull();
  });
});

describe('getThreadDraftPreviewText', () => {
  it('ignores whitespace-only drafts', () => {
    expect(getThreadDraftPreviewText(' \n\t  ')).toBeNull();
  });

  it('trims meaningful draft previews without dropping internal newlines', () => {
    expect(getThreadDraftPreviewText(' \nFirst line\n\nsecond line\t ')).toBe('First line\n\nsecond line');
  });
});
