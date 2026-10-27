import type { RuntimeModelCatalogRecord } from './agentClient';
import type { OpenCodeRuntimeModel } from './openCodeModelCatalog';

export type RuntimeProvider = 'claude' | 'codex' | 'opencode';

export type RuntimeModelModality = 'text' | 'image' | 'audio' | 'pdf' | 'video';
export type RuntimeModelStatus = 'active' | 'beta' | 'alpha' | 'deprecated';

export interface RuntimeModelCapabilities {
  inputModalities: RuntimeModelModality[];
  outputModalities: RuntimeModelModality[];
  reasoningEffort: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  attachments?: boolean;
}

export interface AgentModelConfig {
  model?: string | null;
  canonicalModelId?: string | null;
  familyKey?: string | null;
  familyLabel?: string | null;
  familyDescription?: string | null;
  effortLabel?: string | null;
  effortDescription?: string | null;
  reasoningEffort?: string | null;
  capabilities?: RuntimeModelCapabilities | null;
  modelProvider?: string | null;
  releaseDate?: string | null;
  status?: RuntimeModelStatus | null;
  isFree?: boolean | null;
}

export interface RuntimeModel {
  key: string;
  id: string;
  provider: RuntimeProvider;
  modelId: string;
  canonicalModelId?: string | null;
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
  releaseDate?: string | null;
  status?: RuntimeModelStatus | null;
  isFree?: boolean | null;
}

export interface RuntimeModelIdentity {
  provider: RuntimeProvider;
  modelId: string;
  reasoningEffort?: string | null;
}

// Compact projection for legacy surfaces (graph legend and advanced search).
// RuntimeModel remains the single catalog source of truth.
export interface RuntimeCatalogModel {
  id: string;
  key: string;
  provider: RuntimeProvider;
  name: string;
  description: string;
  inputModalities: RuntimeModelModality[];
  outputModalities: RuntimeModelModality[];
  isFree: boolean;
}

const encodeRuntimeModelKeyPart = (value: string) => encodeURIComponent(value);

const decodeRuntimeModelKeyPart = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export const getRuntimeModelFamilyKey = (
  provider?: string | null,
  modelId?: string | null,
): string | null => {
  if (!provider || !modelId) return null;
  return `${provider}:${encodeRuntimeModelKeyPart(modelId)}`;
};

export const getRuntimeModelKey = (
  provider?: string | null,
  modelId?: string | null,
  reasoningEffort?: string | null,
): string | null => {
  const familyKey = getRuntimeModelFamilyKey(provider, modelId);
  if (!familyKey) return null;
  return reasoningEffort
    ? `${familyKey}:${encodeRuntimeModelKeyPart(reasoningEffort)}`
    : familyKey;
};

export const parseRuntimeModelKey = (key?: string | null): RuntimeModelIdentity | null => {
  if (!key) return null;
  const [provider, encodedModelId, encodedReasoningEffort, ...extra] = key.split(':');
  if (extra.length > 0 || !provider || !encodedModelId) return null;
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'opencode') return null;
  const modelId = decodeRuntimeModelKeyPart(encodedModelId);
  const reasoningEffort = encodedReasoningEffort
    ? decodeRuntimeModelKeyPart(encodedReasoningEffort)
    : null;
  if (!modelId || (encodedReasoningEffort && !reasoningEffort)) return null;
  return { provider, modelId, reasoningEffort };
};

const openCodeStatusRank: Record<RuntimeModelStatus, number> = {
  active: 0,
  beta: 1,
  alpha: 2,
  deprecated: 3,
};

export const compareOpenCodeCatalogModels = (
  left: { label: string; modelProvider: string; releaseDate?: string | null; status?: RuntimeModelStatus | null },
  right: { label: string; modelProvider: string; releaseDate?: string | null; status?: RuntimeModelStatus | null },
) => {
  const statusOrder = (left.status ? openCodeStatusRank[left.status] : 0)
    - (right.status ? openCodeStatusRank[right.status] : 0);
  if (statusOrder !== 0) return statusOrder;
  const releaseOrder = String(right.releaseDate || '').localeCompare(String(left.releaseDate || ''));
  if (releaseOrder !== 0) return releaseOrder;
  return left.label.localeCompare(right.label) || left.modelProvider.localeCompare(right.modelProvider);
};

