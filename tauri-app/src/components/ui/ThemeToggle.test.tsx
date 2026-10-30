// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    window.localStorage.setItem('theme', 'light');
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('uses the shared filled-icon hover treatment without changing its compact control', () => {
    const { container } = render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Toggle theme' });

    expect(button.className).toContain('app-fill-icon-trigger');
    expect(button.className).toContain('size-9');
    expect(button.className).toContain('motion-reduce:transition-none');
    expect(button.getAttribute('title')).toBe('Switch to dark mode');

    expect(container.querySelectorAll('.app-fill-icon')).toHaveLength(2);
    expect(container.querySelectorAll('.app-fill-icon-outline')).toHaveLength(2);
    expect(container.querySelectorAll('.app-fill-icon-filled')).toHaveLength(2);

    for (const icon of container.querySelectorAll('.app-fill-icon')) {
      expect((icon as HTMLElement).style.height).toBe('18px');
      expect((icon as HTMLElement).style.width).toBe('18px');
      expect(icon.parentElement?.className).toContain('motion-reduce:transition-none');
      expect(icon.parentElement?.className).toContain('flex');
      expect(icon.parentElement?.className).toContain('items-center');
      expect(icon.parentElement?.className).toContain('justify-center');
    }
  });

  it('keeps the existing theme toggle behavior and tooltip', async () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Toggle theme' });

    fireEvent.click(button);

    await waitFor(() => {
      expect(button.getAttribute('title')).toBe('Switch to light mode');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(window.localStorage.getItem('theme')).toBe('dark');
    });
  });
});
