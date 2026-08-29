import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AGENT_STATUS } from '@shared/agentStatus';
import { agentClient, type LocalInsightRecord } from '../lib/agentClient';
import { getAccessToken } from '../lib/authSession';
import { queueLocalSyncFlush } from '../lib/localSyncScheduler';
import { useWorkspaceStore, type Insight, type Message, type Workspace } from '../stores/workspaceStore';
import type { Agent } from './useAgents';

interface UseInsightsOptions {
  enabled?: boolean;
  debounceMs?: number;
  messages?: Message[];
  agents?: Agent[];
  workspace?: Workspace | null;
}

const INSIGHT_AGENT_PROMPT = `You are a local background insight agent for Agentree.

Generate 1-3 useful insights from the recent conversation. Prefer divergent thinking:
- competing hypotheses
- explicit doubts or alternative branches
- surprising associations
- meta observations about the work

Return only valid JSON in this exact shape:
{
  "insights": [
    {
      "agentType": "hypothesis",
      "content": "one concise surfaced insight",
      "fullExploration": "short supporting analysis",
      "reasoning": "why this matters",
      "confidence": 0.65
    }
  ]
}

Allowed agentType values: hypothesis, doubt, meta, association, memory, kb. Do not include markdown.`;

const splitCliArgs = (value: string | null | undefined): string[] => (
  String(value || '').split(/\s+/).filter(Boolean)
);

const buildAgentArgs = (agent: Agent, prompt: string): string[] => {
  const args = splitCliArgs(agent.cliArgs);
  if (agent.type === 'codex' || !agent.promptFlag) return [...args, prompt];
  return [...args, agent.promptFlag, prompt];
};

const parseLocalInsight = (row: LocalInsightRecord): Insight | null => {
  try {
    const payload = JSON.parse(row.payload);
    if (!payload || typeof payload.id !== 'string' || typeof payload.content !== 'string') return null;
    return payload as Insight;
  } catch {
    return null;
  }
};

const providerForMessage = (message: Message | null | undefined): string | null => {
  const executionMeta = message?.execution_data?.meta as Record<string, unknown> | undefined;
  return (
    message?.llmProvider
    ?? (typeof executionMeta?.provider === 'string' ? executionMeta.provider : null)
    ?? (typeof executionMeta?.provider_selected_provider === 'string' ? executionMeta.provider_selected_provider : null)
  );
};

const modelForMessage = (message: Message | null | undefined): string | null => {
  const executionMeta = message?.execution_data?.meta as Record<string, unknown> | undefined;
  return (
    message?.llmModel
    ?? (typeof executionMeta?.provider_model === 'string' ? executionMeta.provider_model : null)
    ?? null
  );
};

const chooseInsightAgent = (agents: Agent[], parent: Message | null): Agent | null => {
  const provider = providerForMessage(parent);
  const model = modelForMessage(parent);
  if (provider && model) {
    const exact = agents.find((agent) => agent.type === provider && agent.model_config?.model === model);
    if (exact) return exact;
  }
  if (provider) {
    const sameProvider = agents.find((agent) => agent.type === provider);
    if (sameProvider) return sameProvider;
  }
  return agents.find((agent) => agent.type === 'codex') ?? agents[0] ?? null;
};

const isCompletedAssistant = (message: Message): boolean => {
  if (message.role !== 'assistant') return false;
  const terminalStatus = message.execution_data?.last_terminal_status;
  return (
    message.status === AGENT_STATUS.completed
    || terminalStatus === AGENT_STATUS.completed
    || (!message.status && Boolean(message.content?.trim()))
  );
};

const readCommitForInsightRun = (parent: Message | null, workspace: Workspace | null | undefined): string | null => (
  parent?.output_commit_sha
  ?? parent?.base_commit_sha
  ?? workspace?.base_commit_sha
  ?? null
);

const branchContext = (messages: Message[], parent: Message): string => {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const chain: Message[] = [];
  const seen = new Set<string>();
  let cursor: Message | undefined = parent;
  while (cursor && !seen.has(cursor.id) && chain.length < 12) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain
    .reverse()
    .map((message) => `${message.role.toUpperCase()} ${message.id}\n${String(message.content || '').slice(0, 2000)}`)
    .join('\n\n');
};

