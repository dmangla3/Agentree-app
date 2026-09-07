import { buildComposerContextManifest, buildComposerContextSelection, type ComposerContextManifest } from './composerContext';
import { isFirstClassCommitMessage } from './graph/turnUtils';
import { buildAgentRunPrompt, EMPTY_COMPOSER_CONTEXT_MANIFEST } from './prompts';
import {
  resolveProviderContextRouting,
  resolveProviderContinuation,
  type RuntimeProvider,
} from './providerContinuation';
import type { Message } from '../stores/workspaceStore';

export interface AgentRunLaunchContextInput {
  agentType: string | null | undefined;
  userPrompt: string;
  messages?: Message[];
  messageMap?: Map<string, Message>;
  contextParentMessageId?: string | null;
  baseMessageId?: string | null;
  contextPolicy?: 'continue' | 'fresh';
  contextMode?: 'active' | 'none' | null;
  contextStartMessageId?: string | null;
  excludedBranchMessageIds?: Set<string>;
  nodeId?: string | null;
  targetNodeId?: string | null;
  providerParentMeta?: Record<string, unknown> | null;
  isBranchFromInterior?: boolean;
  contextManifest?: ComposerContextManifest | null;
  threadTitleMode?: 'first_thread_message' | 'none';
  orchestrationLabelMode?: 'orchestrator' | 'none';
  orchestrationControl?: {
    orchestratorRunId: string;
    orchestratorNodeId: string;
  } | null;
}

export interface AgentRunLaunchContextResult {
  selectedProvider: RuntimeProvider | null;
  prompt: string;
  promptMode: 'plain' | 'agentree_context' | 'cross_provider';
  providerInternalArgs: string[];
  contextManifest: ComposerContextManifest;
  agentreeContextAvailableChars: number;
  agentreeContextInjectedChars: number;
  shouldInjectAgentreeContext: boolean;
  providerThreadStrategy: string;
  providerThreadStrategyRequested: string;
  providerContextRoutingMode: string;
  providerContextRoutingReason: string;
  providerParentProvider: RuntimeProvider | 'unknown' | null;
  providerParentThreadId: string | null;
  providerParentTurnId: string | null;
  providerParentLineageId: string | null;
  providerParentUserTurnCount: number | null;
  isBranchFromInterior: boolean;
  meta: Record<string, unknown>;
}

const asRuntimeProvider = (agentType: string | null | undefined): RuntimeProvider | null => (
  agentType === 'claude' || agentType === 'codex' ? agentType : null
);

const hasConversationChild = (
  messageId: string | null | undefined,
  messages: Message[],
  messageMap: Map<string, Message>,
  excludedMessageIds: Set<string> = new Set(),
): boolean => {
  if (!messageId) return false;
  return messages.some((message) => {
    if (excludedMessageIds.has(message.id)) return false;
    if (message.parentId !== messageId) return false;
    return !isFirstClassCommitMessage(message, { messageMap });
  });
};

const resolveMessageMap = (
  messages: Message[] | undefined,
  messageMap: Map<string, Message> | undefined,
): Map<string, Message> => messageMap ?? new Map((messages ?? []).map((message) => [message.id, message]));

const manifestStatsMeta = (
  manifest: ComposerContextManifest,
  injectedChars: number,
  shouldInject: boolean,
): Record<string, unknown> => ({
  context_cache_experiment: 'context_manifest_v1',
  agentree_context_chars: manifest.contextText.trim().length,
  agentree_context_available_chars: manifest.contextText.trim().length,
  agentree_context_available_estimated_tokens: Math.ceil(manifest.contextText.trim().length / 4),
  agentree_context_estimated_tokens: Math.ceil(manifest.contextText.trim().length / 4),
  agentree_context_injected_chars: injectedChars,
  agentree_context_injected_estimated_tokens: Math.ceil(injectedChars / 4),
  agentree_context_injected: shouldInject,
  agentree_context_manifest_version: manifest.version,
  agentree_context_manifest_hash: manifest.manifestHash,
  agentree_context_stable_prefix_hash: manifest.stablePrefixHash,
  agentree_context_volatile_tail_hash: manifest.volatileTailHash,
  agentree_context_stable_prefix_chars: manifest.stablePrefixText.length,
  agentree_context_stable_prefix_estimated_tokens: Math.ceil(manifest.stablePrefixText.length / 4),
  agentree_context_volatile_tail_chars: manifest.volatileTailText.length,
  agentree_context_volatile_tail_estimated_tokens: Math.ceil(manifest.volatileTailText.length / 4),
  agentree_context_block_count: manifest.blocks.length,
  agentree_context_stable_block_count: manifest.stableBlocks.length,
  agentree_context_volatile_block_count: manifest.volatileBlocks.length,
});

