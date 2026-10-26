import type { RuntimeProvider } from './runtimeModels';

export const LOGIN_PROFILES_NAVIGATION_EVENT = 'agentree:open-login-profiles';

export type LoginProfilesNavigationDetail = {
  provider?: RuntimeProvider;
  target?: 'runtime-health';
};

export function buildProviderLoginRequiredToast(provider: RuntimeProvider) {
  const providerLabel = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'OpenCode';
  return {
    title: `Log in to ${providerLabel}`,
    description: `Your ${providerLabel} login is missing or expired.`,
    variant: 'error' as const,
    persistent: true,
    action: {
      label: 'Open Managed Accounts',
      onClick: () => dispatchOpenLoginProfiles(provider),
    },
  };
}

export function dispatchOpenLoginProfiles(provider: RuntimeProvider) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new window.CustomEvent<LoginProfilesNavigationDetail>(LOGIN_PROFILES_NAVIGATION_EVENT, {
    detail: { provider },
  }));
}

export function dispatchOpenRuntimeHealth() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new window.CustomEvent<LoginProfilesNavigationDetail>(LOGIN_PROFILES_NAVIGATION_EVENT, {
    detail: { target: 'runtime-health' },
  }));
}
