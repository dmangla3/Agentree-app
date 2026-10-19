import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  CircleGauge,
  Download,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { Badge } from '../../../@/components/ui/badge';
import { Button } from '../../../@/components/ui/button';
import { Checkbox } from '../../../@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../@/components/ui/dialog';
import { useLoginProfilesStore } from '../../stores/loginProfilesStore';
import {
  getProviderLimitSeverity,
  getProviderLimitSummary,
  providerLimitKey,
  useProviderLimitsStore,
} from '../../stores/providerLimitsStore';
import type { LoginImportCandidate } from '../../lib/agentClient';
import {
  canCheckLoginProfileReadiness,
  getLoginProfileAuthTypeLabel,
  getLoginProfileStatusTone,
  isLoginProfileActive,
  type LoginProfileSummary,
} from '../../lib/loginProfiles';
import type { RuntimeProvider } from '../../lib/runtimeModels';
import { cn } from '../../lib/utils';
import { LoginProfileEditor } from './LoginProfileEditor';
import { LoginProfileRows } from './LoginProfileRows';
import { RuntimeHealthCard } from './RuntimeHealthCard';

type ProviderFilter = 'codex' | 'claude';

interface LoginProfilesPanelProps {
  initialProvider?: ProviderFilter | null;
  runtimeHealthRequestId?: number;
}

const providerFilters: Array<{ id: ProviderFilter; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
];

const panelCopy = {
  codex: {
    eyebrow: 'Managed accounts',
    title: 'Codex accounts',
    description: 'Each account runs in its own profile home, so usage limits and refreshed session state stay isolated.',
    emptyTitle: 'No Codex accounts',
    emptyBody: 'Add a managed Codex profile before selecting Codex models for runs.',
    setupTitle: 'Managed Codex session',
    setupBody: 'Use one Agentree profile per Codex account. Agentree keeps the profile auth state live and saves token rotation after checks and runs.',
  },
  claude: {
    eyebrow: 'Managed accounts',
    title: 'Claude accounts',
    description: 'Use one Agentree profile per Claude account. Subscription accounts connect in the browser; API keys stay isolated per profile.',
    emptyTitle: 'No Claude accounts',
    emptyBody: 'Add a Claude account before selecting Claude models for runs.',
    setupTitle: 'Managed Claude account',
    setupBody: 'Switch between Claude accounts from Agentree after each account has been connected once.',
  },
} satisfies Record<ProviderFilter, Record<string, string>>;

const statusPillClasses = {
  success: 'bg-emerald-50 text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.2)] dark:bg-emerald-950/35 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-800 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)] dark:bg-amber-950/35 dark:text-amber-300',
  danger: 'bg-red-50 text-red-700 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.18)] dark:bg-red-950/35 dark:text-red-300',
  muted: 'bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68)]',
};

const formatStatus = (status: string) => status.replace(/_/g, ' ');

const formatCheckedAt = (timestamp?: number | null) => {
  if (!timestamp) return 'Not checked';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp * 1000));
};

