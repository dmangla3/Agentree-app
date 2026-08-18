import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MINIMAP_EDGE_RENDER_LIMIT, buildMinimapModelFromGraphNodes } from './MiniMapPanel';

describe('buildMinimapModelFromGraphNodes', () => {
    it('builds minimap shapes from the full graph node list instead of the mounted React Flow window', () => {
        const mountedWindowNodes = [
            {
                id: 'visible-a',
                type: 'llm',
                position: { x: 0, y: 0 },
                width: 120,
                height: 80,
                data: { entity: { threadRootId: 'thread-a' } },
            },
        ] as Node<any>[];
        const fullGraphNodes = [
            ...mountedWindowNodes,
            {
                id: 'offscreen-b',
                type: 'llm',
                position: { x: 2400, y: 320 },
                width: 120,
                height: 80,
                data: { entity: { threadRootId: 'thread-b' } },
            },
        ] as Node<any>[];

        const model = buildMinimapModelFromGraphNodes({
            graphNodes: fullGraphNodes,
            mountedNodes: mountedWindowNodes,
            threadRootIdByMessageId: new Map(),
        });

        expect(model.shapes.map((shape) => shape.id)).toEqual(['visible-a', 'offscreen-b']);
        expect(model.dividerRects.map((rect) => rect.id)).toEqual(['visible-a', 'offscreen-b']);
    });

    it('uses absolute positions for parented full graph nodes', () => {
        const model = buildMinimapModelFromGraphNodes({
            graphNodes: [
                {
                    id: 'group',
                    type: 'turn_group_hull',
                    position: { x: 1000, y: 500 },
                    width: 400,
                    height: 300,
                    data: { entity: { threadRootId: 'thread-a' } },
                },
                {
                    id: 'child',
                    type: 'llm',
                    parentId: 'group',
                    position: { x: 40, y: 60 },
                    width: 120,
                    height: 80,
                    data: { entity: { threadRootId: 'thread-a' } },
                },
            ] as Node<any>[],
            threadRootIdByMessageId: new Map(),
        });

        expect(model.shapes.find((shape) => shape.id === 'child')).toMatchObject({
            x: 1040,
            y: 560,
        });
    });

    it('builds minimap edge lines from full graph edges when both endpoints have minimap shapes', () => {
        const model = buildMinimapModelFromGraphNodes({
            graphNodes: [
                {
                    id: 'source',
                    type: 'llm',
                    position: { x: 100, y: 200 },
                    width: 120,
                    height: 80,
                    data: {},
                },
                {
                    id: 'target',
                    type: 'llm',
                    position: { x: 400, y: 520 },
                    width: 160,
                    height: 120,
                    data: {},
                },
            ] as Node<any>[],
            graphEdges: [
                {
                    id: 'source-target',
                    source: 'source',
                    target: 'target',
                    data: { relationship: 'conversation', edgeLegendType: 'conversation' },
                },
            ] as Edge<any>[],
            threadRootIdByMessageId: new Map(),
        });

        expect(model.edges).toEqual([
            expect.objectContaining({
                id: 'source-target',
                sourceX: 160,
                sourceY: 240,
                targetX: 480,
                targetY: 580,
                strokeColor: '#64748b',
            }),
        ]);
    });

    it('skips minimap edge lines whose endpoints are not rendered in the minimap', () => {
        const model = buildMinimapModelFromGraphNodes({
            graphNodes: [
                {
                    id: 'visible',
                    type: 'llm',
                    position: { x: 0, y: 0 },
                    width: 120,
                    height: 80,
                    data: {},
                },
                {
                    id: 'hidden-summary',
                    type: 'summary_block',
                    position: { x: 200, y: 0 },
                    width: 120,
                    height: 80,
                    data: {},
                },
            ] as Node<any>[],
            graphEdges: [
                {
                    id: 'visible-summary',
                    source: 'visible',
                    target: 'hidden-summary',
                    data: { relationship: 'conversation', edgeLegendType: 'conversation' },
                },
            ] as Edge<any>[],
            threadRootIdByMessageId: new Map(),
        });

        expect(model.edges).toEqual([]);
    });

    it('caps minimap edge lines while keeping context path edges first', () => {
        const graphNodes = Array.from({ length: MINIMAP_EDGE_RENDER_LIMIT + 2 }, (_, index) => ({
            id: `node-${index}`,
            type: 'llm',
            position: { x: index * 160, y: 0 },
            width: 120,
            height: 80,
            data: {},
        })) as Node<any>[];
        const graphEdges = Array.from({ length: MINIMAP_EDGE_RENDER_LIMIT + 1 }, (_, index) => ({
            id: `edge-${index}`,
            source: `node-${index}`,
            target: `node-${index + 1}`,
            data: {
                relationship: 'conversation',
                edgeLegendType: 'conversation',
                isOnContextPath: index === MINIMAP_EDGE_RENDER_LIMIT,
            },
        })) as Edge<any>[];

        const model = buildMinimapModelFromGraphNodes({
            graphNodes,
            graphEdges,
            threadRootIdByMessageId: new Map(),
        });

        expect(model.edges).toHaveLength(MINIMAP_EDGE_RENDER_LIMIT);
        expect(model.edges[0]?.id).toBe(`edge-${MINIMAP_EDGE_RENDER_LIMIT}`);
        expect(model.edges.some((edge) => edge.id === `edge-${MINIMAP_EDGE_RENDER_LIMIT - 1}`)).toBe(false);
    });

    it('clamps minimap navigation targets to graph node bounds', () => {
        const source = readFileSync(join(process.cwd(), 'src/components/graph/MiniMapPanel.tsx'), 'utf8');

        expect(source).toContain('clampPointToGraphBounds(point, graphNodeBounds)');
        expect(source).toContain('setCenter(clampedPoint.x, clampedPoint.y');
    });
});
