import { describe, expect, it } from 'vitest';
import { getGraphEdgeVisualZIndex } from './useGraphLayout';

describe('getGraphEdgeVisualZIndex', () => {
  it('keeps non-focused commit lineage and base edges behind graph nodes', () => {
    expect(getGraphEdgeVisualZIndex({
      isOnContextPath: false,
      isSummaryEdge: false,
      relationship: 'git-parent',
      isSecondaryGitParent: false,
    })).toBeLessThanOrEqual(0);
    expect(getGraphEdgeVisualZIndex({
      isOnContextPath: false,
      isSummaryEdge: false,
      relationship: 'base-used',
      isSecondaryGitParent: false,
    })).toBeLessThanOrEqual(0);
  });

  it('raises focused context-path edges above the rest of the graph', () => {
    expect(getGraphEdgeVisualZIndex({
      isOnContextPath: true,
      isSummaryEdge: false,
      relationship: 'git-parent',
      isSecondaryGitParent: false,
    })).toBe(40);
  });
});
