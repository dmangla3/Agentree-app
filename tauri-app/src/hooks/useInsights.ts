import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AGENT_STATUS, isTerminalAgentStatus } from '@shared/agentStatus';
import { agentClient, type LocalInsightCandidateRecord, type LocalInsightRecord } from '../lib/agentClient';
import { getAccessToken } from '../lib/authSession';
import { appendBackgroundAttentionAuditEvent } from '../lib/backgroundAttentionAudit';
import { queueLocalSyncFlush } from '../lib/localSyncScheduler';
import { isLoginProfileActive, type LoginProfileSummary } from '../lib/loginProfiles';
import { INSIGHT_GENERATOR_PROMPT, INSIGHT_VALIDATOR_PROMPT } from '../lib/prompts';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import { useWorkspaceStore, type Insight, type Message, type Workspace } from '../stores/workspaceStore';
import type { Agent } from './useAgents';

interface UseInsightsOptions {
  enabled?: boolean;
  debounceMs?: number;
  messages?: Message[];
  agents?: Agent[];
  workspace?: Workspace | null;
}

type InsightRunStage = 'generate' | 'validate';

interface ProposedInsightCandidate {
  agentKind: string;
  claim: string;
  rationale?: string;
  analysis?: string;
}

const splitCliArgs = (value: string | null | undefined): string[] => (
  String(value || '').split(/\s+/).filter(Boolean)
);

const buildAgentArgs = (agent: Agent, prompt: string): string[] => {
  const args = splitCliArgs(agent.cliArgs);
  if (agent.type === 'codex' || !agent.promptFlag) return [...args, prompt];
  return [...args, agent.promptFlag, prompt];
};

const stringField = (value: unknown, keys: string[]): string | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === 'string' && field.trim()) return field.trim();
  }
  return null;
};

const extractJsonFromAgentText = (content: string): unknown | null => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to forgiving extraction.
  }
  const firstArray = trimmed.indexOf('[');
  const firstObject = trimmed.indexOf('{');
  const starts = [firstArray, firstObject].filter((index) => index >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const endArray = trimmed.lastIndexOf(']');
  const endObject = trimmed.lastIndexOf('}');
  const end = Math.max(endArray, endObject);
  if (end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
};

const extractCandidateArray = (content: string): unknown[] => {
  const parsed = extractJsonFromAgentText(content);
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.candidates)) return record.candidates;
  if (Array.isArray(record.insights)) return record.insights;
  return [];
};

const sanitizeGeneratedCandidatesForValidation = (content: string): ProposedInsightCandidate[] => (
  extractCandidateArray(content)
    .map((raw): ProposedInsightCandidate | null => {
      const claim = stringField(raw, ['claim', 'content', 'title', 'insight']);
      if (!claim) return null;
      return {
        agentKind: stringField(raw, ['agentKind', 'agentType', 'strategy', 'type']) ?? 'hypothesis',
        claim,
        rationale: stringField(raw, ['rationale', 'reasoning', 'why', 'surfaceReason']) ?? undefined,
        analysis: stringField(raw, ['analysis', 'fullExploration', 'evidence', 'support']) ?? undefined,
      };
    })
    .filter((candidate): candidate is ProposedInsightCandidate => Boolean(candidate))
    .slice(0, 8)
);

const parseLocalNodeMessage = (payload: string): Message | null => {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed.id === 'string' ? parsed as Message : null;
  } catch {
    return null;
  }
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

