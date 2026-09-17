import { useQuery } from '@tanstack/react-query';
import {
    type AgentModelConfig,
    defaultRuntimeModelKey,
    getRuntimeModelByKey,
    runtimeModels,
} from '../lib/runtimeModels';

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
    return useQuery({
        queryKey: ['agents'],
        queryFn: async (): Promise<Agent[]> => {
            return runtimeModels.map((model) => ({
                id: model.key,
                name: model.label,
                type: model.provider,
                tools: [],
                model_config: {
                    model: model.modelId,
                    familyKey: model.familyKey,
                    familyLabel: model.familyLabel,
                    familyDescription: model.familyDescription,
                    effortLabel: model.effortLabel,
                    effortDescription: model.effortDescription,
                    reasoningEffort: model.reasoningEffort ?? null,
                    capabilities: model.capabilities,
                },
                cliArgs: model.cliArgs,
                promptFlag: model.promptFlag,
                color: model.color,
            }));
        },
        initialData: runtimeModels.map((model) => ({
            id: model.key,
            name: model.label,
            type: model.provider,
            tools: [],
            model_config: {
                model: model.modelId,
                familyKey: model.familyKey,
                familyLabel: model.familyLabel,
                familyDescription: model.familyDescription,
                effortLabel: model.effortLabel,
                effortDescription: model.effortDescription,
                reasoningEffort: model.reasoningEffort ?? null,
                capabilities: model.capabilities,
            },
            cliArgs: model.cliArgs,
            promptFlag: model.promptFlag,
            color: model.color,
        })),
        staleTime: Infinity,
    });
}
