const titleCaseToken = (token: string): string => {
  if (!token) return token;
  if (token.toLowerCase() === 'gpt') return 'GPT';
  return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
};

export const formatAssistantModelLabel = (model: string | null | undefined): string | null => {
  const rawModel = model?.trim();
  if (!rawModel) return null;

  const modelId = rawModel.split('/').pop()?.trim() || rawModel;
  const normalized = modelId.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  return normalized
    .split(' ')
    .map(titleCaseToken)
    .join(' ')
    .replace(/^GPT ([0-9]+) ([0-9]+)(\b|$)/, 'GPT $1.$2');
};

export const getAssistantIdentityLabel = ({
  agentName,
  llmModel,
  llmProvider,
}: {
  agentName?: string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
}): string => {
  const modelLabel = formatAssistantModelLabel(llmModel);
  if (modelLabel) return modelLabel;

  const normalizedAgentName = agentName?.trim();
  if (normalizedAgentName) return normalizedAgentName;

  const providerLabel = formatAssistantModelLabel(llmProvider);
  return providerLabel || 'Assistant';
};
