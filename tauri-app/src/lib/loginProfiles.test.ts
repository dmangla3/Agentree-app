import { describe, expect, it } from 'vitest';
import {
  canCheckLoginProfileReadiness,
  getLoginProfileAuthTypeLabel,
  getLoginProfileProviderLabel,
  getLoginProfileStatusTone,
  getOpenCodeProviderCapabilities,
  isLoginProfileActive,
  isLoginProfileCompatibleWithProvider,
  resolveLoginProfileSelection,
  selectLoginProfileForProvider,
} from './loginProfiles';

describe('loginProfiles helpers', () => {
  it('labels supported providers', () => {
    expect(getLoginProfileProviderLabel('codex')).toBe('Codex');
    expect(getLoginProfileProviderLabel('claude')).toBe('Claude');
  });

  it('labels subscription and API key authentication types', () => {
    expect(getLoginProfileAuthTypeLabel('codex_chatgpt_session')).toBe('ChatGPT subscription');
    expect(getLoginProfileAuthTypeLabel('codex_api_key')).toBe('OpenAI API key');
    expect(getLoginProfileAuthTypeLabel('claude_oauth')).toBe('Claude subscription');
    expect(getLoginProfileAuthTypeLabel('claude_api_key')).toBe('Anthropic API key');
  });

  it('maps non-ready statuses to actionable tones', () => {
    expect(getLoginProfileStatusTone('ready')).toBe('success');
    expect(getLoginProfileStatusTone('expired')).toBe('danger');
    expect(getLoginProfileStatusTone('runtime_error')).toBe('danger');
    expect(getLoginProfileStatusTone('usage_limited')).toBe('warning');
  });

  it('matches profiles to runtime providers', () => {
    expect(isLoginProfileCompatibleWithProvider({ provider: 'codex' }, 'codex')).toBe(true);
    expect(isLoginProfileCompatibleWithProvider({ provider: 'claude' }, 'codex')).toBe(false);
  });

  it('treats only ready profiles as active for model selection', () => {
    expect(isLoginProfileActive({ status: 'ready' })).toBe(true);
    expect(isLoginProfileActive({ status: 'usage_limited' })).toBe(false);
    expect(isLoginProfileActive({ status: 'unchecked' })).toBe(false);
  });

  it('does not allow readiness checks when authentication is missing', () => {
    expect(canCheckLoginProfileReadiness({ status: 'auth_missing' })).toBe(false);
    expect(canCheckLoginProfileReadiness({ status: 'unknown_error' })).toBe(true);
    expect(canCheckLoginProfileReadiness({ status: 'ready' })).toBe(true);
  });

  it('selects a ready compatible profile before a non-ready default', () => {
    const profiles = [
      { id: 'c1', provider: 'codex', displayName: 'Codex expired', authType: 'codex_api_key', status: 'expired', isDefault: true },
      { id: 'c2', provider: 'codex', displayName: 'Codex ready', authType: 'codex_api_key', status: 'ready', isDefault: false },
    ];

    expect(selectLoginProfileForProvider(profiles, 'codex')?.id).toBe('c2');
  });

  it('reports readiness failures for providers that require profiles', () => {
    const selection = resolveLoginProfileSelection({
      profiles: [
        { id: 'c1', provider: 'codex', displayName: 'Codex expired', authType: 'codex_api_key', status: 'expired', isDefault: true },
      ],
      provider: 'codex',
      agentName: 'Codex',
    });

    expect(selection.selectedProfile?.id).toBe('c1');
    expect(selection.isReady).toBe(false);
    expect(selection.failureMessage).toBe('Log in to Codex in Managed Accounts.');
  });

  it('summarizes OpenCode provider access without exposing check internals', () => {
    const profile = {
      provider: 'opencode',
      config: {
        opencode_provider_capabilities: {
          openrouter: { providerName: 'OpenRouter', authStatus: 'invalid', pricedModelAccess: 'unknown', modelCount: 2, freeModelCount: 1 },
          deepseek: { providerName: 'DeepSeek', authStatus: 'valid', pricedModelAccess: 'available', modelCount: 2, freeModelCount: 0 },
          'kimi-for-coding': { providerName: 'Kimi For Coding', authStatus: 'valid', pricedModelAccess: 'unavailable', modelCount: 1, freeModelCount: 0 },
          openai: { providerName: 'OpenAI', authStatus: 'unknown', pricedModelAccess: 'unknown', modelCount: 2, freeModelCount: 0 },
        },
      },
    };

    expect(getOpenCodeProviderCapabilities(profile)).toEqual([
      { id: 'deepseek', name: 'DeepSeek', access: 'full', authStatus: 'valid', pricedModelAccess: 'available', modelCount: 2, freeModelCount: 0 },
      { id: 'kimi-for-coding', name: 'Kimi For Coding', access: 'unavailable', authStatus: 'valid', pricedModelAccess: 'unavailable', modelCount: 1, freeModelCount: 0 },
      { id: 'openai', name: 'OpenAI', access: 'unconfirmed', authStatus: 'unknown', pricedModelAccess: 'unknown', modelCount: 2, freeModelCount: 0 },
      { id: 'openrouter', name: 'OpenRouter', access: 'invalid', authStatus: 'invalid', pricedModelAccess: 'unknown', modelCount: 2, freeModelCount: 1 },
    ]);
  });
});
