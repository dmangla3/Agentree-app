import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ChevronDown,
  CheckCircle2,
  FileJson,
  FolderOpen,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../@/components/ui/dialog';
import { Label } from '../../@/components/ui/label';
import { Switch } from '../../@/components/ui/switch';
import { Textarea } from '../../@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../@/components/ui/tooltip';
import {
  agentClient,
  DEFAULT_AGENT_WORKTREE_CONFIG,
  type AgentWorktreeConfig,
  type AgentWorktreeConfigStatus,
} from '../lib/agentClient';
import { cn } from '../lib/utils';

interface WorktreePolicyButtonProps {
  repoPath: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface WorktreePolicyPanelProps {
  repoPath: string | null;
}

type LoadState =
  | { status: 'idle'; data: null; error: null }
  | { status: 'loading'; data: null; error: null }
  | { status: 'loaded'; data: AgentWorktreeConfigStatus; error: null }
  | { status: 'error'; data: null; error: string };

const emptyState: LoadState = { status: 'idle', data: null, error: null };

const cloneConfig = (config: AgentWorktreeConfig): AgentWorktreeConfig => ({
  dependencyLinkDirs: [...config.dependencyLinkDirs],
  copyEnvFiles: config.copyEnvFiles,
  envFilePatterns: [...config.envFilePatterns],
  commitExcludePatterns: [...config.commitExcludePatterns],
  blockDependencyMutationCommands: config.blockDependencyMutationCommands,
});

const listToText = (values: string[]) => values.join('\n');

const textToList = (value: string) =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const runtimeCacheEnvRows = [
  ['TMPDIR', 'tmp'],
  ['TMP', 'tmp'],
  ['TEMP', 'tmp'],
  ['XDG_CACHE_HOME', 'cache'],
  ['XDG_STATE_HOME', 'state'],
  ['npm_config_cache', 'npm-cache'],
  ['YARN_CACHE_FOLDER', 'yarn-cache'],
  ['PNPM_HOME', 'pnpm-home'],
  ['TURBO_CACHE_DIR', 'turbo'],
  ['NX_CACHE_DIRECTORY', 'nx'],
  ['PLAYWRIGHT_BROWSERS_PATH', 'playwright'],
  ['CYPRESS_CACHE_FOLDER', 'cypress'],
  ['PIP_CACHE_DIR', 'pip'],
  ['UV_CACHE_DIR', 'uv'],
  ['PYTHONPYCACHEPREFIX', 'pycache'],
  ['GOCACHE', 'go-cache'],
  ['CARGO_HOME', 'cargo'],
  ['CARGO_TARGET_DIR', 'cargo-target'],
] as const;

function StatusPill({ source }: { source: string }) {
  const isProject = source === 'project';
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium',
        isProject
          ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'border-border bg-muted/65 text-muted-foreground'
      )}
    >
      {isProject ? <ShieldCheck size={13} /> : <Settings2 size={13} />}
      {isProject ? 'Project policy' : 'Default policy'}
    </span>
  );
}

function InfoTip({ label, content }: { label: string; content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
        >
          <Info size={13} />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-xs leading-5" side="top">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function PolicyTextareaField({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  info,
  headerAction,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (nextValue: string[]) => void;
  placeholder: string;
  disabled: boolean;
  info: string;
  headerAction?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Label htmlFor={id} className="text-xs font-semibold text-foreground">
            {label}
          </Label>
          <InfoTip label={`About ${label}`} content={info} />
        </div>
        {headerAction}
      </div>
      <Textarea
        id={id}
        value={listToText(value)}
        onChange={(event) => onChange(textToList(event.currentTarget.value))}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className="min-h-[86px] resize-y bg-background/70 font-mono text-xs leading-5"
      />
    </div>
  );
}

