import { useQuery } from '@tanstack/react-query';
import type { AgentResourceUsage } from '../lib/agentClient';
import { agentResourceUsageApplication } from '../application/agentResourceUsage';

const AGENT_RESOURCE_REFRESH_MS = 5_000;

export const useAgentResourceUsage = (
  assistantNodeId: string | null | undefined,
  enabled: boolean,
): AgentResourceUsage | null => {
  const query = useQuery({
    queryKey: ['agent-resource-usage'],
    queryFn: () => agentResourceUsageApplication.list(),
    enabled: enabled && Boolean(assistantNodeId) && agentResourceUsageApplication.isAvailable(),
    staleTime: AGENT_RESOURCE_REFRESH_MS - 500,
    refetchInterval: enabled ? AGENT_RESOURCE_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });

  return query.data?.find((usage) => usage.assistantNodeId === assistantNodeId) ?? null;
};
