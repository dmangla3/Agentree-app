import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { getContextResetCutPosition } from './ContextResetCut';
import { getVerticalThenHorizontalEdgePath } from './HorizontalThenVerticalEdge';

describe('getVerticalThenHorizontalEdgePath', () => {
  it('routes offset edges as vertical-horizontal side-entry segments', () => {
    const { path } = getVerticalThenHorizontalEdgePath({
      sourceX: 100,
      sourceY: 200,
      targetX: 260,
      targetY: 420,
    });

    expect(path).toBe('M 100 200 L 100 420 L 260 420');
  });

  it('collapses to a vertical line when source and target are aligned', () => {
    const { path } = getVerticalThenHorizontalEdgePath({
      sourceX: 140,
      sourceY: 200,
      targetX: 140,
      targetY: 420,
    });

    expect(path).toBe('M 140 200 L 140 420');
  });

  it('positions top-entry context reset cuts on the child top boundary', () => {
    expect(getContextResetCutPosition({
      targetX: 260,
      targetY: 420,
      anchor: { x: 180, y: 360 },
      targetPosition: Position.Top,
    })).toEqual({
      x: 180,
      y: 360,
      orientation: 'horizontal',
    });
  });

  it('positions side-entry context reset cuts on the side boundary', () => {
    expect(getContextResetCutPosition({
      targetX: 260,
      targetY: 420,
      anchor: { x: 180, y: 360 },
      targetPosition: Position.Left,
    })).toEqual({
      x: 260,
      y: 420,
      orientation: 'vertical',
    });
  });

  it('falls back to the edge target when no context anchor is available', () => {
    expect(getContextResetCutPosition({ targetX: 260, targetY: 420 })).toEqual({
      x: 260,
      y: 420,
      orientation: 'horizontal',
    });
  });
});