const textReasoningCapabilities: RuntimeModelCapabilities = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  reasoningEffort: true,
};

export const reasoningEffortsByProvider = {
  claude: [
    { id: 'low', label: 'Low', description: 'Fastest responses with minimal reasoning' },
    { id: 'medium', label: 'Medium', description: 'Balanced reasoning and token use' },
    { id: 'high', label: 'High', description: 'Deep reasoning for complex work' },
    { id: 'xhigh', label: 'Extra High', description: 'Extended reasoning for demanding agentic work' },
    { id: 'max', label: 'Max', description: 'Maximum reasoning for the most demanding work' },
  ],
  codex: [
    { id: 'low', label: 'Low', description: 'Fastest supported Codex reasoning level' },
    { id: 'medium', label: 'Medium', description: 'Balanced Codex reasoning level' },
    { id: 'high', label: 'High', description: 'Deeper Codex reasoning level' },
    { id: 'xhigh', label: 'Extra High', description: 'Very deep Codex reasoning level' },
    { id: 'max', label: 'Max', description: 'Maximum Codex reasoning level' },
    { id: 'ultra', label: 'Ultra', description: 'Highest supported Codex reasoning level' },
  ],
} as const;

export const getReasoningEffortSortOrder = (
  provider: string,
  effort: string | null | undefined
): number => {
  if (provider !== 'claude' && provider !== 'codex') return 99;
  const normalized = String(effort || '').trim().toLowerCase();
  const index = reasoningEffortsByProvider[provider].findIndex((option) => option.id === normalized);
  return index === -1 ? 99 : index;
};

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
  effort: typeof reasoningEffortsByProvider.claude[number];
  description?: string;
}): RuntimeModel => ({
  key: getRuntimeModelKey('claude', id, effort.id)!,
  id: `${id}:${effort.id}`,
  provider: 'claude',
  modelId,
  familyKey: getRuntimeModelFamilyKey('claude', id)!,
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
  effort: typeof reasoningEffortsByProvider.codex[number];
}): RuntimeModel => ({
  key: getRuntimeModelKey('codex', id, effort.id)!,
  id: `${id}:${effort.id}`,
  provider: 'codex',
  modelId: id,
  familyKey: getRuntimeModelFamilyKey('codex', id)!,
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
  key: getRuntimeModelKey('codex', id)!,
  id,
  provider: 'codex',
  modelId: id,
  familyKey: getRuntimeModelFamilyKey('codex', id)!,
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
    id: 'claude-opus-5',
    modelId: 'claude-opus-5',
    label: 'Claude Opus 5',
    modelAlias: 'opus',
    description: 'Anthropic advanced model for complex agentic coding and enterprise work',
  },
  {
    id: 'claude-opus-4-8',
    modelId: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    modelAlias: 'claude-opus-4-8',
    description: 'Anthropic frontier model for complex reasoning and long-horizon agentic coding',
  },
  {
    id: 'claude-sonnet-5',
    modelId: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    modelAlias: 'sonnet',
    description: 'Anthropic model balancing speed and intelligence for agentic coding',
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

const claudeModels: RuntimeModel[] = claudeModelBases.flatMap((model) =>
  reasoningEffortsByProvider.claude.map((effort) => makeClaudeModel({ ...model, effort }))
);

const codexModels: RuntimeModel[] = codexModelBases.flatMap((model) =>
  reasoningEffortsByProvider.codex.map((effort) => makeCodexModel({ ...model, effort }))
);

const codexImageModels: RuntimeModel[] = codexImageModelBases.map((model) =>
  makeCodexImageModel(model)
);

// Bootstrap catalog used until the background/native catalog service has a
// fresher snapshot. Keep runtime discovery out of React render and send paths.
export const bootstrapRuntimeModels: RuntimeModel[] = [...codexModels, ...codexImageModels, ...claudeModels];

/** @deprecated Use the current catalog returned by useRuntimeModelCatalog. */
export const runtimeModels = bootstrapRuntimeModels;

const openCodeEffortLabel = (variant: string | null) => {
  if (!variant) return 'Default';
  return variant.charAt(0).toUpperCase() + variant.slice(1).replace(/_/g, ' ');
};

export const runtimeModelsFromOpenCodeCatalog = (models: OpenCodeRuntimeModel[]): RuntimeModel[] => (
  models.flatMap((model) => {
    const variants = model.variants.length > 0 ? model.variants : [null];
    return variants.map((variant) => ({
      key: getRuntimeModelKey('opencode', model.id, variant)!,
      id: variant ? `${model.id}:${variant}` : model.id,
      provider: 'opencode' as const,
      modelId: model.id,
      familyKey: getRuntimeModelFamilyKey('opencode', model.id)!,
      familyLabel: model.name,
      familyDescription: `${model.providerName} model available through OpenCode`,
      effortLabel: openCodeEffortLabel(variant),
      effortDescription: variant ? `${openCodeEffortLabel(variant)} OpenCode variant` : 'Provider default',
      reasoningEffort: variant,
      label: variant ? `${model.name} ${openCodeEffortLabel(variant)}` : model.name,
      providerLabel: `OpenCode · ${model.providerName}`,
      description: `${model.name} through ${model.providerName}`,
      cliArgs: `--model ${model.id}${variant ? ` --variant ${variant}` : ''}`,
      promptFlag: null,
      color: 'blue',
      capabilities: {
        inputModalities: model.inputModalities.filter((value): value is RuntimeModelModality => ['text', 'image', 'audio', 'pdf', 'video'].includes(value)),
        outputModalities: model.outputModalities.filter((value): value is RuntimeModelModality => ['text', 'image', 'audio', 'pdf', 'video'].includes(value)),
        reasoningEffort: model.variants.length > 0,
        reasoning: model.reasoning,
        toolCall: model.toolCall,
        attachments: model.attachment,
      },
      releaseDate: model.releaseDate,
      status: model.status === 'active' || model.status === 'beta' || model.status === 'alpha' || model.status === 'deprecated'
        ? model.status
        : null,
      isFree: model.isFree,
    }));
  })
);

export const openCodeRuntimeModelsFromCatalogRecords = (
  records: RuntimeModelCatalogRecord[],
): OpenCodeRuntimeModel[] => records.flatMap((record) => {
  if (record.provider !== 'opencode') return [];
  const separator = record.cliModelId.indexOf('/');
  const providerId = record.upstreamProviderId
    ?? (separator > 0 ? record.cliModelId.slice(0, separator) : 'opencode');
  const modelId = separator > 0
    ? record.cliModelId.slice(separator + 1)
    : record.cliModelId;
  return [{
    id: record.cliModelId,
    providerId,
    providerName: record.providerName ?? providerId,
    modelId,
    name: record.name,
    reasoning: record.reasoning ?? (record.supportedReasoningEfforts?.length ?? 0) > 0,
    attachment: record.attachment ?? (record.inputModalities ?? []).some((value) => value !== 'text'),
    toolCall: record.toolCall ?? true,
    inputModalities: record.inputModalities ?? [],
    outputModalities: record.outputModalities ?? [],
    variants: record.supportedReasoningEfforts ?? [],
    contextWindow: record.contextWindow ?? null,
    maxOutputTokens: record.maxOutputTokens ?? null,
    releaseDate: record.releaseDate ?? null,
    status: record.status ?? null,
    isFree: record.isFree ?? null,
  }];
});

const runtimeModalities = (values: string[] | undefined): RuntimeModelModality[] => (
  (values ?? []).filter((value): value is RuntimeModelModality => (
    ['text', 'image', 'audio', 'pdf', 'video'].includes(value)
  ))
);

const runtimeModelStatus = (status: string | null | undefined): RuntimeModelStatus | null => (
  status === 'active' || status === 'beta' || status === 'alpha' || status === 'deprecated'
    ? status
    : null
);

const reasoningEffortMetadata = (provider: 'codex' | 'claude', effort: string | null) => {
  if (!effort) {
    return { label: 'Default', description: 'Provider default reasoning level' };
  }
  const known = reasoningEffortsByProvider[provider].find((option) => option.id === effort);
  return known ?? {
    label: effort.charAt(0).toUpperCase() + effort.slice(1).replace(/_/g, ' '),
    description: `${provider === 'codex' ? 'Codex' : 'Claude'} ${effort} reasoning level`,
  };
};

export const runtimeModelsFromNativeCatalog = (
  records: RuntimeModelCatalogRecord[],
): RuntimeModel[] => records.flatMap((record) => {
  if (record.provider !== 'codex' && record.provider !== 'claude') return [];
  const provider = record.provider;
  const inputModalities = runtimeModalities(record.inputModalities);
  const outputModalities = runtimeModalities(record.outputModalities);
  const isImageOutput = outputModalities.includes('image');
  const advertisedEfforts = isImageOutput ? [] : (record.supportedReasoningEfforts ?? []);
  const efforts: Array<string | null> = advertisedEfforts.length > 0
    ? advertisedEfforts
    : [null];
  const familyKey = getRuntimeModelFamilyKey(provider, record.canonicalModelId)!;

  return efforts.map((effort) => {
    const effortMeta = reasoningEffortMetadata(provider, effort);
    const label = effort ? `${record.name} ${effortMeta.label}` : record.name;
    const effortArg = effort
      ? provider === 'codex'
        ? ` --reasoning-effort ${effort}`
        : ` --effort ${effort}`
      : '';
    const cliArgs = provider === 'codex'
      ? `--model ${record.cliModelId}${effortArg}`
      : `--permission-mode auto --print --output-format stream-json --verbose --no-session-persistence --model ${record.cliModelId}${effortArg}`;

    return {
      key: getRuntimeModelKey(provider, record.canonicalModelId, effort)!,
      id: effort ? `${record.canonicalModelId}:${effort}` : record.canonicalModelId,
      provider,
      modelId: record.cliModelId,
      canonicalModelId: record.canonicalModelId,
      familyKey,
      familyLabel: record.name,
      familyDescription: record.description || `${record.name} runtime model`,
      effortLabel: isImageOutput ? 'Image' : effortMeta.label,
      effortDescription: isImageOutput ? 'Image generation and editing' : effortMeta.description,
      reasoningEffort: effort,
      label,
      providerLabel: provider === 'codex' ? 'Codex' : 'Claude',
      description: record.description || label,
      cliArgs,
      promptFlag: null,
      color: provider === 'codex' ? 'green' : 'amber',
      capabilities: {
        inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
        outputModalities: outputModalities.length > 0 ? outputModalities : ['text'],
        reasoningEffort: advertisedEfforts.length > 0,
        reasoning: advertisedEfforts.length > 0,
        toolCall: !isImageOutput,
        attachments: inputModalities.some((modality) => modality !== 'text'),
      },
      releaseDate: record.releaseDate ?? null,
      status: runtimeModelStatus(record.status),
      isFree: record.isFree ?? null,
    };
  });
});

export const defaultRuntimeModelKey = 'codex:gpt-5.5:high';

export const getRuntimeModelByKey = (
  key?: string | null,
  catalog: readonly RuntimeModel[] = bootstrapRuntimeModels,
): RuntimeModel | null => catalog.find((model) => model.key === key) ?? null;

export const getRuntimeModelByProviderAndId = (
  provider?: string | null,
  modelId?: string | null,
  catalog: readonly RuntimeModel[] = bootstrapRuntimeModels,
  reasoningEffort?: string | null,
): RuntimeModel | null => {
  if (!provider || !modelId) return null;
  return catalog.find((model) => (
    model.provider === provider
    && (model.modelId === modelId || model.canonicalModelId === modelId)
    && (reasoningEffort == null || model.reasoningEffort === reasoningEffort)
  )) ?? null;
};

export const getRuntimeModelById = (
  modelId?: string | null,
  catalog: readonly RuntimeModel[] = bootstrapRuntimeModels,
): RuntimeModel | null => {
  if (!modelId) return null;
  return catalog.find((model) => (
    model.modelId === modelId || model.canonicalModelId === modelId
  )) ?? null;
};

export const getRuntimeModelLabel = (
  modelId?: string | null,
  provider?: string | null,
  catalog: readonly RuntimeModel[] = bootstrapRuntimeModels,
): string => {
  const runtimeModel = getRuntimeModelByProviderAndId(provider, modelId, catalog)
    ?? getRuntimeModelById(modelId, catalog);
  if (runtimeModel) return runtimeModel.label;
  if (!modelId) return 'Unknown Model';
  return modelId.split('/').pop()?.split(':').shift() || modelId;
};

export const projectRuntimeCatalogModel = (model: RuntimeModel): RuntimeCatalogModel => ({
  id: model.modelId,
  key: model.key,
  provider: model.provider,
  name: model.label,
  description: model.description,
  inputModalities: model.capabilities.inputModalities,
  outputModalities: model.capabilities.outputModalities,
  isFree: model.isFree === true,
});
