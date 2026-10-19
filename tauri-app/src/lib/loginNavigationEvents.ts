import type { RuntimeProvider } from './runtimeModels';

export const LOGIN_PROFILES_NAVIGATION_EVENT = 'agentree:open-login-profiles';

export type LoginProfilesNavigationDetail = {
  provider?: RuntimeProvider;
  target?: 'runtime-health';
};

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
