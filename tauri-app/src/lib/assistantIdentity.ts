const titleCaseToken = (token: string): string => {
  if (!token) return token;
  if (token.toLowerCase() === 'gpt') return 'GPT';
  return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
};

const REASONING_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
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
    // Restore the version decimal that gets lost when model ids use dashes
    // between version parts (e.g. "claude-opus-4-8" -> "Claude Opus 4.8",
    // "gpt-5-5" -> "GPT 5.5"). Only the first adjacent numeric pair is joined.
    .replace(/([0-9]+) ([0-9]+)/, '$1.$2');
};

export const formatAssistantReasoningLabel = (reasoningEffort: string | null | undefined): string | null => {
  const rawEffort = reasoningEffort?.trim();
  if (!rawEffort) return null;

  const normalizedId = rawEffort.toLowerCase().replace(/[_\s-]+/g, '');
  const knownLabel = REASONING_LABELS[normalizedId];
  if (knownLabel) return knownLabel;

  const normalizedLabel = rawEffort.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalizedLabel) return null;

  return normalizedLabel
    .split(' ')
    .map(titleCaseToken)
    .join(' ');
};

export const getAssistantReasoningEffortFromExecutionData = (
  executionData: unknown
): string | null => {
  if (!executionData || typeof executionData !== 'object') return null;

  const data = executionData as Record<string, unknown>;
  const meta = data.meta && typeof data.meta === 'object'
    ? data.meta as Record<string, unknown>
    : {};
  const effort = meta.provider_reasoning_effort
    ?? meta.reasoning_effort
    ?? data.provider_reasoning_effort
    ?? data.reasoning_effort;

  return typeof effort === 'string' && effort.trim() ? effort : null;
};

const appendReasoningLabel = (modelLabel: string, reasoningEffort: string | null | undefined): string => {
  const reasoningLabel = formatAssistantReasoningLabel(reasoningEffort);
  if (!reasoningLabel) return modelLabel;

  const normalizedModelLabel = modelLabel.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedReasoningLabel = reasoningLabel.toLowerCase().replace(/\s+/g, ' ').trim();
  if (
    normalizedModelLabel === normalizedReasoningLabel
    || normalizedModelLabel.endsWith(` ${normalizedReasoningLabel}`)
  ) {
    return modelLabel;
  }

  return `${modelLabel} ${reasoningLabel}`;
};

export const getAssistantIdentityLabel = ({
  agentName,
  llmModel,
  llmProvider,
  reasoningEffort,
}: {
  agentName?: string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
  reasoningEffort?: string | null;
}): string => {
  const modelLabel = formatAssistantModelLabel(llmModel);
  if (modelLabel) return appendReasoningLabel(modelLabel, reasoningEffort);

  const normalizedAgentName = agentName?.trim();
  if (normalizedAgentName) return normalizedAgentName;

  const providerLabel = formatAssistantModelLabel(llmProvider);
  return providerLabel || 'Assistant';
};

// Title-cased reasoning effort labels, longest first so "Extra High" is
// matched before "High" when splitting the suffix off the combined label.
const REASONING_EFFORT_DISPLAY_LABELS = ['Extra High', 'High', 'Medium', 'Low'];

// Returns the identity split into the model/agent label and the reasoning
// effort, so callers can render the model in its uppercase chip while showing
// the effort in normal case (e.g. "CLAUDE OPUS 4.8" + "High").
export const getAssistantIdentityParts = (input: {
  agentName?: string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
  reasoningEffort?: string | null;
}): { label: string; reasoningEffort: string | null } => {
  const fullLabel = getAssistantIdentityLabel(input);

  for (const effort of REASONING_EFFORT_DISPLAY_LABELS) {
    const suffix = ` ${effort}`;
    if (fullLabel.length > suffix.length && fullLabel.endsWith(suffix)) {
      return {
        label: fullLabel.slice(0, fullLabel.length - suffix.length),
        reasoningEffort: effort,
      };
    }
  }

  return { label: fullLabel, reasoningEffort: null };
};

export type AssistantProviderIconKind = 'codex' | 'claude' | 'opencode' | 'generic';

const normalizeIdentityPart = (value: string | null | undefined): string => (
  value?.trim().toLowerCase() ?? ''
);

export const getAssistantProviderIconKind = ({
  llmModel,
  llmProvider,
}: {
  llmModel?: string | null;
  llmProvider?: string | null;
}): AssistantProviderIconKind => {
  const provider = normalizeIdentityPart(llmProvider);
  const model = normalizeIdentityPart(llmModel);

  if (provider === 'codex' || model.startsWith('codex/') || model.startsWith('codex:')) {
    return 'codex';
  }

  if (provider === 'opencode' || model.startsWith('opencode/') || model.startsWith('opencode:')) {
    return 'opencode';
  }

  if (
    provider === 'claude' ||
    provider === 'anthropic' ||
    model.includes('claude') ||
    model.startsWith('anthropic/')
  ) {
    return 'claude';
  }

  return 'generic';
};
