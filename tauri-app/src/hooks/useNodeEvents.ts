import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface NodeEvent {
  id: string;
  type: string;
  timestamp: number;
  [key: string]: any;
}

export const useNodeEvents = (nodeId: string | null | undefined, options?: { enabled?: boolean; limit?: number }) => {
  const limit = options?.limit ?? 200;
  return useQuery<{ events: NodeEvent[] }>(
    {
      queryKey: ['nodeEvents', nodeId, limit],
      enabled: Boolean(nodeId) && (options?.enabled ?? true),
      queryFn: async () => {
        const response = await api.get(`/nodes/${nodeId}/events`, { params: { limit, order: 'asc' } });
        return response.data;
      },
      staleTime: 1000,
    }
  );
};