const chooseReadyLoginProfile = (
  profiles: LoginProfileSummary[],
  provider: string,
): LoginProfileSummary | null => {
  const compatibleReady = profiles.filter((profile) => (
    profile.provider === provider && isLoginProfileActive(profile)
  ));
  return compatibleReady.find((profile) => profile.isDefault) ?? compatibleReady[0] ?? null;
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

const executionMetaForMessage = (message: Message): Record<string, unknown> => (
  (message.execution_data?.meta as Record<string, unknown> | undefined) ?? {}
);

const isHiddenBackgroundMessage = (message: Message): boolean => {
  const meta = executionMetaForMessage(message);
  return (
    meta.agentree_hidden_node === true
    || meta.agentree_insight_run === true
    || message.execution_data?.agentree_hidden_node === true
    || message.execution_data?.agentree_insight_run === true
  );
};

const completedAtMs = (message: Message): number => {
  const raw = message.updatedAt ?? message.createdAt;
  const parsed = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};

const isEligibleInsightParent = (message: Message, byId: Map<string, Message>): boolean => {
  if (!isCompletedAssistant(message)) return false;
  if (isHiddenBackgroundMessage(message)) return false;
  if (String(message.content || '').trim().length < 80) return false;
  const parent = message.parentId ? byId.get(message.parentId) : null;
  if (!parent || parent.role !== 'user' || isHiddenBackgroundMessage(parent)) return false;
  return true;
};

const readCommitForInsightRun = (parent: Message | null, workspace: Workspace | null | undefined): string | null => (
  parent?.output_commit_sha
  ?? parent?.base_commit_sha
  ?? workspace?.base_commit_sha
  ?? null
);

const messageCommitContext = (message: Message): string | null => {
  const parts: string[] = [];
  if (message.base_commit_sha) parts.push(`base=${message.base_commit_sha}`);
  if (message.output_commit_sha) parts.push(`output=${message.output_commit_sha}`);
  if (message.git_branch_name) parts.push(`branch=${message.git_branch_name}`);
  return parts.length > 0 ? `COMMIT_CONTEXT ${parts.join(' ')}` : null;
};

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
    .map((message) => [
      `${message.role.toUpperCase()} ${message.id}`,
      messageCommitContext(message),
      String(message.content || '').slice(0, 2000),
    ].filter(Boolean).join('\n'))
    .join('\n\n');
};

