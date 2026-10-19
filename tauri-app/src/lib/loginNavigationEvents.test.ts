// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  buildProviderLoginRequiredToast,
  LOGIN_PROFILES_NAVIGATION_EVENT,
  type LoginProfilesNavigationDetail,
} from './loginNavigationEvents';

describe('provider login navigation', () => {
  it.each([
    ['codex', 'Codex'],
    ['claude', 'Claude'],
  ] as const)('builds an actionable %s login toast', (provider, label) => {
    const listener = vi.fn();
    window.addEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, listener);

    const toast = buildProviderLoginRequiredToast(provider);
    expect(toast.title).toBe(`Log in to ${label}`);
    expect(toast.description).toBe(`Your ${label} login is missing or expired.`);
    expect(toast.action.label).toBe('Open Managed Accounts');

    toast.action.onClick();

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent<LoginProfilesNavigationDetail>).detail).toEqual({
      provider,
    });
    window.removeEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, listener);
  });
});
