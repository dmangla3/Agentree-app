// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

describe('AppHeader terminal control', () => {
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
