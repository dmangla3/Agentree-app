import { describe, expect, it } from 'vitest';
import {
  clampGraphZoom,
  GRAPH_MIN_ZOOM,
  shouldDispatchGraphFocusSynchronously,
  shouldSkipActiveGraphClickCentering,
  shouldTreatGraphMoveAsViewportInteraction,
} from './GraphView';

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
