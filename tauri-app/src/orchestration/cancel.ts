import { isActiveAgentStatus } from '@shared/agentStatus';
import type { Message } from '../stores/workspaceStore';
import { cancelOrchestration, type CancelOrchestrationDeps } from './controlPlane';
import { getControlledByNodeId, getNodeKind } from './domain';
import { getOrchestratorRunId } from './startupRecovery';

export interface CancelOrchestrationTargetInput {
  targetNodeId: string;
  messages: Message[];
  reason?: string | null;
}

export interface CancelOrchestrationTargetResult {
  handled: boolean;
  stoppedAssistantNodeIds: string[];
}

export async function cancelOrchestrationTargetIfNeeded(
  input: CancelOrchestrationTargetInput,
  deps: CancelOrchestrationDeps,
): Promise<CancelOrchestrationTargetResult> {
  const targetMessage = input.messages.find((message) => message.id === input.targetNodeId) ?? null;
  if (!targetMessage || targetMessage.role !== 'assistant') {
    return { handled: false, stoppedAssistantNodeIds: [] };
  }
  if (getNodeKind(targetMessage) !== 'orchestrator') {
    return { handled: false, stoppedAssistantNodeIds: [] };
  }

  const orchestratorRunId = getOrchestratorRunId(targetMessage);
  if (!orchestratorRunId) {
    return { handled: false, stoppedAssistantNodeIds: [] };
  }

  const activeOrchestrationRunAssistantNodeIds = input.messages
    .filter((message) => message.role === 'assistant')
    .filter((message) => getControlledByNodeId(message) === input.targetNodeId)
    .filter((message) => isActiveAgentStatus(message.status))
    .map((message) => message.id);

  const result = await cancelOrchestration({
    orchestratorRunId,
    orchestratorNodeId: input.targetNodeId,
    activeOrchestrationRunAssistantNodeIds,
    reason: input.reason ?? 'cancelled',
  }, deps);

  return {
    handled: true,
    stoppedAssistantNodeIds: result.stoppedAssistantNodeIds,
  };
}
