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

vi.mock('./GraphNodeHoverCardContent', () => ({
  GraphNodeHoverCardContent: ({ entity }: { entity?: { messageId?: string | null } }) => (
    <div>hover entity: {entity?.messageId}</div>
  ),
}));

describe('GraphOrchestrationNode', () => {
  it('renders child turn dots, status counts, and graph edge handles', () => {
    const onToggleCollapse = vi.fn();

    const { container } = render(
      <GraphOrchestrationNode
        data={{
          controllerMessageId: 'assistant-orchestrator',
          label: 'Orchestration',
          totalOrchestrationRuns: 3,
          activeOrchestrationRuns: 1,
          completedOrchestrationRuns: 1,
          failedOrchestrationRuns: 1,
          miniChildren: [
            { id: 'child-1', label: 'Plan result.', status: 'running' },
            { id: 'child-2', label: 'Review result.', status: 'completed' },
            { id: 'child-3', label: 'Fix failed.', status: 'failed_runtime' },
          ],
          miniAnchors: [{ id: 'root' }],
          miniEdges: [
            { sourceId: 'root', targetId: 'child-1' },
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
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByTitle('Plan result. (running)')).toBeTruthy();
    expect(screen.getByTitle('Review result. (completed)')).toBeTruthy();
    expect(screen.getByTitle('Fix failed. (failed_runtime)')).toBeTruthy();
    expect(container.querySelectorAll('.agentree-orchestration-edge')).toHaveLength(3);
    expect(screen.getByTestId('handle-top-target')).toBeTruthy();
    expect(screen.getByTestId('handle-bottom-source')).toBeTruthy();
    expect(screen.getByTestId('handle-left-target')).toBeTruthy();
    expect(screen.getByTestId('handle-right-target')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Expand orchestration container'));

    expect(onToggleCollapse).toHaveBeenCalledWith('assistant-orchestrator', false);
  });

  it('uses shared active and failure status groups for mini child dot colors', () => {
    render(
      <GraphOrchestrationNode
        data={{
          controllerMessageId: 'assistant-orchestrator',
          label: 'Orchestration',
          miniChildren: [
            { id: 'child-creating', label: 'Creating child.', status: 'creating' as any },
            { id: 'child-error', label: 'Errored child.', status: 'error' as any },
          ],
        }}
      />
    );

    expect(screen.getByTitle('Creating child. (creating)').className).toContain('bg-sky-500');
    expect(screen.getByTitle('Errored child. (error)').className).toContain('bg-red-500');
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
    fireEvent.pointerEnter(screen.getByLabelText('Cancelled child. (cancelled)'));

    expect(screen.getByTestId('mini-dot-hover-card')).toBeTruthy();
    expect(screen.getByText('hover entity: child-1')).toBeTruthy();
  });

  it('uses the orchestrator hover card for empty collapsed node area', () => {
    render(
      <GraphOrchestrationNode
        data={{
          controllerMessageId: 'assistant-orchestrator',
          label: 'Orchestration',
          controllerEntity: {
            entityId: 'assistant_message:assistant-orchestrator',
            kind: 'assistant_message',
            messageId: 'assistant-orchestrator',
            focusMessageId: 'assistant-orchestrator',
            sortTs: 0,
            preview: 'Orchestrator thinking with Mermaid.',
            shortLabel: 'Orchestrator',
            status: 'running',
          } as any,
          projection: {} as any,
        }}
      />
    );

    fireEvent.pointerEnter(screen.getByText('Orchestration').closest('[data-agentree-orchestration-node="true"]')!);

    expect(screen.getByText('hover entity: assistant-orchestrator')).toBeTruthy();
  });
});
