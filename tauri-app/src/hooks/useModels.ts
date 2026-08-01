import { useQuery } from '@tanstack/react-query';
import { RuntimeCatalogModel } from '../stores/modelStore';
import { runtimeModels } from '../lib/runtimeModels';

export const useModels = () => {
    return useQuery<RuntimeCatalogModel[]>({
        queryKey: ['models'],
        queryFn: async () => {
            return runtimeModels.map((model) => ({
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
                    modality: 'text',
                    tokenizer: model.provider,
                    instruct_type: 'agentic',
                    input_modalities: ['text'],
                    output_modalities: ['text'],
                },
                top_provider: {
                    max_completion_tokens: null,
                    is_moderated: false,
                },
                per_request_limits: null,
                isFree: false,
                supportsImageInput: false,
            }));
        },
        initialData: runtimeModels.map((model) => ({
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
                modality: 'text',
                tokenizer: model.provider,
                instruct_type: 'agentic',
                input_modalities: ['text'],
                output_modalities: ['text'],
            },
            top_provider: {
                max_completion_tokens: null,
                is_moderated: false,
            },
            per_request_limits: null,
            isFree: false,
            supportsImageInput: false,
        })),
        staleTime: Infinity,
    });
};
