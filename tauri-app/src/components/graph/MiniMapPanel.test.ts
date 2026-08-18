import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMinimapModelFromGraphNodes } from './MiniMapPanel';

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

    it('clamps minimap navigation targets to graph node bounds', () => {
        const source = readFileSync(join(process.cwd(), 'src/components/graph/MiniMapPanel.tsx'), 'utf8');

        expect(source).toContain('clampPointToGraphBounds(point, graphNodeBounds)');
        expect(source).toContain('setCenter(clampedPoint.x, clampedPoint.y');
    });
});
