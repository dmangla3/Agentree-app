// @vitest-environment jsdom
import '../../../test/setup';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphOrchestrationNode } from './GraphOrchestrationNode';

vi.mock('@xyflow/react', () => ({
  Handle: ({ id }: { id: string }) => <div data-testid={`handle-${id}`} />,
  Position: {
    Top: 'top',
    Left: 'left',
    Right: 'right',
    Bottom: 'bottom',
  },
}));

vi.mock('../../../../@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <div data-testid="mini-dot-hover-card">{children}</div>,
}));

vi.mock('../../NodeHoverCardContent', () => ({
  NodeHoverCardContent: ({ entity }: { entity?: { messageId?: string | null } }) => (
    <div>hover entity: {entity?.messageId}</div>
  ),
}));

describe('GraphOrchestrationNode', () => {
  it('renders child turn dots, status counts, and graph edge handles', () => {
    const onToggleCollapse = vi.fn();

    render(
      <GraphOrchestrationNode
        data={{
          controllerMessageId: 'assistant-orchestrator',
          label: 'Orchestration',
          activeChildRuns: 1,
          completedChildRuns: 1,
          failedChildRuns: 1,
          miniChildren: [
            { id: 'child-1', label: 'Plan result.', status: 'running' },
            { id: 'child-2', label: 'Review result.', status: 'completed' },
            { id: 'child-3', label: 'Fix failed.', status: 'failed_runtime' },
          ],
          miniEdges: [
            { sourceId: 'child-1', targetId: 'child-2' },
            { sourceId: 'child-2', targetId: 'child-3' },
          ],
          onToggleCollapse,
        }}
      />
    );

    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.getByTitle('Plan result. (running)')).toBeTruthy();
    expect(screen.getByTitle('Review result. (completed)')).toBeTruthy();
    expect(screen.getByTitle('Fix failed. (failed_runtime)')).toBeTruthy();
    expect(screen.getByTestId('handle-top-target')).toBeTruthy();
    expect(screen.getByTestId('handle-bottom-source')).toBeTruthy();
    expect(screen.getByTestId('handle-left-target')).toBeTruthy();
    expect(screen.getByTestId('handle-right-target')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Expand orchestration container'));

    expect(onToggleCollapse).toHaveBeenCalledWith('assistant-orchestrator', false);
  });

  it('uses the node hover card for mini child dots with projected assistant entities', () => {
    render(
      <GraphOrchestrationNode
        data={{
          controllerMessageId: 'assistant-orchestrator',
          label: 'Orchestration',
          miniChildren: [
            {
              id: 'assistant_message:child-1',
              label: 'Cancelled child.',
              status: 'cancelled',
              entity: {
                entityId: 'assistant_message:child-1',
                kind: 'assistant_message',
                messageId: 'child-1',
                focusMessageId: 'child-1',
                sortTs: 0,
                preview: 'Cancelled child.',
                shortLabel: 'Child',
                status: 'cancelled',
              } as any,
            },
          ],
          projection: {} as any,
        }}
      />
    );

    expect(screen.getByLabelText('Cancelled child. (cancelled)')).toBeTruthy();
    expect(screen.getByTestId('mini-dot-hover-card')).toBeTruthy();
    expect(screen.getByText('hover entity: child-1')).toBeTruthy();
  });
});
