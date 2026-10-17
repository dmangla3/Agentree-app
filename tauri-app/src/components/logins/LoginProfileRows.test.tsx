// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoginProfileSummary } from '../../lib/loginProfiles';
import { LoginProfileRows } from './LoginProfileRows';

const profileWithStatusMessage = (statusMessage: string): LoginProfileSummary => ({
  id: 'profile-codex',
  provider: 'codex',
  displayName: 'Codex Login',
  authType: 'codex_chatgpt_session',
  redactedHint: null,
  status: 'unknown_error',
  statusMessage,
  isDefault: true,
  lastCheckedAt: null,
});

describe('LoginProfileRows', () => {
  it('keeps row status text clamped while exposing a copyable hover popover', async () => {
    const statusMessage =
      'Live check failed because /very/long/path/with/no/breaks/could/not/write/auth/session/metadata/after/sending/hi.';

    render(
      <LoginProfileRows
        activeRunsByProfile={{}}
        onCheck={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSetDefault={vi.fn()}
        pendingProfileId={null}
        profiles={[profileWithStatusMessage(statusMessage)]}
      />
    );

    const rowMessage = screen.getByText(statusMessage);

    expect(rowMessage.className).toContain('line-clamp-2');
    expect(rowMessage.className).toContain('[overflow-wrap:anywhere]');

    fireEvent.pointerEnter(rowMessage);

    const popover = await screen.findByText(statusMessage, {
      selector: '[data-slot="popover-content"]',
    });

    expect(popover.textContent).toBe(statusMessage);
    expect(popover.className).toContain('whitespace-pre-wrap');
    expect(popover.className).toContain('[overflow-wrap:anywhere]');
  });
});