export function LoginProfilesPanel({
  initialProvider,
  runtimeHealthRequestId = 0,
}: LoginProfilesPanelProps = {}) {
  const {
    profiles,
    activeRunsByProfile,
    isLoading,
    isMutating,
    error,
    refresh,
    saveProfile,
    connectCodexProfile,
    connectClaudeOauthProfile,
    pollClaudeOauthProfile,
    submitClaudeOauthCode,
    deleteProfile,
    setDefaultProfile,
    checkProfile,
    discoverImportCandidates,
    importCandidate,
    startSync,
  } = useLoginProfilesStore();
  const providerLimits = useProviderLimitsStore((state) => state.byProvider);
  const refreshLimitsIfStale = useProviderLimitsStore((state) => state.refreshIfStale);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(initialProvider ?? 'codex');
  const [editorProvider, setEditorProvider] = useState<'codex' | 'claude'>('codex');
  const [editingProfile, setEditingProfile] = useState<LoginProfileSummary | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isImportingCandidates, setIsImportingCandidates] = useState(false);
  const [importCandidates, setImportCandidates] = useState<LoginImportCandidate[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const runtimeHealthRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => startSync(), [startSync]);

  useEffect(() => {
    if (initialProvider) {
      setProviderFilter(initialProvider);
    }
  }, [initialProvider]);

  useEffect(() => {
    if (runtimeHealthRequestId <= 0) return;
    runtimeHealthRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    runtimeHealthRef.current?.focus({ preventScroll: true });
  }, [runtimeHealthRequestId]);

  const filteredProfiles = useMemo(
    () => profiles.filter((profile) => profile.provider === providerFilter),
    [profiles, providerFilter]
  );

  const selectedProfile = useMemo(() => {
    if (selectedProfileId) {
      const selected = filteredProfiles.find((profile) => profile.id === selectedProfileId);
      if (selected) return selected;
    }
    return filteredProfiles.find((profile) => profile.isDefault) ?? filteredProfiles[0] ?? null;
  }, [filteredProfiles, selectedProfileId]);

  useEffect(() => {
    setSelectedProfileId((current) => {
      if (current && filteredProfiles.some((profile) => profile.id === current)) return current;
      return filteredProfiles.find((profile) => profile.isDefault)?.id ?? filteredProfiles[0]?.id ?? null;
    });
  }, [filteredProfiles]);

  useEffect(() => {
    if (!editingProfile) return;
    const latest = profiles.find((profile) => profile.id === editingProfile.id);
    if (latest && latest !== editingProfile) {
      setEditingProfile(latest);
    }
  }, [editingProfile, profiles]);

  useEffect(() => {
    filteredProfiles
      .filter((profile) => profile.provider === 'codex' && isLoginProfileActive(profile))
      .forEach((profile) => {
        refreshLimitsIfStale('codex', Date.now(), profile.id);
      });
  }, [filteredProfiles, refreshLimitsIfStale]);

  const readyCount = filteredProfiles.filter((profile) => profile.status === 'ready').length;
  const activeRunCount = filteredProfiles.reduce(
    (total, profile) => total + (activeRunsByProfile[profile.id]?.length ?? 0),
    0
  );
  const limitedCount = filteredProfiles.filter((profile) => profile.status === 'usage_limited').length;

  const limitSummaryByProfile = useMemo(() => {
    return filteredProfiles.reduce<Record<string, string | null>>((acc, profile) => {
      if (profile.provider !== 'codex' && profile.provider !== 'claude') {
        acc[profile.id] = null;
        return acc;
      }
      const snapshot = providerLimits[providerLimitKey(profile.provider as RuntimeProvider, profile.id)];
      acc[profile.id] = getProviderLimitSummary(snapshot);
      return acc;
    }, {});
  }, [filteredProfiles, providerLimits]);

  const limitSeverityByProfile = useMemo(() => {
    return filteredProfiles.reduce<Record<string, ReturnType<typeof getProviderLimitSeverity>>>((acc, profile) => {
      if (profile.provider !== 'codex' && profile.provider !== 'claude') {
        acc[profile.id] = 'normal';
        return acc;
      }
      const snapshot = providerLimits[providerLimitKey(profile.provider as RuntimeProvider, profile.id)];
      acc[profile.id] = getProviderLimitSeverity(snapshot);
      return acc;
    }, {});
  }, [filteredProfiles, providerLimits]);

  const activeProfileLimitSummary = selectedProfile ? limitSummaryByProfile[selectedProfile.id] ?? null : null;
  const activeProfileRuns = selectedProfile ? activeRunsByProfile[selectedProfile.id] ?? [] : [];
  const copy = panelCopy[providerFilter];

  const openNewEditor = (provider: 'codex' | 'claude') => {
    setEditorProvider(provider);
    setEditingProfile(null);
    setEditorOpen(true);
  };

  const openEdit = (profile: LoginProfileSummary) => {
    setEditorProvider(profile.provider === 'claude' ? 'claude' : 'codex');
    setEditingProfile(profile);
    setEditorOpen(true);
  };

  const runProfileAction = async (profile: LoginProfileSummary, action: () => Promise<void>) => {
    setPendingProfileId(profile.id);
    try {
      await action();
    } finally {
      setPendingProfileId(null);
    }
  };

  const saveEditorProfile = async (request: Parameters<typeof saveProfile>[0]) => {
    const saved = await saveProfile(request);
    setEditingProfile(saved);
    setSelectedProfileId(saved.id);
    setEditorProvider(saved.provider === 'claude' ? 'claude' : 'codex');
    return saved;
  };

  const runDiscovery = async () => {
    setIsDiscovering(true);
    setDiscoveryError(null);
    try {
      const candidates = await discoverImportCandidates();
      setImportCandidates(candidates);
      setSelectedCandidateIds(new Set(candidates.filter((candidate) => candidate.importable).map((candidate) => candidate.id)));
      setDiscoveryOpen(true);
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDiscovering(false);
    }
  };

  const toggleCandidate = (candidateId: string, checked: boolean) => {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (checked) next.add(candidateId);
      else next.delete(candidateId);
      return next;
    });
  };

  const importSelectedCandidates = async () => {
    const selected = importCandidates.filter((candidate) => selectedCandidateIds.has(candidate.id));
    if (!selected.length) return;
    setIsImportingCandidates(true);
    setDiscoveryError(null);
    try {
      for (const candidate of selected) {
        await importCandidate({
          candidateId: candidate.id,
          displayName: candidate.displayName,
          makeDefault: candidate.authType === 'external_cli' ? false : true,
        });
      }
      setDiscoveryOpen(false);
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsImportingCandidates(false);
    }
  };

  return (
    <div className="app-view-surface h-full w-full overflow-auto p-5">
      <div className="app-view-frame mx-auto flex min-h-full w-full max-w-7xl flex-col">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--app-accent))]">{copy.eyebrow}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{copy.description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={isLoading}>
              <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => void runDiscovery()} disabled={isDiscovering || isMutating}>
              <Download className={cn('h-4 w-4', isDiscovering && 'animate-pulse')} />
              Find existing
            </Button>
            <Button size="sm" onClick={() => openNewEditor(providerFilter)}>
              <Plus className="h-4 w-4" />
              Add {providerFilter === 'codex' ? 'Codex' : 'Claude'}
            </Button>
          </div>
        </header>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg bg-background/82 p-1 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.7)]">
            {providerFilters.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setProviderFilter(filter.id)}
                className={cn(
                  'h-9 min-w-24 rounded-md px-3 text-[12px] font-semibold transition-[background-color,color,box-shadow,transform] active:scale-[0.96]',
                  providerFilter === filter.id
                    ? 'bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.16)]'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-background/82 px-2.5 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              <span className="font-mono tabular-nums">{readyCount}</span> ready
            </span>
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-background/82 px-2.5 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]">
              <Activity className="h-3.5 w-3.5" />
              <span className="font-mono tabular-nums">{activeRunCount}</span> running
            </span>
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-background/82 px-2.5 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]">
              <CircleGauge className="h-3.5 w-3.5" />
              <span className="font-mono tabular-nums">{limitedCount}</span> limited
            </span>
          </div>
        </div>

        {error ? (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/35 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="min-w-0">
            {filteredProfiles.length > 0 ? (
              <LoginProfileRows
                profiles={filteredProfiles}
                activeRunsByProfile={activeRunsByProfile}
                limitSummaryByProfile={limitSummaryByProfile}
                limitSeverityByProfile={limitSeverityByProfile}
                pendingProfileId={pendingProfileId}
                selectedProfileId={selectedProfile?.id ?? null}
                onSelect={(profile) => setSelectedProfileId(profile.id)}
                onEdit={openEdit}
                onCheck={(profile) => void runProfileAction(profile, () => checkProfile(profile.id))}
                onSetDefault={(profile) => void runProfileAction(profile, () => setDefaultProfile(profile.provider, profile.id))}
                onDelete={(profile) => void runProfileAction(profile, () => deleteProfile(profile.id))}
              />
            ) : (
              <div className="flex min-h-[360px] flex-col items-center justify-center rounded-xl bg-background/78 p-8 text-center shadow-[0_18px_52px_-44px_rgba(15,23,42,0.65),inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                  <KeyRound className="h-5 w-5" />
                </div>
                <div className="mt-4 text-sm font-semibold text-foreground">{copy.emptyTitle}</div>
                <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">{copy.emptyBody}</p>
                <Button className="mt-5" size="sm" onClick={() => openNewEditor(providerFilter)}>
                  <Plus className="h-4 w-4" />
                  Add account
                </Button>
              </div>
            )}
          </section>

          <aside className="space-y-3">
            <section className="min-w-0 rounded-xl bg-background/82 p-4 shadow-[0_18px_52px_-44px_rgba(15,23,42,0.65),inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Selected</div>
                  <h2 className="mt-1 min-w-0 break-words text-[15px] font-semibold text-foreground [overflow-wrap:anywhere]">
                    {selectedProfile?.displayName ?? 'No account selected'}
                  </h2>
                </div>
                {selectedProfile ? (
                  <span className={cn('inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[11px] font-semibold capitalize', statusPillClasses[getLoginProfileStatusTone(selectedProfile.status)])}>
                    {formatStatus(selectedProfile.status)}
                  </span>
                ) : null}
              </div>

              {selectedProfile ? (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="min-w-0 rounded-lg bg-muted/38 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Auth</div>
                      <div className="mt-1 min-w-0 break-words text-[12px] font-semibold text-foreground [overflow-wrap:anywhere]">{getLoginProfileAuthTypeLabel(selectedProfile.authType)}</div>
                    </div>
                    <div className="min-w-0 rounded-lg bg-muted/38 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Limits</div>
                      <div className="mt-1 min-w-0 break-words text-[12px] font-semibold text-foreground tabular-nums [overflow-wrap:anywhere]">{activeProfileLimitSummary ?? 'No data'}</div>
                    </div>
                    <div className="min-w-0 rounded-lg bg-muted/38 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Runs</div>
                      <div className="mt-1 text-[12px] font-semibold text-foreground tabular-nums">{activeProfileRuns.length} active</div>
                    </div>
                    <div className="min-w-0 rounded-lg bg-muted/38 p-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Checked</div>
                      <div className="mt-1 min-w-0 break-words text-[12px] font-semibold text-foreground [overflow-wrap:anywhere]">{formatCheckedAt(selectedProfile.lastCheckedAt)}</div>
                    </div>
                  </div>

                  {selectedProfile.statusMessage ? (
                    <p className="min-w-0 break-words rounded-lg bg-muted/38 px-3 py-2 text-[12px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                      {selectedProfile.statusMessage}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void runProfileAction(selectedProfile, () => checkProfile(selectedProfile.id))}
                      disabled={
                        pendingProfileId === selectedProfile.id
                        || selectedProfile.status === 'checking'
                        || !canCheckLoginProfileReadiness(selectedProfile)
                      }
                    >
                      {selectedProfile.status === 'checking' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      Check account
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => openEdit(selectedProfile)}>
                      <KeyRound className="h-4 w-4" />
                      Reconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-sm leading-6 text-muted-foreground">Select an account to inspect readiness and limit state.</p>
              )}
            </section>

            <section className="rounded-xl bg-background/82 p-4 shadow-[0_18px_52px_-44px_rgba(15,23,42,0.65),inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                {providerFilter === 'codex' ? <ShieldCheck className="h-4 w-4 text-[hsl(var(--app-accent))]" /> : <Terminal className="h-4 w-4 text-[hsl(var(--app-accent))]" />}
                {copy.setupTitle}
              </div>
              <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{copy.setupBody}</p>
              <div className="mt-3 space-y-2 text-[11px] text-muted-foreground">
                <div className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[hsl(var(--app-accent))]" />
                  <span>One profile per account.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[hsl(var(--app-accent))]" />
                  <span>Default profile is used by model selection.</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[hsl(var(--app-accent))]" />
                  <span>Usage limits refresh per account.</span>
                </div>
              </div>
            </section>

            <div
              ref={runtimeHealthRef}
              tabIndex={-1}
              className="scroll-m-4 outline-none"
              data-runtime-health-target="true"
            >
              <RuntimeHealthCard />
            </div>
          </aside>
        </div>
      </div>

      <LoginProfileEditor
        open={editorOpen}
        provider={editorProvider}
        profile={editingProfile}
        isSaving={isMutating}
        error={error}
        onOpenChange={setEditorOpen}
        onSave={saveEditorProfile}
        onConnectCodex={connectCodexProfile}
        onConnectClaudeOauth={connectClaudeOauthProfile}
        onPollClaudeOauth={pollClaudeOauthProfile}
        onSubmitClaudeOauthCode={submitClaudeOauthCode}
      />

      <Dialog open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import existing logins</DialogTitle>
            <DialogDescription>
              Review detected credentials before importing. Secret values stay hidden.
            </DialogDescription>
          </DialogHeader>

          {importCandidates.length > 0 ? (
            <div className="max-h-[420px] overflow-auto rounded-lg border border-border/70 bg-background">
              {importCandidates.map((candidate) => {
                const checked = selectedCandidateIds.has(candidate.id);
                return (
                  <label
                    key={candidate.id}
                    className={cn(
                      'grid cursor-pointer grid-cols-[auto_1fr] gap-3 border-b border-border/60 p-3 last:border-b-0 transition-colors hover:bg-muted/45',
                      !candidate.importable && 'cursor-not-allowed opacity-60'
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!candidate.importable || isImportingCandidates}
                      indicatorMode="check"
                      onCheckedChange={(value) => toggleCandidate(candidate.id, value === true)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{candidate.displayName}</span>
                        <Badge variant="outline" className="rounded-md px-1.5 py-0 text-[10px] uppercase tracking-[0.08em]">
                          {candidate.provider}
                        </Badge>
                        <Badge variant="secondary" className="rounded-md px-1.5 py-0 text-[10px]">
                          {candidate.sourceKind}
                        </Badge>
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {candidate.sourceLabel}
                        {candidate.redactedHint ? ` · ${candidate.redactedHint}` : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-border/70 bg-background px-4 py-8 text-center">
              <div className="text-sm font-semibold text-foreground">No existing logins found</div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Checked supported environment variables.
              </p>
            </div>
          )}

          {discoveryError ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/35 dark:text-red-300">
              {discoveryError}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDiscoveryOpen(false)} disabled={isImportingCandidates}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void importSelectedCandidates()}
              disabled={isImportingCandidates || selectedCandidateIds.size === 0}
            >
              Import selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default LoginProfilesPanel;
