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

  it('uses muted colored visuals for conversation endpoint dots', () => {
    expect(getEdgeEndpointDotVisuals('conversation')).toMatchObject({
      color: '#64748b',
      sourceRadius: 5,
      targetRadius: 6,
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

  it('shows conversation dots for visible inter-turn conversation edges by default', () => {
    expect(getGraphEdgeEndpointDotVariant({
      edgeLegendType: 'conversation',
      matchedContextPathPreview: false,
      isInterTurnEdge: true,
    })).toBe('conversation');

    expect(getGraphEdgeEndpointDotVariant({
      edgeLegendType: 'context-break',
      matchedContextPathPreview: false,
      isInterTurnEdge: true,
    })).toBe('conversation');

    expect(getGraphEdgeEndpointDotVariant({
      edgeLegendType: 'conversation',
      matchedContextPathPreview: false,
      isInterTurnEdge: false,
    })).toBeNull();
  });

  it('keeps context path preview convergence dots above default conversation dots', () => {
    expect(getGraphEdgeEndpointDotVariant({
      edgeLegendType: 'conversation',
      matchedContextPathPreview: true,
      isInterTurnEdge: true,
    })).toBe('convergence');
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
    expect(getEdgeEndpointDotVariant({ endpointDotVariant: 'conversation' })).toBe('conversation');
    expect(getEdgeEndpointDotVariant({ endpointDotVariant: 'base-used' })).toBeNull();
  });
});
