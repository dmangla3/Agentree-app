import { useEffect, useMemo, useState } from 'react';
import { Download, KeyRound, Plus, RefreshCw } from 'lucide-react';
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
import { agentClient, type LoginImportCandidate } from '../../lib/agentClient';
import type { LoginProfileSummary } from '../../lib/loginProfiles';
import { cn } from '../../lib/utils';
import { LoginProfileEditor } from './LoginProfileEditor';
import { LoginProfileRows } from './LoginProfileRows';

type ProviderFilter = 'codex' | 'claude';

const providerFilters: Array<{ id: ProviderFilter; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
];

export function LoginProfilesPanel() {
  const {
    profiles,
    activeRunsByProfile,
    isLoading,
    isMutating,
    error,
    refresh,
    saveProfile,
    deleteProfile,
    setDefaultProfile,
    checkProfile,
    discoverImportCandidates,
    importCandidate,
  } = useLoginProfilesStore();
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('codex');
  const [editorProvider, setEditorProvider] = useState<'codex' | 'claude'>('codex');
  const [editingProfile, setEditingProfile] = useState<LoginProfileSummary | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isImportingCandidates, setIsImportingCandidates] = useState(false);
  const [importCandidates, setImportCandidates] = useState<LoginImportCandidate[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void agentClient.onLoginProfilesChanged(() => {
      void refresh();
    }).then((cleanup) => {
      if (cancelled) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  const filteredProfiles = useMemo(() => {
    return profiles.filter((profile) => profile.provider === providerFilter);
  }, [profiles, providerFilter]);

  const readyCount = profiles.filter((profile) => profile.status === 'ready').length;
  const activeRunCount = Object.values(activeRunsByProfile).reduce((total, runs) => total + runs.length, 0);

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
      if (checked) {
        next.add(candidateId);
      } else {
        next.delete(candidateId);
      }
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
      <div className="app-view-frame mx-auto flex min-h-full w-full max-w-6xl flex-col">
        <header className="app-view-header">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--app-accent))]">Runtime access</p>
            <h1 className="mt-1 text-2xl font-semibold text-foreground">Logins</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Manage provider credentials and see which runs are using each login profile.
            </p>
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
            <Button size="sm" onClick={() => openNewEditor('codex')}>
              <Plus className="h-4 w-4" />
              Codex
            </Button>
            <Button size="sm" onClick={() => openNewEditor('claude')}>
              <Plus className="h-4 w-4" />
              Claude
            </Button>
          </div>
        </header>

        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg bg-background/74 p-4 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
            <div className="text-[11px] font-medium text-muted-foreground">Profiles</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{profiles.length}</div>
          </div>
          <div className="rounded-lg bg-background/74 p-4 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
            <div className="text-[11px] font-medium text-muted-foreground">Ready</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{readyCount}</div>
          </div>
          <div className="rounded-lg bg-background/74 p-4 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
            <div className="text-[11px] font-medium text-muted-foreground">Active Runs</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{activeRunCount}</div>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg bg-background/78 p-1 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.7)]">
            {providerFilters.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setProviderFilter(filter.id)}
                className={cn(
                  'h-8 rounded-md px-3 text-[12px] font-semibold transition-[background-color,color,box-shadow,transform] active:scale-[0.96]',
                  providerFilter === filter.id
                    ? 'bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.16)]'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/35 dark:text-red-300">
            {error}
          </div>
        ) : null}

        {filteredProfiles.length > 0 ? (
          <LoginProfileRows
            profiles={filteredProfiles}
            activeRunsByProfile={activeRunsByProfile}
            pendingProfileId={pendingProfileId}
            onEdit={openEdit}
            onCheck={(profile) => void runProfileAction(profile, () => checkProfile(profile.id))}
            onSetDefault={(profile) => void runProfileAction(profile, () => setDefaultProfile(profile.provider, profile.id))}
            onDelete={(profile) => void runProfileAction(profile, () => deleteProfile(profile.id))}
          />
        ) : (
          <div className="flex min-h-[300px] flex-col items-center justify-center rounded-lg bg-background/72 p-6 text-center shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
              <KeyRound className="h-5 w-5" />
            </div>
            <div className="mt-3 text-sm font-semibold text-foreground">No login profiles</div>
            <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
              Add a provider login to unlock model selection and credential-aware agent runs.
            </p>
          </div>
        )}
      </div>

      <LoginProfileEditor
        open={editorOpen}
        provider={editorProvider}
        profile={editingProfile}
        isSaving={isMutating}
        error={error}
        onOpenChange={setEditorOpen}
        onSave={saveProfile}
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
                Checked supported environment variables, Codex auth files, and Claude CLI status.
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
