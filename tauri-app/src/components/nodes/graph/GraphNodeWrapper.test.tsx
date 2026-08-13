// @vitest-environment jsdom
import '../../../test/setup';
import React from 'react';
import { render, screen } from '@testing-library/react';
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
  HoverCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HoverCardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../agent-runs/agentRunManager', () => ({
  agentRunManager: {
    watch: vi.fn(),
    unwatch: vi.fn(),
  },
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
});