const processedInsightParentsStorageKey = (workspaceId: string): string => (
  `agentree.backgroundAttention.processedParentNodeIds.v1.${workspaceId}`
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

const candidateRowsFingerprint = (rows: LocalInsightCandidateRecord[]): string => (
  rows
    .map((row) => `${row.workspaceId}:${row.candidateId}:${row.status}:${row.updatedAt}:${row.priority ?? ''}:${row.payload}`)
    .join('|')
);

const isTerminalInsightRunState = (state: Awaited<ReturnType<typeof agentClient.getAgentRunState>> | null): boolean => {
  const ledger = state?.ledger as Record<string, unknown> | null | undefined;
  const status = String(ledger?.terminalStatus ?? ledger?.status ?? '');
  return isTerminalAgentStatus(status) || status === 'needs_user_action';
};

const recordBackgroundAttentionAudit = (input: {
  workspaceId: string | null | undefined;
  outcome: 'baseline' | 'queued' | 'ran' | 'skipped' | 'failed';
  reason: string;
  triggerClass?: string | null;
  parentNodeId?: string | null;
  runNodeId?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}) => {
  if (!input.workspaceId) return;
  appendBackgroundAttentionAuditEvent({
    workspaceId: input.workspaceId,
    outcome: input.outcome,
    reason: input.reason,
    triggerClass: input.triggerClass ?? 'light',
    parentNodeId: input.parentNodeId ?? null,
    runNodeId: input.runNodeId ?? null,
    message: input.message ?? null,
    metadata: input.metadata ?? null,
  });
};

const readLocalNodeMessage = async (
  workspaceId: string,
  nodeId: string,
): Promise<Message | null> => {
  const rows = await agentClient.listLocalNodes(workspaceId);
  const row = rows.find((candidate) => candidate.nodeId === nodeId);
  return row ? parseLocalNodeMessage(row.payload) : null;
};

export function useInsights(
  workspaceId: string | null,
  messageCount: number,
  options: UseInsightsOptions = {},
) {
  const { enabled = true, messages = [], agents = [], workspace = null } = options;

  const setInsights = useWorkspaceStore((state) => state.setInsights);
  const setInsightCandidates = useWorkspaceStore((state) => state.setInsightCandidates);
  const dismissInsightInStore = useWorkspaceStore((state) => state.dismissInsight);
  const setLoadingInsights = useWorkspaceStore((state) => state.setLoadingInsights);
  const loginProfiles = useLoginProfilesStore((state) => state.profiles);

  const queuedParentIdsRef = useRef<string[]>([]);
  const queuedParentIdSetRef = useRef<Set<string>>(new Set());
  const activeRunRef = useRef<string | null>(null);
  const activeParentRef = useRef<string | null>(null);
  const activeStageRef = useRef<InsightRunStage | null>(null);
  const lastRowsFingerprintRef = useRef<string | null>(null);
  const lastCandidateRowsFingerprintRef = useRef<string | null>(null);
  const processInsightQueueRef = useRef<() => void>(() => undefined);
  const triggerBaselineReadyRef = useRef(false);
  const seenTriggerParentIdsRef = useRef<Set<string>>(new Set());
  const triggerStartedAtMsRef = useRef(Date.now());

  const completedAssistantMessages = useMemo(() => {
    return messages.filter(isCompletedAssistant);
  }, [messages]);

  const messageById = useMemo(() => (
    new Map(messages.map((message) => [message.id, message]))
  ), [messages]);

  const eligibleCompletedAssistantMessages = useMemo(() => (
    completedAssistantMessages.filter((message) => isEligibleInsightParent(message, messageById))
  ), [completedAssistantMessages, messageById]);

  const eligibleCompletedAssistantById = useMemo(() => (
    new Map(eligibleCompletedAssistantMessages.map((message) => [message.id, message]))
  ), [eligibleCompletedAssistantMessages]);

  const loadLocalInsights = useCallback(async () => {
    if (!workspaceId || !agentClient.hasRuntime()) {
      if (lastRowsFingerprintRef.current !== '') {
        lastRowsFingerprintRef.current = '';
        lastCandidateRowsFingerprintRef.current = '';
        setInsights([]);
        setInsightCandidates([]);
      }
      return [];
    }
    const [rows, candidateRows] = await Promise.all([
      agentClient.listLocalInsights(workspaceId),
      agentClient.listLocalInsightCandidates(workspaceId),
    ]);
    const fingerprint = insightRowsFingerprint(rows);
    const candidateFingerprint = candidateRowsFingerprint(candidateRows);
    const insights = rows.map(parseLocalInsight).filter((insight): insight is Insight => Boolean(insight));
    if (fingerprint !== lastRowsFingerprintRef.current) {
      lastRowsFingerprintRef.current = fingerprint;
      setInsights(insights);
    }
    if (candidateFingerprint !== lastCandidateRowsFingerprintRef.current) {
      lastCandidateRowsFingerprintRef.current = candidateFingerprint;
      setInsightCandidates(candidateRows);
    }
    if (rows.some((row) => row.syncStatus === 'local_only')) {
      queueLocalSyncFlush({ reason: 'local-insights' });
    }
    return insights;
  }, [setInsightCandidates, setInsights, workspaceId]);

  useEffect(() => {
    void loadLocalInsights().catch((error) => {
      console.error('[useInsights] Failed to load local insights:', error);
    });
  }, [loadLocalInsights]);

  const startHiddenInsightRun = useCallback(async (input: {
    parent: Message;
    agent: Agent;
    loginProfile: LoginProfileSummary;
    repoPath: string;
    parentCommit: string;
    authToken: string;
    prompt: string;
    stage: InsightRunStage;
    generatorRunNodeId?: string | null;
  }): Promise<string> => {
    if (!workspaceId) throw new Error('Missing workspace id for background attention run.');

    const runId = crypto.randomUUID();
    const userNodeId = crypto.randomUUID();
    const assistantNodeId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const sharedMeta = {
      agentree_insight_run: true,
      agentree_hidden_node: true,
      insight_parent_node_id: input.parent.id,
      insight_stage: input.stage,
      insight_generator_run_node_id: input.generatorRunNodeId ?? null,
      insight_trigger_class: 'light',
      insight_trigger_reason: 'light_assistant_completed',
      provider: input.agent.type,
      provider_model: input.agent.model_config?.model ?? null,
      login_profile_id: input.loginProfile.id,
      login_profile_name: input.loginProfile.displayName,
      login_profile_provider: input.loginProfile.provider,
      login_profile_auth_type: input.loginProfile.authType,
      login_profile_redacted_hint: input.loginProfile.redactedHint ?? null,
      base_commit_sha: input.parentCommit,
    };
    const userMessage: Message = {
      id: userNodeId,
      role: 'user',
      content: input.prompt,
      parentId: input.parent.id,
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
      llmProvider: input.agent.type,
      llmModel: input.agent.model_config?.model ?? null,
      base_commit_sha: input.parentCommit,
      execution_data: {
        current_run_id: runId,
        workspace_id: workspaceId,
        parentId: userNodeId,
        meta: sharedMeta,
      },
    };

    setLoadingInsights(true);
    activeRunRef.current = assistantNodeId;
    activeParentRef.current = input.parent.id;
    activeStageRef.current = input.stage;
    await Promise.all([
      agentClient.upsertLocalNode(workspaceId, userNodeId, userMessage),
      agentClient.upsertLocalNode(workspaceId, assistantNodeId, assistantMessage),
    ]);
    await agentClient.startAgentRun({
      runId,
      assistantNodeId,
      workspaceId,
      repoPath: input.repoPath,
      parentCommit: input.parentCommit,
      agentType: input.agent.type,
      args: buildAgentArgs(input.agent, input.prompt),
      authToken: input.authToken,
      traceId: null,
      loginProfileId: input.loginProfile.id,
      runContext: {
        runId,
        executionData: assistantMessage.execution_data,
        gitBranchName: `agentree/${assistantNodeId}`,
        repoPath: input.repoPath,
        parentCommit: input.parentCommit,
        authorName: input.agent.name ?? null,
        promptFallback: input.prompt,
      },
    });
    return assistantNodeId;
  }, [setLoadingInsights, workspaceId]);

  const watchInsightRun = useCallback((runNodeId: string) => {
    let attempts = 0;
    const tick = () => {
      if (activeRunRef.current !== runNodeId) return;
      attempts += 1;
      void agentClient.getAgentRunState(runNodeId)
        .then(async (state) => {
          if (isTerminalInsightRunState(state)) {
            const ledger = state?.ledger as Record<string, unknown> | null | undefined;
            const status = String(ledger?.terminalStatus ?? ledger?.status ?? '');
            const stage = activeStageRef.current ?? 'validate';
            const parentNodeId = activeParentRef.current;

            if (status === AGENT_STATUS.completed && stage === 'generate') {
              const parent = parentNodeId ? messageById.get(parentNodeId) ?? null : null;
              const generatorMessage = workspaceId ? await readLocalNodeMessage(workspaceId, runNodeId) : null;
              const proposedCandidates = sanitizeGeneratedCandidatesForValidation(generatorMessage?.content ?? '');
              recordBackgroundAttentionAudit({
                workspaceId,
                outcome: 'ran',
                reason: 'generator_completed',
                triggerClass: 'light',
                parentNodeId,
                runNodeId,
                message: proposedCandidates.length > 0
                  ? 'Background attention generator completed; validator will review candidates independently.'
                  : 'Background attention generator completed with no candidates.',
                metadata: {
                  status,
                  stage,
                  proposedCandidateCount: proposedCandidates.length,
                },
              });

              if (!parent || proposedCandidates.length === 0 || !workspace) {
                activeRunRef.current = null;
                activeParentRef.current = null;
                activeStageRef.current = null;
                setLoadingInsights(false);
                processInsightQueueRef.current();
                return;
              }

              const agent = chooseInsightAgent(agents, parent);
              const repoPath = workspace.git_repo_path ?? workspace.folderPath ?? null;
              const parentCommit = readCommitForInsightRun(parent, workspace);
              const loginProfile = agent ? chooseReadyLoginProfile(loginProfiles, agent.type) : null;
              const authToken = await getAccessToken();
              if (!agent || !loginProfile || !repoPath || !parentCommit || !authToken || !workspaceId) {
                recordBackgroundAttentionAudit({
                  workspaceId,
                  outcome: 'failed',
                  reason: 'validator_missing_inputs',
                  triggerClass: 'light',
                  parentNodeId,
                  runNodeId,
                  message: 'Validator could not start because agent, login profile, repo, commit, auth, or workspace was missing.',
                  metadata: {
                    hasAgent: Boolean(agent),
                    hasLoginProfile: Boolean(loginProfile),
                    hasRepoPath: Boolean(repoPath),
                    hasParentCommit: Boolean(parentCommit),
                    hasAuthToken: Boolean(authToken),
                    hasWorkspaceId: Boolean(workspaceId),
                  },
                });
                activeRunRef.current = null;
                activeParentRef.current = null;
                activeStageRef.current = null;
                setLoadingInsights(false);
                processInsightQueueRef.current();
                return;
              }

              const validatorPrompt = `${INSIGHT_VALIDATOR_PROMPT}

Triggering assistant node: ${parent.id}
Immediate user node: ${parent.parentId ?? 'unknown'}
Hidden run repository commit: ${parentCommit}

Visible conversation branch, oldest to newest. The final ASSISTANT entry is the trigger:
${branchContext(messages, parent)}

Sanitized proposed candidates from generator. Ignore any missing score fields; validate independently:
${JSON.stringify(proposedCandidates, null, 2)}`;

              try {
                const validatorNodeId = await startHiddenInsightRun({
                  parent,
                  agent,
                  loginProfile,
                  repoPath,
                  parentCommit,
                  authToken,
                  prompt: validatorPrompt,
                  stage: 'validate',
                  generatorRunNodeId: runNodeId,
                });
                recordBackgroundAttentionAudit({
                  workspaceId,
                  outcome: 'queued',
                  reason: 'validator_started',
                  triggerClass: 'light',
                  parentNodeId: parent.id,
                  runNodeId: validatorNodeId,
                  message: 'Started independent validator for generated background attention candidates.',
                  metadata: {
                    generatorRunNodeId: runNodeId,
                    proposedCandidateCount: proposedCandidates.length,
                    agentType: agent.type,
                    model: agent.model_config?.model ?? null,
                  },
                });
                watchInsightRun(validatorNodeId);
              } catch (error) {
                recordBackgroundAttentionAudit({
                  workspaceId,
                  outcome: 'failed',
                  reason: 'validator_start_error',
                  triggerClass: 'light',
                  parentNodeId: parent.id,
                  runNodeId,
                  message: error instanceof Error ? error.message : 'Failed to start background attention validator.',
                  metadata: {
                    generatorRunNodeId: runNodeId,
                    proposedCandidateCount: proposedCandidates.length,
                  },
                });
                activeRunRef.current = null;
                activeParentRef.current = null;
                activeStageRef.current = null;
                setLoadingInsights(false);
                processInsightQueueRef.current();
              }
              return;
            }

            recordBackgroundAttentionAudit({
              workspaceId,
              outcome: status === AGENT_STATUS.completed ? 'ran' : 'failed',
              reason: status === AGENT_STATUS.completed ? 'validator_completed' : 'run_terminal_non_completed',
              triggerClass: 'light',
              parentNodeId,
              runNodeId,
              message: status === AGENT_STATUS.completed
                ? 'Background attention validator completed and eligible candidates were persisted.'
                : `Background attention run ended with ${status || 'unknown'} status.`,
              metadata: { status, stage },
            });
            await loadLocalInsights();
            queueLocalSyncFlush({ reason: 'local-insight-run-terminal' });
            activeRunRef.current = null;
            activeParentRef.current = null;
            activeStageRef.current = null;
            setLoadingInsights(false);
            processInsightQueueRef.current();
          }
        })
        .catch((error) => {
          console.error('[useInsights] Failed to watch local insight run:', error);
          if (activeRunRef.current === runNodeId) {
            recordBackgroundAttentionAudit({
              workspaceId,
              outcome: 'failed',
              reason: 'watch_error',
              triggerClass: 'light',
              parentNodeId: activeParentRef.current,
              runNodeId,
              message: error instanceof Error ? error.message : 'Failed while watching background attention run.',
              metadata: { stage: activeStageRef.current },
            });
            activeRunRef.current = null;
            activeParentRef.current = null;
            activeStageRef.current = null;
            setLoadingInsights(false);
            processInsightQueueRef.current();
          }
        })
        .finally(() => {
          if (attempts < 40 && activeRunRef.current === runNodeId) {
            window.setTimeout(tick, 3000);
          } else if (activeRunRef.current === runNodeId) {
            recordBackgroundAttentionAudit({
              workspaceId,
              outcome: 'failed',
              reason: 'watch_timeout',
              triggerClass: 'light',
              parentNodeId: activeParentRef.current,
              runNodeId,
              message: 'Stopped watching because the background attention run did not reach a terminal state in time.',
              metadata: { attempts },
            });
            activeRunRef.current = null;
            activeParentRef.current = null;
            activeStageRef.current = null;
            setLoadingInsights(false);
            processInsightQueueRef.current();
          }
        });
    };
    window.setTimeout(tick, 3000);
  }, [agents, loadLocalInsights, loginProfiles, messageById, messages, setLoadingInsights, startHiddenInsightRun, workspace, workspaceId]);

  const startInsightRunForParent = useCallback(async (parent: Message) => {
    if (!workspaceId || !agentClient.hasRuntime() || !workspace) {
      console.info('[useInsights] Skipping local insight generation:', {
        reason: 'missing-runtime-or-workspace',
        workspaceId,
        hasRuntime: agentClient.hasRuntime(),
        hasWorkspace: Boolean(workspace),
      });
      recordBackgroundAttentionAudit({
        workspaceId,
        outcome: 'skipped',
        reason: 'missing_runtime_or_workspace',
        triggerClass: 'light',
        parentNodeId: parent.id,
        message: 'Skipped because the local runtime or workspace was unavailable.',
        metadata: { hasRuntime: agentClient.hasRuntime(), hasWorkspace: Boolean(workspace) },
      });
      return;
    }
    if (activeRunRef.current) {
      queuedParentIdsRef.current = [parent.id];
      queuedParentIdSetRef.current = new Set([parent.id]);
      recordBackgroundAttentionAudit({
        workspaceId,
        outcome: 'queued',
        reason: 'active_run_in_progress',
        triggerClass: 'light',
        parentNodeId: parent.id,
        runNodeId: activeRunRef.current,
        message: 'Queued latest eligible turn while another background attention run was active.',
      });
      return;
    }

    const agent = chooseInsightAgent(agents, parent);
    const repoPath = workspace.git_repo_path ?? workspace.folderPath ?? null;
    const parentCommit = readCommitForInsightRun(parent, workspace);
    const loginProfile = agent ? chooseReadyLoginProfile(loginProfiles, agent.type) : null;
    if (!agent || !repoPath || !parentCommit) {
      console.info('[useInsights] Skipping local insight generation:', {
        reason: 'missing-inputs',
        workspaceId,
        parentNodeId: parent.id,
        hasAgent: Boolean(agent),
        hasRepoPath: Boolean(repoPath),
        hasParentCommit: Boolean(parentCommit),
      });
      recordBackgroundAttentionAudit({
        workspaceId,
        outcome: 'skipped',
        reason: 'missing_inputs',
        triggerClass: 'light',
        parentNodeId: parent.id,
        message: 'Skipped because agent, repo path, or parent commit was missing.',
        metadata: {
          hasAgent: Boolean(agent),
          hasRepoPath: Boolean(repoPath),
          hasParentCommit: Boolean(parentCommit),
        },
      });
      return;
    }
    if (!loginProfile) {
      console.info('[useInsights] Skipping local insight generation:', {
        reason: 'missing-ready-login-profile',
        workspaceId,
        parentNodeId: parent.id,
        agentType: agent.type,
      });
      recordBackgroundAttentionAudit({
        workspaceId,
        outcome: 'skipped',
        reason: 'missing_ready_login_profile',
        triggerClass: 'light',
        parentNodeId: parent.id,
        message: 'Skipped because the selected local agent has no ready login profile.',
        metadata: {
          agentType: agent.type,
        },
      });
      return;
    }
    if (readProcessedInsightParentNodeIds(workspaceId).has(parent.id)) {
      console.info('[useInsights] Skipping local insight generation:', {
        reason: 'already-processed',
        workspaceId,
        parentNodeId: parent.id,
      });
      recordBackgroundAttentionAudit({
        workspaceId,
        outcome: 'skipped',
        reason: 'already_processed',
        triggerClass: 'light',
        parentNodeId: parent.id,
        message: 'Skipped because this assistant turn was already processed.',
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
      recordBackgroundAttentionAudit({
        workspaceId,
        outcome: 'skipped',
        reason: 'missing_auth_token',
        triggerClass: 'light',
        parentNodeId: parent.id,
        message: 'Skipped because no auth token was available for the local run.',
      });
      return;
    }

    const prompt = `${INSIGHT_GENERATOR_PROMPT}

Triggering assistant node: ${parent.id}
Immediate user node: ${parent.parentId ?? 'unknown'}
Hidden run repository commit: ${parentCommit}

Conversation branch, oldest to newest. The final ASSISTANT entry is the trigger:
${branchContext(messages, parent)}`;
    console.info('[useInsights] Starting local insight run:', {
      workspaceId,
      parentNodeId: parent.id,
      stage: 'generate',
      agentType: agent.type,
      model: agent.model_config?.model ?? null,
    });
    const generatorNodeId = await startHiddenInsightRun({
      parent,
      agent,
      loginProfile,
      repoPath,
      parentCommit,
      authToken,
      prompt,
      stage: 'generate',
    });
    recordBackgroundAttentionAudit({
      workspaceId,
      outcome: 'queued',
      reason: 'generator_started',
      triggerClass: 'light',
      parentNodeId: parent.id,
      runNodeId: generatorNodeId,
      message: 'Started background attention generator for the latest eligible assistant turn.',
      metadata: {
        agentType: agent.type,
        model: agent.model_config?.model ?? null,
      },
    });
    rememberProcessedInsightParentNodeId(workspaceId, parent.id);
    watchInsightRun(generatorNodeId);
  }, [agents, loginProfiles, messages, startHiddenInsightRun, watchInsightRun, workspace, workspaceId]);

  useEffect(() => {
    processInsightQueueRef.current = () => {
      if (!workspaceId || activeRunRef.current) return;
      while (queuedParentIdsRef.current.length > 0) {
        const parentId = queuedParentIdsRef.current.shift();
        if (!parentId) continue;
        queuedParentIdSetRef.current.delete(parentId);
        if (readProcessedInsightParentNodeIds(workspaceId).has(parentId)) {
          recordBackgroundAttentionAudit({
            workspaceId,
            outcome: 'skipped',
            reason: 'queued_parent_already_processed',
            triggerClass: 'light',
            parentNodeId: parentId,
            message: 'Skipped queued turn because it was already processed before the queue drained.',
          });
          continue;
        }
        const parent = eligibleCompletedAssistantById.get(parentId);
        if (!parent) {
          recordBackgroundAttentionAudit({
            workspaceId,
            outcome: 'skipped',
            reason: 'queued_parent_not_eligible',
            triggerClass: 'light',
            parentNodeId: parentId,
            message: 'Skipped queued turn because it was no longer eligible.',
          });
          continue;
        }
        void startInsightRunForParent(parent).catch((error) => {
          activeRunRef.current = null;
          activeParentRef.current = null;
          activeStageRef.current = null;
          setLoadingInsights(false);
          console.error('[useInsights] Local insight generation failed:', error);
          recordBackgroundAttentionAudit({
            workspaceId,
            outcome: 'failed',
            reason: 'start_run_error',
            triggerClass: 'light',
            parentNodeId: parent.id,
            message: error instanceof Error ? error.message : 'Background attention run failed to start.',
          });
          processInsightQueueRef.current();
        });
        return;
      }
    };
  }, [eligibleCompletedAssistantById, setLoadingInsights, startInsightRunForParent, workspaceId]);

  useEffect(() => {
    queuedParentIdsRef.current = [];
    queuedParentIdSetRef.current = new Set();
    activeRunRef.current = null;
    activeParentRef.current = null;
    activeStageRef.current = null;
    triggerBaselineReadyRef.current = false;
    seenTriggerParentIdsRef.current = new Set();
    triggerStartedAtMsRef.current = Date.now();
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled || !workspaceId || messageCount <= 0) {
      return;
    }

    if (!triggerBaselineReadyRef.current) {
      seenTriggerParentIdsRef.current = new Set(eligibleCompletedAssistantMessages.map((message) => message.id));
      triggerBaselineReadyRef.current = true;
      console.info('[useInsights] Initialized background attention trigger baseline:', {
        workspaceId,
        baselineCount: seenTriggerParentIdsRef.current.size,
      });
      recordBackgroundAttentionAudit({
        workspaceId,
        outcome: 'baseline',
        reason: 'baseline_initialized',
        triggerClass: 'light',
        message: 'Skipped historical backlog on workspace load.',
        metadata: { baselineCount: seenTriggerParentIdsRef.current.size },
      });
      return;
    }

    const processed = readProcessedInsightParentNodeIds(workspaceId);
    const newParents: Message[] = [];
    for (const parent of eligibleCompletedAssistantMessages) {
      if (seenTriggerParentIdsRef.current.has(parent.id)) continue;
      seenTriggerParentIdsRef.current.add(parent.id);
      if (processed.has(parent.id)) {
        recordBackgroundAttentionAudit({
          workspaceId,
          outcome: 'skipped',
          reason: 'already_processed',
          triggerClass: 'light',
          parentNodeId: parent.id,
          message: 'Skipped because this assistant turn was already processed.',
        });
        continue;
      }
      if (activeParentRef.current === parent.id) {
        recordBackgroundAttentionAudit({
          workspaceId,
          outcome: 'skipped',
          reason: 'active_parent_in_progress',
          triggerClass: 'light',
          parentNodeId: parent.id,
          runNodeId: activeRunRef.current,
          message: 'Skipped because this assistant turn already has an active background attention run.',
        });
        continue;
      }
      if (completedAtMs(parent) < triggerStartedAtMsRef.current - 2_000) {
        recordBackgroundAttentionAudit({
          workspaceId,
          outcome: 'skipped',
          reason: 'historical_completion',
          triggerClass: 'light',
          parentNodeId: parent.id,
          message: 'Skipped because the assistant turn completed before background attention started watching.',
        });
        continue;
      }
      newParents.push(parent);
    }

    const parent = newParents.length > 0 ? newParents[newParents.length - 1] : undefined;
    if (!parent) return;
    for (const supersededParent of newParents.slice(0, -1)) {
      recordBackgroundAttentionAudit({
        workspaceId,
        outcome: 'skipped',
        reason: 'superseded_by_latest_parent',
        triggerClass: 'light',
        parentNodeId: supersededParent.id,
        message: 'Skipped because multiple assistant turns completed together; only the latest was queued.',
        metadata: { selectedParentNodeId: parent.id },
      });
    }

    queuedParentIdsRef.current = [parent.id];
    queuedParentIdSetRef.current = new Set([parent.id]);
    console.info('[useInsights] Queued background attention parent:', {
      workspaceId,
      parentNodeId: parent.id,
      triggerClass: 'light',
      triggerReason: 'light_assistant_completed',
      skippedNewParents: Math.max(0, newParents.length - 1),
    });
    recordBackgroundAttentionAudit({
      workspaceId,
      outcome: 'queued',
      reason: 'light_assistant_completed',
      triggerClass: 'light',
      parentNodeId: parent.id,
      message: 'Queued latest eligible assistant turn after user-caused completion.',
      metadata: { skippedNewParents: Math.max(0, newParents.length - 1) },
    });
    processInsightQueueRef.current();
  }, [eligibleCompletedAssistantMessages, enabled, messageCount, workspaceId]);

  const dismissInsight = useCallback(async (insightId: string) => {
    if (!workspaceId || !agentClient.hasRuntime()) {
      dismissInsightInStore(insightId);
      return;
    }
    dismissInsightInStore(insightId);
    await agentClient.localFirstDismissInsight(workspaceId, insightId);
    queueLocalSyncFlush({ reason: 'local-insights-dismiss' });
  }, [dismissInsightInStore, workspaceId]);

  const recordInsightFeedback = useCallback(async (insightId: string, action: string, context?: unknown) => {
    if (!workspaceId || !agentClient.hasRuntime()) return;
    await agentClient.recordLocalInsightFeedback(workspaceId, insightId, action, context);
    await loadLocalInsights();
  }, [loadLocalInsights, workspaceId]);

  return {
    triggerInsightGeneration: () => {
      const processed = readProcessedInsightParentNodeIds(workspaceId);
      const parent = [...eligibleCompletedAssistantMessages]
        .reverse()
        .find((candidate) => !processed.has(candidate.id) && activeParentRef.current !== candidate.id);
      if (parent) {
        seenTriggerParentIdsRef.current.add(parent.id);
        queuedParentIdsRef.current = [parent.id];
        queuedParentIdSetRef.current = new Set([parent.id]);
        recordBackgroundAttentionAudit({
          workspaceId,
          outcome: 'queued',
          reason: 'manual_trigger',
          triggerClass: 'light',
          parentNodeId: parent.id,
          message: 'Queued by manual background attention refresh.',
        });
      } else {
        recordBackgroundAttentionAudit({
          workspaceId,
          outcome: 'skipped',
          reason: 'manual_no_eligible_parent',
          triggerClass: 'light',
          message: 'Manual refresh skipped because there was no unprocessed eligible assistant turn.',
        });
      }
      processInsightQueueRef.current();
      return Promise.resolve();
    },
    refreshInsights: loadLocalInsights,
    dismissInsight,
    recordInsightFeedback,
  };
}

export default useInsights;
