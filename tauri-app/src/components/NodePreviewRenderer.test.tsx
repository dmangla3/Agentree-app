// @vitest-environment jsdom
import '../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { NodePreviewRenderer } from './NodePreviewRenderer';

vi.mock('./nodes/chat/ChatNodeDispatcher', () => ({
  ChatNodeDispatcher: ({ layout }: { layout?: string }) => (
    <div data-testid="preview-dispatcher" data-layout={layout} />
  ),
}));

describe('NodePreviewRenderer', () => {
  it('renders message cards in hovercard layout', () => {
    render(
      <NodePreviewRenderer
        entity={{ entityId: 'message:1' } as ProjectedNodeEntity}
        projection={{} as WorkspaceProjection}
      />,
    );

    expect(screen.getByTestId('preview-dispatcher').getAttribute('data-layout')).toBe('hovercard');
  });
});