function PolicySwitchRow({
  id,
  label,
  value,
  onChange,
  disabled,
  info,
}: {
  id: string;
  label: string;
  value: boolean;
  onChange: (nextValue: boolean) => void;
  disabled: boolean;
  info?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 bg-background/70 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Label htmlFor={id} className="min-w-0 text-xs font-semibold text-foreground">
          {label}
        </Label>
        {info ? <InfoTip label={`About ${label}`} content={info} /> : null}
      </div>
      <Switch id={id} checked={value} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function RuntimeCachePolicy() {
  const [sandboxRoot, setSandboxRoot] = useState<{
    status: 'loading' | 'loaded' | 'error';
    value: string | null;
  }>({ status: 'loading', value: null });

  useEffect(() => {
    let cancelled = false;

    agentClient.getAgentSandboxRoot()
      .then((value) => {
        if (cancelled) return;
        setSandboxRoot({ status: 'loaded', value });
      })
      .catch(() => {
        if (cancelled) return;
        setSandboxRoot({ status: 'error', value: null });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const rootLabel =
    sandboxRoot.value ?? 'OS temp directory / agentree / agents';
  const rootTitle =
    sandboxRoot.value ?? 'Actual path is available in the desktop app runtime.';

  return (
    <Collapsible className="rounded-md border border-border/70 bg-background/70">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
        >
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">Advanced</div>
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Runtime cache isolation
            </div>
          </div>
          <ChevronDown
            size={16}
            className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/70 px-3 py-3">
          <div className="text-xs leading-5 text-muted-foreground">
            Agentree redirects common cache, temp, and build-output env vars outside the repo and
            worktree into a per-agent sandbox, then clears that sandbox during run cleanup.
          </div>
          <div className="mt-2 overflow-hidden rounded-md border border-border/60 bg-muted/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-start gap-2.5 border-b border-border/50 bg-background/65 px-3 py-2.5">
              <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/45 text-muted-foreground">
                <FolderOpen size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold leading-5 text-foreground">Root path</div>
                  <span className="shrink-0 rounded-md border border-border/60 bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground">
                    {sandboxRoot.status === 'loading'
                      ? 'Detecting'
                      : sandboxRoot.value
                        ? 'Resolved'
                        : 'Runtime default'}
                  </span>
                </div>
                <div
                  className="mt-1 break-all rounded-[5px] bg-muted/55 px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground/85"
                  title={rootTitle}
                >
                  {rootLabel}
                </div>
                <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                  macOS often uses <span className="font-mono">/var/folders/.../T</span> for temp paths.
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 divide-y divide-border/45 sm:grid-cols-[1fr_1.1fr] sm:divide-x sm:divide-y-0">
              <div className="px-3 py-2.5">
                <div className="text-[11px] font-medium leading-4 text-muted-foreground">
                  Agent folder
                </div>
                <div className="mt-1 font-mono text-[11px] leading-4 text-foreground/80">
                  worktree-id / agent-id
                </div>
              </div>
              <div className="px-3 py-2.5">
                <div className="text-[11px] font-medium leading-4 text-muted-foreground">
                  Override
                </div>
                <div className="mt-1 truncate font-mono text-[11px] leading-4 text-foreground/80" title="AGENTREE_AGENT_SANDBOX_ROOT">
                  AGENTREE_AGENT_SANDBOX_ROOT
                </div>
              </div>
            </div>
          </div>
          <div className="mt-2 rounded-md border border-border/60 bg-muted/25">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,0.55fr)] gap-2 border-b border-border/60 px-3 py-2 text-[11px] font-semibold text-muted-foreground">
              <span>Env var</span>
              <span>Sandbox folder</span>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {runtimeCacheEnvRows.map(([envName, folder]) => (
                <div
                  key={envName}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(120px,0.55fr)] gap-2 border-b border-border/35 px-3 py-1.5 text-xs last:border-b-0"
                >
                  <span className="truncate font-mono text-foreground/85" title={envName}>
                    {envName}
                  </span>
                  <span className="truncate font-mono text-muted-foreground" title={`$AGENTREE_AGENT_SANDBOX/${folder}`}>
                    {folder}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function WorktreePolicyPanel({ repoPath }: WorktreePolicyPanelProps) {
  const [loadState, setLoadState] = useState<LoadState>(emptyState);
  const [draft, setDraft] = useState<AgentWorktreeConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const loadPolicy = () => {
    if (!repoPath) {
      setLoadState(emptyState);
      setDraft(null);
      return;
    }

    let cancelled = false;
    setLoadState({ status: 'loading', data: null, error: null });
    setSaveError(null);
    setSavedMessage(null);
    agentClient.getAgentWorktreeConfig(repoPath)
      .then((data) => {
        if (cancelled) return;
        setLoadState({ status: 'loaded', data, error: null });
        setDraft(cloneConfig(data.config));
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadState({
          status: 'error',
          data: null,
          error: error instanceof Error ? error.message : String(error),
        });
        setDraft(null);
      });

    return () => {
      cancelled = true;
    };
  };

  useEffect(() => loadPolicy(), [repoPath]);

  const policy = loadState.status === 'loaded' ? loadState.data : null;
  const hasChanges = Boolean(
    policy &&
      draft &&
      JSON.stringify(policy.config) !== JSON.stringify(draft)
  );

  const updateDraft = <Key extends keyof AgentWorktreeConfig>(
    key: Key,
    value: AgentWorktreeConfig[Key]
  ) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setSaveError(null);
    setSavedMessage(null);
  };

  const savePolicy = async () => {
    if (!repoPath || !draft) return;
    setIsSaving(true);
    setSaveError(null);
    setSavedMessage(null);
    try {
      const saved = await agentClient.saveAgentWorktreeConfig(repoPath, draft);
      setLoadState({ status: 'loaded', data: saved, error: null });
      setDraft(cloneConfig(saved.config));
      setSavedMessage('Saved');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const resetToDefaults = () => {
    setDraft(cloneConfig(DEFAULT_AGENT_WORKTREE_CONFIG));
    setSaveError(null);
    setSavedMessage(null);
  };

  return (
    <TooltipProvider delayDuration={150}>
        <DialogHeader className="border-b border-border/70 px-5 py-4 pr-12">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-base leading-6">Worktree policy</DialogTitle>
              <DialogDescription className="truncate text-xs leading-5" title={repoPath ?? undefined}>
                {repoPath || 'No connected repository'}
              </DialogDescription>
            </div>
            {policy ? <StatusPill source={policy.source} /> : null}
          </div>
          {policy ? (
            <div className="mt-3 flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/35 px-2.5 py-2 text-xs">
              <FileJson size={15} className="shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-medium text-muted-foreground">Config</span>
              <span className="min-w-0 truncate font-mono text-foreground/85" title={policy.configPath}>
                {policy.configPath}
              </span>
            </div>
          ) : null}
        </DialogHeader>

        <div className="max-h-[calc(100dvh-10rem)] overflow-y-auto bg-muted/20">
          {loadState.status === 'loading' ? (
            <div className="p-5">
              <div className="space-y-4">
                <div className="app-skeleton h-28 rounded-md" />
                <div className="app-skeleton h-28 rounded-md" />
                <div className="app-skeleton h-28 rounded-md" />
              </div>
            </div>
          ) : loadState.status === 'error' ? (
            <div className="p-5">
              <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm leading-5 text-destructive">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{loadState.error}</span>
              </div>
            </div>
          ) : draft && policy ? (
            <div className="p-5">
              <section className="space-y-4">
                <div className="grid gap-3">
                  <PolicySwitchRow
                    id="block-dependency-mutations"
                    label="Block package install/update commands"
                    value={draft.blockDependencyMutationCommands}
                    onChange={(value) => updateDraft('blockDependencyMutationCommands', value)}
                    disabled={isSaving}
                    info="When this is on, agents cannot run package-manager commands that install, update, or remove dependencies."
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <PolicyTextareaField
                    id="dependency-link-dirs"
                    label="Dependency symlink dirs"
                    value={draft.dependencyLinkDirs}
                    onChange={(value) => updateDraft('dependencyLinkDirs', value)}
                    placeholder="node_modules"
                    disabled={isSaving}
                    info="Folders Agentree should symlink into every agent worktree, like node_modules. Add one repo-relative path per line."
                  />
                  <PolicyTextareaField
                    id="env-file-patterns"
                    label="Ignored files to copy"
                    value={draft.envFilePatterns}
                    onChange={(value) => updateDraft('envFilePatterns', value)}
                    placeholder=".env*"
                    disabled={isSaving || !draft.copyEnvFiles}
                    info=".gitignored files are not included in Git worktrees. Add files like .env.local here if agents need them."
                    headerAction={
                      <div className="flex shrink-0 items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2 py-1">
                        <Label
                          htmlFor="copy-env-files"
                          className="text-[11px] font-medium text-muted-foreground"
                        >
                          Copy env files
                        </Label>
                        <Switch
                          id="copy-env-files"
                          checked={draft.copyEnvFiles}
                          onCheckedChange={(value) => updateDraft('copyEnvFiles', value)}
                          disabled={isSaving}
                        />
                      </div>
                    }
                  />
                  <PolicyTextareaField
                    id="commit-exclude-patterns"
                    label="Commit exclude patterns"
                    value={draft.commitExcludePatterns}
                    onChange={(value) => updateDraft('commitExcludePatterns', value)}
                    placeholder="dist/**"
                    disabled={isSaving}
                    info="Files already ignored by .gitignore are excluded by default. Add patterns here only for other files you want left out of the agent's commit."
                  />
                </div>
                <RuntimeCachePolicy />
                {saveError ? (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
                    <AlertCircle size={15} className="mt-0.5 shrink-0" />
                    <span>{saveError}</span>
                  </div>
                ) : savedMessage ? (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium leading-5 text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 size={15} />
                    <span>{savedMessage}</span>
                  </div>
                ) : null}
              </section>
            </div>
          ) : (
            <div className="p-5 text-sm text-muted-foreground">Select a connected repository.</div>
          )}
        </div>

        <DialogFooter className="border-t border-border/70 bg-background px-5 py-3 sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetToDefaults}
              disabled={!draft || isSaving}
            >
              <RotateCcw size={15} />
              Defaults
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => loadPolicy()}
              disabled={!repoPath || isSaving}
            >
              <RefreshCw size={15} className={loadState.status === 'loading' ? 'animate-spin' : undefined} />
              Reload
            </Button>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={savePolicy}
            disabled={!repoPath || !draft || !hasChanges || isSaving}
          >
            {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            Save policy
          </Button>
        </DialogFooter>
    </TooltipProvider>
  );
}

export function WorktreePolicyButton({ repoPath, open, onOpenChange }: WorktreePolicyButtonProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = open ?? uncontrolledOpen;
  const setIsOpen = onOpenChange ?? setUncontrolledOpen;
  const triggerTitle = repoPath ? 'Worktree policy' : 'Worktree policy unavailable';

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            'app-rail-button app-focus-ring',
            !repoPath && 'cursor-not-allowed opacity-45'
          )}
          disabled={!repoPath}
          title={triggerTitle}
          aria-label={triggerTitle}
        >
          <Settings2 size={18} strokeWidth={2.1} />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[860px] gap-0 overflow-hidden rounded-xl border-border/80 p-0 shadow-[0_28px_90px_-46px_hsl(var(--foreground)/0.65)] sm:max-w-[860px]">
        <WorktreePolicyPanel repoPath={repoPath} />
      </DialogContent>
    </Dialog>
  );
}
