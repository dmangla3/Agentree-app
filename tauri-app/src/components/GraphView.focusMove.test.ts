import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import {
  clampGraphZoom,
  GRAPH_MIN_ZOOM,
  resolveFocusedThreadRootId,
  resolveBlockingEmptyThreadRootId,
  resolveThreadDeletePlan,
  resolveThreadScopedDefaultFocus,
  resolveThreadDropdownSelection,
  resolveReactFlowNodeClickFocusMessageId,
  resolveReactFlowNodeClickFocusTarget,
  shouldDispatchGraphFocusSynchronously,
  shouldClampViewportDuringMove,
  shouldRestoreViewportAfterGraphNodeCountChange,
  shouldSkipActiveGraphClickCentering,
  shouldTreatGraphMoveAsViewportInteraction,
} from './GraphView';
import {
  buildGraphTranslateExtent,
  clampGraphViewportToNodeBounds,
  GRAPH_VIEWPORT_NODE_BOUNDS_PADDING,
} from '../lib/graphViewportBounds';

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

describe('buildGraphTranslateExtent', () => {
  it('uses padded laid-out graph bounds for viewport panning', () => {
    expect(buildGraphTranslateExtent([
      {
        id: 'a',
        position: { x: 100, y: 200 },
        data: {},
        width: 150,
        height: 80,
      },
      {
        id: 'b',
        position: { x: 500, y: 700 },
        data: {},
        style: { width: 240, height: 160 },
      },
    ])).toEqual([
      [100 - GRAPH_VIEWPORT_NODE_BOUNDS_PADDING, 200 - GRAPH_VIEWPORT_NODE_BOUNDS_PADDING],
      [740 + GRAPH_VIEWPORT_NODE_BOUNDS_PADDING, 860 + GRAPH_VIEWPORT_NODE_BOUNDS_PADDING],
    ]);
  });

  it('does not constrain an empty graph', () => {
    expect(buildGraphTranslateExtent([])).toBeUndefined();
  });
});

describe('clampGraphViewportToNodeBounds', () => {
  const nodes = [
    {
      id: 'a',
      position: { x: 100, y: 200 },
      data: {},
      width: 150,
      height: 80,
    },
    {
      id: 'b',
      position: { x: 500, y: 700 },
      data: {},
      width: 240,
      height: 160,
    },
  ];

  it('keeps the viewport center inside the padded graph node bounds', () => {
    expect(clampGraphViewportToNodeBounds(
      { x: -3000, y: -4000, zoom: 1 },
      nodes,
      { width: 1000, height: 800 }
    )).toEqual({
      x: -560,
      y: -780,
      zoom: 1,
    });
  });

  it('leaves in-bounds viewport positions unchanged', () => {
    expect(clampGraphViewportToNodeBounds(
      { x: 150, y: 0, zoom: 1 },
      nodes,
      { width: 1000, height: 800 }
    )).toEqual({ x: 150, y: 0, zoom: 1 });
  });
});

describe('GraphView canvas running status', () => {
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

  it('does not render a graph-canvas running count shortcut to timeline view', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

    expect(source).not.toContain('<span>{runningCount} Running</span>');
  });

  it('stores and restores viewport by active thread root id', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

    expect(source).toContain('viewportByThreadRootIdRef');
    expect(source).toContain('saveViewportForActiveThread');
    expect(source).toContain('restoreViewportForActiveThread');
    expect(source).toContain('threadGraphScope.activeThreadRootId');
  });

  it('does not restore saved thread viewport from active-window node count churn', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

    expect(source).toContain('shouldRestoreViewportAfterGraphNodeCountChange({');
    expect(source).toContain('activeGraphRenderHold,');
    expect(source).toContain('graphRenderMode: graphRenderElements.mode');
    expect(source).toContain('isViewportInteracting: isViewportInteractingRef.current');
  });

  it('does not set a clamped viewport from React Flow onMove while active drag is in progress', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

    expect(source).toContain('shouldClampViewportDuringMove({');
    expect(source).toContain('isViewportInteracting: isViewportInteractingRef.current');
    expect(source).toContain('onMoveEnd={(_event, viewport) => {');
    expect(source).toContain('const clampedViewport = clampViewportToGraphBounds(viewport);');
  });

  it('uses explicit full graph viewport bounds instead of active render elements for panning limits', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

    expect(source).toContain('fullGraphViewportBoundsRef');
    expect(source).toContain('buildFullGraphViewportBoundsModel(branchNodesForRender)');
    expect(source).toContain('fullGraphViewportBoundsRef.current = fullGraphViewportBounds;');
    expect(source).toContain('graphTranslateExtent = fullGraphViewportBounds?.translateExtent');
    expect(source).toContain('clampGraphViewportToFullGraphBoundsModel(viewport, fullGraphViewportBoundsRef.current');
    expect(source).not.toContain('buildGraphTranslateExtent(branchNodesForRender)');
    expect(source).not.toContain(`useLayoutEffect(() => {
        fullGraphViewportBoundsRef.current = fullGraphViewportBounds;
    }, [fullGraphViewportBounds]);`);
  });

  it('records thread switch performance boundaries', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

    expect(source).toContain("recordPerfEvent('graph.thread-switch.start'");
    expect(source).toContain("recordPerfEvent('graph.thread-switch.rendered'");
    expect(source).toContain('threadSwitchStartedAtRef');
    expect(source).toContain('renderedNodeCount');
  });

  it('passes full graph translate extent to React Flow', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

    expect(source).toContain('translateExtent={graphTranslateExtent}');
  });

  it('mounts the execution timeline as a workspace header popover instead of a graph dock', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

    expect(source).toContain('executionTimelineOpen');
    expect(source).toContain('handleExecutionTimelineOpenChange');
    expect(source).toContain('onExecutionTimelineOpenChange={handleExecutionTimelineOpenChange}');
    expect(source).toContain('renderExecutionTimelinePanel=');
    expect(source).not.toContain('timelinePreviewAtMs');
    expect(source).not.toContain('applyTimelineReplayToGraph');
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
});

describe('resolveFocusedThreadRootId', () => {
  it('resolves the thread that contains the focused message', () => {
    const messages = [
      makeMessage('thread-a', 'user', null, '2026-05-19T00:00:00.000Z'),
      makeMessage('assistant-a', 'assistant', 'thread-a', '2026-05-19T00:01:00.000Z'),
      makeMessage('thread-b', 'user', null, '2026-05-19T00:02:00.000Z'),
    ];

    expect(resolveFocusedThreadRootId({
      focusedMessageId: 'assistant-a',
      messages,
    })).toBe('thread-a');
  });

  it('resolves synthetic commit focus ids and output commit shas to the owning thread', () => {
    const messages = [
      makeMessage('thread-a', 'user', null, '2026-05-19T00:00:00.000Z'),
      makeMessage('assistant-a', 'assistant', 'thread-a', '2026-05-19T00:01:00.000Z', 'abc123456789'),
      makeMessage('thread-b', 'user', null, '2026-05-19T00:02:00.000Z'),
    ];

    expect(resolveFocusedThreadRootId({
      focusedMessageId: 'assistant-a:commit',
      messages,
    })).toBe('thread-a');
    expect(resolveFocusedThreadRootId({
      focusedMessageId: 'abc123456789',
      messages,
    })).toBe('thread-a');
  });
});
