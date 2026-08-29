import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { buildMinimapModelFromGraphNodes } from './MiniMapPanel';

describe('buildMinimapModelFromGraphNodes', () => {
  it('renders nodes whose dimensions are stored on style', () => {
    const graphNodes: Node<any>[] = [
      {
        id: 'user-1',
        type: 'user_message',
        position: { x: 10, y: 20 },
        data: {
          entity: {
            kind: 'user_message',
            threadRootId: 'user-1',
          },
        },
        style: {
          width: 190,
          height: 78,
        },
      },
      {
        id: 'assistant-1',
        type: 'assistant_message',
        position: { x: 10, y: 112 },
        data: {
          entity: {
            kind: 'assistant_message',
            threadRootId: 'user-1',
          },
        },
        style: {
          width: '190px',
          height: '106px',
        },
      },
    ];

    const model = buildMinimapModelFromGraphNodes({ graphNodes });

    expect(model.shapes).toHaveLength(2);
    expect(model.shapes[0]).toMatchObject({
      id: 'user-1',
      width: 190,
      height: 78,
    });
    expect(model.shapes[1]).toMatchObject({
      id: 'assistant-1',
      width: 190,
      height: 106,
    });
  });
});
