// @vitest-environment jsdom
import '../../../test/setup';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphNodeWrapper } from './GraphNodeWrapper';

vi.mock('@xyflow/react', () => ({
  Handle: () => <div data-testid="handle" />,
  Position: {
    Top: 'top',
    Left: 'left',
    Right: 'right',
    Bottom: 'bottom',
  },
}));

vi.mock('../../../../@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange?.(true)}>open hover</button>
      <button type="button" onClick={() => onOpenChange?.(false)}>close hover</button>
      {children}
    </div>
  ),
  HoverCardContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) => (
    <div data-testid="hover-content" {...props}>{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../agent-runs/agentRunManager', () => ({
  agentRunManager: {
    watch: vi.fn(),
    unwatch: vi.fn(),
  },
}));

vi.mock('../../../agent-runs/agentRunHydration', () => ({
  ensureAgentRunHydrated: vi.fn(() => Promise.resolve({ status: 'hydrated' })),
}));

const baseProps = {
  nodeId: 'node-1',
  isFocused: false,
  isSelected: false,
  onFocus: vi.fn(),
  onSelect: vi.fn(),
  onContextMenu: vi.fn(),
};

describe('GraphNodeWrapper', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not register a viewport listener for nodes without hover content', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');

    render(
      <GraphNodeWrapper {...baseProps}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    expect(addEventListener).not.toHaveBeenCalledWith(
      'agentree:graph-viewport-interaction-start',
      expect.any(Function),
    );
  });

  it('does not render hover content until the hover card opens', () => {
    render(
      <GraphNodeWrapper {...baseProps} hoverCardContent={<div>expensive hover content</div>}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    expect(screen.getByText('node body')).toBeTruthy();
    expect(screen.queryByText('expensive hover content')).toBeNull();
  });

  it('requests shared run hydration when a hover card opens', async () => {
    const { ensureAgentRunHydrated } = await import('../../../agent-runs/agentRunHydration');

    render(
      <GraphNodeWrapper {...baseProps} hoverCardContent={<div>expensive hover content</div>}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    fireEvent.click(screen.getByText('open hover'));

    expect(screen.getByText('expensive hover content')).toBeTruthy();
    expect(ensureAgentRunHydrated).toHaveBeenCalledWith('node-1', 'hover');
  });

  it('does not close from focus churn while the pointer remains inside hover content', () => {
    render(
      <GraphNodeWrapper
        {...baseProps}
        hoverCardContent={<button type="button">hover action</button>}
      >
        <div>node body</div>
      </GraphNodeWrapper>
    );

    fireEvent.click(screen.getByText('open hover'));
    const content = screen.getByTestId('hover-content');
    fireEvent.pointerEnter(content);
    fireEvent.blur(screen.getByText('hover action'), { relatedTarget: document.body });
    fireEvent.click(screen.getByText('close hover'));

    expect(screen.getByText('hover action')).toBeTruthy();

    fireEvent.pointerLeave(content);
    fireEvent.click(screen.getByText('close hover'));

    expect(screen.queryByText('hover action')).toBeNull();
  });

  it('clears transient click focus feedback after the feedback window', () => {
    vi.useFakeTimers();

    render(
      <GraphNodeWrapper {...baseProps}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    const node = screen.getByText('node body').closest('[data-agentree-graph-node-id]');
    expect(node).toBeTruthy();

    fireEvent.pointerDown(node!, { button: 0 });
    expect(node!.className).toContain('ring-indigo-500');

    act(() => {
      vi.advanceTimersByTime(421);
    });

    expect(node!.className).not.toContain('ring-indigo-500');
  });

  it('clears transient click focus feedback when the wrapper is reused for another node', () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <GraphNodeWrapper {...baseProps} nodeId="node-1">
        <div>node body</div>
      </GraphNodeWrapper>
    );

    const node = screen.getByText('node body').closest('[data-agentree-graph-node-id]');
    expect(node).toBeTruthy();

    fireEvent.pointerDown(node!, { button: 0 });
    expect(node!.className).toContain('ring-indigo-500');

    rerender(
      <GraphNodeWrapper {...baseProps} nodeId="node-2">
        <div>node body</div>
      </GraphNodeWrapper>
    );

    expect(node!.className).not.toContain('ring-indigo-500');
  });
});
