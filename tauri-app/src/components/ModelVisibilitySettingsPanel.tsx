import { useEffect, useMemo, useState } from 'react';
import { Check, Eye, KeyRound, Search, SlidersHorizontal } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { Checkbox } from '../../@/components/ui/checkbox';
import { Input } from '../../@/components/ui/input';
import { useAgents, type Agent } from '../hooks/useAgents';
import { dispatchOpenLoginProfiles } from '../lib/loginNavigationEvents';
import {
  compareOpenCodeCatalogModels,
  type AgentModelConfig,
  type RuntimeModelModality,
  type RuntimeModelStatus,
  type RuntimeProvider,
} from '../lib/runtimeModels';
import { cn } from '../lib/utils';
import { useLoginProfilesStore } from '../stores/loginProfilesStore';
import { useModelStore } from '../stores/modelStore';

type ModelFamily = {
  key: string;
  label: string;
  description: string;
  provider: RuntimeProvider;
  modelProvider: string;
  modelId: string;
  modesCount: number;
  inputModalities: RuntimeModelModality[];
  outputModalities: RuntimeModelModality[];
  reasoning: boolean;
  releaseDate: string | null;
  status: RuntimeModelStatus | null;
  isFree: boolean | null;
};

type OpenCodeCapabilityFilter = 'free' | 'vision' | 'image-output' | 'reasoning';

const openCodeCapabilityFilters: Array<{ id: OpenCodeCapabilityFilter; label: string }> = [
  { id: 'free', label: 'Free models' },
  { id: 'vision', label: 'Vision' },
  { id: 'image-output', label: 'Image output' },
  { id: 'reasoning', label: 'Reasoning' },
];

interface ModelVisibilitySettingsPanelProps {
  initialProvider?: RuntimeProvider;
  showHeader?: boolean;
}

const providers: Array<{ id: RuntimeProvider; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'opencode', label: 'OpenCode' },
];

