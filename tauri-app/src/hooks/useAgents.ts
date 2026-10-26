import { useQuery } from '@tanstack/react-query';
import {
    type AgentModelConfig,
    defaultRuntimeModelKey,
    getRuntimeModelByKey,
    runtimeModels,
    runtimeModelsFromOpenCodeCatalog,
} from '../lib/runtimeModels';
import { agentClient } from '../lib/agentClient';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';

export interface Agent {
    id: string;
    name: string;
    type: string;
    tools?: string[];
    model_config?: AgentModelConfig | null;
    cliArgs?: string;  // Raw CLI arguments for this agent
    promptFlag?: string | null;
    color?: string;    // Color theme for the agent
}

const agentsFromRuntimeModels = (models: typeof runtimeModels): Agent[] => models.map((model) => ({
    id: model.key,
    name: model.label,
    type: model.provider,
    tools: [],
    model_config: {
        model: model.modelId,
        modelProvider: model.provider === 'opencode' ? model.modelId.split('/')[0] : model.provider,
        familyKey: model.familyKey,
        familyLabel: model.familyLabel,
        familyDescription: model.familyDescription,
        effortLabel: model.effortLabel,
        effortDescription: model.effortDescription,
        reasoningEffort: model.reasoningEffort ?? null,
        capabilities: model.capabilities,
        releaseDate: model.releaseDate ?? null,
        status: model.status ?? null,
        isFree: model.isFree ?? null,
    },
    cliArgs: model.cliArgs,
    promptFlag: model.promptFlag,
    color: model.color,
}));

export const runtimeAgents: Agent[] = agentsFromRuntimeModels(runtimeModels);

export function findDefaultCodexAgentId(agents: Agent[]): string | null {
    const preferred = getRuntimeModelByKey(defaultRuntimeModelKey);
    if (preferred) {
        const exact = agents.find((agent) => agent.id === preferred.key);
        if (exact) return exact.id;
    }

    const codexAgent = agents.find((agent) => agent.type === 'codex');
    if (codexAgent) return codexAgent.id;

    const nameMatch = agents.find((agent) => agent.name?.toLowerCase().includes('codex'));
    return nameMatch?.id ?? null;
}

export function useAgents() {
    const opencodeProfile = useLoginProfilesStore((state) => {
        const profiles = state.profiles.filter((profile) => profile.provider === 'opencode');
        return profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
    });
    const opencodeProfileId = opencodeProfile?.id ?? null;

    return useQuery({
        queryKey: ['agents', 'opencode', opencodeProfileId, opencodeProfile?.lastCheckedAt ?? null],
        queryFn: async (): Promise<Agent[]> => {
            if (!opencodeProfileId) return runtimeAgents;
            const catalog = await agentClient.listOpenCodeModels(opencodeProfileId);
            return [...runtimeAgents, ...agentsFromRuntimeModels(runtimeModelsFromOpenCodeCatalog(catalog))];
        },
        initialData: runtimeAgents,
        staleTime: 60_000,
        refetchOnMount: 'always',
    });
}
