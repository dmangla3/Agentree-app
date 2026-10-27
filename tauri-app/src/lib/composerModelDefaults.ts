import { defaultRuntimeModelKey, type AgentModelConfig, getRuntimeModelKey } from './runtimeModels';

type ComposerAgent = {
  id: string;
  type?: string | null;
  model_config?: AgentModelConfig | null;
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

export const defaultRootRuntimeModelKey = defaultRuntimeModelKey;

const stringValue = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const getParentRuntimeModelPreference = (
  parentMessage: ComposerParentMessage,
  agents: ComposerAgent[],
): {
  key: string | null;
  provider: string | null;
  model: string | null;
} | null => {
  if (!parentMessage) return null;

  const agentId = stringValue(parentMessage.agent_id);
  const parentAgent = agentId ? agents.find((agent) => agent.id === agentId) : null;
  if (parentAgent) {
    return {
      key: parentAgent.id,
      provider: stringValue(parentAgent.type),
      model: stringValue(parentAgent.model_config?.model),
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
  if (exactKey && agents.some((agent) => agent.id === exactKey)) {
    return { key: exactKey, provider, model };
  }

  const matchingModel = agents.find((agent) => (
    agent.type === provider && agent.model_config?.model === model
  ));
  return { key: matchingModel?.id ?? null, provider, model };
};

export const resolveComposerDefaultAgentId = ({
  agents,
  fallbackAgents = agents,
  parentMessage,
}: {
  agents: ComposerAgent[];
  fallbackAgents?: ComposerAgent[];
  parentMessage: ComposerParentMessage;
}): string | null => {
  const parentPreference = getParentRuntimeModelPreference(parentMessage, agents);
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

  if (fallbackAgents.some((agent) => agent.id === defaultRootRuntimeModelKey)) {
    return defaultRootRuntimeModelKey;
  }

  return fallbackAgents.find((agent) => agent.type === 'codex')?.id ?? fallbackAgents[0]?.id ?? null;
};
