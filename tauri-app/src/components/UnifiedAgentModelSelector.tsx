import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Check, ChevronRight, CircleGauge, KeyRound, Minus, Plus, Sparkles, X } from 'lucide-react';
import { useAgents, type Agent } from '../hooks/useAgents';
import {
    getReasoningEffortSortOrder,
    runtimeModels,
    type AgentModelConfig,
    type RuntimeProvider,
} from '../lib/runtimeModels';
import { dispatchOpenLoginProfiles } from '../lib/loginNavigationEvents';
import { ScrollArea } from "../../@/components/ui/scroll-area";
import { Checkbox } from "../../@/components/ui/checkbox";
import { cn } from '../lib/utils';
import {
    getProviderLimitSeverity,
    getProviderLimitWindows,
    providerLimitKey,
    type ProviderLimitDisplayWindow,
    type ProviderLimitsSnapshot,
    useProviderLimitsStore,
} from '../stores/providerLimitsStore';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import {
    hasActiveLoginProfileForProvider,
    isLoginProfileActive,
    isLoginProfileCompatibleWithProvider,
} from '../lib/loginProfiles';

interface UnifiedAgentModelSelectorProps {
    onSelectAgent: (agentId: string) => void;
    selectedAgentId: string | null;
    agentRunCounts?: Record<string, number>;
    onAgentRunCountChange?: (agentId: string, count: number) => void;
    excludedAgentIds?: readonly string[];
}

type AgentWithMeta = Agent & {
    model_config?: AgentModelConfig | null;
};

type AgentFamily = {
    key: string;
    label: string;
    description: string;
    provider: string;
    modesCount: number;
    models: AgentWithMeta[];
    defaultAgentId: string | null;
    selectedAgentId: string | null;
};

type ModelAvailability = {
    selectable: boolean;
    reason: string | null;
};

type PointerLocation = {
    x: number;
    y: number;
};

type MenuAimDebugState = {
    activeFamilyKey: string | null;
    candidateFamilyKey: string | null;
    delayMs: number;
    points: [PointerLocation, PointerLocation, PointerLocation] | null;
    pointer: PointerLocation | null;
};

const MENU_AIM_LOCATIONS_TRACKED = 3;
const MENU_AIM_ACTIVATION_DELAY_MS = 300;
const MENU_AIM_TOLERANCE_PX = 75;
const MENU_AIM_DEBUG_STORAGE_KEY = 'agentree.debug.model-menu-aim';

