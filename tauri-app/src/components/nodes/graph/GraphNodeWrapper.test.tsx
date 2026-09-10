// @vitest-environment jsdom
import '../../../test/setup';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { useRunStatusStore } from '../../../stores/runStatusStore';

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
    openDelay,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
    openDelay?: number;
  }) => (
    <div data-open-delay={openDelay}>
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
    snapshot: vi.fn(() => null),
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
  beforeEach(async () => {
    const { ensureAgentRunHydrated } = await import('../../../agent-runs/agentRunHydration');
    vi.mocked(ensureAgentRunHydrated).mockClear();
  });

  afterEach(() => {
    useRunStatusStore.getState().clearAllRunStatus();
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

  it('uses a 300ms graph hover delay and does not open directly on pointer enter', () => {
    render(
      <GraphNodeWrapper {...baseProps} hoverCardContent={<div>expensive hover content</div>}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    const hoverRoot = screen.getByText('open hover').parentElement;
    expect(hoverRoot?.getAttribute('data-open-delay')).toBe('300');

    fireEvent.pointerEnter(screen.getByText('node body'));

    expect(screen.queryByText('expensive hover content')).toBeNull();
  });

  it('requests shared run hydration when a hover card opens', async () => {
    const { ensureAgentRunHydrated } = await import('../../../agent-runs/agentRunHydration');

    render(
      <GraphNodeWrapper {...baseProps} hoverHydrationEnabled hoverCardContent={<div>expensive hover content</div>}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    fireEvent.click(screen.getByText('open hover'));

    expect(screen.getByText('expensive hover content')).toBeTruthy();
    expect(ensureAgentRunHydrated).toHaveBeenCalledWith('node-1', 'hover');
  });

  it('does not poll hover hydration after the initial hover catch-up', async () => {
    vi.useFakeTimers();
    const { ensureAgentRunHydrated } = await import('../../../agent-runs/agentRunHydration');
    useRunStatusStore.getState().setRunStatus('node-1', {
      workspaceId: 'workspace-1',
      role: 'assistant',
      status: 'running',
      progress: 'Running...',
    });

    render(
      <GraphNodeWrapper {...baseProps} hoverHydrationEnabled hoverCardContent={<div>expensive hover content</div>}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    fireEvent.click(screen.getByText('open hover'));
    await act(async () => {});

    expect(ensureAgentRunHydrated).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(async () => {});

    expect(ensureAgentRunHydrated).toHaveBeenCalledTimes(1);
  });

  it('does not request shared run hydration when hover hydration is disabled', async () => {
    const { ensureAgentRunHydrated } = await import('../../../agent-runs/agentRunHydration');

    render(
      <GraphNodeWrapper {...baseProps} hoverHydrationEnabled={false} hoverCardContent={<div>expensive hover content</div>}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    fireEvent.click(screen.getByText('open hover'));

    expect(screen.getByText('expensive hover content')).toBeTruthy();
    expect(ensureAgentRunHydrated).not.toHaveBeenCalled();
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

  it('closes when the pointer leaves hover content without retained focus', () => {
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
    fireEvent.click(screen.getByText('close hover'));

    expect(screen.getByText('hover action')).toBeTruthy();

    fireEvent.pointerLeave(content);

    expect(screen.queryByText('hover action')).toBeNull();
  });

  it('closes an open hover card when the document is hidden', () => {
    render(
      <GraphNodeWrapper {...baseProps} hoverCardContent={<div>hover details</div>}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    fireEvent.click(screen.getByText('open hover'));
    expect(screen.getByText('hover details')).toBeTruthy();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    expect(document.visibilityState).toBe('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(screen.queryByText('hover details')).toBeNull();
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

  it('can skip transient focus feedback for redirected proxy nodes', () => {
    render(
      <GraphNodeWrapper {...baseProps} focusFeedbackEnabled={false}>
        <div>node body</div>
      </GraphNodeWrapper>
    );

    const node = screen.getByText('node body').closest('[data-agentree-graph-node-id]');
    expect(node).toBeTruthy();

    fireEvent.pointerDown(node!, { button: 0 });

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
