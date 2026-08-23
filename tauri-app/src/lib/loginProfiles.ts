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

export const getLoginProfileProviderLabel = (provider: LoginProvider) => {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  return provider;
};

export const getLoginProfileAuthTypeLabel = (authType: string) => {
  if (authType === 'codex_chatgpt_session') return 'ChatGPT session';
  if (authType === 'codex_api_key') return 'OpenAI API key';
  if (authType === 'claude_api_key') return 'Anthropic API key';
  if (authType === 'claude_auth_token') return 'Anthropic auth token';
  if (authType === 'claude_bedrock') return 'Bedrock';
  if (authType === 'claude_vertex') return 'Vertex AI';
  if (authType === 'claude_azure_foundry') return 'Azure Foundry';
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

export const isLoginProfileCompatibleWithProvider = (
  profile: Pick<LoginProfileSummary, 'provider'>,
  provider?: string | null
) => Boolean(provider && profile.provider === provider);

export const hasActiveLoginProfileForProvider = (
  profiles: Pick<LoginProfileSummary, 'provider' | 'status'>[],
  provider?: string | null
) => profiles.some((profile) =>
  isLoginProfileCompatibleWithProvider(profile, provider) && isLoginProfileActive(profile)
);