export function buildAgentRunLaunchContext(input: AgentRunLaunchContextInput): AgentRunLaunchContextResult {
  const selectedProvider = asRuntimeProvider(input.agentType);
  const contextPolicy = input.contextPolicy ?? 'continue';
  const messages = input.messages ?? [];
  const messageMap = resolveMessageMap(input.messages, input.messageMap);
  const providerParentMessage = input.contextParentMessageId
    ? messageMap.get(input.contextParentMessageId) ?? null
    : null;
  const parentMeta = input.providerParentMeta
    ?? ((providerParentMessage?.execution_data as { meta?: Record<string, unknown> } | null | undefined)?.meta ?? {});
  const branchFromInterior = input.isBranchFromInterior ?? hasConversationChild(
    providerParentMessage?.id ?? input.baseMessageId,
    messages,
    messageMap,
    input.excludedBranchMessageIds ?? new Set(),
  );
  const providerContinuation = selectedProvider
    ? resolveProviderContinuation({
      selectedProvider,
      parentMeta,
      isBranchFromInterior: branchFromInterior,
    })
    : null;

  const hasPotentialContext = contextPolicy !== 'fresh' && (
    Boolean(input.contextManifest?.contextText.trim())
    || Boolean(providerParentMessage?.id)
    || Boolean(input.providerParentMeta)
  );
  const providerRouting = resolveProviderContextRouting({
    continuation: providerContinuation,
    contextMode: contextPolicy === 'fresh' ? 'none' : input.contextMode ?? 'active',
    contextPolicy,
    hasSelectedAgentreeContext: hasPotentialContext,
  });

  let contextManifest = input.contextManifest ?? EMPTY_COMPOSER_CONTEXT_MANIFEST;
  if (
    !input.contextManifest
    && contextPolicy !== 'fresh'
    && providerParentMessage?.id
    && (providerRouting.shouldBuildCrossProviderPacket || providerRouting.shouldInjectAgentreeContext)
  ) {
    const selection = buildComposerContextSelection(
      providerParentMessage.id,
      messages,
      null,
      'continue',
      input.contextStartMessageId ?? null,
    );
    contextManifest = buildComposerContextManifest(selection.turns, new Set(selection.defaultSelectedIds));
  }

  const promptMode = providerRouting.promptContextMode === 'cross_provider_packet' && providerContinuation && selectedProvider
    ? 'cross_provider'
    : providerRouting.promptContextMode === 'agentree_context'
      ? 'agentree_context'
      : 'plain';
  const agentRunPrompt = buildAgentRunPrompt({
    mode: promptMode,
    userPrompt: input.userPrompt,
    contextManifest,
    threadTitleMode: input.threadTitleMode ?? 'none',
    orchestrationLabelMode: input.orchestrationLabelMode ?? 'none',
    orchestrationControl: input.orchestrationControl ?? null,
  });

  const providerThreadStrategy = providerRouting.providerThreadStrategy;
  const parentProviderThreadId = providerContinuation?.sourceThreadId ?? null;
  const parentProviderTurnId = providerContinuation?.sourceTurnId ?? null;
  const parentProviderLineageId = providerContinuation?.sourceLineageId ?? null;
  const parentProviderUserTurnCount = providerContinuation?.sourceUserTurnCount ?? null;
  const sourceProviderThreadIdForSpawn = providerThreadStrategy === 'fresh_thread'
    ? null
    : providerContinuation?.sourceThreadId ?? null;
  const sourceProviderLineageIdForSpawn = providerThreadStrategy === 'fresh_thread'
    ? null
    : parentProviderLineageId;
  const sourceProviderTurnIdForSpawn = providerThreadStrategy === 'fresh_thread'
    ? null
    : parentProviderTurnId;

  const providerInternalArgs = selectedProvider
    ? [
      '--provider-thread-strategy',
      providerThreadStrategy,
      ...((sourceProviderThreadIdForSpawn && providerThreadStrategy === 'resume') ? ['--provider-thread-id', sourceProviderThreadIdForSpawn] : []),
      ...((sourceProviderThreadIdForSpawn && providerThreadStrategy !== 'resume') ? ['--source-provider-thread-id', sourceProviderThreadIdForSpawn] : []),
      ...((parentProviderLineageId && providerThreadStrategy !== 'fresh_thread') ? ['--source-provider-lineage-id', parentProviderLineageId] : []),
      ...((providerThreadStrategy === 'fork_then_rollback' && parentProviderUserTurnCount != null)
        ? ['--target-provider-user-turn-count', String(parentProviderUserTurnCount)]
        : []),
      ...((providerThreadStrategy === 'fork' && parentProviderTurnId)
        ? ['--target-provider-turn-id', parentProviderTurnId]
        : []),
      ...(input.targetNodeId ? ['--target-node-id', input.targetNodeId] : []),
      ...(input.nodeId ? ['--node-id', input.nodeId] : []),
    ]
    : [];

  const agentreeContextAvailableChars = contextManifest.contextText.trim().length;
  const shouldInjectAgentreeContext = agentRunPrompt.agentreeContextInjected;
  const agentreeContextInjectedChars = shouldInjectAgentreeContext ? agentreeContextAvailableChars : 0;
  const providerThreadStrategyRequested = providerRouting.providerThreadStrategyRequested;
  const providerContextRoutingMode = providerRouting.promptContextMode;
  const providerContextRoutingReason = providerRouting.reason;

  return {
    selectedProvider,
    prompt: agentRunPrompt.prompt,
    promptMode,
    providerInternalArgs,
    contextManifest,
    agentreeContextAvailableChars,
    agentreeContextInjectedChars,
    shouldInjectAgentreeContext,
    providerThreadStrategy,
    providerThreadStrategyRequested,
    providerContextRoutingMode,
    providerContextRoutingReason,
    providerParentProvider: providerContinuation?.parentProvider ?? null,
    providerParentThreadId: parentProviderThreadId,
    providerParentTurnId: parentProviderTurnId,
    providerParentLineageId: parentProviderLineageId,
    providerParentUserTurnCount: parentProviderUserTurnCount,
    isBranchFromInterior: branchFromInterior,
    meta: {
      ...manifestStatsMeta(contextManifest, agentreeContextInjectedChars, shouldInjectAgentreeContext),
      provider_thread_resume_enabled: providerThreadStrategy === 'resume',
      provider_parent_provider: providerContinuation?.parentProvider ?? null,
      provider_selected_provider: selectedProvider,
      provider_cross_provider_fresh_thread: providerContextRoutingMode === 'cross_provider_packet',
      provider_context_routing_mode: providerContextRoutingMode,
      provider_context_routing_reason: providerContextRoutingReason,
      provider_thread_strategy_requested: providerThreadStrategyRequested,
      provider_thread_id: sourceProviderThreadIdForSpawn,
      provider_source_thread_id: sourceProviderThreadIdForSpawn,
      provider_source_turn_id: sourceProviderTurnIdForSpawn,
      provider_parent_thread_id_available: parentProviderThreadId,
      provider_parent_turn_id_available: parentProviderTurnId,
      provider_parent_lineage_id_available: parentProviderLineageId,
      provider_lineage_id: sourceProviderLineageIdForSpawn,
      provider_target_user_turn_count: providerThreadStrategy === 'fork_then_rollback' ? parentProviderUserTurnCount : null,
      provider_target_turn_id: providerThreadStrategy === 'fork' ? parentProviderTurnId : null,
      provider_thread_strategy: providerThreadStrategy,
      ...(selectedProvider ? { provider: selectedProvider } : {}),
    },
  };
}
