import type { RuntimeProvider } from './runtimeModels';

export const MODEL_CONFIGURATION_EVENT = 'agentree:open-model-configuration';

export type ModelConfigurationDetail = {
  provider: RuntimeProvider;
};

export function dispatchOpenModelConfiguration(provider: RuntimeProvider) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new window.CustomEvent<ModelConfigurationDetail>(MODEL_CONFIGURATION_EVENT, {
    detail: { provider },
  }));
}
