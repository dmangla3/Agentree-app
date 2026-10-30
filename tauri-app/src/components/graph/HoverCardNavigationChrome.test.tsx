// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getAdjacentHoverNavigationIndex,
  HoverCardNavigationChrome,
} from './HoverCardNavigationChrome';

describe('HoverCardNavigationChrome', () => {
  it('clamps shared previous and next index steps', () => {
    expect(getAdjacentHoverNavigationIndex(1, 4, -1)).toBe(0);
    expect(getAdjacentHoverNavigationIndex(1, 4, 1)).toBe(2);
    expect(getAdjacentHoverNavigationIndex(0, 4, -1)).toBe(0);
    expect(getAdjacentHoverNavigationIndex(3, 4, 1)).toBe(3);
    expect(getAdjacentHoverNavigationIndex(3, 0, -1)).toBe(0);
  });

  it('renders the shared counter, controls, accessory, and next attention state', () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { container } = render(
      <HoverCardNavigationChrome
        position={2}
        itemCount={4}
        canGoPrevious
        canGoNext
        onPrevious={onPrevious}
        onNext={onNext}
        previousLabel="Show older agent message"
        nextLabel="Show newer agent message"
        accessory={<button type="button">View new reply</button>}
        announcement="New reply ready"
        nextAttention
      />,
    );

    expect(container.querySelector('[data-agentree-hover-navigation-chrome="true"]')).toBeTruthy();
    expect(screen.getByText('2 / 4')).toBeTruthy();
    expect(screen.getByText('New reply ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show newer agent message' }).getAttribute('data-navigation-attention')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Show older agent message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show newer agent message' }));
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });
});
