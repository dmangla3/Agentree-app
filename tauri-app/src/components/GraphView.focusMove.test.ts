import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message } from '../stores/workspaceStore';
import {
  clampGraphZoom,
  GRAPH_MIN_ZOOM,
  resolveFocusedThreadRootId,
  resolveThreadDropdownSelection,
  shouldDispatchGraphFocusSynchronously,
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