const legacyInsightParentStorageKey = (workspaceId: string): string => (
  `agentree.insights.lastParentNodeId.v1.${workspaceId}`
);

const processedInsightParentsStorageKey = (workspaceId: string): string => (
  `agentree.insights.processedParentNodeIds.v1.${workspaceId}`
);

const readProcessedInsightParentNodeIds = (workspaceId: string | null): Set<string> => {
  const processed = new Set<string>();
  if (!workspaceId || typeof window === 'undefined') return processed;
  try {
    const raw = window.localStorage.getItem(processedInsightParentsStorageKey(workspaceId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      parsed.forEach((value) => {
        if (typeof value === 'string' && value) processed.add(value);
      });
    }
    const legacyParentId = window.localStorage.getItem(legacyInsightParentStorageKey(workspaceId));
    if (legacyParentId) processed.add(legacyParentId);
  } catch {
    // Best-effort duplicate suppression only.
  }
  return processed;
};

const rememberProcessedInsightParentNodeId = (workspaceId: string, parentNodeId: string) => {
  if (typeof window === 'undefined') return;
  try {
    const processed = readProcessedInsightParentNodeIds(workspaceId);
    processed.add(parentNodeId);
    window.localStorage.setItem(
      processedInsightParentsStorageKey(workspaceId),
      JSON.stringify(Array.from(processed).slice(-500)),
    );
  } catch {
    // Best-effort duplicate suppression only.
  }
};

const insightRowsFingerprint = (rows: LocalInsightRecord[]): string => (
  rows
    .map((row) => `${row.workspaceId}:${row.insightId}:${row.updatedAt}:${row.syncStatus}:${row.payload}`)
    .join('|')
);

const isTerminalInsightRunState = (state: Awaited<ReturnType<typeof agentClient.getAgentRunState>> | null): boolean => {
  const ledger = state?.ledger as Record<string, unknown> | null | undefined;
  const status = String(ledger?.terminalStatus ?? ledger?.status ?? '');
  return [
    'completed',
    'failed',
    'cancelled',
    'error',
    'failed_setup',
    'failed_spawn',
    'failed_runtime',
    'failed_finalization',
    'needs_user_action',
  ].includes(status);
};

export function useInsights(
  workspaceId: string | null,
  messageCount: number,
  options: UseInsightsOptions = {},
) {
  const { enabled = true, messages = [], agents = [], workspace = null } = options;

  const setInsights = useWorkspaceStore((state) => state.setInsights);
  const dismissInsightInStore = useWorkspaceStore((state) => state.dismissInsight);
  const setLoadingInsights = useWorkspaceStore((state) => state.setLoadingInsights);

  const queuedParentIdsRef = useRef<string[]>([]);
  const queuedParentIdSetRef = useRef<Set<string>>(new Set());
  const activeRunRef = useRef<string | null>(null);
  const activeParentRef = useRef<string | null>(null);
  const lastRowsFingerprintRef = useRef<string | null>(null);
  const processInsightQueueRef = useRef<() => void>(() => undefined);

  const completedAssistantMessages = useMemo(() => {
    return messages.filter(isCompletedAssistant);
  }, [messages]);

  const completedAssistantById = useMemo(() => (
    new Map(completedAssistantMessages.map((message) => [message.id, message]))
  ), [completedAssistantMessages]);

  const loadLocalInsights = useCallback(async () => {
    if (!workspaceId || !agentClient.hasRuntime()) {
      if (lastRowsFingerprintRef.current !== '') {
        lastRowsFingerprintRef.current = '';
        setInsights([]);
      }
      return [];
    }
    const rows = await agentClient.listLocalInsights(workspaceId);
    const fingerprint = insightRowsFingerprint(rows);
    if (fingerprint === lastRowsFingerprintRef.current) {
      return rows.map(parseLocalInsight).filter((insight): insight is Insight => Boolean(insight));
    }
    const insights = rows.map(parseLocalInsight).filter((insight): insight is Insight => Boolean(insight));
    lastRowsFingerprintRef.current = fingerprint;
    setInsights(insights);
    if (rows.some((row) => row.syncStatus === 'local_only')) {
      queueLocalSyncFlush({ reason: 'local-insights' });
    }
    return insights;
  }, [setInsights, workspaceId]);

  useEffect(() => {
    void loadLocalInsights().catch((error) => {
      console.error('[useInsights] Failed to load local insights:', error);
    });
  }, [loadLocalInsights]);

  const watchInsightRun = useCallback((runNodeId: string) => {
    let attempts = 0;
    const tick = () => {
      if (activeRunRef.current !== runNodeId) return;
      attempts += 1;
      void agentClient.getAgentRunState(runNodeId)
        .then(async (state) => {
          if (isTerminalInsightRunState(state)) {
            await loadLocalInsights();
            queueLocalSyncFlush({ reason: 'local-insight-run-terminal' });
            activeRunRef.current = null;
            activeParentRef.current = null;
            setLoadingInsights(false);
            processInsightQueueRef.current();
          }
        })
        .catch((error) => console.error('[useInsights] Failed to watch local insight run:', error))
        .finally(() => {
          if (attempts < 40 && activeRunRef.current === runNodeId) {
            window.setTimeout(tick, 3000);
          } else if (activeRunRef.current === runNodeId) {
            activeRunRef.current = null;
            activeParentRef.current = null;
            setLoadingInsights(false);
            processInsightQueueRef.current();
          }
        });
    };
    window.setTimeout(tick, 3000);
  }, [loadLocalInsights, setLoadingInsights]);

  const startInsightRunForParent = useCallback(async (parent: Message) => {
    if (!workspaceId || !agentClient.hasRuntime() || !workspace) {
      console.info('[useInsights] Skipping local insight generation:', {
        reason: 'missing-runtime-or-workspace',
        workspaceId,
        hasRuntime: agentClient.hasRuntime(),
        hasWorkspace: Boolean(workspace),
      });
      return;
    }
    if (activeRunRef.current) {
      queuedParentIdsRef.current.unshift(parent.id);
      queuedParentIdSetRef.current.add(parent.id);
      return;
    }

    const agent = chooseInsightAgent(agents, parent);
    const repoPath = workspace.git_repo_path ?? workspace.folderPath ?? null;
    const parentCommit = readCommitForInsightRun(parent, workspace);
    if (!agent || !repoPath || !parentCommit) {
      console.info('[useInsights] Skipping local insight generation:', {
        reason: 'missing-inputs',
        workspaceId,
        parentNodeId: parent.id,
        hasAgent: Boolean(agent),
        hasRepoPath: Boolean(repoPath),
        hasParentCommit: Boolean(parentCommit),
      });
      return;
    }
    if (readProcessedInsightParentNodeIds(workspaceId).has(parent.id)) {
      console.info('[useInsights] Skipping local insight generation:', {
        reason: 'already-processed',
        workspaceId,
        parentNodeId: parent.id,
      });
      return;
    }

    const authToken = await getAccessToken();
    if (!authToken) {
      console.info('[useInsights] Skipping local insight generation:', {
        reason: 'missing-auth-token',
        workspaceId,
        parentNodeId: parent.id,
      });
      return;
    }

    const runId = crypto.randomUUID();
    const userNodeId = crypto.randomUUID();
    const assistantNodeId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const prompt = `${INSIGHT_AGENT_PROMPT}

Parent node: ${parent.id}

Conversation branch:
${branchContext(messages, parent)}`;
    const sharedMeta = {
      agentree_insight_run: true,
      agentree_hidden_node: true,
      insight_parent_node_id: parent.id,
      provider: agent.type,
      provider_model: agent.model_config?.model ?? null,
      base_commit_sha: parentCommit,
    };
    console.info('[useInsights] Starting local insight run:', {
      workspaceId,
      parentNodeId: parent.id,
      assistantNodeId,
      agentType: agent.type,
      model: agent.model_config?.model ?? null,
    });
    const userMessage: Message = {
      id: userNodeId,
      role: 'user',
      content: prompt,
      parentId: parent.id,
      workspaceId,
      attachments: [],
      createdAt,
      updatedAt: createdAt,
      execution_data: { meta: sharedMeta },
    };
    const assistantMessage: Message = {
      id: assistantNodeId,
      role: 'assistant',
      content: '',
      parentId: userNodeId,
      workspaceId,
      attachments: [],
      createdAt,
      updatedAt: createdAt,
      status: AGENT_STATUS.pending,
      llmProvider: agent.type,
      llmModel: agent.model_config?.model ?? null,
      base_commit_sha: parentCommit,
      execution_data: {
        current_run_id: runId,
        workspace_id: workspaceId,
        parentId: userNodeId,
        meta: sharedMeta,
      },
    };

    setLoadingInsights(true);
    activeRunRef.current = assistantNodeId;
    activeParentRef.current = parent.id;
    await Promise.all([
      agentClient.upsertLocalNode(workspaceId, userNodeId, userMessage),
      agentClient.upsertLocalNode(workspaceId, assistantNodeId, assistantMessage),
    ]);
    await agentClient.startAgentRun({
      runId,
      assistantNodeId,
      workspaceId,
      repoPath,
      parentCommit,
      agentType: agent.type,
      args: buildAgentArgs(agent, prompt),
      authToken,
      traceId: null,
      loginProfileId: null,
      runContext: {
        runId,
        executionData: assistantMessage.execution_data,
        gitBranchName: `agentree/${assistantNodeId}`,
        repoPath,
        parentCommit,
        authorName: agent.name ?? null,
        promptFallback: prompt,
      },
    });
    rememberProcessedInsightParentNodeId(workspaceId, parent.id);
    watchInsightRun(assistantNodeId);
  }, [agents, messages, setLoadingInsights, watchInsightRun, workspace, workspaceId]);

  useEffect(() => {
    processInsightQueueRef.current = () => {
      if (!workspaceId || activeRunRef.current) return;
      while (queuedParentIdsRef.current.length > 0) {
        const parentId = queuedParentIdsRef.current.shift();
        if (!parentId) continue;
        queuedParentIdSetRef.current.delete(parentId);
        if (readProcessedInsightParentNodeIds(workspaceId).has(parentId)) continue;
        const parent = completedAssistantById.get(parentId);
        if (!parent) continue;
        void startInsightRunForParent(parent).catch((error) => {
          activeRunRef.current = null;
          activeParentRef.current = null;
          setLoadingInsights(false);
          console.error('[useInsights] Local insight generation failed:', error);
          processInsightQueueRef.current();
        });
        return;
      }
    };
  }, [completedAssistantById, setLoadingInsights, startInsightRunForParent, workspaceId]);

  useEffect(() => {
    queuedParentIdsRef.current = [];
    queuedParentIdSetRef.current = new Set();
    activeRunRef.current = null;
    activeParentRef.current = null;
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled || !workspaceId || messageCount <= 0) {
      return;
    }

    const processed = readProcessedInsightParentNodeIds(workspaceId);
    let queuedCount = 0;
    for (const parent of completedAssistantMessages) {
      if (
        processed.has(parent.id) ||
        queuedParentIdSetRef.current.has(parent.id) ||
        activeParentRef.current === parent.id
      ) {
        continue;
      }
      queuedParentIdSetRef.current.add(parent.id);
      queuedParentIdsRef.current.push(parent.id);
      queuedCount += 1;
    }

    if (queuedCount > 0) {
      console.info('[useInsights] Queued local insight parents:', {
        workspaceId,
        queuedCount,
        queueDepth: queuedParentIdsRef.current.length,
      });
      processInsightQueueRef.current();
    }
  }, [completedAssistantMessages, enabled, messageCount, workspaceId]);

  const dismissInsight = useCallback(async (insightId: string) => {
    if (!workspaceId || !agentClient.hasRuntime()) {
      dismissInsightInStore(insightId);
      return;
    }
    dismissInsightInStore(insightId);
    await agentClient.localFirstDismissInsight(workspaceId, insightId);
    queueLocalSyncFlush({ reason: 'local-insights-dismiss' });
  }, [dismissInsightInStore, workspaceId]);

  return {
    triggerInsightGeneration: () => {
      processInsightQueueRef.current();
      return Promise.resolve();
    },
    refreshInsights: loadLocalInsights,
    dismissInsight,
  };
}

export default useInsights;
