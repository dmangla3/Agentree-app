import { agentClient, type AgentResourceUsage } from '../lib/agentClient';

const isAvailable = (): boolean => agentClient.hasRuntime();
const list = async (): Promise<AgentResourceUsage[]> => agentClient.listAgentResourceUsage();

export const agentResourceUsageApplication = {
  isAvailable,
  list,
};
