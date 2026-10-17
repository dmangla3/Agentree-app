import defaultPromptDefinitions from './defaultPromptDefinitions.json';

export type DefaultPromptId =
  | 'dependency_guard'
  | 'artifact_path'
  | 'agentree_context_envelope'
  | 'thread_title_first'
  | 'thread_title_none'
  | 'delegation_control';

export interface DefaultPromptDefinition {
  id: DefaultPromptId;
  label: string;
  description: string;
  defaultText: string;
  variables?: string[];
}

export interface DefaultPromptOverride {
  id: DefaultPromptId;
  text: string;
  updatedAt?: string | null;
}

export interface EffectiveDefaultPrompt extends DefaultPromptDefinition {
  text: string;
  source: 'built_in' | 'user';
  updatedAt?: string | null;
}

const placeholderPattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export const DEFAULT_PROMPT_DEFINITIONS = defaultPromptDefinitions as DefaultPromptDefinition[];

const defaultPromptIds = new Set(DEFAULT_PROMPT_DEFINITIONS.map((definition) => definition.id));

export const isDefaultPromptId = (value: string): value is DefaultPromptId => (
  defaultPromptIds.has(value as DefaultPromptId)
);

export const getDefaultPromptDefinition = (id: DefaultPromptId): DefaultPromptDefinition => {
  const definition = DEFAULT_PROMPT_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) {
    throw new Error(`Unknown default prompt id: ${id}`);
  }
  return definition;
};

export const getDefaultPromptPlaceholders = (text: string): Set<string> => {
  const placeholders = new Set<string>();
  for (const match of text.matchAll(placeholderPattern)) {
    const key = match[1];
    if (key) placeholders.add(key);
  }
  return placeholders;
};

export const getMissingDefaultPromptVariables = (
  id: DefaultPromptId,
  text: string,
): string[] => {
  const requiredVariables = getDefaultPromptDefinition(id).variables ?? [];
  if (requiredVariables.length === 0) return [];
  const placeholders = getDefaultPromptPlaceholders(text);
  return requiredVariables.filter((variable) => !placeholders.has(variable));
};

export const normalizeDefaultPromptOverrides = (
  overrides: DefaultPromptOverride[],
): DefaultPromptOverride[] => {
  const normalized = new Map<DefaultPromptId, DefaultPromptOverride>();
  for (const override of overrides) {
    if (!isDefaultPromptId(override.id)) continue;
    const text = typeof override.text === 'string' ? override.text.trim() : '';
    if (!text) continue;
    if (text === getDefaultPromptDefinition(override.id).defaultText.trim()) continue;
    if (getMissingDefaultPromptVariables(override.id, text).length > 0) continue;
    normalized.set(override.id, {
      id: override.id,
      text,
      updatedAt: override.updatedAt ?? null,
    });
  }
  return Array.from(normalized.values());
};

export const mergeDefaultPromptOverrides = (
  overrides: DefaultPromptOverride[],
): EffectiveDefaultPrompt[] => {
  const overridesById = new Map(
    normalizeDefaultPromptOverrides(overrides).map((override) => [override.id, override]),
  );

  return DEFAULT_PROMPT_DEFINITIONS.map((definition) => {
    const override = overridesById.get(definition.id);
    return {
      ...definition,
      text: override?.text ?? definition.defaultText,
      source: override ? 'user' : 'built_in',
      updatedAt: override?.updatedAt ?? null,
    };
  });
};

export const renderDefaultPromptText = (
  text: string,
  variables: Record<string, string> = {},
): string => text.replace(placeholderPattern, (_match, key: string) => (
  variables[key] ?? ''
));

export const getEffectiveDefaultPromptText = (
  id: DefaultPromptId,
  overrides: DefaultPromptOverride[] = [],
  variables: Record<string, string> = {},
): string => {
  const normalizedOverrides = normalizeDefaultPromptOverrides(overrides);
  const override = normalizedOverrides.find((candidate) => candidate.id === id);
  return renderDefaultPromptText(
    override?.text ?? getDefaultPromptDefinition(id).defaultText,
    variables,
  );
};