const isModelMenuAimDebugEnabled = () => {
    if (!import.meta.env.DEV || typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(MENU_AIM_DEBUG_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
};

const isPointInTriangle = (
    point: PointerLocation,
    triangle: [PointerLocation, PointerLocation, PointerLocation]
) => {
    const [a, b, c] = triangle;
    const sign = (left: PointerLocation, right: PointerLocation, target: PointerLocation) => (
        (left.x - target.x) * (right.y - target.y) - (right.x - target.x) * (left.y - target.y)
    );
    const d1 = sign(point, a, b);
    const d2 = sign(point, b, c);
    const d3 = sign(point, c, a);
    const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNegative && hasPositive);
};

const providerEffortNoun = (provider: string) => (provider === 'claude' ? 'Thinking' : 'Reasoning');

const isRuntimeProvider = (provider: string): provider is RuntimeProvider => (
    provider === 'codex' || provider === 'claude'
);

const providerAccentClasses = (provider: string) => {
    if (provider === 'claude') {
        return {
            text: 'text-stone-700 dark:text-stone-200',
            mutedText: 'text-stone-600/75 dark:text-stone-300/75',
            iconText: 'text-[#9a6b3d] dark:text-[#d2a06b]',
            iconSurface: 'bg-[#f4eadf] text-[#9a6b3d] shadow-[inset_0_0_0_1px_rgba(154,107,61,0.18)] dark:bg-[#38291d] dark:text-[#d2a06b]',
            rail: 'bg-[#b6814f]',
            selectedSurface: 'bg-[#fff8f0] shadow-[inset_0_0_0_1px_rgba(182,129,79,0.18)] dark:bg-[#2a211a]',
            hoverSurface: 'hover:bg-[#fff9f2] dark:hover:bg-[#251f1a]',
            dot: 'bg-[#b6814f]',
        };
    }
    return {
        text: 'text-emerald-900 dark:text-emerald-100',
        mutedText: 'text-emerald-800/70 dark:text-emerald-200/70',
        iconText: 'text-emerald-700 dark:text-emerald-300',
        iconSurface: 'bg-emerald-50 text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,135,93,0.16)] dark:bg-emerald-950/55 dark:text-emerald-300',
        rail: 'bg-emerald-600',
        selectedSurface: 'bg-emerald-50/85 shadow-[inset_0_0_0_1px_rgba(16,135,93,0.17)] dark:bg-emerald-950/35',
        hoverSurface: 'hover:bg-emerald-50/70 dark:hover:bg-emerald-950/25',
        dot: 'bg-emerald-600',
    };
};

const familyOrderByKey = new Map<string, number>();
const providerOrderByKey = new Map<string, number>();
for (const model of runtimeModels) {
    if (!providerOrderByKey.has(model.provider)) {
        providerOrderByKey.set(model.provider, providerOrderByKey.size);
    }
    if (!familyOrderByKey.has(model.familyKey)) {
        familyOrderByKey.set(model.familyKey, familyOrderByKey.size);
    }
}

const fallbackFamilyRank = (family: AgentFamily) => {
    const text = `${family.key} ${family.label}`.toLowerCase();
    const versionMatch = text.match(/(\d+(?:\.\d+)?)/);
    const version = versionMatch ? Number(versionMatch[1]) : 0;
    let tier = 0;

    if (text.includes('opus') || text.includes('max') || text.includes('frontier')) tier += 40;
    if (text.includes('sonnet') || text.includes('codex')) tier += 25;
    if (text.includes('haiku') || text.includes('mini') || text.includes('small')) tier -= 20;

    return (version * 100) + tier;
};

const sortModelFamilies = (left: AgentFamily, right: AgentFamily) => {
    const leftKnownOrder = familyOrderByKey.get(left.key);
    const rightKnownOrder = familyOrderByKey.get(right.key);

    if (leftKnownOrder != null && rightKnownOrder != null && leftKnownOrder !== rightKnownOrder) {
        return leftKnownOrder - rightKnownOrder;
    }
    if (leftKnownOrder != null) return -1;
    if (rightKnownOrder != null) return 1;

    const rankDelta = fallbackFamilyRank(right) - fallbackFamilyRank(left);
    if (rankDelta !== 0) return rankDelta;

    return left.label.localeCompare(right.label);
};

const sortProviders = ([left]: [string, Map<string, AgentFamily>], [right]: [string, Map<string, AgentFamily>]) => {
    const leftKnownOrder = providerOrderByKey.get(left);
    const rightKnownOrder = providerOrderByKey.get(right);

    if (leftKnownOrder != null && rightKnownOrder != null && leftKnownOrder !== rightKnownOrder) {
        return leftKnownOrder - rightKnownOrder;
    }
    if (leftKnownOrder != null) return -1;
    if (rightKnownOrder != null) return 1;

    return left.localeCompare(right);
};

const visibleLimitWindows = (
    snapshot: ProviderLimitsSnapshot | null,
    windows: ProviderLimitDisplayWindow[]
) => {
    if (!snapshot) return [];
    if (snapshot.kind === 'claude') {
        const fiveHour = windows.find((window) => window.id === 'five_hour') ?? null;
        const weekly =
            windows.find((window) => window.id === 'seven_day')
            ?? windows.filter((window) => String(window.id).startsWith('seven_day'))
                .sort((left, right) => (left.shortLabel + left.label).localeCompare(right.shortLabel + right.label))[0]
            ?? null;
        return [fiveHour, weekly].filter((window): window is ProviderLimitDisplayWindow => window != null);
    }
    return windows.slice(0, 2);
};

const usageRowClasses = (severity: ReturnType<typeof getProviderLimitSeverity>) => {
    if (severity === 'critical') {
        return {
            row: 'bg-red-50/88 text-red-700 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.16)] dark:bg-red-950/30 dark:text-red-300 dark:shadow-[inset_0_0_0_1px_rgba(248,113,113,0.18)]',
            dot: 'bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.12)]',
        };
    }
    if (severity === 'warning') {
        return {
            row: 'bg-amber-50/88 text-amber-800 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.16)] dark:bg-amber-950/30 dark:text-amber-300 dark:shadow-[inset_0_0_0_1px_rgba(251,191,36,0.18)]',
            dot: 'bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.12)]',
        };
    }
    return {
        row: 'bg-[hsl(var(--app-panel-strong))] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68)]',
        dot: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.1)]',
    };
};

