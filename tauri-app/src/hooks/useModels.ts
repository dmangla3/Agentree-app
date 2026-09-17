import { useQuery } from '@tanstack/react-query';
import { RuntimeCatalogModel } from '../stores/modelStore';
import { runtimeModels } from '../lib/runtimeModels';

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
    isFree: false,
    supportsImageInput: model.capabilities.inputModalities.includes('image'),
});

export const useModels = () => {
    return useQuery<RuntimeCatalogModel[]>({
        queryKey: ['models'],
        queryFn: async () => {
            return runtimeModels.map(catalogModelFromRuntimeModel);
        },
        initialData: runtimeModels.map(catalogModelFromRuntimeModel),
        staleTime: Infinity,
    });
};
