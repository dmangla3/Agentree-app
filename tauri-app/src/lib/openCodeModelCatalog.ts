import type { LoginProfileSummary } from './loginProfiles';

// Compatibility shape persisted by explicit OpenCode account checks. It is a
// frontend storage DTO, not a native command contract.
export interface OpenCodeRuntimeModel {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  attachment: boolean;
  toolCall: boolean;
  inputModalities: string[];
  outputModalities: string[];
  variants: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  releaseDate: string | null;
  status: string | null;
  isFree: boolean | null;
}

export const OPENCODE_MODEL_CATALOG_CONFIG_KEY = 'opencode_model_catalog';
export const OPENCODE_MODEL_CATALOG_CHECKED_AT_CONFIG_KEY = 'opencode_model_catalog_checked_at';

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((item) => typeof item === 'string')
);

const isOpenCodeRuntimeModel = (value: unknown): value is OpenCodeRuntimeModel => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const model = value as Partial<OpenCodeRuntimeModel>;
  return typeof model.id === 'string'
    && typeof model.providerId === 'string'
    && typeof model.providerName === 'string'
    && typeof model.modelId === 'string'
    && typeof model.name === 'string'
    && typeof model.reasoning === 'boolean'
    && typeof model.attachment === 'boolean'
    && typeof model.toolCall === 'boolean'
    && isStringArray(model.inputModalities)
    && isStringArray(model.outputModalities)
    && isStringArray(model.variants);
};

const providerModelIsVisible = (
  profile: Pick<LoginProfileSummary, 'config'>,
  model: OpenCodeRuntimeModel,
) => {
  const capabilities = profile.config?.opencode_provider_capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return true;
  const raw = (capabilities as Record<string, unknown>)[model.providerId];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const capability = raw as Record<string, unknown>;
  if (capability.authStatus === 'invalid') return false;
  if (capability.pricedModelAccess === 'unavailable') return model.isFree === true;
  return true;
};

export const getCachedOpenCodeSupportedModelCatalog = (
  profile: Pick<LoginProfileSummary, 'provider' | 'config'> | null | undefined,
): OpenCodeRuntimeModel[] => {
  if (profile?.provider !== 'opencode') return [];
  const stored = profile.config?.[OPENCODE_MODEL_CATALOG_CONFIG_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.filter(isOpenCodeRuntimeModel);
};

export const getCachedOpenCodeAccessibleModelCatalog = (
  profile: Pick<LoginProfileSummary, 'provider' | 'config'> | null | undefined,
): OpenCodeRuntimeModel[] => {
  if (profile?.provider !== 'opencode') return [];
  return getCachedOpenCodeSupportedModelCatalog(profile)
    .filter((model) => providerModelIsVisible(profile, model));
};

// The effective selector catalog is the intersection of runtime support and
// access recorded when the user last checked or updated this profile.
export const getCachedOpenCodeModelCatalog = getCachedOpenCodeAccessibleModelCatalog;

export const getCachedOpenCodeModelCatalogCheckedAt = (
  profile: Pick<LoginProfileSummary, 'provider' | 'config'> | null | undefined,
): number | null => {
  if (profile?.provider !== 'opencode') return null;
  const checkedAt = profile.config?.[OPENCODE_MODEL_CATALOG_CHECKED_AT_CONFIG_KEY];
  return typeof checkedAt === 'number' && Number.isFinite(checkedAt) ? checkedAt : null;
};
