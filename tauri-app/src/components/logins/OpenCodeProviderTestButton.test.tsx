// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../@/components/ui/tooltip';
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
  await screen.findByText('Check credentials and model access for each selected provider.');
};

const renderButton = (config: LoginProfileSummary['config'], onTest = vi.fn()) => render(
  <TooltipProvider delayDuration={0}>
    <OpenCodeProviderTestButton profile={opencodeProfile(config)} onTest={onTest} />
  </TooltipProvider>,
);

describe('OpenCodeProviderTestButton', () => {
  it('opens with every provider selected and runs the full probe set', async () => {
    const onTest = vi.fn();
    renderButton(fullCapabilities(), onTest);

    await openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Test all (3)' }));

    await waitFor(() => expect(onTest).toHaveBeenCalledWith(['deepseek', 'groq', 'openai']));
  });

  it('tests only the providers left selected', async () => {
    const onTest = vi.fn();
    renderButton(fullCapabilities(), onTest);

    await openPopover();
    fireEvent.click(screen.getByRole('checkbox', { name: 'DeepSeek' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test selected (2)' }));

    await waitFor(() => expect(onTest).toHaveBeenCalledWith(['groq', 'openai']));
  });

  it('disables the action when no provider is selected and offers Test all', async () => {
    const onTest = vi.fn();
    renderButton(fullCapabilities(), onTest);

    await openPopover();
    fireEvent.click(screen.getByRole('checkbox', { name: 'DeepSeek' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'OpenAI' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Groq' }));

    const action = screen.getByRole('button', { name: 'Test all' }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
  });

  it('offers a single Test all action before any provider data exists', async () => {
    const onTest = vi.fn();
    renderButton({}, onTest);

    await openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Test all' }));

    await waitFor(() => expect(onTest).toHaveBeenCalledWith(null));
  });

  it('uses precise access labels and explains failures on focus', async () => {
    renderButton({
      opencode_provider_capabilities: {
        deepseek: { providerName: 'DeepSeek', authStatus: 'valid', pricedModelAccess: 'available', modelCount: 2, freeModelCount: 0 },
        google: { providerName: 'Google', authStatus: 'unknown', pricedModelAccess: 'unknown', modelCount: 2, freeModelCount: 0 },
        'kimi-for-coding': { providerName: 'Kimi For Coding', authStatus: 'valid', pricedModelAccess: 'unavailable', modelCount: 1, freeModelCount: 0 },
        openai: { providerName: 'OpenAI', authStatus: 'valid', pricedModelAccess: 'unknown', modelCount: 3, freeModelCount: 0 },
        opencode: { providerName: 'OpenCode Zen', authStatus: 'valid', pricedModelAccess: 'unavailable', modelCount: 2, freeModelCount: 1 },
        openrouter: { providerName: 'OpenRouter', authStatus: 'invalid', pricedModelAccess: 'unknown', modelCount: 2, freeModelCount: 1 },
      },
    });

    await openPopover();

    expect(screen.getByText('Paid models available')).toBeTruthy();
    expect(screen.getByText('Free models only')).toBeTruthy();
    expect(screen.getByText('Test inconclusive')).toBeTruthy();
    expect(screen.getByText('No usable models')).toBeTruthy();
    expect(screen.getByText('Paid access unverified')).toBeTruthy();

    const rejectedStatus = screen.getByLabelText('OpenRouter: Credentials rejected');
    fireEvent.focus(rejectedStatus);
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'OpenRouter rejected these credentials. Reconnect the provider, then test it again.',
    );
  });
});
