import { describe, expect, it } from 'vitest';
import { shouldTreatGraphMoveAsViewportInteraction } from './GraphView';

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
