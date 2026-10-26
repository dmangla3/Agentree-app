// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  dispatchOpenCommitTerminal,
  OPEN_COMMIT_TERMINAL_EVENT,
  type OpenCommitTerminalDetail,
} from './commitTerminalEvents';

describe('commit terminal events', () => {
  it('normalizes and dispatches a commit terminal request', () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_COMMIT_TERMINAL_EVENT, listener);

    expect(dispatchOpenCommitTerminal({
      repoPath: ' /repo ',
      commitSha: ' abc123 ',
      label: ' Fix tests ',
    })).toBe(true);

    const event = listener.mock.calls[0]?.[0] as CustomEvent<OpenCommitTerminalDetail>;
    expect(event.detail).toEqual({
      repoPath: '/repo',
      commitSha: 'abc123',
      label: 'Fix tests',
    });
    window.removeEventListener(OPEN_COMMIT_TERMINAL_EVENT, listener);
  });

  it('rejects incomplete requests', () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_COMMIT_TERMINAL_EVENT, listener);

    expect(dispatchOpenCommitTerminal({ repoPath: '', commitSha: 'abc123' })).toBe(false);
    expect(dispatchOpenCommitTerminal({ repoPath: '/repo', commitSha: ' ' })).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(OPEN_COMMIT_TERMINAL_EVENT, listener);
  });
});
