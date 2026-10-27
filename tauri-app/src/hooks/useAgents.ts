import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    type AgentModelConfig,
    bootstrapRuntimeModels,
    defaultRuntimeModelKey,
    openCodeRuntimeModelsFromCatalogRecords,
    runtimeModelsFromOpenCodeCatalog,
    runtimeModelsFromNativeCatalog,
    type RuntimeModel,
    type RuntimeProvider,
} from '../lib/runtimeModels';
import { agentClient, type RuntimeModelCatalogCache } from '../lib/agentClient';
import {
    getCachedOpenCodeModelCatalog,
    getCachedOpenCodeModelCatalogCheckedAt,
} from '../lib/openCodeModelCatalog';
import { isLoginProfileActive, selectLoginProfileForProvider } from '../lib/loginProfiles';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import { useModelStore } from '../stores/modelStore';

export interface Agent {
    id: string;
    name: string;
    type: string;
    tools?: string[];
    model_config?: AgentModelConfig | null;
    cliArgs?: string;
    promptFlag?: string | null;
    color?: string;
}

export const agentsFromRuntimeModels = (models: readonly RuntimeModel[]): Agent[] => models.map((model) => ({
    id: model.key,
    name: model.label,
    type: model.provider,
    tools: [],
    model_config: {
        model: model.modelId,
        canonicalModelId: model.canonicalModelId ?? model.modelId,
        modelProvider: model.provider === 'opencode' ? model.modelId.split('/')[0] : model.provider,
        familyKey: model.familyKey,
        familyLabel: model.familyLabel,
        familyDescription: model.familyDescription,
        effortLabel: model.effortLabel,
        effortDescription: model.effortDescription,
        reasoningEffort: model.reasoningEffort ?? null,
        capabilities: model.capabilities,
        releaseDate: model.releaseDate ?? null,
        status: model.status ?? null,
        isFree: model.isFree ?? null,
    },
    cliArgs: model.cliArgs,
    promptFlag: model.promptFlag,
    color: model.color,
}));

export const runtimeAgents: Agent[] = agentsFromRuntimeModels(bootstrapRuntimeModels);

const emptyNativeCatalogCache: RuntimeModelCatalogCache = {
    supported: [],
    opencodeAccessible: null,
    staleProviders: [],
};

export function findDefaultCodexAgentId(agents: Agent[]): string | null {
    const exact = agents.find((agent) => agent.id === defaultRuntimeModelKey);
    if (exact) return exact.id;

    const codexAgent = agents.find((agent) => agent.type === 'codex');
    if (codexAgent) return codexAgent.id;

    const nameMatch = agents.find((agent) => agent.name?.toLowerCase().includes('codex'));
    return nameMatch?.id ?? null;
}

const familyKeysByProvider = (catalog: readonly RuntimeModel[]) => {
    const result = new Map<RuntimeProvider, Set<string>>();
    for (const model of catalog) {
        const keys = result.get(model.provider) ?? new Set<string>();
        keys.add(model.familyKey);
        result.set(model.provider, keys);
    }
    return result;
};

export const composeRuntimeModelCatalog = (
    nativeCache: RuntimeModelCatalogCache,
    accessibleOpenCodeModels: Parameters<typeof runtimeModelsFromOpenCodeCatalog>[0],
): RuntimeModel[] => {
    const supportedByProvider = new Map(
        nativeCache.supported
            .filter((snapshot) => snapshot.scope === 'supported' && snapshot.models.length > 0)
            .map((snapshot) => [snapshot.provider, snapshot] as const),
    );
    const nativeCodexAndClaude = ['codex', 'claude'].flatMap((provider) => {
        const snapshot = supportedByProvider.get(provider);
        return snapshot ? runtimeModelsFromNativeCatalog(snapshot.models) : [];
    });
    const providersWithNativeCatalog = new Set(
        nativeCodexAndClaude.map((model) => model.provider),
    );
    const bootstrapFallback = bootstrapRuntimeModels.filter(
        (model) => !providersWithNativeCatalog.has(model.provider),
    );

    const nativeAccessibleOpenCode = nativeCache.opencodeAccessible
        ? openCodeRuntimeModelsFromCatalogRecords(nativeCache.opencodeAccessible.models)
        : null;
    const accessibleOpenCode = nativeAccessibleOpenCode ?? accessibleOpenCodeModels;
    const supportedOpenCode = supportedByProvider.get('opencode');
    const supportedOpenCodeIds = supportedOpenCode
        ? new Set(supportedOpenCode.models.flatMap((model) => [
            model.canonicalModelId,
            model.cliModelId,
        ]))
        : null;
    const effectiveOpenCode = supportedOpenCodeIds
        ? accessibleOpenCode.filter((model) => supportedOpenCodeIds.has(model.id))
        : accessibleOpenCode;

    return [
        ...bootstrapFallback,
        ...nativeCodexAndClaude,
        ...runtimeModelsFromOpenCodeCatalog(effectiveOpenCode),
    ];
};