function OpenAiMark({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
            <path
                d="M12 2.75a3.9 3.9 0 0 1 3.37 1.95l.22.39.37-.02a3.9 3.9 0 0 1 3.99 3.98l-.02.38.4.21a3.9 3.9 0 0 1 .5 6.45l-.3.24.1.36a3.9 3.9 0 0 1-5.1 4.7l-.35-.12-.24.3a3.9 3.9 0 0 1-6.43-.48l-.21-.4-.38.03a3.9 3.9 0 0 1-4-3.98l.03-.38-.4-.21a3.9 3.9 0 0 1-.48-6.45l.3-.24-.1-.36a3.9 3.9 0 0 1 5.1-4.71l.34.12.24-.3A3.9 3.9 0 0 1 12 2.75Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
            />
            <path
                d="M9.05 5.64 15.7 9.5v7.72M8.3 17.22 15 13.36M8.3 9.5 15 5.64"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function AnthropicMark({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
            <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
        </svg>
    );
}

export function UnifiedAgentModelSelector({
    onSelectAgent,
    selectedAgentId,
    agentRunCounts,
    onAgentRunCountChange,
    excludedAgentIds,
}: UnifiedAgentModelSelectorProps) {
    const { data: agentsData } = useAgents();
    const allAgents = useMemo(() => agentsData ?? [], [agentsData]);
    const excludedAgentIdSet = useMemo(() => new Set(excludedAgentIds ?? []), [excludedAgentIds]);
    const agents = useMemo(
        () => allAgents.filter((agent) => !excludedAgentIdSet.has(agent.id)),
        [allAgents, excludedAgentIdSet]
    );
    const providerLimits = useProviderLimitsStore((state) => state.byProvider);
    const loginProfiles = useLoginProfilesStore((state) => state.profiles);
    const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
    const [hoveredFamilyKey, setHoveredFamilyKey] = useState<string | null>(null);
    const hoveredFamilyKeyRef = useRef<string | null>(null);
    const activeFamilyKeyRef = useRef<string | null>(null);
    const familyListRef = useRef<HTMLDivElement | null>(null);
    const effortPanelRef = useRef<HTMLDivElement | null>(null);
    const pointerLocationsRef = useRef<PointerLocation[]>([]);
    const lastDelayLocationRef = useRef<PointerLocation | null>(null);
    const activationTimeoutRef = useRef<number | null>(null);
    const isMenuAimDebugEnabledRef = useRef(isModelMenuAimDebugEnabled());
    const [menuAimDebugState, setMenuAimDebugState] = useState<MenuAimDebugState | null>(null);
    const supportsMultiRun = Boolean(onAgentRunCountChange);
    const totalSelectedRuns = useMemo(() => (
        Object.values(agentRunCounts ?? {}).reduce((total, count) => total + Math.max(0, count || 0), 0)
    ), [agentRunCounts]);

    const getAgentRunCount = (agentId: string) => agentRunCounts?.[agentId] ?? (agentId === selectedAgentId ? 1 : 0);

    const updateAgentRunCount = (agentId: string, count: number) => {
        onSelectAgent(agentId);
        onAgentRunCountChange?.(agentId, count);
    };

    const getSelectedLoginProfileForProvider = (provider: string) => {
        const compatible = loginProfiles.filter((profile) => isLoginProfileCompatibleWithProvider(profile, provider));
        return compatible.find((profile) => profile.isDefault)
            ?? compatible[0]
            ?? null;
    };

    const isProviderSelectable = (provider: string) => {
        const selectedProfile = getSelectedLoginProfileForProvider(provider);
        if (selectedProfile) return isLoginProfileActive(selectedProfile);
        if (hasActiveLoginProfileForProvider(loginProfiles, provider)) return true;
        return false;
    };

    const getModelAvailability = (agent: AgentWithMeta): ModelAvailability => {
        if (!isProviderSelectable(agent.type)) {
            return { selectable: false, reason: 'Connect a ready login profile before choosing this model.' };
        }
        const outputsImages = agent.model_config?.capabilities?.outputModalities?.includes('image') === true;
        const selectedProfile = getSelectedLoginProfileForProvider(agent.type);
        if (agent.type === 'codex' && outputsImages && selectedProfile?.authType === 'codex_chatgpt_session') {
            return {
                selectable: false,
                reason: 'GPT Image 2 is not available through a Codex ChatGPT subscription. Use a Codex OpenAI API key profile to select this model.',
            };
        }
        return { selectable: true, reason: null };
    };

    const clearPendingFamilyActivation = () => {
        if (activationTimeoutRef.current == null) return;
        window.clearTimeout(activationTimeoutRef.current);
        activationTimeoutRef.current = null;
    };

    const activateFamily = (familyKey: string) => {
        if (activeFamilyKeyRef.current === familyKey) return;
        hoveredFamilyKeyRef.current = familyKey;
        activeFamilyKeyRef.current = familyKey;
        flushSync(() => {
            setHoveredFamilyKey(familyKey);
        });
    };

    const updateMenuAimDebugState = (state: MenuAimDebugState | null) => {
        if (!isMenuAimDebugEnabledRef.current) return;
        setMenuAimDebugState(state);
    };

    const trackPointerLocation = (event: ReactPointerEvent<HTMLElement>) => {
        const locations = pointerLocationsRef.current;
        const nextLocation = { x: event.clientX, y: event.clientY };
        const previousLocation = locations[locations.length - 1];
        if (previousLocation && previousLocation.x === nextLocation.x && previousLocation.y === nextLocation.y) {
            return;
        }
        locations.push(nextLocation);
        if (locations.length > MENU_AIM_LOCATIONS_TRACKED) {
            locations.shift();
        }
    };

    const familyActivationDelay = (candidateFamilyKey: string) => {
        if (!activeFamilyKeyRef.current) return 0;

        const familyListRect = familyListRef.current?.getBoundingClientRect();
        const effortPanelRect = effortPanelRef.current?.getBoundingClientRect();
        if (!familyListRect || !effortPanelRect || effortPanelRect.left <= familyListRect.right) return 0;

        const locations = pointerLocationsRef.current;
        const location = locations[locations.length - 1];
        const previousLocation = locations[0] ?? location;
        if (!location || !previousLocation) return 0;

        const panelUpperLeft = {
            x: effortPanelRect.left,
            y: effortPanelRect.top - MENU_AIM_TOLERANCE_PX,
        };
        const panelLowerLeft = {
            x: effortPanelRect.left,
            y: effortPanelRect.bottom + MENU_AIM_TOLERANCE_PX,
        };
        const previousWasOutsideFamilyList =
            previousLocation.x < familyListRect.left
            || previousLocation.x > effortPanelRect.left
            || previousLocation.y < familyListRect.top
            || previousLocation.y > familyListRect.bottom;
        if (previousWasOutsideFamilyList) return 0;

        const lastDelayLocation = lastDelayLocationRef.current;
        if (lastDelayLocation && location.x === lastDelayLocation.x && location.y === lastDelayLocation.y) {
            return MENU_AIM_ACTIVATION_DELAY_MS;
        }

        const triangle: [PointerLocation, PointerLocation, PointerLocation] = [previousLocation, panelUpperLeft, panelLowerLeft];
        const isMovingTowardPanel = location.x > previousLocation.x + 4;
        const shouldDelay = isMovingTowardPanel && isPointInTriangle(location, triangle);
        const delay = shouldDelay ? MENU_AIM_ACTIVATION_DELAY_MS : 0;
        updateMenuAimDebugState({
            activeFamilyKey: activeFamilyKeyRef.current,
            candidateFamilyKey,
            delayMs: delay,
            points: triangle,
            pointer: location,
        });

        if (shouldDelay) {
            lastDelayLocationRef.current = location;
            return delay;
        }

        lastDelayLocationRef.current = null;
        return 0;
    };

    const requestFamilyActivation = (familyKey: string, event: ReactPointerEvent<HTMLElement>) => {
        trackPointerLocation(event);
        if (activeFamilyKeyRef.current === familyKey) return;

        clearPendingFamilyActivation();
        const delay = familyActivationDelay(familyKey);
        if (delay <= 0) {
            activateFamily(familyKey);
            return;
        }

        activationTimeoutRef.current = window.setTimeout(() => {
            activationTimeoutRef.current = null;
            activateFamily(familyKey);
        }, delay);
    };

    const activateFamilyImmediately = (familyKey: string) => {
        clearPendingFamilyActivation();
        lastDelayLocationRef.current = null;
        updateMenuAimDebugState(null);
        activateFamily(familyKey);
    };

    const groupedAgents = useMemo(() => {
        const providerGroups = new Map<string, Map<string, AgentFamily>>();

        for (const agent of agents as AgentWithMeta[]) {
            const provider = agent.type;
            const providerFamilies = providerGroups.get(provider) ?? new Map<string, AgentFamily>();
            const familyKey = agent.model_config?.familyKey ?? `${provider}:${agent.model_config?.model ?? agent.id}`;
            const familyLabel = agent.model_config?.familyLabel ?? agent.name;
            const familyDescription = agent.model_config?.familyDescription
                ?? agent.model_config?.effortDescription
                ?? agent.name;
            const existing = providerFamilies.get(familyKey);
            if (existing) {
                existing.models.push(agent);
                if (agent.id === selectedAgentId || (agentRunCounts?.[agent.id] ?? 0) > 0) {
                    existing.selectedAgentId = agent.id;
                }
            } else {
                providerFamilies.set(familyKey, {
                    key: familyKey,
                    label: familyLabel,
                    description: familyDescription,
                    provider,
                    modesCount: 1,
                    models: [agent],
                    defaultAgentId: null,
                    selectedAgentId: agent.id === selectedAgentId || (agentRunCounts?.[agent.id] ?? 0) > 0 ? agent.id : null,
                });
            }
            providerGroups.set(provider, providerFamilies);
        }

        return Array.from(providerGroups.entries())
            .sort(sortProviders)
            .map(([provider, families]) => {
                const providerFamilies = Array.from(families.values()).map((family) => {
                    const sortedModels = [...family.models].sort((left, right) => {
                        const leftOrder = getReasoningEffortSortOrder(provider, left.model_config?.reasoningEffort);
                        const rightOrder = getReasoningEffortSortOrder(provider, right.model_config?.reasoningEffort);
                        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
                        return left.name.localeCompare(right.name);
                    });
                    const preferredEffort = provider === 'claude' ? 'high' : 'medium';
                    const defaultAgent =
                        sortedModels.find((model) => model.model_config?.reasoningEffort === preferredEffort)
                        ?? sortedModels[0]
                        ?? null;

                    return {
                        ...family,
                        modesCount: sortedModels.length,
                        models: sortedModels,
                        defaultAgentId: defaultAgent?.id ?? null,
                        selectedAgentId: sortedModels.find((model) => model.id === selectedAgentId || (agentRunCounts?.[model.id] ?? 0) > 0)?.id ?? null,
                    };
                }).sort(sortModelFamilies);

                return {
                    provider,
                    families: providerFamilies,
                };
            });
    }, [agents, selectedAgentId, agentRunCounts]);

    const activeProviderGroup = useMemo(() => (
        groupedAgents.find((group) => group.provider === selectedProvider)
        ?? groupedAgents.find((group) => group.families.some((family) => (
            family.models.some((model) => model.id === selectedAgentId)
        )))
        ?? groupedAgents.find((group) => group.families.some((family) => family.selectedAgentId != null))
        ?? groupedAgents[0]
        ?? null
    ), [groupedAgents, selectedAgentId, selectedProvider]);
    const familyList = useMemo(() => activeProviderGroup?.families ?? [], [activeProviderGroup]);
    const activeFamily = useMemo(() => {
        return familyList.find((family) => family.key === hoveredFamilyKey)
            ?? familyList.find((family) => family.selectedAgentId != null)
            ?? familyList[0]
            ?? null;
    }, [familyList, hoveredFamilyKey]);

    useEffect(() => {
        if (familyList.length === 0) {
            hoveredFamilyKeyRef.current = null;
            activeFamilyKeyRef.current = null;
            setHoveredFamilyKey(null);
            return;
        }
        if (hoveredFamilyKey && familyList.some((family) => family.key === hoveredFamilyKey)) return;
        const nextFamilyKey = (familyList.find((family) => family.selectedAgentId != null) ?? familyList[0]).key;
        hoveredFamilyKeyRef.current = nextFamilyKey;
        activeFamilyKeyRef.current = nextFamilyKey;
        setHoveredFamilyKey(nextFamilyKey);
    }, [familyList, hoveredFamilyKey]);

    useEffect(() => {
        hoveredFamilyKeyRef.current = hoveredFamilyKey;
    }, [hoveredFamilyKey]);

    useEffect(() => {
        activeFamilyKeyRef.current = activeFamily?.key ?? null;
    }, [activeFamily?.key]);

    useEffect(() => () => {
        clearPendingFamilyActivation();
    }, []);

    const providerMeta = (provider: string) => {
        if (provider === 'claude') {
            return {
                badge: 'Anthropic',
                title: 'Claude',
            };
        }
        if (provider === 'codex') {
            return {
                badge: 'OpenAI',
                title: 'Codex',
            };
        }
        return {
            badge: provider,
            title: provider.charAt(0).toUpperCase() + provider.slice(1),
        };
    };

    const openLoginProfilesForProvider = (provider: string) => {
        if (!isRuntimeProvider(provider)) return;
        dispatchOpenLoginProfiles(provider);
    };

    return (
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-[hsl(var(--app-bg-elevated))] text-popover-foreground">
            <div className="shrink-0 border-b border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong))] px-4 py-3 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset] dark:shadow-[0_1px_0_rgba(255,255,255,0.05)_inset]">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h4 className="text-[13px] font-semibold leading-none text-foreground">Models</h4>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">Hover a model to pick its effort level.</p>
                    </div>
                    <div className="hidden h-8 shrink-0 items-center gap-1.5 rounded-md bg-background/80 px-2.5 text-[10.5px] font-medium text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.7)] sm:flex">
                        <CircleGauge className="h-3.5 w-3.5" />
                        Effort
                    </div>
                </div>
                {groupedAgents.length > 0 ? (
                    <div role="tablist" aria-label="Model providers" className="mt-3 flex items-center gap-1 rounded-lg bg-background/58 p-1 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]">
                        {groupedAgents.map(({ provider, families }) => {
                            const meta = providerMeta(provider);
                            const accent = providerAccentClasses(provider);
                            const isActive = activeProviderGroup?.provider === provider;
                            const providerSelectable = isProviderSelectable(provider);
                            return (
                                <button
                                    key={provider}
                                    type="button"
                                    role="tab"
                                    aria-selected={isActive}
                                    data-model-provider-tab={provider}
                                    onClick={() => setSelectedProvider(provider)}
                                    className={cn(
                                        "flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-[12px] font-semibold outline-none transition-[background-color,box-shadow,color,transform] duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]",
                                        isActive
                                            ? "bg-background text-foreground shadow-[0_8px_18px_-16px_rgba(15,23,42,0.72),inset_0_0_0_1px_hsl(var(--app-border)/0.76)]"
                                            : "text-muted-foreground hover:bg-background/62 hover:text-foreground"
                                    )}
                                >
                                    {provider === 'claude' ? (
                                        <AnthropicMark className={cn("h-3.5 w-3.5 shrink-0", accent.iconText)} />
                                    ) : (
                                        <OpenAiMark className={cn("h-3.5 w-3.5 shrink-0", accent.iconText)} />
                                    )}
                                    <span className="truncate">{meta.title}</span>
                                    <span className="rounded bg-muted/55 px-1.5 py-0.5 text-[9.5px] font-medium tabular-nums text-muted-foreground">
                                        {families.length}
                                    </span>
                                    <span
                                        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", providerSelectable ? accent.dot : "bg-amber-500")}
                                        aria-label={providerSelectable ? `${meta.title} ready` : `${meta.title} login required`}
                                    />
                                </button>
                            );
                        })}
                    </div>
                ) : null}
            </div>

            {groupedAgents.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-2.5">
                    <div className="flex min-h-[220px] w-full flex-col items-center justify-center rounded-lg bg-background/65 px-5 text-center shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.7)]">
                        <Sparkles className="h-4 w-4 text-muted-foreground" />
                        <div className="mt-2 text-[13px] font-semibold text-foreground">
                            {allAgents.length > 0 && excludedAgentIdSet.size > 0 ? 'All models selected' : 'No runtimes available'}
                        </div>
                        <p className="mt-1 max-w-[26ch] text-[11px] leading-relaxed text-muted-foreground">
                            {allAgents.length > 0 && excludedAgentIdSet.size > 0
                                ? 'Every available model is already included in this run.'
                                : 'Add an agent provider before selecting a composer model.'}
                        </p>
                    </div>
                </div>
            ) : (
                <div
                    data-model-selector-body="true"
                    className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(156px,0.85fr)_minmax(0,1fr)]"
                >
                    <ScrollArea
                        data-model-family-column="true"
                        className="min-w-0 border-r border-[hsl(var(--app-border)/0.62)]"
                    >
                        <div
                            ref={familyListRef}
                            data-model-family-list="true"
                            className="space-y-3 p-2.5"
                            onPointerMove={trackPointerLocation}
                            onPointerLeave={() => {
                                pointerLocationsRef.current = [];
                                lastDelayLocationRef.current = null;
                                clearPendingFamilyActivation();
                                updateMenuAimDebugState(null);
                            }}
                        >
                            {activeProviderGroup ? (() => {
                                const { provider, families } = activeProviderGroup;
                                const meta = providerMeta(provider);
                                const accent = providerAccentClasses(provider);
                                const providerSelectable = isProviderSelectable(provider);
                                const selectedLoginProfile = getSelectedLoginProfileForProvider(provider);
                                const limitsSnapshot = provider === 'claude' || provider === 'codex'
                                    ? providerLimits[providerLimitKey(provider as RuntimeProvider, selectedLoginProfile?.id)]
                                    : null;
                                const limitWindows = getProviderLimitWindows(limitsSnapshot);
                                const limitSeverity = getProviderLimitSeverity(limitsSnapshot);
                                const showSeverityHint = limitSeverity !== 'normal';
                                const displayedLimitWindows = visibleLimitWindows(limitsSnapshot ?? null, limitWindows);
                                return (
                                    <section
                                        key={provider}
                                        data-login-provider-active={providerSelectable ? 'true' : 'false'}
                                        className={cn(
                                            "rounded-lg bg-background/72 p-2 shadow-[0_12px_34px_-30px_rgba(15,23,42,0.45),inset_0_0_0_1px_hsl(var(--app-border)/0.72)]"
                                        )}
                                    >
                                        {!providerSelectable || displayedLimitWindows.length > 0 ? (
                                            <div className="mb-2 space-y-2 px-1">
                                                <div className="flex min-w-0 items-center justify-between gap-2">
                                                    <span className="text-[10.5px] font-medium text-muted-foreground">
                                                        {families.length} {families.length === 1 ? 'family' : 'families'} available
                                                    </span>
                                                    {!providerSelectable && isRuntimeProvider(provider) ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => openLoginProfilesForProvider(provider)}
                                                            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-amber-50 px-2 text-[10.5px] font-semibold text-amber-800 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)] transition-[background-color,transform] duration-150 hover:bg-amber-100 active:scale-[0.96] dark:bg-amber-950/35 dark:text-amber-300 dark:hover:bg-amber-950/55"
                                                        >
                                                            <KeyRound className="h-3 w-3" />
                                                            Login to {meta.title}
                                                        </button>
                                                    ) : null}
                                                </div>
                                                {displayedLimitWindows.length > 0 ? (
                                                    <div className="flex justify-end">
                                                        <div className="grid shrink-0 gap-1" aria-label={`${meta.title} usage availability`}>
                                                            {displayedLimitWindows.map((window) => {
                                                                const rowStyle = usageRowClasses(window.severity);
                                                                return (
                                                                    <div
                                                                        key={window.id}
                                                                        className={cn(
                                                                            "flex h-5 min-w-[92px] items-center justify-between gap-2 rounded px-1.5 text-[10px] font-semibold tabular-nums",
                                                                            rowStyle.row
                                                                        )}
                                                                    >
                                                                        <span className="flex min-w-0 items-center gap-1.5">
                                                                            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", rowStyle.dot)} aria-hidden="true" />
                                                                            <span className="truncate">{window.shortLabel}</span>
                                                                        </span>
                                                                        <span className="text-foreground/82 dark:text-current">
                                                                            {window.percent != null ? `${window.percent}% left` : 'n/a'}
                                                                        </span>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </div>
                                        ) : null}
                                        <div className={cn("space-y-1", !providerSelectable && "opacity-45 grayscale")}>
                                            {families.map((family) => {
                                                const isSelected = family.selectedAgentId != null;
                                                const isActive = activeFamily?.key === family.key;
                                                const isSelectedActive = isSelected && isActive;
                                                return (
                                                    <button
                                                        key={family.key}
                                                        type="button"
                                                        data-model-family-key={family.key}
                                                        onPointerEnter={(event) => {
                                                            if (providerSelectable) requestFamilyActivation(family.key, event);
                                                        }}
                                                        onPointerMove={(event) => {
                                                            if (providerSelectable) requestFamilyActivation(family.key, event);
                                                        }}
                                                        onFocus={() => {
                                                            if (providerSelectable) activateFamilyImmediately(family.key);
                                                        }}
                                                        onClick={() => {
                                                            if (providerSelectable) activateFamilyImmediately(family.key);
                                                        }}
                                                        className={cn(
                                                            "group relative flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2.5 text-left outline-none transition-[background-color,box-shadow,transform] duration-150 ease-out",
                                                            "focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-[0.96]",
                                                            accent.hoverSurface,
                                                            isActive ? accent.selectedSurface : "bg-transparent",
                                                            isSelectedActive && "shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.4)]"
                                                        )}
                                                        aria-pressed={isActive}
                                                        aria-disabled={!providerSelectable}
                                                    >
                                                        <span
                                                            className={cn(
                                                                "absolute left-0 top-2 bottom-2 w-0.5 rounded-full opacity-0 transition-opacity duration-150",
                                                                accent.rail,
                                                                isActive && "opacity-100"
                                                            )}
                                                            aria-hidden="true"
                                                        />
                                                        <div className="min-w-0 flex-1">
                                                            <div className={cn(
                                                                "truncate text-[13px] leading-tight",
                                                                isSelected ? cn("font-semibold", accent.text) : "font-medium text-foreground/86 group-hover:text-foreground"
                                                            )}>
                                                                {family.label}
                                                            </div>
                                                            <div className="mt-1 truncate text-[10.5px] leading-none text-muted-foreground">
                                                                {family.description}
                                                            </div>
                                                        </div>
                                                        <div className="flex shrink-0 items-center gap-2 pl-2">
                                                            <span className="rounded bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.55)]">
                                                                {family.modesCount}x
                                                            </span>
                                                            {showSeverityHint ? (
                                                                <span
                                                                    className={cn(
                                                                        "h-1.5 w-1.5 rounded-full",
                                                                        limitSeverity === 'critical' ? "bg-red-500/80" : "bg-amber-500/80"
                                                                    )}
                                                                    aria-hidden="true"
                                                                />
                                                            ) : null}
                                                            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-150", isActive && "translate-x-0.5")} aria-hidden="true" />
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </section>
                                );
                            })() : null}
                        </div>
                    </ScrollArea>
                    <div
                        ref={effortPanelRef}
                        data-model-effort-column="true"
                        className="min-w-0 overflow-x-hidden overflow-y-auto bg-[hsl(var(--app-bg-elevated))] p-2.5"
                    >
                        {activeFamily ? (() => {
                            const provider = activeFamily.provider;
                            const accent = providerAccentClasses(provider);
                            const providerSelectable = isProviderSelectable(provider);
                            const meta = providerMeta(provider);
                            if (!providerSelectable) {
                                return (
                                    <div
                                        data-model-effort-panel={activeFamily.key}
                                        data-login-provider-active="false"
                                        className="flex h-full items-center justify-center rounded-lg bg-background/74 p-5 text-center shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72)]"
                                    >
                                        <div className="max-w-[24ch]">
                                            <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-700 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)] dark:bg-amber-950/35 dark:text-amber-300">
                                                <KeyRound className="h-4 w-4" />
                                            </div>
                                            <div className="mt-3 text-[13px] font-semibold text-foreground">{meta.title} login required</div>
                                            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                                                Connect a ready account before choosing effort.
                                            </p>
                                            {isRuntimeProvider(provider) ? (
                                                <button
                                                    type="button"
                                                    onClick={() => openLoginProfilesForProvider(provider)}
                                                    className="mt-4 inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-foreground px-3 text-[11px] font-semibold text-background shadow-[0_10px_24px_-18px_rgba(15,23,42,0.75)] transition-[background-color,transform] duration-150 hover:bg-foreground/88 active:scale-[0.96]"
                                                >
                                                    <KeyRound className="h-3.5 w-3.5" />
                                                    Login to {meta.title}
                                                </button>
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            }
                            return (
                                <div
                                    data-model-effort-panel={activeFamily.key}
                                    className="min-h-full min-w-0 overflow-hidden rounded-lg bg-background/74 p-2 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72)]"
                                >
                                    <div className="border-b border-[hsl(var(--app-border)/0.58)] px-2 pb-2">
                                        <div className="text-[11px] font-medium text-muted-foreground">
                                            {providerEffortNoun(provider)} effort
                                        </div>
                                        <div className="mt-1 truncate text-[13px] font-semibold leading-tight text-foreground">
                                            {activeFamily.label}
                                        </div>
                                    </div>
                                    <div className="mt-2 space-y-1">
                                        {activeFamily.models.map((agent) => {
                                            const count = getAgentRunCount(agent.id);
                                            const isSelected = count > 0;
                                            const canRemove = totalSelectedRuns > count;
                                            const effortLabel = agent.model_config?.effortLabel ?? agent.model_config?.reasoningEffort ?? 'default';
                                            const effortDescription = agent.model_config?.effortDescription ?? 'Available mode';
                                            const availability = getModelAvailability(agent);
                                            const isModelSelectable = availability.selectable;
                                            const increment = () => updateAgentRunCount(agent.id, count + 1);
                                            const decrement = () => updateAgentRunCount(agent.id, count - 1);
                                            const remove = () => updateAgentRunCount(agent.id, 0);
                                            return (
                                                <div
                                                    key={agent.id}
                                                    role="button"
                                                    tabIndex={0}
                                                    title={availability.reason ?? undefined}
                                                    onClick={() => {
                                                        if (!isModelSelectable) return;
                                                        if (supportsMultiRun) {
                                                            if (!isSelected) {
                                                                updateAgentRunCount(agent.id, 1);
                                                            } else {
                                                                onSelectAgent(agent.id);
                                                            }
                                                            return;
                                                        }
                                                        onSelectAgent(agent.id);
                                                    }}
                                                    onKeyDown={(event) => {
                                                        if (event.key !== 'Enter' && event.key !== ' ') return;
                                                        event.preventDefault();
                                                        if (!isModelSelectable) return;
                                                        if (supportsMultiRun) {
                                                            updateAgentRunCount(agent.id, isSelected ? Math.max(1, count) : 1);
                                                            return;
                                                        }
                                                        onSelectAgent(agent.id);
                                                    }}
                                                    data-model-effort={agent.model_config?.reasoningEffort ?? 'default'}
                                                    className={cn(
                                                        "group/effort flex w-full min-w-0 flex-wrap items-start justify-between gap-3 overflow-hidden rounded-md px-2.5 py-2.5 text-left outline-none transition-[background-color,box-shadow,transform] duration-150 ease-out",
                                                        "hover:bg-[hsl(var(--app-bg-elevated))] focus-visible:bg-[hsl(var(--app-bg-elevated))] focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-[0.96]",
                                                        isSelected ? "bg-[hsl(var(--app-bg-elevated))] shadow-[0_10px_24px_-22px_rgba(15,23,42,0.7),inset_0_0_0_1px_hsl(var(--app-border)/0.8)]" : "bg-transparent",
                                                        !isModelSelectable && "cursor-not-allowed opacity-45 hover:bg-transparent active:scale-100"
                                                    )}
                                                    aria-disabled={!isModelSelectable}
                                                >
                                                    <div className="flex min-w-0 flex-[1_1_7rem] gap-2.5 pr-1">
                                                        {supportsMultiRun ? (
                                                            <span
                                                                className="mt-0.5 shrink-0"
                                                                onClick={(event) => event.stopPropagation()}
                                                                onPointerDown={(event) => event.stopPropagation()}
                                                            >
                                                                <Checkbox
                                                                    checked={isSelected}
                                                                    indicatorMode="check"
                                                                    onCheckedChange={(checked) => {
                                                                        if (!isModelSelectable) return;
                                                                        updateAgentRunCount(agent.id, checked === true ? Math.max(1, count) : 0);
                                                                    }}
                                                                    disabled={!isModelSelectable || (isSelected && !canRemove)}
                                                                    aria-label={`${isSelected ? 'Remove' : 'Add'} ${effortLabel}`}
                                                                />
                                                            </span>
                                                        ) : (
                                                            <span
                                                                className={cn(
                                                                    "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full opacity-60 transition-opacity duration-150",
                                                                    accent.dot,
                                                                    isSelected && "opacity-100"
                                                                )}
                                                                aria-hidden="true"
                                                            />
                                                        )}
                                                        <div className="min-w-0 flex-1">
                                                            <div className={cn(
                                                                "truncate text-[13px] leading-tight",
                                                                isSelected ? "font-semibold text-foreground" : "font-medium text-foreground/82 group-hover/effort:text-foreground"
                                                            )}>
                                                                {effortLabel}
                                                            </div>
                                                            <div className="mt-1 truncate text-[10.5px] leading-none text-muted-foreground">
                                                                {effortDescription}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div
                                                        className={cn(
                                                            "ml-auto flex min-h-7 max-w-full shrink-0 items-center gap-1.5 rounded-md bg-muted/35 p-0.5 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.55)] transition-[opacity,transform,background-color,box-shadow] duration-150 ease-out",
                                                            supportsMultiRun && !isSelected && "opacity-0 group-hover/effort:opacity-100 group-focus-visible/effort:opacity-100",
                                                            isSelected && "bg-background shadow-[0_8px_20px_-16px_rgba(15,23,42,0.8),inset_0_0_0_1px_hsl(var(--app-border)/0.8)]"
                                                        )}
                                                        onClick={(event) => event.stopPropagation()}
                                                        onPointerDown={(event) => event.stopPropagation()}
                                                    >
                                                        {supportsMultiRun ? (
                                                            <>
                                                                {isSelected ? (
                                                                    <button
                                                                        type="button"
                                                                        onClick={remove}
                                                                        disabled={!isModelSelectable || !canRemove}
                                                                        className="flex h-6 w-6 items-center justify-center rounded bg-background text-muted-foreground shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_0_0_1px_hsl(var(--app-border)/0.8)] transition-[background-color,color,transform,opacity] duration-150 hover:bg-red-50 hover:text-red-600 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                                                                        aria-label={`Remove ${effortLabel}`}
                                                                    >
                                                                        <X className="h-3.5 w-3.5" strokeWidth={2.4} />
                                                                    </button>
                                                                ) : null}
                                                                <button
                                                                    type="button"
                                                                    onClick={decrement}
                                                                    disabled={!isModelSelectable || !isSelected || !canRemove}
                                                                    className="flex h-6 w-6 items-center justify-center rounded bg-background text-muted-foreground shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_0_0_1px_hsl(var(--app-border)/0.8)] transition-[background-color,color,transform,opacity] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35"
                                                                    aria-label={`Decrease ${effortLabel}`}
                                                                >
                                                                    <Minus className="h-3.5 w-3.5" strokeWidth={2.4} />
                                                                </button>
                                                                <span className="min-w-5 text-center text-[11px] font-semibold tabular-nums text-foreground">
                                                                    {count}
                                                                </span>
                                                                <button
                                                                    type="button"
                                                                    onClick={increment}
                                                                    disabled={!isModelSelectable}
                                                                    className={cn(
                                                                        "flex h-6 w-6 items-center justify-center rounded text-white shadow-[0_8px_18px_-12px_rgba(16,185,129,0.7)] transition-[background-color,transform,box-shadow] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35",
                                                                        provider === 'claude' ? "bg-[#b6814f] hover:bg-[#a47346]" : "bg-emerald-600 hover:bg-emerald-700"
                                                                    )}
                                                                    aria-label={`Increase ${effortLabel}`}
                                                                >
                                                                    <Plus className="h-3.5 w-3.5" strokeWidth={2.6} />
                                                                </button>
                                                            </>
                                                        ) : isSelected ? (
                                                            <Check className={cn("h-3.5 w-3.5", accent.text)} strokeWidth={2.5} />
                                                        ) : null}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })() : null}
                    </div>
                </div>
            )}
            {isMenuAimDebugEnabledRef.current && menuAimDebugState?.points && typeof document !== 'undefined' ? createPortal((
                <svg
                    className="pointer-events-none fixed inset-0 z-[2147483647] h-screen w-screen"
                    aria-hidden="true"
                >
                    <polygon
                        points={menuAimDebugState.points.map((point) => `${point.x},${point.y}`).join(' ')}
                        fill={menuAimDebugState.delayMs > 0 ? 'rgba(16, 185, 129, 0.16)' : 'rgba(239, 68, 68, 0.12)'}
                        stroke={menuAimDebugState.delayMs > 0 ? 'rgba(5, 150, 105, 0.9)' : 'rgba(220, 38, 38, 0.75)'}
                        strokeWidth="2"
                        strokeDasharray={menuAimDebugState.delayMs > 0 ? undefined : '6 5'}
                    />
                    {menuAimDebugState.points.map((point, index) => (
                        <circle
                            key={`${point.x}:${point.y}:${index}`}
                            cx={point.x}
                            cy={point.y}
                            r="4"
                            fill={index === 0 ? 'rgba(15, 23, 42, 0.95)' : 'rgba(5, 150, 105, 0.95)'}
                        />
                    ))}
                    {menuAimDebugState.pointer ? (
                        <circle
                            cx={menuAimDebugState.pointer.x}
                            cy={menuAimDebugState.pointer.y}
                            r="5"
                            fill={menuAimDebugState.delayMs > 0 ? 'rgb(16, 185, 129)' : 'rgb(239, 68, 68)'}
                            stroke="white"
                            strokeWidth="2"
                        />
                    ) : null}
                    {menuAimDebugState.pointer ? (
                        <text
                            x={menuAimDebugState.pointer.x + 10}
                            y={menuAimDebugState.pointer.y - 10}
                            fill={menuAimDebugState.delayMs > 0 ? 'rgb(4, 120, 87)' : 'rgb(185, 28, 28)'}
                            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                            fontSize="11"
                            fontWeight="700"
                        >
                            {menuAimDebugState.delayMs > 0 ? 'menu aim: delay' : 'menu aim: switch'}
                        </text>
                    ) : null}
                </svg>
            ), document.body) : null}
        </div>
    );
}
