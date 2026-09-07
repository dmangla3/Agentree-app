import { useEffect, useMemo, useRef } from 'react';
import { agentClient } from '../lib/agentClient';
import type { Message } from '../stores/workspaceStore';
import {
  parseOrchestrationJournalEvent,
  planOrchestrationRecoveryAction,
  recoverOrchestrationProjection,
} from './domain';
import {
  applyOrchestrationRecoveryAction,
  findRecoverableOrchestratorRuns,
} from './startupRecovery';

export const useOrchestrationStartupRecovery = (
  workspaceId: string | null | undefined,
  messages: Message[],
) => {
  const recoverableRuns = useMemo(
    () => findRecoverableOrchestratorRuns(messages),
    [messages],
  );
  const appliedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!workspaceId || !agentClient.hasRuntime() || recoverableRuns.length === 0) return;

    let cancelled = false;
    void (async () => {
      for (const orchestrator of recoverableRuns) {
        const journalRows = await agentClient.replayAgentRunEvents(orchestrator.runId, 0);
        if (cancelled) return;
        const events = journalRows
          .map(parseOrchestrationJournalEvent)
          .filter((event): event is NonNullable<typeof event> => Boolean(event));
        const projection = recoverOrchestrationProjection({
          orchestratorNodeId: orchestrator.orchestratorNodeId,
          events,
          messages,
        });
        const action = planOrchestrationRecoveryAction(projection);
        if (action.type === 'none') {
          continue;
        }
        const key = `${workspaceId}:${orchestrator.runId}:${projection.lastSeq}:${action.type}`;
        if (appliedKeysRef.current.has(key)) continue;
        appliedKeysRef.current.add(key);
        const result = await applyOrchestrationRecoveryAction({
          orchestratorRunId: orchestrator.runId,
          orchestratorNodeId: orchestrator.orchestratorNodeId,
          projection,
          action,
        }, {
          recordOrchestrationEvent: (runId, assistantNodeId, eventType, payload) => (
            agentClient.recordOrchestrationEvent(runId, assistantNodeId, eventType, payload)
          ),
          stopAgent: (assistantNodeId) => agentClient.stopAgent(assistantNodeId),
        });
        if (cancelled || result.skippedReason) {
          appliedKeysRef.current.delete(key);
        }
      }
    })().catch((error) => {
      console.warn('[orchestration] startup recovery failed:', error);
    });

    return () => {
      cancelled = true;
    };
  }, [messages, recoverableRuns, recoverableRuns.length, workspaceId]);
};
