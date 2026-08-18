import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import {
  buildFullGraphViewportBoundsModel,
  clampGraphViewportToBounds,
  clampGraphViewportToFullGraphBoundsModel,
  GRAPH_VIEWPORT_NODE_BOUNDS_PADDING,
} from './graphViewportBounds';

const fullNodes: Node<any>[] = [
  {
    id: 'left',
    position: { x: 100, y: 200 },
    data: {},
    width: 150,
    height: 80,
  },
  {
    id: 'right',
    position: { x: 900, y: 1200 },
    data: {},
    style: { width: 220, height: 140 },
  },
];

describe('full graph viewport bounds model', () => {
  it('builds padded translate extent from the full graph', () => {
    expect(buildFullGraphViewportBoundsModel(fullNodes)?.translateExtent).toEqual([
      [100 - GRAPH_VIEWPORT_NODE_BOUNDS_PADDING, 200 - GRAPH_VIEWPORT_NODE_BOUNDS_PADDING],
      [1120 + GRAPH_VIEWPORT_NODE_BOUNDS_PADDING, 1340 + GRAPH_VIEWPORT_NODE_BOUNDS_PADDING],
    ]);
  });

  it('keeps active render windows from shrinking full graph bounds', () => {
    const fullModel = buildFullGraphViewportBoundsModel(fullNodes);
    const activeWindowModel = buildFullGraphViewportBoundsModel([fullNodes[0]]);

    expect(fullModel?.nodeBounds.maxX).toBe(1120);
    expect(activeWindowModel?.nodeBounds.maxX).toBe(250);
    expect(fullModel?.translateExtent).not.toEqual(activeWindowModel?.translateExtent);
  });

  it('clamps viewport against an existing full bounds model', () => {
    const model = buildFullGraphViewportBoundsModel(fullNodes);
    expect(model).not.toBeNull();

    expect(clampGraphViewportToBounds(
      { x: -6000, y: -6000, zoom: 1 },
      model!.nodeBounds,
      { width: 1000, height: 800 }
    )).toEqual({
      x: -940,
      y: -1260,
      zoom: 1,
    });
  });

  it('uses the same full graph model for translate extent and clamp bounds', () => {
    const fullModel = buildFullGraphViewportBoundsModel(fullNodes);
    const activeWindowModel = buildFullGraphViewportBoundsModel([fullNodes[0]]);
    expect(fullModel).not.toBeNull();
    expect(activeWindowModel).not.toBeNull();

    expect(fullModel!.translateExtent).toEqual([
      [100 - GRAPH_VIEWPORT_NODE_BOUNDS_PADDING, 200 - GRAPH_VIEWPORT_NODE_BOUNDS_PADDING],
      [1120 + GRAPH_VIEWPORT_NODE_BOUNDS_PADDING, 1340 + GRAPH_VIEWPORT_NODE_BOUNDS_PADDING],
    ]);

    const farViewport = { x: -6000, y: -6000, zoom: 1 };
    const flowSize = { width: 1000, height: 800 };

    expect(clampGraphViewportToFullGraphBoundsModel(farViewport, fullModel, flowSize)).toEqual({
      x: -940,
      y: -1260,
      zoom: 1,
    });
    expect(clampGraphViewportToFullGraphBoundsModel(farViewport, activeWindowModel, flowSize)).toEqual({
      x: -70,
      y: -200,
      zoom: 1,
    });
    expect(clampGraphViewportToFullGraphBoundsModel(farViewport, fullModel, flowSize)).not.toEqual(
      clampGraphViewportToFullGraphBoundsModel(farViewport, activeWindowModel, flowSize)
    );
  });
});
