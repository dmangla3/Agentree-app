import { describe, expect, it } from 'vitest';
import {
  createComposerSendStartGate,
  finishComposerSendStart,
  shouldShowComposerCancel,
  tryBeginComposerSendStart,
} from './composerCancelState';

describe('shouldShowComposerCancel', () => {
  it('shows cancel immediately for an accepted local composer send', () => {
    expect(shouldShowComposerCancel({
      activeComposerSend: {
        flowId: 'flow-1',
        nodeIds: ['user-1', 'assistant-1'],
        preferredNodeId: 'assistant-1',
        workspaceId: 'workspace-1',
      },
      isNewThreadTarget: false,
      isSelectedNodeRunning: false,
    })).toBe(true);
  });

  it('keeps existing selected-running cancel behavior', () => {
    expect(shouldShowComposerCancel({
      activeComposerSend: null,
      isNewThreadTarget: false,
      isSelectedNodeRunning: true,
    })).toBe(true);
  });

  it('does not show cancel for new thread target controls', () => {
    expect(shouldShowComposerCancel({
      activeComposerSend: {
        flowId: 'flow-1',
        nodeIds: ['assistant-1'],
        preferredNodeId: 'assistant-1',
        workspaceId: 'workspace-1',
      },
      isNewThreadTarget: true,
      isSelectedNodeRunning: true,
    })).toBe(false);
  });
});

describe('composer send start gate', () => {
  it('blocks a duplicate send while the pre-optimistic cancel affordance is being armed', () => {
    const gate = createComposerSendStartGate();

    expect(tryBeginComposerSendStart(gate)).toBe(true);
    expect(tryBeginComposerSendStart(gate)).toBe(false);

    finishComposerSendStart(gate);
    expect(tryBeginComposerSendStart(gate)).toBe(true);
  });
});
