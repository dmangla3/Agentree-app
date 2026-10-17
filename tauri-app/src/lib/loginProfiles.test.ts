import { describe, expect, it } from 'vitest';
import {
  getLoginProfileAuthTypeLabel,
  getLoginProfileProviderLabel,
  getLoginProfileStatusTone,
  hasActiveLoginProfileForProvider,
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

  it('finds active provider availability from ready compatible profiles only', () => {
    const profiles = [
      { id: 'c1', provider: 'codex', displayName: 'Codex expired', authType: 'codex_api_key', status: 'expired', isDefault: true },
      { id: 'a1', provider: 'claude', displayName: 'Claude ready', authType: 'claude_api_key', status: 'ready', isDefault: true },
    ];

    expect(hasActiveLoginProfileForProvider(profiles, 'codex')).toBe(false);
    expect(hasActiveLoginProfileForProvider(profiles, 'claude')).toBe(true);
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
    expect(selection.failureMessage).toBe('Codex needs a ready login profile before it can run.');
  });
});
