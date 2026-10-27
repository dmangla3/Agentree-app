import type { Agent } from '../hooks/useAgents';
import { parseRuntimeCliArgs } from '../lib/agentRuntimeArgs';
import {
  resolveLoginProfileSelection,
  type LoginProfileSummary,
} from '../lib/loginProfiles';

export type AgentRunProvider = 'codex' | 'claude' | 'opencode';

export interface AgentRunSelection {
  readonly agentId: string;
  readonly agentName: string;
  readonly ordinal: number;
  readonly totalForAgent: number;
  readonly agent: Agent;
}

export interface PreparedAgentRun extends AgentRunSelection {
  readonly runKey: string;
  readonly provider: AgentRunProvider | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly loginProfile: LoginProfileSummary | null;
  readonly loginProfileId: string | null;
}

export interface AgentRunSpec<TContext> extends PreparedAgentRun {
  readonly prompt: string;
  readonly base: Readonly<{
    commitSha: string;
    selectedFromNodeId: string | null;
  }>;
  readonly context: Readonly<TContext>;
}

export interface AgentRunPreflightFailure {
  readonly runKeys: readonly string[];
  readonly provider: AgentRunProvider;
  readonly profileId: string | null;
  readonly reason: unknown;
}

export class AgentRunPreflightError extends Error {
  readonly failures: readonly AgentRunPreflightFailure[];

  constructor(failures: readonly AgentRunPreflightFailure[]) {
    super('One or more selected models do not have a ready login profile.');
    this.name = 'AgentRunPreflightError';
    this.failures = failures;
  }
}

export interface AgentRunBatchResult<TContext, TResult> {
  readonly spec: AgentRunSpec<TContext>;
  readonly result: PromiseSettledResult<TResult>;
}

const toRuntimeProvider = (provider: string): AgentRunProvider | null => (
  provider === 'codex' || provider === 'claude' || provider === 'opencode'
    ? provider
    : null
);

const createRunKey = (run: AgentRunSelection, index: number): string => (
  `${run.agentId}:${run.ordinal}/${run.totalForAgent}:${index}`
);

const snapshotAgent = (agent: Agent): Agent => {
  const capabilities = agent.model_config?.capabilities
    ? {
      ...agent.model_config.capabilities,
      inputModalities: [...agent.model_config.capabilities.inputModalities],
      outputModalities: [...agent.model_config.capabilities.outputModalities],
    }
    : agent.model_config?.capabilities;
  if (capabilities) {
    Object.freeze(capabilities.inputModalities);
    Object.freeze(capabilities.outputModalities);
    Object.freeze(capabilities);
  }
  const modelConfig = agent.model_config
    ? { ...agent.model_config, capabilities }
    : agent.model_config;
  if (modelConfig) Object.freeze(modelConfig);
  const tools = agent.tools ? [...agent.tools] : undefined;
  if (tools) Object.freeze(tools);
  const snapshot: Agent = {
    ...agent,
    tools,
    model_config: modelConfig,
  };
  return Object.freeze(snapshot);
};

export function prepareAgentRuns(input: {
  runs: readonly AgentRunSelection[];
  profiles: readonly LoginProfileSummary[];
}): PreparedAgentRun[] {
  const selections = input.runs.map((run, index) => {
    const agent = snapshotAgent(run.agent);
    const provider = toRuntimeProvider(agent.type);
    const parsedCliArgs = parseRuntimeCliArgs(agent.cliArgs ?? '');
    const selection = resolveLoginProfileSelection({
      profiles: [...input.profiles],
      provider,
      agentName: agent.name ?? agent.type,
    });

    return { run, index, agent, provider, parsedCliArgs, selection };
  });

  // Sending consumes the readiness result cached by Managed Accounts. Probing a
  // provider here made composer acceptance depend on network/runtime discovery
  // and repeated work that belongs to account add/edit/check flows.
  const readinessFailures = selections.flatMap(({ run, index, provider, selection }): AgentRunPreflightFailure[] => (
    provider && !selection.isReady
      ? [{
        runKeys: [createRunKey(run, index)],
        provider,
        profileId: selection.selectedProfile?.id ?? null,
        reason: selection.selectedProfile?.status ?? 'missing-profile',
      }]
      : []
  ));
  if (readinessFailures.length > 0) {
    throw new AgentRunPreflightError(readinessFailures);
  }

  return selections.map(({ run, index, agent, provider, parsedCliArgs, selection }): PreparedAgentRun => Object.freeze({
    ...run,
    agent,
    runKey: createRunKey(run, index),
    provider,
    model: agent.model_config?.model ?? parsedCliArgs.model ?? null,
    reasoningEffort: agent.model_config?.reasoningEffort ?? parsedCliArgs.reasoningEffort ?? null,
    loginProfile: selection.selectedProfile,
    loginProfileId: selection.selectedProfile?.id ?? null,
  }));
}

export function createAgentRunSpec<TContext>(
  run: PreparedAgentRun,
  input: {
    prompt: string;
    base: { commitSha: string; selectedFromNodeId: string | null };
    context: TContext;
  },
): AgentRunSpec<TContext> {
  return Object.freeze({
    ...run,
    prompt: input.prompt,
    base: Object.freeze({ ...input.base }),
    context: Object.freeze({ ...input.context }),
  });
}

export async function launchAgentRunBatch<TContext, TResult>(
  specs: readonly AgentRunSpec<TContext>[],
  launch: (spec: AgentRunSpec<TContext>) => Promise<TResult>,
): Promise<AgentRunBatchResult<TContext, TResult>[]> {
  const settled = await Promise.allSettled(specs.map((spec) => launch(spec)));
  return settled.map((result, index) => ({ spec: specs[index], result }));
}
