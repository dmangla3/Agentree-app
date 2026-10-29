// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoginProfileSummary } from '../../lib/loginProfiles';
import { LoginProfileRows } from './LoginProfileRows';

const profileWithStatusMessage = (
  statusMessage: string,
  status: LoginProfileSummary['status'] = 'unknown_error',
): LoginProfileSummary => ({
  id: 'profile-codex',
  provider: 'codex',
  displayName: 'Codex Login',
  authType: 'codex_chatgpt_session',
  redactedHint: null,
  status,
  statusMessage,
  isDefault: true,
  lastCheckedAt: null,
});

describe('LoginProfileRows', () => {
  it('disables Check when authentication is missing', () => {
    const onCheck = vi.fn();
    render(
      <LoginProfileRows
        activeRunsByProfile={{}}
        onCheck={onCheck}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSetDefault={vi.fn()}
        pendingProfileId={null}
        profiles={[profileWithStatusMessage('Log in to Codex in Managed Accounts.', 'auth_missing')]}
      />
    );

    const checkButton = screen.getByRole('button', { name: 'Test' });
    expect((checkButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(checkButton);
    expect(onCheck).not.toHaveBeenCalled();
  });

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

  it('lets OpenCode rows choose providers to test instead of a plain Test', async () => {
    const onTestProviders = vi.fn();
    const opencodeProfile: LoginProfileSummary = {
      id: 'profile-opencode',
      provider: 'opencode',
      displayName: 'OpenCode Login',
      authType: 'opencode_auth',
      redactedHint: null,
      status: 'ready',
      statusMessage: null,
      isDefault: true,
      lastCheckedAt: null,
      config: {
        opencode_provider_capabilities: {
          deepseek: {
            authStatus: 'valid',
            pricedModelAccess: 'available',
            providerName: 'DeepSeek',
            modelCount: 1,
            freeModelCount: 0,
          },
          openai: {
            authStatus: 'valid',
            pricedModelAccess: 'available',
            providerName: 'OpenAI',
            modelCount: 1,
            freeModelCount: 0,
          },
        },
      },
    };
    render(
      <LoginProfileRows
        activeRunsByProfile={{}}
        onCheck={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSetDefault={vi.fn()}
        onTestProviders={onTestProviders}
        pendingProfileId={null}
        profiles={[opencodeProfile]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Test providers' }));
    await screen.findByText('Run a live model call on each selected provider to confirm it works.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'OpenAI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test selected (1)' }));

    await waitFor(() => expect(onTestProviders).toHaveBeenCalledWith(opencodeProfile, ['deepseek']));
  });

  it('falls back to a plain Test for OpenCode rows without the provider-picker handler', () => {
    const onCheck = vi.fn();
    const opencodeProfile: LoginProfileSummary = {
      id: 'profile-opencode',
      provider: 'opencode',
      displayName: 'OpenCode Login',
      authType: 'opencode_auth',
      redactedHint: null,
      status: 'ready',
      statusMessage: null,
      isDefault: true,
      lastCheckedAt: null,
    };
    render(
      <LoginProfileRows
        activeRunsByProfile={{}}
        onCheck={onCheck}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSetDefault={vi.fn()}
        pendingProfileId={null}
        profiles={[opencodeProfile]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(onCheck).toHaveBeenCalledWith(opencodeProfile);
  });
});
