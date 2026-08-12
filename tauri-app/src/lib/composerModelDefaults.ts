import { getRuntimeModelKey, runtimeModels } from './runtimeModels';

type ComposerAgent = {
  id: string;
  type?: string | null;
  model_config?: {
    model?: string | null;
    reasoningEffort?: string | null;
  } | null;
};

type ComposerParentMessage = {
  role?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  agent_id?: string | null;
  execution_data?: {
    meta?: Record<string, unknown> | null;
  } | null;
} | null;

export const defaultRootRuntimeModelKey = 'codex:gpt-5.5:high';

const stringValue = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const getParentRuntimeModelPreference = (parentMessage: ComposerParentMessage): {
  key: string | null;
  provider: string | null;
  model: string | null;
} | null => {
  if (!parentMessage) return null;

  const agentId = stringValue(parentMessage.agent_id);
  if (agentId && runtimeModels.some((model) => model.key === agentId)) {
    const runtimeModel = runtimeModels.find((model) => model.key === agentId);
    return {
      key: agentId,
      provider: runtimeModel?.provider ?? null,
      model: runtimeModel?.modelId ?? null,
    };
  }

  const meta = parentMessage.execution_data?.meta ?? {};
  const provider = stringValue(parentMessage.llmProvider)
    ?? stringValue(meta.provider)
    ?? stringValue(meta.provider_selected_provider);
  const model = stringValue(parentMessage.llmModel)
    ?? stringValue(meta.provider_model);
  const reasoningEffort = stringValue(meta.provider_reasoning_effort);

  const exactKey = getRuntimeModelKey(provider, model, reasoningEffort);
  if (exactKey && runtimeModels.some((runtimeModel) => runtimeModel.key === exactKey)) {
    return { key: exactKey, provider, model };
  }

  const matchingModel = runtimeModels.find((runtimeModel) => (
    runtimeModel.provider === provider && runtimeModel.modelId === model
  ));
  return { key: matchingModel?.key ?? null, provider, model };
};

export const resolveComposerDefaultAgentId = ({
  agents,
  parentMessage,
}: {
  agents: ComposerAgent[];
  parentMessage: ComposerParentMessage;
}): string | null => {
  const parentPreference = getParentRuntimeModelPreference(parentMessage);
  if (parentPreference?.key && agents.some((agent) => agent.id === parentPreference.key)) {
    return parentPreference.key;
  }

  if (parentPreference?.provider && parentPreference.model) {
    const matchingAgent = agents.find((agent) => (
      agent.type === parentPreference.provider
      && agent.model_config?.model === parentPreference.model
    ));
    if (matchingAgent) return matchingAgent.id;
  }

  if (agents.some((agent) => agent.id === defaultRootRuntimeModelKey)) {
    return defaultRootRuntimeModelKey;
  }

  return agents.find((agent) => agent.type === 'codex')?.id ?? agents[0]?.id ?? null;
};
