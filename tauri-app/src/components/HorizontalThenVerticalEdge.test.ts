import { describe, expect, it } from 'vitest';
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
});
