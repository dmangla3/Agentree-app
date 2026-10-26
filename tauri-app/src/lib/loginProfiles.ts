export type LoginProvider = 'codex' | 'claude' | string;

export type LoginProfileStatus =
  | 'unchecked'
  | 'checking'
  | 'ready'
  | 'auth_missing'
  | 'invalid'
  | 'expired'
  | 'usage_limited'
  | 'keychain_unavailable'
  | 'unknown_error'
  | string;

export interface LoginProfileSummary {
  id: string;
  provider: LoginProvider;
  displayName: string;
  authType: string;
  redactedHint?: string | null;
  config?: Record<string, any> | null;
  status: LoginProfileStatus;
  statusMessage?: string | null;
  planType?: string | null;
  isDefault: boolean;
  lastCheckedAt?: number | null;
}

export type OpenCodeProviderAccess = 'full' | 'free_only' | 'unavailable' | 'invalid' | 'unconfirmed';

export interface OpenCodeProviderCapability {
  id: string;
  name: string;
  access: OpenCodeProviderAccess;
  modelCount: number | null;
  freeModelCount: number | null;
}

const openCodeProviderNames: Record<string, string> = {
  deepseek: 'DeepSeek',
  google: 'Google',
  groq: 'Groq',
  'kimi-for-coding': 'Kimi For Coding',
  openai: 'OpenAI',
  opencode: 'OpenCode Zen',
  openrouter: 'OpenRouter',
};

export const getOpenCodeProviderLabel = (providerId: string) => (
  openCodeProviderNames[providerId] || providerId.replace(/-/g, ' ')
);

export const getOpenCodeProviderCapabilities = (
  profile: Pick<LoginProfileSummary, 'provider' | 'config'>,
): OpenCodeProviderCapability[] => {
  if (profile.provider !== 'opencode') return [];
  const stored = profile.config?.opencode_provider_capabilities;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];

  return Object.entries(stored)
    .map(([id, raw]) => {
      const capability = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      const authStatus = capability.authStatus;
      const pricedModelAccess = capability.pricedModelAccess;
      let access: OpenCodeProviderAccess = 'unconfirmed';
      const modelCount = typeof capability.modelCount === 'number' ? capability.modelCount : null;
      const freeModelCount = typeof capability.freeModelCount === 'number' ? capability.freeModelCount : null;
      if (authStatus === 'invalid') access = 'invalid';
      else if (authStatus === 'valid' && pricedModelAccess === 'available') access = 'full';
      else if (authStatus === 'valid' && pricedModelAccess === 'unavailable') {
        access = freeModelCount !== null && freeModelCount > 0 ? 'free_only' : 'unavailable';
      }
      const providerName = typeof capability.providerName === 'string'
        ? capability.providerName.trim()
        : '';
      return {
        id,
        name: providerName || getOpenCodeProviderLabel(id),
        access,
        modelCount,
        freeModelCount,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

export const getOpenCodeProviderSummary = (
  profile: Pick<LoginProfileSummary, 'provider' | 'config'>,
): string | null => {
  const capabilities = getOpenCodeProviderCapabilities(profile);
  if (!capabilities.length) return null;
  const reconnectCount = capabilities.filter((capability) => capability.access === 'invalid').length;
  if (reconnectCount > 0) return `${capabilities.length} checked · ${reconnectCount} invalid`;
  const unconfirmedCount = capabilities.filter((capability) => capability.access === 'unconfirmed').length;
  if (unconfirmedCount > 0) return `${capabilities.length} checked · ${unconfirmedCount} not confirmed`;
  return `${capabilities.length} checked`;
};

export const getLoginProfileProviderLabel = (provider: LoginProvider) => {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  if (provider === 'opencode') return 'OpenCode';
  return provider;
};

export const getLoginProfileAuthTypeLabel = (authType: string) => {
  if (authType === 'codex_chatgpt_session') return 'ChatGPT subscription';
  if (authType === 'codex_api_key') return 'OpenAI API key';
  if (authType === 'claude_oauth') return 'Claude subscription';
  if (authType === 'claude_api_key') return 'Anthropic API key';
  if (authType === 'claude_bedrock') return 'Bedrock';
  if (authType === 'claude_vertex') return 'Vertex AI';
  if (authType === 'claude_azure_foundry') return 'Azure Foundry';
  if (authType === 'opencode_auth') return 'OpenCode providers';
  if (authType === 'external_cli') return 'External CLI';
  return authType.replace(/_/g, ' ');
};

export const getLoginProfileStatusTone = (status: LoginProfileStatus) => {
  if (status === 'ready') return 'success' as const;
  if (status === 'usage_limited' || status === 'unchecked' || status === 'checking') return 'warning' as const;
  if (status === 'expired' || status === 'invalid' || status === 'auth_missing') return 'danger' as const;
  return 'muted' as const;
};

export const isLoginProfileActive = (profile: Pick<LoginProfileSummary, 'status'>) =>
  profile.status === 'ready';

export const canCheckLoginProfileReadiness = (
  profile: Pick<LoginProfileSummary, 'status'>
) => profile.status !== 'auth_missing';

export const isLoginProfileCompatibleWithProvider = (
  profile: Pick<LoginProfileSummary, 'provider'>,
  provider?: string | null
) => Boolean(provider && profile.provider === provider);

export const providerRequiresLoginProfile = (provider?: string | null): boolean => (
  provider === 'codex' || provider === 'claude' || provider === 'opencode'
);

export interface LoginProfileSelection {
  provider: string | null;
  selectedProfile: LoginProfileSummary | null;
  requiresProfile: boolean;
  isReady: boolean;
  failureMessage: string | null;
}

export const selectLoginProfileForProvider = (
  profiles: LoginProfileSummary[],
  provider?: string | null,
): LoginProfileSummary | null => {
  if (!provider) return null;
  const compatibleProfiles = profiles.filter((profile) => profile.provider === provider);
  return compatibleProfiles.find((profile) => profile.isDefault && isLoginProfileActive(profile))
    ?? compatibleProfiles.find((profile) => isLoginProfileActive(profile))
    ?? compatibleProfiles.find((profile) => profile.isDefault)
    ?? compatibleProfiles[0]
    ?? null;
};

export const resolveLoginProfileSelection = (input: {
  profiles: LoginProfileSummary[];
  provider?: string | null;
  agentName?: string | null;
}): LoginProfileSelection => {
  const provider = input.provider ?? null;
  const requiresProfile = providerRequiresLoginProfile(provider);
  const selectedProfile = selectLoginProfileForProvider(input.profiles, provider);
  const isReady = !requiresProfile || Boolean(selectedProfile && isLoginProfileActive(selectedProfile));
  const providerLabel = getLoginProfileProviderLabel(provider ?? '');
  return {
    provider,
    selectedProfile,
    requiresProfile,
    isReady,
    failureMessage: isReady ? null : `Log in to ${providerLabel} in Managed Accounts.`,
  };
};

export const hasActiveLoginProfileForProvider = (
  profiles: Pick<LoginProfileSummary, 'provider' | 'status'>[],
  provider?: string | null
) => profiles.some((profile) =>
  isLoginProfileCompatibleWithProvider(profile, provider) && isLoginProfileActive(profile)
);
