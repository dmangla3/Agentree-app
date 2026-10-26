import { useQuery } from '@tanstack/react-query';
import type { RuntimeCatalogModel } from '../stores/modelStore';
import { runtimeModels, runtimeModelsFromOpenCodeCatalog } from '../lib/runtimeModels';
import { agentClient } from '../lib/agentClient';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';

const catalogModelFromRuntimeModel = (model: typeof runtimeModels[number]): RuntimeCatalogModel => ({
    id: model.modelId,
    name: model.label,
    description: model.description,
    pricing: {
        prompt: '0',
        completion: '0',
        request: '0',
        image: '0',
    },
    context_length: null,
    architecture: {
        modality: model.capabilities.outputModalities.includes('image') ? 'multimodal' : 'text',
        tokenizer: model.provider,
        instruct_type: 'agentic',
        input_modalities: model.capabilities.inputModalities,
        output_modalities: model.capabilities.outputModalities,
    },
    top_provider: {
        max_completion_tokens: null,
        is_moderated: false,
    },
    per_request_limits: null,
    isFree: model.isFree === true,
    supportsImageInput: model.capabilities.inputModalities.includes('image'),
});

export const runtimeCatalogModels = runtimeModels.map(catalogModelFromRuntimeModel);

export const useModels = () => {
    const opencodeProfile = useLoginProfilesStore((state) => {
        const profiles = state.profiles.filter((profile) => profile.provider === 'opencode');
        return profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
    });
    const opencodeProfileId = opencodeProfile?.id ?? null;

    return useQuery<RuntimeCatalogModel[]>({
        queryKey: ['models', 'opencode', opencodeProfileId, opencodeProfile?.lastCheckedAt ?? null],
        queryFn: async () => {
            const openCodeModels = opencodeProfileId
                ? runtimeModelsFromOpenCodeCatalog(await agentClient.listOpenCodeModels(opencodeProfileId))
                : [];
            return [...runtimeModels, ...openCodeModels].map(catalogModelFromRuntimeModel);
        },
        initialData: runtimeCatalogModels,
        staleTime: 60_000,
        refetchOnMount: 'always',
    });
};
