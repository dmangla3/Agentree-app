import { describe, expect, it } from 'vitest';
import {
  getLoginProfileProviderLabel,
  getLoginProfileStatusTone,
  hasActiveLoginProfileForProvider,
  isLoginProfileActive,
  isLoginProfileCompatibleWithProvider,
} from './loginProfiles';

describe('loginProfiles helpers', () => {
  it('labels supported providers', () => {
    expect(getLoginProfileProviderLabel('codex')).toBe('Codex');
    expect(getLoginProfileProviderLabel('claude')).toBe('Claude');
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
});
