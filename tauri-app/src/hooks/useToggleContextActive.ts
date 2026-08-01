import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Message } from '../stores/workspaceStore';

export const useToggleContextActive = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({
            messageIds,
            active,
        }: {
            messageIds: string[];
            active: boolean;
        }) => {
            await api.put('/messages/batch/context-active', {
                messageIds,
                active,
            });
        },
        onMutate: async ({ messageIds, active }) => {
            await queryClient.cancelQueries({ queryKey: ['messages'] });

            const previous = queryClient.getQueriesData<Message[]>({ queryKey: ['messages'] });

            for (const [queryKey, data] of previous) {
                if (!Array.isArray(data)) continue;
                const updated = data.map((msg) =>
                    messageIds.includes(msg.id)
                        ? { ...msg, context_active: active }
                        : msg
                );
                queryClient.setQueryData(queryKey, updated);
            }

            return { previous };
        },
        onError: (_err, _vars, context) => {
            if (!context?.previous) return;
            for (const [queryKey, data] of context.previous) {
                queryClient.setQueryData(queryKey, data);
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'], refetchType: 'none' });
        },
    });
};
