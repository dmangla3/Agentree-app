// @vitest-environment jsdom
import '../../test/setup';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../Toast';
import { dispatchOpenCommitTerminal } from '../../lib/commitTerminalEvents';
import type { TerminalEvent } from '../../generated/tauri-bindings';
import { TerminalDock } from './TerminalDock';

const terminalPanes = vi.hoisted(() => new Map<string, Record<string, any>>());

vi.mock('./TerminalPane', () => ({
  TerminalPane: (props: Record<string, any>) => {
    terminalPanes.set(props.tabId, props);
    return <div data-testid="terminal-pane">{props.closeRequested ? 'closing' : 'open'}</div>;
  },
}));

const exitEvent = (disposition: string): Extract<TerminalEvent, { type: 'exit' }> => ({
  type: 'exit',
  exit_code: 0,
  signal: null,
  worktree_disposition: disposition,
  cleanup_message: null,
});

describe('TerminalDock', () => {
  beforeEach(() => {
    terminalPanes.clear();
  });

  it('keeps same-commit terminals as separate tabs until each session exits', async () => {
    render(
      <ToastProvider>
        <TerminalDock />
      </ToastProvider>
    );

    act(() => {
      dispatchOpenCommitTerminal({ repoPath: '/repo', commitSha: 'abc123456789', label: 'First shell' });
      dispatchOpenCommitTerminal({ repoPath: '/repo', commitSha: 'abc123456789', label: 'Second shell' });
    });

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(await screen.findAllByTestId('terminal-pane')).toHaveLength(2);

    const firstTabId = Array.from(terminalPanes.keys())[0];
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal First shell' }));
    expect(terminalPanes.get(firstTabId)?.closeRequested).toBe(true);

    act(() => {
      terminalPanes.get(firstTabId)?.onExit(firstTabId, exitEvent('shared'));
    });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /Second shell/ })).toBeTruthy();
  });

  it('opens another tab at the active commit from the plus button', async () => {
    render(
      <ToastProvider>
        <TerminalDock />
      </ToastProvider>
    );

    act(() => {
      dispatchOpenCommitTerminal({ repoPath: '/repo', commitSha: 'def987654321', label: 'Feature commit' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'New terminal at active commit' }));

    expect(screen.getAllByRole('tab', { name: /Feature commit/ })).toHaveLength(2);
    expect(await screen.findAllByTestId('terminal-pane')).toHaveLength(2);
  });

  it('closes the tab when the shell exits naturally', async () => {
    const onTabsChange = vi.fn();
    render(
      <ToastProvider>
        <TerminalDock onTabsChange={onTabsChange} />
      </ToastProvider>
    );

    act(() => {
      dispatchOpenCommitTerminal({ repoPath: '/repo', commitSha: 'abc123456789', label: 'Exit shell' });
    });
    expect(await screen.findByRole('tab', { name: /Exit shell/ })).toBeTruthy();

    const tabId = Array.from(terminalPanes.keys())[0];
    act(() => {
      terminalPanes.get(tabId)?.onExit(tabId, exitEvent('removed'));
    });

    expect(screen.queryByRole('tab', { name: /Exit shell/ })).toBeNull();
    expect(onTabsChange).toHaveBeenLastCalledWith(false);
  });

  it('requests dock reveal separately from reporting tab presence', async () => {
    const onRequestShow = vi.fn();
    const onTabsChange = vi.fn();
    render(
      <ToastProvider>
        <TerminalDock onRequestShow={onRequestShow} onTabsChange={onTabsChange} />
      </ToastProvider>
    );

    expect(onTabsChange).toHaveBeenLastCalledWith(false);
    act(() => {
      dispatchOpenCommitTerminal({ repoPath: '/repo', commitSha: 'abc123456789', label: 'Reveal shell' });
    });

    expect(await screen.findByRole('tab', { name: /Reveal shell/ })).toBeTruthy();
    expect(onRequestShow).toHaveBeenCalledOnce();
    expect(onTabsChange).toHaveBeenLastCalledWith(true);
  });
});
