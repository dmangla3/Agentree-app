import { describe, expect, it } from 'vitest';
import {
  getEdgeEndpointDotVariant,
  getEdgeEndpointDotVisuals,
  getGraphEdgeEndpointDotVariant,
  isInterTurnEndpointEdge,
} from './graphEdgeEndpointDots';

describe('graph edge endpoint dots', () => {
  it('uses prominent colored visuals for commit-parent endpoint dots', () => {
    expect(getEdgeEndpointDotVisuals('commit-parent')).toMatchObject({
      color: '#10b981',
      sourceRadius: 6,
      targetRadius: 7,
    });
  });

  it('uses prominent colored visuals for convergence endpoint dots', () => {
    expect(getEdgeEndpointDotVisuals('convergence')).toMatchObject({
      color: '#6366f1',
      sourceRadius: 6,
      targetRadius: 7,
    });
  });

  it('shows commit-parent dots only for inter-turn commit-parent edges', () => {
    expect(getGraphEdgeEndpointDotVariant({
      edgeLegendType: 'git-parent',
      matchedContextPathPreview: false,
      isInterTurnEdge: true,
    })).toBe('commit-parent');

    expect(getGraphEdgeEndpointDotVariant({
      edgeLegendType: 'git-parent',
      matchedContextPathPreview: false,
      isInterTurnEdge: false,
    })).toBeNull();
  });

  it('shows convergence dots only for inter-turn context path previews', () => {
    expect(getGraphEdgeEndpointDotVariant({
      edgeLegendType: 'conversation',
      matchedContextPathPreview: true,
      isInterTurnEdge: true,
    })).toBe('convergence');

    expect(getGraphEdgeEndpointDotVariant({
      edgeLegendType: 'conversation',
      matchedContextPathPreview: true,
      isInterTurnEdge: false,
    })).toBeNull();
  });

  it('suppresses obvious intra-turn user-to-assistant connections', () => {
    expect(isInterTurnEndpointEdge(
      {
        type: 'conversation',
        data: { entity: { turnGroupId: 'turn-1' } },
      },
      {
        type: 'assistant_message',
        data: { entity: { turnGroupId: 'turn-1' } },
      }
    )).toBe(false);
  });

  it('recognizes requested endpoint dot variants on rendered edges', () => {
    expect(getEdgeEndpointDotVariant({ endpointDotVariant: 'commit-parent' })).toBe('commit-parent');
    expect(getEdgeEndpointDotVariant({ endpointDotVariant: 'convergence' })).toBe('convergence');
    expect(getEdgeEndpointDotVariant({ endpointDotVariant: 'base-used' })).toBeNull();
  });
});
