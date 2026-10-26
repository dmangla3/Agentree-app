export type RuntimeProvider = 'claude' | 'codex' | 'opencode';
export type ProviderThreadStrategy = 'fresh_thread' | 'resume' | 'fork_at_turn';
export type ProviderThreadStrategyRequested = ProviderThreadStrategy | 'cross_provider_fresh_thread';
export type PromptContextMode = 'provider_native_only' | 'agentree_context' | 'cross_provider_packet' | 'none';

export interface ProviderContinuationDecision {
    adapterStrategy: ProviderThreadStrategy;
    requestedStrategy: ProviderThreadStrategyRequested;
    sourceThreadId: string | null;
    sourceTurnId: string | null;
    sourceLineageId: string | null;
    parentProvider: RuntimeProvider | 'unknown' | null;
    selectedProvider: RuntimeProvider;
    isCrossProvider: boolean;
    canUseProviderThread: boolean;
}

export interface ProviderContextRoutingDecision {
    providerThreadStrategy: ProviderThreadStrategy;
    providerThreadStrategyRequested: ProviderThreadStrategyRequested;
    promptContextMode: PromptContextMode;
    shouldInjectAgentreeContext: boolean;
    shouldBuildCrossProviderPacket: boolean;
    reason: string;
}

const PROVIDERS: RuntimeProvider[] = ['claude', 'codex', 'opencode'];

const normalizeProvider = (value: unknown): RuntimeProvider | null => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return PROVIDERS.includes(normalized as RuntimeProvider) ? normalized as RuntimeProvider : null;
};

export const resolveParentProvider = (meta: Record<string, unknown>): RuntimeProvider | 'unknown' | null => {
    const provider =
        normalizeProvider(meta.provider) ||
        normalizeProvider(meta.provider_lineage_provider) ||
        normalizeProvider(meta.agent_session_provider);

    if (provider) return provider;

    const hasProviderState = typeof meta.provider_thread_id === 'string' || typeof meta.agent_session_id === 'string';
    return hasProviderState ? 'unknown' : null;
};

const stringValue = (value: unknown): string | null => (
    typeof value === 'string' && value.trim() ? value : null
);

export function resolveProviderContinuation(params: {
    selectedProvider: RuntimeProvider;
    parentMeta: Record<string, unknown>;
    isBranchFromInterior: boolean;
}): ProviderContinuationDecision {
    const parentProvider = resolveParentProvider(params.parentMeta);
    const parentThreadId = stringValue(params.parentMeta.provider_thread_id);
    const parentTurnId = stringValue(params.parentMeta.provider_turn_id);
    const parentLineageId = stringValue(params.parentMeta.provider_lineage_id) || parentThreadId;
    const canUseProviderThread = parentProvider === params.selectedProvider && Boolean(parentThreadId);

    if (!canUseProviderThread) {
        return {
            adapterStrategy: 'fresh_thread',
            requestedStrategy: parentProvider && parentProvider !== params.selectedProvider
                ? 'cross_provider_fresh_thread'
                : 'fresh_thread',
            sourceThreadId: null,
            sourceTurnId: null,
            sourceLineageId: null,
            parentProvider,
            selectedProvider: params.selectedProvider,
            isCrossProvider: Boolean(parentProvider && parentProvider !== params.selectedProvider),
            canUseProviderThread: false,
        };
    }

    if (!params.isBranchFromInterior) {
        return {
            adapterStrategy: 'resume',
            requestedStrategy: 'resume',
            sourceThreadId: parentThreadId,
            sourceTurnId: parentTurnId,
            sourceLineageId: parentLineageId,
            parentProvider,
            selectedProvider: params.selectedProvider,
            isCrossProvider: false,
            canUseProviderThread: true,
        };
    }

    return {
        adapterStrategy: 'fork_at_turn',
        requestedStrategy: 'fork_at_turn',
        sourceThreadId: parentThreadId,
        sourceTurnId: parentTurnId,
        sourceLineageId: parentLineageId,
        parentProvider,
        selectedProvider: params.selectedProvider,
        isCrossProvider: false,
        canUseProviderThread: true,
    };
}

export function resolveProviderContextRouting(params: {
    continuation: ProviderContinuationDecision | null;
    contextMode: 'active' | 'none' | null | undefined;
    contextPolicy?: 'continue' | 'fresh' | null | undefined;
    hasSelectedAgentreeContext: boolean;
}): ProviderContextRoutingDecision {
    if (params.contextPolicy === 'fresh') {
        return {
            providerThreadStrategy: 'fresh_thread',
            providerThreadStrategyRequested: 'fresh_thread',
            promptContextMode: 'none',
            shouldInjectAgentreeContext: false,
            shouldBuildCrossProviderPacket: false,
            reason: 'fresh_context',
        };
    }

    if (params.contextMode === 'none') {
        return {
            providerThreadStrategy: 'fresh_thread',
            providerThreadStrategyRequested: 'fresh_thread',
            promptContextMode: 'none',
            shouldInjectAgentreeContext: false,
            shouldBuildCrossProviderPacket: false,
            reason: 'context_mode_none',
        };
    }

    const continuation = params.continuation;
    const providerThreadStrategy = continuation?.adapterStrategy ?? 'fresh_thread';
    const providerThreadStrategyRequested = continuation?.requestedStrategy ?? providerThreadStrategy;

    if (continuation && !continuation.isCrossProvider && providerThreadStrategy !== 'fresh_thread') {
        return {
            providerThreadStrategy,
            providerThreadStrategyRequested,
            promptContextMode: 'provider_native_only',
            shouldInjectAgentreeContext: false,
            shouldBuildCrossProviderPacket: false,
            reason: 'same_provider_thread_reuse',
        };
    }

    if (continuation?.isCrossProvider) {
        return {
            providerThreadStrategy: 'fresh_thread',
            providerThreadStrategyRequested: 'cross_provider_fresh_thread',
            promptContextMode: 'cross_provider_packet',
            shouldInjectAgentreeContext: params.hasSelectedAgentreeContext,
            shouldBuildCrossProviderPacket: true,
            reason: 'cross_provider_fresh_thread',
        };
    }

    if (params.hasSelectedAgentreeContext) {
        return {
            providerThreadStrategy,
            providerThreadStrategyRequested,
            promptContextMode: 'agentree_context',
            shouldInjectAgentreeContext: true,
            shouldBuildCrossProviderPacket: false,
            reason: 'fresh_thread_with_selected_context',
        };
    }

    return {
        providerThreadStrategy,
        providerThreadStrategyRequested,
        promptContextMode: 'none',
        shouldInjectAgentreeContext: false,
        shouldBuildCrossProviderPacket: false,
        reason: 'no_selected_context',
    };
}
