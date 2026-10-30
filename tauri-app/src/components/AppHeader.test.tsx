// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader';

vi.mock('./ui/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('./updates/UpdateManager', () => ({ UpdateToolbarButton: () => null }));
vi.mock('./WorkspaceShareDialog', () => ({ WorkspaceShareDialog: () => null }));

const baseProps = {
  selectedWorkspaceId: null,
  selectedWorkspaceName: null,
  selectedWorkspaceCloudSyncEnabled: false,
  onOpenSearch: vi.fn(),
  onToggleTerminalDock: vi.fn(),
  terminalShortcutLabel: 'Cmd+J',
};

const originalPlatform = window.navigator.platform;

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  Object.defineProperty(window.navigator, 'platform', { configurable: true, value: originalPlatform });
});

describe('AppHeader terminal control', () => {
  it('exposes stable design-review parts without changing the header controls', () => {
    const { container } = render(
      <AppHeader
        {...baseProps}
        hasTerminalTabs={false}
        isTerminalDockVisible={false}
      />
    );

    expect(container.querySelector('[data-design-scope="navigation"][data-design-part="app-header"]')).not.toBeNull();
    expect(container.querySelector('[data-design-part="app-logo"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-design-part="header-action-group"]')).toHaveLength(3);
    expect(screen.getByTitle('Search workspaces, nodes, commits, and messages')).not.toBeNull();
  });

  it('reserves macOS traffic-light space and provides a drag region in the native overlay title bar', () => {
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });

    const { container } = render(
      <AppHeader
        {...baseProps}
        hasTerminalTabs={false}
        isTerminalDockVisible={false}
      />
    );
    const header = container.querySelector('[data-design-part="app-header"]');

    expect(header?.getAttribute('data-tauri-drag-region')).toBe('true');
    expect(header?.className).toContain('pl-[84px]');
  });

  it('does not show a terminal control when no tabs are alive', () => {
    render(
      <AppHeader
        {...baseProps}
        hasTerminalTabs={false}
        isTerminalDockVisible={false}
      />
    );

    expect(screen.queryByRole('button', { name: /terminal dock/i })).toBeNull();
  });

  it('shows a stateful terminal control while tabs are alive', () => {
    const onToggleTerminalDock = vi.fn();
    const { rerender } = render(
      <AppHeader
        {...baseProps}
        hasTerminalTabs
        isTerminalDockVisible={false}
        onToggleTerminalDock={onToggleTerminalDock}
      />
    );

    const showButton = screen.getByRole('button', { name: 'Show terminal dock' });
    expect(showButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(showButton);
    expect(onToggleTerminalDock).toHaveBeenCalledOnce();

    rerender(
      <AppHeader
        {...baseProps}
        hasTerminalTabs
        isTerminalDockVisible
        onToggleTerminalDock={onToggleTerminalDock}
      />
    );
    expect(screen.getByRole('button', { name: 'Hide terminal dock' }).getAttribute('aria-pressed')).toBe('true');
  });
});
