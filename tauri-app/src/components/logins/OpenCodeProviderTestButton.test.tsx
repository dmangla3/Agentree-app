// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoginProfileSummary } from '../../lib/loginProfiles';
import { OpenCodeProviderTestButton } from './OpenCodeProviderTestButton';

const opencodeProfile = (config?: LoginProfileSummary['config']): LoginProfileSummary => ({
  id: 'opencode-profile',
  provider: 'opencode',
  displayName: 'OpenCode',
  authType: 'opencode_auth',
  redactedHint: null,
  status: 'ready',
  statusMessage: null,
  isDefault: true,
  lastCheckedAt: null,
  config,
});

const fullCapabilities = (): LoginProfileSummary['config'] => ({
  opencode_provider_capabilities: {
    deepseek: {
      authStatus: 'valid',
      pricedModelAccess: 'available',
      providerName: 'DeepSeek',
      modelCount: 2,
      freeModelCount: 0,
    },
    openai: {
      authStatus: 'valid',
      pricedModelAccess: 'unavailable',
      providerName: 'OpenAI',
      modelCount: 3,
      freeModelCount: 1,
    },
    groq: {
      authStatus: 'invalid',
      pricedModelAccess: 'unknown',
      providerName: 'Groq',
      modelCount: 1,
      freeModelCount: 0,
    },
  },
});

const openPopover = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Test providers' }));
  await screen.findByText('Run a live model call on each selected provider to confirm it works.');
};

describe('OpenCodeProviderTestButton', () => {
  it('opens with every provider selected and runs the full probe set', async () => {
    const onTest = vi.fn();
    render(<OpenCodeProviderTestButton profile={opencodeProfile(fullCapabilities())} onTest={onTest} />);

    await openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Test all (3)' }));

    await waitFor(() => expect(onTest).toHaveBeenCalledWith(['deepseek', 'groq', 'openai']));
  });

  it('tests only the providers left selected', async () => {
    const onTest = vi.fn();
    render(<OpenCodeProviderTestButton profile={opencodeProfile(fullCapabilities())} onTest={onTest} />);

    await openPopover();
    fireEvent.click(screen.getByRole('checkbox', { name: 'DeepSeek' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test selected (2)' }));

    await waitFor(() => expect(onTest).toHaveBeenCalledWith(['groq', 'openai']));
  });

  it('disables the action when no provider is selected and offers Test all', async () => {
    const onTest = vi.fn();
    render(<OpenCodeProviderTestButton profile={opencodeProfile(fullCapabilities())} onTest={onTest} />);

    await openPopover();
    fireEvent.click(screen.getByRole('checkbox', { name: 'DeepSeek' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'OpenAI' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Groq' }));

    const action = screen.getByRole('button', { name: 'Test all' }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
  });

  it('offers a single Test all action before any provider data exists', async () => {
    const onTest = vi.fn();
    render(<OpenCodeProviderTestButton profile={opencodeProfile({})} onTest={onTest} />);

    await openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Test all' }));

    await waitFor(() => expect(onTest).toHaveBeenCalledWith(null));
  });
});