/**
 * Canonical frontend catalog. Codex and Claude currently come from the bundled
 * bootstrap snapshot; OpenCode is the cached accessible catalog for the same
 * ready profile the launch flow would select. Refreshing that profile belongs
 * to account management/background catalog work, never this render hook.
 */
export function useRuntimeModelCatalog() {
    const queryClient = useQueryClient();
    const loginProfiles = useLoginProfilesStore((state) => state.profiles);
    const initializeVisibleFamilyKeys = useModelStore((state) => state.initializeVisibleFamilyKeys);
    const opencodeProfile = useMemo(
        () => selectLoginProfileForProvider(loginProfiles, 'opencode'),
        [loginProfiles],
    );
    const opencodeCatalog = useMemo(
        () => opencodeProfile && isLoginProfileActive(opencodeProfile)
            ? getCachedOpenCodeModelCatalog(opencodeProfile)
            : [],
        [opencodeProfile],
    );
    const catalogCheckedAt = getCachedOpenCodeModelCatalogCheckedAt(opencodeProfile);
    const queryKey = useMemo(() => [
        'runtime-model-catalog-cache',
        opencodeProfile?.id ?? null,
        catalogCheckedAt,
        opencodeProfile?.lastCheckedAt ?? null,
    ] as const, [catalogCheckedAt, opencodeProfile?.id, opencodeProfile?.lastCheckedAt]);
    const nativeCatalogQuery = useQuery({
        queryKey,
        queryFn: () => agentClient.getRuntimeModelCatalogs(opencodeProfile?.id ?? null),
        placeholderData: emptyNativeCatalogCache,
        staleTime: Infinity,
        refetchOnMount: false,
    });
    const catalog = useMemo(
        () => composeRuntimeModelCatalog(
            nativeCatalogQuery.data ?? emptyNativeCatalogCache,
            opencodeCatalog,
        ),
        [nativeCatalogQuery.data, opencodeCatalog],
    );

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;
        void agentClient.onRuntimeModelCatalogChanged((cache) => {
            if (!disposed) {
                queryClient.setQueryData<RuntimeModelCatalogCache>(queryKey, (current) => ({
                    ...cache,
                    opencodeAccessible: cache.opencodeAccessible
                        ?? current?.opencodeAccessible
                        ?? null,
                }));
            }
        }).then((cleanup) => {
            if (disposed) cleanup();
            else unlisten = cleanup;
        });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [queryClient, queryKey]);

    useEffect(() => {
        for (const [provider, familyKeys] of familyKeysByProvider(catalog)) {
            if (familyKeys.size > 0) {
                initializeVisibleFamilyKeys(provider, Array.from(familyKeys));
            }
        }
    }, [catalog, initializeVisibleFamilyKeys]);

    return {
        ...nativeCatalogQuery,
        data: catalog,
        dataUpdatedAt: Math.max(
            nativeCatalogQuery.dataUpdatedAt,
            catalogCheckedAt ?? 0,
            (opencodeProfile?.lastCheckedAt ?? 0) * 1_000,
        ),
    };
}

export function useAgents() {
    const catalogQuery = useRuntimeModelCatalog();
    const agents = useMemo(
        () => agentsFromRuntimeModels(catalogQuery.data),
        [catalogQuery.data],
    );
    return { ...catalogQuery, data: agents };
}
