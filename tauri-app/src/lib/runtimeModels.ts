export type RuntimeProvider = 'claude' | 'codex';

export interface RuntimeModel {
  key: string;
  id: string;
  provider: RuntimeProvider;
  modelId: string;
  familyKey: string;
  familyLabel: string;
  familyDescription: string;
  effortLabel: string;
  effortDescription: string;
  reasoningEffort?: string | null;
  label: string;
  providerLabel: string;
  description: string;
  cliArgs: string;
  promptFlag: string | null;
  color: string;
}

const claudeEfforts = [
  { id: 'low', label: 'Low', description: 'Minimal thinking, fastest responses' },
  { id: 'medium', label: 'Medium', description: 'Moderate thinking' },
  { id: 'high', label: 'High', description: 'Deep reasoning' },
] as const;

const codexReasoningEfforts = [
  { id: 'low', label: 'Low', description: 'Fastest supported Codex reasoning level' },
  { id: 'medium', label: 'Medium', description: 'Balanced Codex reasoning level' },
  { id: 'high', label: 'High', description: 'Deeper Codex reasoning level' },
  { id: 'xhigh', label: 'Extra High', description: 'Maximum supported Codex reasoning level' },
] as const;

const makeClaudeModel = ({
  id,
  modelId,
  label,
  modelAlias,
  effort,
  description,
}: {
  id: string;
  modelId: string;
  label: string;
  modelAlias: string;
  effort: typeof claudeEfforts[number] | { id: 'max'; label: 'Max'; description: string };
  description?: string;
}): RuntimeModel => ({
  key: `claude:${id}:${effort.id}`,
  id: `${id}:${effort.id}`,
  provider: 'claude',
  modelId,
  familyKey: `claude:${id}`,
  familyLabel: label,
  familyDescription: description ?? `${label} reasoning modes`,
  effortLabel: effort.label,
  effortDescription: effort.description,
  reasoningEffort: effort.id,
  label: `${label} ${effort.label}`,
  providerLabel: 'Claude',
  description: description ?? effort.description,
  cliArgs: `--permission-mode auto --print --output-format stream-json --verbose --no-session-persistence --model ${modelAlias} --effort ${effort.id}`,
  promptFlag: null,
  color: 'amber',
});

const makeCodexModel = ({
  id,
  label,
  description,
  effort,
}: {
  id: string;
  label: string;
  description: string;
  effort: typeof codexReasoningEfforts[number];
}): RuntimeModel => ({
  key: `codex:${id}:${effort.id}`,
  id: `${id}:${effort.id}`,
  provider: 'codex',
  modelId: id,
  familyKey: `codex:${id}`,
  familyLabel: label,
  familyDescription: description,
  effortLabel: effort.label,
  effortDescription: effort.description,
  reasoningEffort: effort.id,
  label: `${label} ${effort.label}`,
  providerLabel: 'Codex',
  description: `${description}. ${effort.description}.`,
  cliArgs: `--model ${id} --reasoning-effort ${effort.id}`,
  promptFlag: null,
  color: 'green',
});

const claudeModelBases = [
  {
    id: 'claude-fable-5',
    modelId: 'claude-fable-5',
    label: 'Claude Fable 5',
    modelAlias: 'claude-fable-5',
    description: 'Anthropic frontier model for complex reasoning and agentic work',
  },
  {
    id: 'claude-opus-4-8',
    modelId: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    modelAlias: 'claude-opus-4-8',
    description: 'Anthropic frontier model for complex reasoning and long-horizon agentic coding',
  },
  {
    id: 'claude-sonnet-4-6',
    modelId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    modelAlias: 'sonnet',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    modelId: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    modelAlias: 'haiku',
  },
] as const;

const codexModelBases = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Latest frontier agentic coding model',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Previous frontier agentic coding model',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'Smaller, faster GPT-5.4 variant',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'Previous-generation Codex model',
  },
  {
    id: 'gpt-5.2-codex',
    label: 'GPT-5.2 Codex',
    description: 'Stable Codex coding model',
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    description: 'General GPT-5.2 model',
  },
  {
    id: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    description: 'High-capacity Codex model',
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    description: 'Smaller, faster Codex model',
  },
] as const;

const claudeModels: RuntimeModel[] = [
  ...claudeModelBases.flatMap((model) => claudeEfforts.map((effort) => makeClaudeModel({ ...model, effort }))),
  makeClaudeModel({
    ...claudeModelBases[0],
    effort: { id: 'max', label: 'Max', description: 'Maximum effort for Claude Opus 4.8' },
    description: 'Maximum effort for Claude Opus 4.8',
  }),
];

const codexModels: RuntimeModel[] = codexModelBases.flatMap((model) =>
  codexReasoningEfforts.map((effort) => makeCodexModel({ ...model, effort }))
);

export const runtimeModels: RuntimeModel[] = [...codexModels, ...claudeModels];

export const defaultRuntimeModelKey = 'codex:gpt-5.5:high';

export const getRuntimeModelByKey = (key?: string | null): RuntimeModel | null =>
  runtimeModels.find((model) => model.key === key) ?? null;

export const getRuntimeModelByProviderAndId = (
  provider?: string | null,
  modelId?: string | null
): RuntimeModel | null => {
  if (!provider || !modelId) return null;
  return runtimeModels.find((model) => model.provider === provider && model.modelId === modelId) ?? null;
};

export const getRuntimeModelById = (modelId?: string | null): RuntimeModel | null => {
  if (!modelId) return null;
  return runtimeModels.find((model) => model.modelId === modelId) ?? null;
};

export const getRuntimeModelLabel = (
  modelId?: string | null,
  provider?: string | null
): string => {
  const runtimeModel = getRuntimeModelByProviderAndId(provider, modelId) ?? getRuntimeModelById(modelId);
  if (runtimeModel) return runtimeModel.label;
  if (!modelId) return 'Unknown Model';
  return modelId.split('/').pop()?.split(':').shift() || modelId;
};

export const getRuntimeModelKey = (
  provider?: string | null,
  modelId?: string | null,
  reasoningEffort?: string | null
): string | null => {
  if (!provider || !modelId) return null;
  return reasoningEffort ? `${provider}:${modelId}:${reasoningEffort}` : `${provider}:${modelId}`;
};
