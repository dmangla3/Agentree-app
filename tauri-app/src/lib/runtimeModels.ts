export type RuntimeProvider = 'claude' | 'codex';

export type RuntimeModelModality = 'text' | 'image';

export interface RuntimeModelCapabilities {
  inputModalities: RuntimeModelModality[];
  outputModalities: RuntimeModelModality[];
  reasoningEffort: boolean;
}

export interface AgentModelConfig {
  model?: string | null;
  familyKey?: string | null;
  familyLabel?: string | null;
  familyDescription?: string | null;
  effortLabel?: string | null;
  effortDescription?: string | null;
  reasoningEffort?: string | null;
  capabilities?: RuntimeModelCapabilities | null;
}

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
  capabilities: RuntimeModelCapabilities;
}

const textReasoningCapabilities: RuntimeModelCapabilities = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  reasoningEffort: true,
};

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
  capabilities: textReasoningCapabilities,
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
  capabilities: textReasoningCapabilities,
});

const makeCodexImageModel = ({
  id,
  label,
  description,
}: {
  id: string;
  label: string;
  description: string;
}): RuntimeModel => ({
  key: `codex:${id}`,
  id,
  provider: 'codex',
  modelId: id,
  familyKey: `codex:${id}`,
  familyLabel: label,
  familyDescription: description,
  effortLabel: 'Image',
  effortDescription: 'Image generation and editing',
  reasoningEffort: null,
  label,
  providerLabel: 'Codex',
  description,
  cliArgs: `--model ${id}`,
  promptFlag: null,
  color: 'green',
  capabilities: {
    inputModalities: ['text', 'image'],
    outputModalities: ['text', 'image'],
    reasoningEffort: false,
  },
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
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'Flagship GPT-5.6 model for the most demanding work',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'Balanced GPT-5.6 model for everyday work',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'Fastest and most cost-efficient GPT-5.6 model',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Previous frontier agentic coding model',
  },
] as const;

const codexImageModelBases = [
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    description: 'OpenAI image generation and editing model for visual assistant outputs',
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

const codexImageModels: RuntimeModel[] = codexImageModelBases.map((model) =>
  makeCodexImageModel(model)
);

export const runtimeModels: RuntimeModel[] = [...codexModels, ...codexImageModels, ...claudeModels];

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