const formatModelProvider = (provider: string) => {
  if (provider === 'opencode') return 'OpenCode Zen';
  if (provider === 'openrouter') return 'OpenRouter';
  return provider
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const familyFromAgent = (agent: Agent): ModelFamily => {
  const config = agent.model_config as AgentModelConfig | null | undefined;
  return {
    key: config?.familyKey ?? `${agent.type}:${config?.model ?? agent.id}`,
    label: config?.familyLabel ?? agent.name,
    description: config?.familyDescription ?? config?.effortDescription ?? agent.name,
    provider: agent.type as RuntimeProvider,
    modelProvider: config?.modelProvider ?? agent.type,
    modelId: config?.model ?? agent.id,
    modesCount: 1,
    inputModalities: config?.capabilities?.inputModalities ?? [],
    outputModalities: config?.capabilities?.outputModalities ?? [],
    reasoning: config?.capabilities?.reasoning === true,
    releaseDate: config?.releaseDate ?? null,
    status: config?.status ?? null,
    isFree: config?.isFree ?? null,
  };
};

const matchesOpenCodeCapabilities = (family: ModelFamily, filters: OpenCodeCapabilityFilter[]) => (
  filters.every((filter) => {
    if (filter === 'free') return family.isFree === true;
    if (filter === 'vision') return family.inputModalities.includes('image');
    if (filter === 'image-output') return family.outputModalities.includes('image');
    return family.reasoning;
  })
);

export function ModelVisibilitySettingsPanel({
  initialProvider = 'codex',
  showHeader = true,
}: ModelVisibilitySettingsPanelProps) {
  const { data: agentsData } = useAgents();
  const agents = useMemo(() => agentsData ?? [], [agentsData]);
  const loginProfiles = useLoginProfilesStore((state) => state.profiles);
  const visibleFamilyKeysByProvider = useModelStore((state) => state.visibleFamilyKeysByProvider);
  const setVisibleFamilyKeys = useModelStore((state) => state.setVisibleFamilyKeys);
  const [activeProvider, setActiveProvider] = useState<RuntimeProvider>(initialProvider);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [modelProviderFilter, setModelProviderFilter] = useState('all');
  const [capabilityFilters, setCapabilityFilters] = useState<OpenCodeCapabilityFilter[]>([]);

  useEffect(() => {
    setActiveProvider(initialProvider);
  }, [initialProvider]);

  useEffect(() => {
    setSearchTerm('');
    setSelectedOnly(false);
    setModelProviderFilter('all');
    setCapabilityFilters([]);
  }, [activeProvider]);

  const familiesByProvider = useMemo(() => {
    const grouped: Record<RuntimeProvider, Map<string, ModelFamily>> = {
      codex: new Map(),
      claude: new Map(),
      opencode: new Map(),
    };
    for (const agent of agents) {
      if (agent.type !== 'codex' && agent.type !== 'claude' && agent.type !== 'opencode') continue;
      const family = familyFromAgent(agent);
      if (
        family.inputModalities.some((modality) => modality === 'audio' || modality === 'video')
        || family.outputModalities.some((modality) => modality === 'audio' || modality === 'video')
      ) continue;
      const existing = grouped[family.provider].get(family.key);
      if (existing) {
        existing.modesCount += 1;
      } else {
        grouped[family.provider].set(family.key, family);
      }
    }
    return {
      codex: Array.from(grouped.codex.values()).sort((a, b) => a.label.localeCompare(b.label)),
      claude: Array.from(grouped.claude.values()).sort((a, b) => a.label.localeCompare(b.label)),
      opencode: Array.from(grouped.opencode.values()).sort(compareOpenCodeCatalogModels),
    };
  }, [agents]);

  const families = familiesByProvider[activeProvider];
  const configuredKeys = visibleFamilyKeysByProvider[activeProvider];
  const selectedKeys = useMemo(
    () => new Set(configuredKeys ?? families.map((family) => family.key)),
    [configuredKeys, families],
  );
  const modelProviders = useMemo(() => (
    Array.from(new Set(families.map((family) => family.modelProvider))).sort((a, b) => a.localeCompare(b))
  ), [families]);
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredFamilies = useMemo(() => families.filter((family) => {
    if (selectedOnly && !selectedKeys.has(family.key)) return false;
    if (modelProviderFilter !== 'all' && family.modelProvider !== modelProviderFilter) return false;
    if (activeProvider === 'opencode' && !matchesOpenCodeCapabilities(family, capabilityFilters)) return false;
    if (!normalizedSearch) return true;
    return `${family.label} ${family.description} ${family.modelProvider} ${family.modelId}`.toLowerCase().includes(normalizedSearch);
  }), [activeProvider, capabilityFilters, families, modelProviderFilter, normalizedSearch, selectedKeys, selectedOnly]);
  const selectedCount = families.filter((family) => selectedKeys.has(family.key)).length;
  const hasOpenCodeProfile = loginProfiles.some((profile) => profile.provider === 'opencode');

  const toggleFamily = (familyKey: string, checked: boolean) => {
    const next = new Set(configuredKeys ?? families.map((family) => family.key));
    if (checked) next.add(familyKey);
    else next.delete(familyKey);
    setVisibleFamilyKeys(activeProvider, Array.from(next));
  };

  const toggleCapabilityFilter = (filter: OpenCodeCapabilityFilter) => {
    setCapabilityFilters((current) => current.includes(filter)
      ? current.filter((value) => value !== filter)
      : [...current, filter]);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {showHeader ? (
        <header className="shrink-0 border-b border-border/70 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
              <SlidersHorizontal className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-balance text-base font-semibold text-foreground">Visible models</h2>
              <p className="mt-1 max-w-2xl text-pretty text-xs leading-5 text-muted-foreground">
                Choose the model families shown throughout Agentree. Effort and variant choices stay grouped under each family.
              </p>
            </div>
          </div>
        </header>
      ) : null}

      <div className="shrink-0 border-b border-border/60 px-5 py-3">
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/30 p-1.5 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]">
          {providers.map((provider) => {
            const active = activeProvider === provider.id;
            const providerFamilies = familiesByProvider[provider.id];
            const providerConfigured = visibleFamilyKeysByProvider[provider.id];
            const visibleCount = providerConfigured === undefined
              ? providerFamilies.length
              : providerFamilies.filter((family) => providerConfigured.includes(family.key)).length;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => setActiveProvider(provider.id)}
                className={cn(
                  'min-h-11 rounded-lg px-3 py-2 text-left transition-[background-color,box-shadow,transform] duration-150 active:scale-[0.96]',
                  active
                    ? 'bg-background text-foreground shadow-[0_8px_22px_-18px_rgba(15,23,42,0.75),inset_0_0_0_1px_hsl(var(--app-border)/0.78)]'
                    : 'text-muted-foreground hover:bg-background/65 hover:text-foreground',
                )}
                aria-pressed={active}
              >
                <span className="block text-xs font-semibold">{provider.label}</span>
                <span className="mt-0.5 block text-[10.5px] tabular-nums text-muted-foreground">
                  {visibleCount} of {providerFamilies.length} shown
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={`Search ${providers.find((provider) => provider.id === activeProvider)?.label} models`}
            aria-label={`Search ${activeProvider} models`}
            className="h-10 pl-9"
          />
        </div>
        {activeProvider === 'opencode' && modelProviders.length > 1 ? (
          <select
            value={modelProviderFilter}
            onChange={(event) => setModelProviderFilter(event.target.value)}
            aria-label="Filter OpenCode source"
            className="h-10 max-w-48 rounded-md border border-input bg-background px-3 text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">All sources</option>
            {modelProviders.map((provider) => <option key={provider} value={provider}>{formatModelProvider(provider)}</option>)}
          </select>
        ) : null}
        <Button
          type="button"
          variant={selectedOnly ? 'secondary' : 'outline'}
          className="h-10"
          onClick={() => setSelectedOnly((current) => !current)}
          aria-pressed={selectedOnly}
        >
          <Check className="h-4 w-4" />
          Selected only
        </Button>
      </div>

      {activeProvider === 'opencode' && families.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-5 py-2.5">
          <span className="mr-1 text-[11px] font-medium text-muted-foreground">Capabilities</span>
          {openCodeCapabilityFilters.map((filter) => {
            const active = capabilityFilters.includes(filter.id);
            return (
              <Button
                key={filter.id}
                type="button"
                size="sm"
                variant={active ? 'secondary' : 'outline'}
                className="h-8 px-2.5 text-xs"
                aria-pressed={active}
                onClick={() => toggleCapabilityFilter(filter.id)}
              >
                {filter.label}
              </Button>
            );
          })}
          {capabilityFilters.length > 0 ? (
            <Button type="button" size="sm" variant="ghost" className="h-8 px-2.5 text-xs" onClick={() => setCapabilityFilters([])}>
              Reset
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Eye className="h-4 w-4" />
            <span className="tabular-nums">{selectedCount} of {families.length} families visible</span>
            {configuredKeys === undefined ? <span>· New models appear automatically</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-10" onClick={() => setVisibleFamilyKeys(activeProvider, null)}>
              Select all
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-10" onClick={() => setVisibleFamilyKeys(activeProvider, [])}>
              Clear
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-background/75 p-1.5 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
          {activeProvider === 'opencode' && families.length === 0 && !hasOpenCodeProfile ? (
            <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
              <KeyRound className="h-5 w-5 text-muted-foreground" />
              <div className="mt-3 text-sm font-semibold text-foreground">Connect OpenCode first</div>
              <p className="mt-1 max-w-sm text-pretty text-xs leading-5 text-muted-foreground">
                Agentree reads the available model catalog from your active OpenCode environment.
              </p>
              <Button type="button" size="sm" className="mt-4 h-10" onClick={() => dispatchOpenLoginProfiles('opencode')}>
                Manage OpenCode login
              </Button>
            </div>
          ) : filteredFamilies.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              No model families match these filters.
            </div>
          ) : (
            <div className="divide-y divide-border/55">
              {filteredFamilies.map((family) => {
                const checked = selectedKeys.has(family.key);
                return (
                  <label
                    key={family.key}
                    className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-[background-color,transform] duration-150 hover:bg-muted/45 active:scale-[0.99]"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) => toggleFamily(family.key, value === true)}
                      indicatorMode="check"
                      aria-label={`${checked ? 'Hide' : 'Show'} ${family.label}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-foreground">{family.label}</span>
                        {activeProvider === 'opencode' ? (
                          <>
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {formatModelProvider(family.modelProvider)}
                            </span>
                            {family.isFree === true ? (
                              <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                                Free
                              </span>
                            ) : null}
                            {family.status && family.status !== 'active' ? (
                              <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium capitalize text-amber-700 dark:text-amber-300">
                                {family.status}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{family.description}</span>
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                      {family.modesCount} {family.modesCount === 1 ? 'mode' : 'modes'}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
