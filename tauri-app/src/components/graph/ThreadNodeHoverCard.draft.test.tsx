// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import type { HTMLAttributes, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ThreadNodeHoverCard, type ThreadNavigationItem } from './GraphControls';

vi.mock('../../../@/components/ui/hover-card', () => ({
  HoverCard: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange?.(true)}>open hover</button>
      {children}
    </div>
  ),
  HoverCardContent: ({
    children,
    align: _align,
    collisionPadding: _collisionPadding,
    side: _side,
    sideOffset: _sideOffset,
    ...props
  }: HTMLAttributes<HTMLDivElement> & {
    align?: string;
    collisionPadding?: number;
    side?: string;
    sideOffset?: number;
  }) => <div data-testid="thread-hover-content" {...props}>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const makeThread = (overrides: Partial<ThreadNavigationItem> = {}): ThreadNavigationItem => ({
  threadRootId: 'thread-draft',
  label: 'New thread',
  turnCount: 0,
  commitCount: 0,
  updatedLabel: 'just now',
  runningCount: 0,
  hidden: false,
  done: false,
  current: false,
  draftPreviewText: 'Draft user message',
  ...overrides,
});

describe('ThreadNodeHoverCard draft preview', () => {
  it('shows a draft-only user message preview for non-current threads', () => {
    render(
      <ThreadNodeHoverCard thread={makeThread()} side="right">
        <button type="button">Thread row</button>
      </ThreadNodeHoverCard>
    );

    fireEvent.click(screen.getByText('open hover'));

    expect(screen.getByTestId('thread-hover-content').textContent).toContain('Draft');
    expect(screen.getByText('Draft user message')).toBeTruthy();
  });

  it('does not render hover content for whitespace-only draft previews', () => {
    render(
      <ThreadNodeHoverCard thread={makeThread({ draftPreviewText: ' \n\t ' })} side="right">
        <button type="button">Thread row</button>
      </ThreadNodeHoverCard>
    );

    expect(screen.queryByText('open hover')).toBeNull();
  });
});
