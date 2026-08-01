import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, CircleGauge, Sparkles } from 'lucide-react';
import { useAgents, type Agent } from '../hooks/useAgents';
import { runtimeModels } from '../lib/runtimeModels';
import { ScrollArea } from "../../@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "../../@/components/ui/popover";
import { cn } from '../lib/utils';
import {
    getProviderLimitSeverity,
    getProviderLimitWindows,
    type ProviderLimitDisplayWindow,
    type ProviderLimitsSnapshot,
    useProviderLimitsStore,
} from '../stores/providerLimitsStore';

interface UnifiedAgentModelSelectorProps {
    onSelectAgent: (agentId: string) => void;
    selectedAgentId: string | null;
}

type AgentModelConfig = {
    model?: string;
    familyKey?: string | null;
    familyLabel?: string | null;
    familyDescription?: string | null;
    effortLabel?: string | null;
    effortDescription?: string | null;
    reasoningEffort?: string | null;
};

type AgentWithMeta = Agent & {
    model_config?: AgentModelConfig;
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

const providerEffortNoun = (provider: string) => (provider === 'claude' ? 'Thinking' : 'Reasoning');
const FLYOUT_OPEN_DELAY_MS = 180;
const FLYOUT_CLOSE_DELAY_MS = 120;
const SCROLL_SETTLE_DELAY_MS = 220;

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

const effortSortOrder = (provider: string, effort: string | null | undefined) => {
    const normalized = String(effort || '').trim().toLowerCase();
    if (provider === 'claude') {
        return { low: 0, medium: 1, high: 2, max: 3 }[normalized as 'low' | 'medium' | 'high' | 'max'] ?? 99;
    }
    return { low: 0, medium: 1, high: 2, xhigh: 3 }[normalized as 'low' | 'medium' | 'high' | 'xhigh'] ?? 99;
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
    selectedAgentId
}: UnifiedAgentModelSelectorProps) {
    const { data: agentsData } = useAgents();
    const agents = useMemo(() => agentsData ?? [], [agentsData]);
    const providerLimits = useProviderLimitsStore((state) => state.byProvider);
    const [hoveredFamilyKey, setHoveredFamilyKey] = useState<string | null>(null);
    const openFlyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeFlyoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isListScrolling = useRef(false);

    const clearFlyoutClose = () => {
        if (closeFlyoutTimer.current) {
            clearTimeout(closeFlyoutTimer.current);
            closeFlyoutTimer.current = null;
        }
    };

    const clearFlyoutOpen = () => {
        if (openFlyoutTimer.current) {
            clearTimeout(openFlyoutTimer.current);
            openFlyoutTimer.current = null;
        }
    };

    const openFamilyFlyoutSoon = (familyKey: string) => {
        clearFlyoutOpen();
        clearFlyoutClose();

        if (isListScrolling.current) {
            return;
        }

        openFlyoutTimer.current = setTimeout(() => {
            if (!isListScrolling.current) {
                setHoveredFamilyKey(familyKey);
            }
        }, FLYOUT_OPEN_DELAY_MS);
    };

    const closeFamilyFlyoutSoon = (familyKey: string) => {
        clearFlyoutOpen();
        clearFlyoutClose();
        closeFlyoutTimer.current = setTimeout(() => {
            setHoveredFamilyKey((current) => current === familyKey ? null : current);
        }, FLYOUT_CLOSE_DELAY_MS);
    };

    const handleModelListWheel = () => {
        isListScrolling.current = true;
        clearFlyoutOpen();

        if (scrollSettleTimer.current) {
            clearTimeout(scrollSettleTimer.current);
        }

        scrollSettleTimer.current = setTimeout(() => {
            isListScrolling.current = false;
        }, SCROLL_SETTLE_DELAY_MS);
    };

    useEffect(() => {
        return () => {
            clearFlyoutOpen();
            clearFlyoutClose();
            if (scrollSettleTimer.current) {
                clearTimeout(scrollSettleTimer.current);
            }
        };
    }, []);

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
                if (agent.id === selectedAgentId) {
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
                    selectedAgentId: agent.id === selectedAgentId ? agent.id : null,
                });
            }
            providerGroups.set(provider, providerFamilies);
        }

        return Array.from(providerGroups.entries())
            .sort(sortProviders)
            .map(([provider, families]) => {
                const providerFamilies = Array.from(families.values()).map((family) => {
                    const sortedModels = [...family.models].sort((left, right) => {
                        const leftOrder = effortSortOrder(provider, left.model_config?.reasoningEffort);
                        const rightOrder = effortSortOrder(provider, right.model_config?.reasoningEffort);
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
                        selectedAgentId: sortedModels.find((model) => model.id === selectedAgentId)?.id ?? null,
                    };
                }).sort(sortModelFamilies);

                return {
                    provider,
                    families: providerFamilies,
                };
            });
    }, [agents, selectedAgentId]);

    const providerMeta = (provider: string) => {
        if (provider === 'claude') {
            return {
                badge: 'Anthropic',
                title: 'Claude',
            };
        }
        return {
            badge: 'OpenAI',
            title: 'Codex',
        };
    };

    return (
        <div className="flex h-full w-full flex-col bg-[hsl(var(--app-bg-elevated))] text-popover-foreground">
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
            </div>

            <ScrollArea className="flex-1" onWheelCapture={handleModelListWheel} onViewportScroll={handleModelListWheel}>
                <div className="space-y-3 p-2.5">
                    {groupedAgents.length === 0 ? (
                        <div className="flex min-h-[220px] flex-col items-center justify-center rounded-lg bg-background/65 px-5 text-center shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.7)]">
                            <Sparkles className="h-4 w-4 text-muted-foreground" />
                            <div className="mt-2 text-[13px] font-semibold text-foreground">No runtimes available</div>
                            <p className="mt-1 max-w-[26ch] text-[11px] leading-relaxed text-muted-foreground">
                                Add an agent provider before selecting a composer model.
                            </p>
                        </div>
                    ) : (
                        groupedAgents.map(({ provider, families }) => {
                            const meta = providerMeta(provider);
                            const accent = providerAccentClasses(provider);
                            const limitsSnapshot = provider === 'claude' || provider === 'codex'
                                ? providerLimits[provider]
                                : null;
                            const limitWindows = getProviderLimitWindows(limitsSnapshot);
                            const limitSeverity = getProviderLimitSeverity(limitsSnapshot);
                            const showSeverityHint = limitSeverity !== 'normal';
                            const displayedLimitWindows = visibleLimitWindows(limitsSnapshot ?? null, limitWindows);
                            return (
                                <section
                                    key={provider}
                                    className="rounded-lg bg-background/72 p-2 shadow-[0_12px_34px_-30px_rgba(15,23,42,0.45),inset_0_0_0_1px_hsl(var(--app-border)/0.72)]"
                                >
                                    <div className="mb-2 flex items-center justify-between gap-3 px-1">
                                        <div className="flex min-w-0 items-center gap-2.5">
                                            <div className={cn("flex h-8 w-8 items-center justify-center rounded-md", accent.iconSurface)}>
                                                {provider === 'claude' ? (
                                                    <AnthropicMark className={cn("h-4 w-4", accent.iconText)} />
                                                ) : (
                                                    <OpenAiMark className={cn("h-4 w-4", accent.iconText)} />
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[13px] font-semibold text-foreground">{meta.title}</span>
                                                    <span className="text-[10.5px] text-muted-foreground">{meta.badge}</span>
                                                </div>
                                                <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                                                    {families.length} {families.length === 1 ? 'family' : 'families'} available
                                                </div>
                                            </div>
                                        </div>
                                        {displayedLimitWindows.length > 0 ? (
                                            <div className="grid shrink-0 gap-1" aria-label={`${meta.title} usage availability`}>
                                                {displayedLimitWindows.map((window) => {
                                                    const rowStyle = usageRowClasses(window.severity);
                                                    return (
                                                        <div
                                                            key={window.id}
                                                            className={cn(
                                                                "flex h-5 min-w-[74px] items-center justify-between gap-2 rounded px-1.5 text-[10px] font-semibold tabular-nums",
                                                                rowStyle.row
                                                            )}
                                                        >
                                                            <span className="flex min-w-0 items-center gap-1.5">
                                                                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", rowStyle.dot)} aria-hidden="true" />
                                                                <span className="truncate">{window.shortLabel}</span>
                                                            </span>
                                                            <span className="text-foreground/82 dark:text-current">
                                                                {window.percent != null ? `${window.percent}%` : 'n/a'}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : null}
                                    </div>
                                    <div className="space-y-1">
                                        {families.map((family) => {
                                            const isSelected = family.selectedAgentId === selectedAgentId;
                                            const isHovered = hoveredFamilyKey === family.key;
                                            return (
                                                <Popover
                                                    key={family.key}
                                                    open={isHovered}
                                                    onOpenChange={(open) => {
                                                        if (!open) {
                                                            setHoveredFamilyKey((current) => current === family.key ? null : current);
                                                        }
                                                    }}
                                                >
                                                    <PopoverTrigger asChild>
                                                    <button
                                                        type="button"
                                                        onPointerEnter={() => openFamilyFlyoutSoon(family.key)}
                                                        onPointerLeave={() => closeFamilyFlyoutSoon(family.key)}
                                                        onClick={() => onSelectAgent(family.selectedAgentId ?? family.defaultAgentId ?? family.models[0]?.id ?? '')}
                                                        className={cn(
                                                            "group relative flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2.5 text-left outline-none transition-[background-color,box-shadow,transform] duration-200 ease-out",
                                                            "focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1 focus-visible:ring-offset-background active:translate-y-px",
                                                            accent.hoverSurface,
                                                            isHovered ? accent.selectedSurface : "bg-transparent",
                                                            isSelected && "shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.4)]"
                                                        )}
                                                    >
                                                        <span
                                                            className={cn(
                                                                "absolute left-0 top-2 bottom-2 w-0.5 rounded-full opacity-0 transition-opacity duration-200",
                                                                accent.rail,
                                                                (isSelected || isHovered) && "opacity-100"
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
                                                            <div className="mt-1 flex min-w-0 items-center gap-2">
                                                                <div className="truncate text-[10.5px] leading-none text-muted-foreground">
                                                                    {family.description}
                                                                </div>
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
                                                            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200", isHovered && "translate-x-0.5")} aria-hidden="true" />
                                                        </div>
                                                    </button>
                                                    </PopoverTrigger>
                                                    <PopoverContent
                                                        side="right"
                                                        align="start"
                                                        sideOffset={7}
                                                        collisionPadding={12}
                                                        onPointerEnter={() => {
                                                            clearFlyoutOpen();
                                                            clearFlyoutClose();
                                                            setHoveredFamilyKey(family.key);
                                                        }}
                                                        onPointerLeave={() => closeFamilyFlyoutSoon(family.key)}
                                                        className="w-[248px] origin-[var(--radix-popover-content-transform-origin)] rounded-lg border border-[hsl(var(--app-border)/0.78)] bg-[hsl(var(--app-bg-elevated))] p-2 shadow-[0_18px_42px_-18px_rgba(15,23,42,0.38)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-98 data-[side=right]:slide-in-from-left-1 data-[side=left]:slide-in-from-right-1"
                                                    >
                                                        <div className="border-b border-[hsl(var(--app-border)/0.58)] px-2 pb-2">
                                                            <div className="text-[11px] font-medium text-muted-foreground">
                                                                {providerEffortNoun(provider)} effort
                                                            </div>
                                                            <div className="mt-1 truncate text-[13px] font-semibold leading-tight text-foreground">
                                                                {family.label}
                                                            </div>
                                                        </div>
                                                        <div className="mt-2 space-y-1">
                                                            {family.models.map((agent) => {
                                                            const isSelected = selectedAgentId === agent.id;
                                                            const effortLabel = agent.model_config?.effortLabel ?? agent.model_config?.reasoningEffort ?? 'default';
                                                            const effortDescription = agent.model_config?.effortDescription ?? 'Available mode';
                                                            return (
                                                                <button
                                                                    key={agent.id}
                                                                    type="button"
                                                                    onClick={() => {
                                                                        onSelectAgent(agent.id);
                                                                        setHoveredFamilyKey(null);
                                                                    }}
                                                                    className={cn(
                                                                        "group flex w-full items-start justify-between gap-3 rounded-md px-2.5 py-2.5 text-left outline-none transition-[background-color,box-shadow,transform] duration-200 ease-out",
                                                                        "hover:bg-background/88 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))] focus-visible:ring-offset-1 focus-visible:ring-offset-background active:translate-y-px",
                                                                        isSelected ? "bg-background shadow-[0_10px_24px_-22px_rgba(15,23,42,0.7),inset_0_0_0_1px_hsl(var(--app-border)/0.8)]" : "bg-transparent"
                                                                    )}
                                                                >
                                                                    <div className="flex min-w-0 flex-1 gap-2.5">
                                                                        <span
                                                                            className={cn(
                                                                                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full opacity-60 transition-opacity duration-200",
                                                                                accent.dot,
                                                                                isSelected && "opacity-100"
                                                                            )}
                                                                            aria-hidden="true"
                                                                        />
                                                                        <div className="min-w-0 flex-1">
                                                                        <div className={cn(
                                                                            "text-[13px] leading-tight",
                                                                            isSelected ? "font-semibold text-foreground" : "font-medium text-foreground/82 group-hover:text-foreground"
                                                                        )}>
                                                                            {effortLabel}
                                                                        </div>
                                                                        <div className="mt-1 truncate text-[10.5px] leading-none text-muted-foreground">
                                                                            {effortDescription}
                                                                        </div>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted/40 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.55)]">
                                                                        {isSelected ? (
                                                                            <Check className={cn("h-3.5 w-3.5", accent.text)} strokeWidth={2.5} />
                                                                        ) : null}
                                                                    </div>
                                                                </button>
                                                            );
                                                        })}
                                                        </div>
                                                    </PopoverContent>
                                                </Popover>
                                            );
                                        })}
                                    </div>
                                </section>
                            );
                        })
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
