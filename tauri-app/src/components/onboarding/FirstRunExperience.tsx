import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  FolderSearch,
  GitBranch,
  MessageSquare,
  Loader2,
  RefreshCw,
  Sparkles,
  Terminal,
  XCircle,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../../../@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../../../@/components/ui/alert';
import { Badge } from '../../../@/components/ui/badge';
import { Input } from '../../../@/components/ui/input';
import { cn } from '../../lib/utils';
import { useCreateWorkspace, RepoPrepareActionRequiredError } from '../../hooks/useWorkspaces';
import { agentClient, type CliToolStatus, type LocalEnvironmentStatus, type LoginImportCandidate } from '../../lib/agentClient';
import { getErrorMessage } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useLoginProfilesStore } from '../../stores/loginProfilesStore';
import {
  getLoginProfileAuthTypeLabel,
  getLoginProfileProviderLabel,
  isLoginProfileActive,
  isLoginProfileCompatibleWithProvider,
  type LoginProfileSummary,
} from '../../lib/loginProfiles';
import { finalizeCreatedWorkspace } from '../../lib/finalizeCreatedWorkspace';
import { useToast } from '../Toast';
import { ChangedFilesSummary } from '../ChangedFilesSummary';
import { LoginProfileEditor } from '../logins/LoginProfileEditor';
import { ModelVisibilitySettingsPanel } from '../ModelVisibilitySettingsPanel';
import type { Workspace } from '../../stores/workspaceStore';
import logoSrc from '../../assets/logo.png';
import { bucketCount, track, trackOnboardingStepViewed } from '../../lib/analytics';
import { usesMacOSOverlayTitleBar } from '../../hooks/useTauriWorkspace';

type StepId = 'environment' | 'models' | 'workspace';

interface FirstRunExperienceProps {
  userName: string;
  workspaces: Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onComplete: (workspaceId?: string | null) => void;
  onRepositoryConnected?: (repoPath: string, workspaceId: string) => void;
  reviewMode?: boolean;
}

const onboardingTips = [
  {
    icon: MessageSquare,
    eyebrow: 'Focused tasks',
    title: 'Start with one clear task.',
    body: 'Try a contained task in a real repository to see its context, output, and branch history.',
    caption: 'A bug fix, refactor, or code review works well.',
  },
  {
    icon: GitBranch,
    eyebrow: 'Branching',
    title: 'Branch when ideas diverge.',
    body: 'Start each approach from the relevant node instead of forcing every idea into one conversation.',
    caption: 'Clear branch intent makes parallel runs easier to compare.',
  },
  {
    icon: FolderSearch,
    eyebrow: 'Starting points',
    title: 'Start from any commit.',
    body: 'Choose the exact base state instead of always working from the latest checkout.',
    caption: 'Compare approaches or revisit an earlier state without losing context.',
  },
] as const;

const stepBadgeClassName =
  'w-fit rounded-full border-border/70 bg-muted/45 px-2.5 py-1 text-[11px] font-medium text-muted-foreground';

const onboardingCardClassName =
  'gap-5 border-border/70 bg-[hsl(var(--app-panel-strong))] text-foreground shadow-[var(--app-shadow-panel)]';

const onboardingPanelClassName =
  'border border-border/65 bg-[hsl(var(--app-panel))] shadow-[0_12px_34px_-28px_hsl(var(--foreground)/0.28)]';

const outlineButtonClassName =
  'h-9 rounded-md';

const normalizePath = (value?: string | null): string | null => {
  if (!value) return null;
  const normalized = value.trim().replace(/[\\/]+$/, '');
  if (!normalized) return null;
  return normalized.toLowerCase();
};

type CheckStatus = 'pending' | 'checking' | 'ready' | 'missing';
type EnvironmentCheck = {
  label: string;
  command: string;
  detail: string;
  status: CheckStatus;
  provider?: 'codex' | 'claude' | 'opencode';
};

function StatusRow({
  label,
  detail,
  command,
  status,
  action,
}: {
  label: string;
  detail: string;
  command: string;
  status: CheckStatus;
  action?: ReactNode;
}) {
  const iconClassName = 'h-4 w-4';
  const statusLabel = {
    pending: 'Pending',
    checking: 'Testing',
    ready: 'Ready',
    missing: 'Action needed',
  }[status];

  return (
    <div
      role="listitem"
      data-design-part="onboarding-status-row"
      data-status={status}
      className={cn(
        'grid min-h-14 grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 px-3.5 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center',
        status === 'missing' && 'bg-destructive/[0.035] dark:bg-destructive/[0.06]'
      )}
    >
      <div
        data-design-part="onboarding-status-icon"
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)]',
          status === 'ready' && 'text-emerald-700 dark:text-emerald-400',
          status === 'missing' && 'text-destructive',
          status === 'checking' && 'text-foreground'
        )}
      >
        {status === 'ready' && <CheckCircle2 className={iconClassName} />}
        {status === 'missing' && <XCircle className={iconClassName} />}
        {status === 'checking' && <Loader2 className={cn(iconClassName, 'animate-spin')} />}
        {status === 'pending' && <CircleDashed className={iconClassName} />}
      </div>

      <div data-design-part="onboarding-status-content" className="min-w-0">
        <div data-design-part="onboarding-status-heading" className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div data-design-part="onboarding-status-command" className="truncate font-mono text-[11px] text-muted-foreground/75">{command}</div>
        </div>
        <div data-design-part="onboarding-status-detail" className={cn('mt-0.5 break-words text-xs leading-5 text-muted-foreground', status === 'missing' && 'text-destructive/85')}>
          {detail}
        </div>
      </div>

      <div data-design-part="onboarding-status-trailing" className="col-span-2 flex items-center justify-between gap-2 pl-9 sm:col-span-1 sm:pl-0">
        <Badge
          data-design-part="onboarding-status-badge"
          variant="outline"
          className={cn(
            'w-fit rounded-full border px-2 py-0.5 text-[11px] font-medium',
            status === 'ready' && 'border-emerald-600/20 bg-emerald-600/[0.07] text-emerald-700 dark:text-emerald-400',
            status === 'missing' && 'border-destructive/20 bg-destructive/[0.06] text-destructive',
            status === 'checking' && 'border-border/70 bg-muted/55 text-foreground',
            status === 'pending' && 'border-border/70 bg-muted/40 text-muted-foreground'
          )}
          aria-label={`${label}: ${statusLabel}`}
        >
          {statusLabel}
        </Badge>
        {action}
      </div>
    </div>
  );
}

function toolDetail(label: string, tool: CliToolStatus | null, missingMessage: string) {
  if (!tool) return `${label} has not been tested yet.`;
  if (tool.installed) return tool.version || `${label} is available.`;
  return tool.error || missingMessage;
}

function activeProfileForProvider(profiles: LoginProfileSummary[], provider: 'codex' | 'claude' | 'opencode') {
  const compatible = profiles.filter((profile) => isLoginProfileCompatibleWithProvider(profile, provider));
  return compatible.find((profile) => profile.isDefault) ?? compatible[0] ?? null;
}

function loginProfileDetail(profile: LoginProfileSummary | null, provider: 'codex' | 'claude' | 'opencode'): string {
  const label = getLoginProfileProviderLabel(provider);
  if (!profile) return `No active ${label} login profile has been added yet.`;
  const authLabel = getLoginProfileAuthTypeLabel(profile.authType);
  if (isLoginProfileActive(profile)) return `${profile.displayName} is ready via ${authLabel}.`;
  return profile.statusMessage || `${profile.displayName} is ${profile.status}.`;
}

function loginProfileStatus(
  profile: LoginProfileSummary | null,
  isCheckingEnvironment: boolean,
  hasEnvironmentCheck: boolean
): CheckStatus {
  if (isCheckingEnvironment) return 'checking';
  if (!profile) return hasEnvironmentCheck ? 'missing' : 'pending';
  if (isLoginProfileActive(profile)) return 'ready';
  if (profile.status === 'checking') return 'checking';
  return 'missing';
}

export function FirstRunExperience({
  userName,
  workspaces,
  onSelectWorkspace,
  onComplete,
  onRepositoryConnected,
  reviewMode = false,
}: FirstRunExperienceProps) {
  const [currentStep, setCurrentStep] = useState<StepId>('environment');
  const [activeTipIndex, setActiveTipIndex] = useState(0);
  const [environment, setEnvironment] = useState<LocalEnvironmentStatus | null>(null);
  const [isCheckingEnvironment, setIsCheckingEnvironment] = useState(false);
  const [importCandidates, setImportCandidates] = useState<LoginImportCandidate[]>([]);
  const [importingCandidateId, setImportingCandidateId] = useState<string | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [checkpointMessage, setCheckpointMessage] = useState('WIP: pre-agentree checkpoint');
  const [setupRequirement, setSetupRequirement] = useState<RepoPrepareActionRequiredError['requirement'] | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [editorProvider, setEditorProvider] = useState<'codex' | 'claude' | 'opencode'>('codex');
  const [editingProfile, setEditingProfile] = useState<LoginProfileSummary | null>(null);
  const [isLoginEditorOpen, setIsLoginEditorOpen] = useState(false);
  const createWorkspace = useCreateWorkspace();
  const queryClient = useQueryClient();
  const dispatchFocus = useWorkspaceStore((state) => state.dispatchFocus);
  const loginProfiles = useLoginProfilesStore((state) => state.profiles);
  const isMutatingLoginProfiles = useLoginProfilesStore((state) => state.isMutating);
  const loginProfilesError = useLoginProfilesStore((state) => state.error);
  const refreshLoginProfiles = useLoginProfilesStore((state) => state.refresh);
  const saveLoginProfile = useLoginProfilesStore((state) => state.saveProfile);
  const connectCodexProfile = useLoginProfilesStore((state) => state.connectCodexProfile);
  const connectClaudeOauthProfile = useLoginProfilesStore((state) => state.connectClaudeOauthProfile);
  const pollClaudeOauthProfile = useLoginProfilesStore((state) => state.pollClaudeOauthProfile);
  const submitClaudeOauthCode = useLoginProfilesStore((state) => state.submitClaudeOauthCode);
  const checkLoginProfile = useLoginProfilesStore((state) => state.checkProfile);
  const checkAllLoginProfiles = useLoginProfilesStore((state) => state.checkAllProfiles);
  const discoverImportCandidates = useLoginProfilesStore((state) => state.discoverImportCandidates);
  const importCandidate = useLoginProfilesStore((state) => state.importCandidate);
  const { addToast } = useToast();

  const selectedFolderName = useMemo(() => {
    if (!selectedFolderPath) return null;
    return selectedFolderPath.split(/[/\\]/).pop() || selectedFolderPath;
  }, [selectedFolderPath]);

  const codexProfile = activeProfileForProvider(loginProfiles, 'codex');
  const claudeProfile = activeProfileForProvider(loginProfiles, 'claude');
  const opencodeProfile = activeProfileForProvider(loginProfiles, 'opencode');
  const hasReadyAgentRuntime =
    Boolean(codexProfile && isLoginProfileActive(codexProfile)) ||
    Boolean(claudeProfile && isLoginProfileActive(claudeProfile)) ||
    Boolean(opencodeProfile && isLoginProfileActive(opencodeProfile));

  const environmentReady = Boolean(
    environment?.git.installed &&
    hasReadyAgentRuntime
  );

  const environmentChecks = useMemo<EnvironmentCheck[]>(() => {
    const getStatus = (tool: CliToolStatus | null | undefined): CheckStatus => {
      if (isCheckingEnvironment) return 'checking';
      if (!tool) return 'pending';
      return tool.installed ? 'ready' : 'missing';
    };
    const hasEnvironmentCheck = Boolean(environment);

    return [
      {
        label: 'Git',
        command: 'git --version',
        detail: toolDetail('Git', environment?.git ?? null, 'Git is not installed or not available on PATH.'),
        status: getStatus(environment?.git),
      },
      {
        label: 'Codex login',
        command: codexProfile ? getLoginProfileAuthTypeLabel(codexProfile.authType) : 'Import or add a Codex login profile',
        detail: loginProfileDetail(codexProfile, 'codex'),
        status: loginProfileStatus(codexProfile, isCheckingEnvironment, hasEnvironmentCheck),
        provider: 'codex',
      },
      {
        label: 'Claude login',
        command: claudeProfile ? getLoginProfileAuthTypeLabel(claudeProfile.authType) : 'Import or add a Claude login profile',
        detail: loginProfileDetail(claudeProfile, 'claude'),
        status: loginProfileStatus(claudeProfile, isCheckingEnvironment, hasEnvironmentCheck),
        provider: 'claude',
      },
      {
        label: 'OpenCode providers',
        command: opencodeProfile ? getLoginProfileAuthTypeLabel(opencodeProfile.authType) : 'Import or add an OpenCode environment',
        detail: loginProfileDetail(opencodeProfile, 'opencode'),
        status: loginProfileStatus(opencodeProfile, isCheckingEnvironment, hasEnvironmentCheck),
        provider: 'opencode',
      },
    ];
  }, [claudeProfile, codexProfile, environment, isCheckingEnvironment, opencodeProfile]);

  const completedEnvironmentChecks = environmentChecks.filter((check) => check.status === 'ready').length;

  const existingWorkspaceForSelection = useMemo(() => {
    const normalizedSelectedPath = normalizePath(selectedFolderPath);
    if (!normalizedSelectedPath) return null;

    return (
      workspaces.find((workspace) => {
        const candidates = [workspace.folderPath, workspace.repo_path, workspace.git_repo_path];
        return candidates.some((value) => normalizePath(value) === normalizedSelectedPath);
      }) ?? null
    );
  }, [selectedFolderPath, workspaces]);

  useEffect(() => {
    if (reviewMode || currentStep !== 'environment' || environment) return;
    void refreshEnvironment();
  }, [currentStep, reviewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (reviewMode) return;
    trackOnboardingStepViewed(currentStep);
  }, [currentStep, reviewMode]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActiveTipIndex((index) => (index + 1) % onboardingTips.length);
    }, 9000);

    return () => window.clearInterval(interval);
  }, [onboardingTips.length]);

  const refreshEnvironment = async () => {
    setIsCheckingEnvironment(true);
    try {
      const [localEnvironment] = await Promise.all([
        agentClient.checkLocalEnvironment(),
        checkAllLoginProfiles().catch(() => refreshLoginProfiles()),
      ]);
      const candidates = await discoverImportCandidates();
      setEnvironment(localEnvironment);
      setImportCandidates(candidates.filter((candidate) => candidate.importable));
      track('Onboarding Environment Checked', {
        git_installed: localEnvironment.git.installed,
        codex_authenticated: Boolean(codexProfile && isLoginProfileActive(codexProfile)),
        codex_readiness_status: codexProfile?.status ?? 'missing_profile',
        claude_authenticated: Boolean(claudeProfile && isLoginProfileActive(claudeProfile)),
        claude_readiness_status: claudeProfile?.status ?? 'missing_profile',
        opencode_authenticated: Boolean(opencodeProfile && isLoginProfileActive(opencodeProfile)),
        opencode_readiness_status: opencodeProfile?.status ?? 'missing_profile',
      });
    } catch (error) {
      track('Onboarding Environment Check Failed');
      addToast({
        title: 'Unable to check environment',
        description: getErrorMessage(error),
        variant: 'error',
      });
    } finally {
      setIsCheckingEnvironment(false);
    }
  };

  const importDetectedLogin = async (candidate: LoginImportCandidate) => {
    setImportingCandidateId(candidate.id);
    try {
      await importCandidate({
        candidateId: candidate.id,
        displayName: candidate.displayName,
        makeDefault: true,
      });
      await checkAllLoginProfiles();
      const candidates = await discoverImportCandidates();
      setImportCandidates(candidates.filter((item) => item.importable));
    } catch (error) {
      addToast({
        title: 'Unable to import login',
        description: getErrorMessage(error),
        variant: 'error',
      });
    } finally {
      setImportingCandidateId(null);
    }
  };

  const openLoginSetup = (provider: 'codex' | 'claude' | 'opencode') => {
    setEditorProvider(provider);
    setEditingProfile(provider === 'codex' ? codexProfile : provider === 'claude' ? claudeProfile : opencodeProfile);
    setIsLoginEditorOpen(true);
  };

  const saveEditorProfile = async (request: Parameters<typeof saveLoginProfile>[0]) => {
    const saved = await saveLoginProfile(request);
    setEditingProfile(saved);
    if (saved.authType !== 'codex_chatgpt_session' && saved.authType !== 'claude_oauth' && saved.provider !== 'opencode') {
      await checkLoginProfile(saved.id).catch(() => undefined);
    }
    return saved;
  };

  const completeWithWorkspace = (workspaceId?: string | null) => {
    if (workspaceId) {
      onSelectWorkspace(workspaceId);
    }
    onComplete(workspaceId);
  };

  const handlePickFolder = async () => {
    track('Onboarding Folder Picker Opened');
    const selected = await openFolderDialog({
      directory: true,
      title: 'Select your first project folder',
    });
    const folderPath = Array.isArray(selected) ? selected[0] : selected;
    if (!folderPath || typeof folderPath !== 'string') return;
    track('Onboarding Folder Selected');
    setSelectedFolderPath(folderPath);
    setSetupRequirement(null);
    setWorkspaceError(null);
  };

  const handleCreateWorkspace = async (options?: {
    allowGitInit?: boolean;
    dirtyStrategy?: 'last-commit' | 'checkpoint';
    commitMessage?: string | null;
  }) => {
    if (!selectedFolderPath) {
      setWorkspaceError('Pick a local project folder first.');
      return;
    }

    if (existingWorkspaceForSelection?.id) {
      track('Onboarding Existing Workspace Selected');
      completeWithWorkspace(existingWorkspaceForSelection.id);
      return;
    }

    setWorkspaceError(null);

    try {
      const created = await createWorkspace.mutateAsync({
        folderPath: selectedFolderPath,
        allowGitInit: options?.allowGitInit ?? false,
        dirtyStrategy: options?.dirtyStrategy,
        commitMessage: options?.commitMessage ?? null,
      });
      setSetupRequirement(null);
      if (created?.id) {
        const createdRepoPath = created.git_repo_path || created.repo_path || created.folderPath || selectedFolderPath;
        track('Onboarding Completed');
        if (createdRepoPath) {
          onRepositoryConnected?.(createdRepoPath, created.id);
        }
        void finalizeCreatedWorkspace({
          created,
          fallbackFolderPath: selectedFolderPath,
          queryClient,
          selectWorkspace: onSelectWorkspace,
          dispatchFocus,
          onImportFailed: (error) => {
            console.error('[FirstRunExperience] Initial commit import failed:', error);
            addToast({
              title: 'Workspace created',
              description: 'Initial commit import failed. You can refresh or track branches from the graph.',
              variant: 'warning',
            });
          },
        });
        onComplete(created.id);
      }
    } catch (error) {
      if (error instanceof RepoPrepareActionRequiredError) {
        track('Onboarding Workspace Setup Action Required', {
          requirement_type: error.requirement.type,
          changed_files_count_bucket: bucketCount(error.requirement.workspace.changed_files.length),
        });
        setSetupRequirement(error.requirement);
        setCheckpointMessage(error.requirement.defaultCommitMessage);
        return;
      }
      track('Onboarding Workspace Setup Failed');
      setWorkspaceError(getErrorMessage(error));
    }
  };

  return (
    <div
      data-design-scope="onboarding"
      data-design-part="onboarding-root"
      data-review-preview={reviewMode ? 'true' : undefined}
      className="app-shell-background relative flex min-h-[100dvh] overflow-hidden text-foreground"
      onClickCapture={reviewMode ? (event) => {
        if ((event.target as HTMLElement).closest('[data-design-review-navigation="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
      } : undefined}
      onChangeCapture={reviewMode ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      } : undefined}
      onSubmitCapture={reviewMode ? (event) => {
        event.preventDefault();
        event.stopPropagation();
      } : undefined}
    >
      {usesMacOSOverlayTitleBar() ? (
        <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-20 h-12" aria-hidden="true" />
      ) : null}
      <div data-design-part="onboarding-aside" className="relative hidden w-[35%] max-w-[30rem] flex-col justify-between border-r border-border/65 bg-[hsl(var(--app-bg-muted)/0.62)] px-9 py-10 lg:flex">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          className="space-y-10"
        >
          <div data-design-part="onboarding-brand" className="inline-flex w-fit items-center gap-3">
            <img src={logoSrc} alt="Agentree" className="h-8 w-auto" />
            <span className="rounded-full bg-muted/65 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              Beta
            </span>
          </div>

          <div data-design-part="onboarding-intro" className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground">Agentree tips</div>
            <h2 className="max-w-sm text-3xl font-semibold leading-tight tracking-[-0.03em] text-balance">
              See every path.
              <br />
              Branch at any point.
            </h2>
            <p className="max-w-md text-sm leading-6 text-muted-foreground text-pretty">
              Keep every agent run, branch, and outcome visible in one connected workspace.
            </p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.08, ease: [0.2, 0, 0, 1] }}
          className="space-y-2"
        >
          <div data-design-part="onboarding-tip-card" className="relative overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--app-panel-strong))] p-5 shadow-[var(--app-shadow-panel)]">
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                key={activeTipIndex}
                initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="space-y-4"
              >
                <div data-design-part="onboarding-tip-icon" className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/65 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)]">
                  {(() => {
                    const Icon = onboardingTips[activeTipIndex].icon;
                    return <Icon className="h-5 w-5" />;
                  })()}
                </div>
                <div className="space-y-2">
                  <div data-design-part="onboarding-tip-eyebrow" className="text-xs font-medium text-muted-foreground">
                    {onboardingTips[activeTipIndex].eyebrow}
                  </div>
                  <div data-design-part="onboarding-tip-title" className="text-xl font-semibold leading-tight tracking-[-0.02em] text-balance">
                    {onboardingTips[activeTipIndex].title}
                  </div>
                  <p data-design-part="onboarding-tip-body" className="text-sm leading-6 text-muted-foreground text-pretty">
                    {onboardingTips[activeTipIndex].body}
                  </p>
                </div>
                <div data-design-part="onboarding-tip-caption" className="rounded-lg bg-muted/45 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                  {onboardingTips[activeTipIndex].caption}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          <div data-design-part="onboarding-tip-nav" className="flex gap-0.5" role="group" aria-label="Onboarding tips">
            {onboardingTips.map((tip, index) => (
              <button
                key={tip.eyebrow}
                type="button"
                aria-label={`Show ${tip.eyebrow}`}
                data-design-review-navigation="true"
                onClick={() => setActiveTipIndex(index)}
                className="flex h-10 w-10 items-center justify-center rounded-lg transition-[background-color,transform] duration-150 ease-out hover:bg-muted/65 active:scale-[0.96]"
              >
                <span
                  className={cn(
                    'h-1.5 rounded-full transition-[width,background-color] duration-200',
                    index === activeTipIndex ? 'w-6 bg-foreground/75' : 'w-1.5 bg-muted-foreground/35'
                  )}
                />
              </button>
            ))}
          </div>
        </motion.div>
      </div>
      <div data-design-part="onboarding-main" className="relative flex flex-1 items-center justify-center px-5 py-8 sm:px-8 lg:px-10">
        <div className="w-full max-w-3xl">
          <AnimatePresence initial={false} mode="wait">
            {currentStep === 'environment' && (
              <motion.div
                key="environment"
                initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              >
                <Card data-design-part="onboarding-step-card" className={onboardingCardClassName}>
                  <CardHeader className="pb-4">
                    <Badge variant="outline" className={stepBadgeClassName}>
                      Step 1 of 3
                    </Badge>
                    <CardTitle className="text-balance text-2xl tracking-[-0.025em]">Testing requirements</CardTitle>
                    <CardDescription className="max-w-2xl text-pretty text-sm leading-6">
                      {userName ? `${userName}, confirm ` : 'Confirm '}Git and one active provider login before your first run.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-6">
                    <div data-design-part="onboarding-environment-panel" className={cn('overflow-hidden rounded-xl', onboardingPanelClassName)}>
                      <div data-design-part="onboarding-environment-header" className="flex flex-col gap-3 border-b border-border/60 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-medium text-foreground">Local requirements</div>
                          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                            {isCheckingEnvironment
                              ? 'Checking your machine now.'
                              : environmentReady
                                ? 'Git and an agent runtime are ready.'
                                : 'Git and one agent runtime are required.'}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            'w-fit rounded-full px-2.5 py-0.5 text-[11px] font-medium tabular-nums',
                            environmentReady
                              ? 'border-emerald-600/20 bg-emerald-600/[0.07] text-emerald-700 dark:text-emerald-400'
                              : 'border-border/70 bg-muted/40 text-muted-foreground'
                          )}
                        >
                          {completedEnvironmentChecks} of {environmentChecks.length} ready
                        </Badge>
                      </div>

                      <div data-design-part="onboarding-environment-list" role="list" aria-label="Environment requirements" className="divide-y divide-border/55">
                        {environmentChecks.map((check) => (
                          <StatusRow
                            key={check.label}
                            label={check.label}
                            command={check.command}
                            detail={check.detail}
                            status={check.status}
                            action={check.provider ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 rounded-md"
                                onClick={() => openLoginSetup(check.provider!)}
                                disabled={isCheckingEnvironment}
                              >
                                <ShieldCheck className="h-4 w-4" />
                                {check.status === 'ready' ? 'Manage' : 'Set up'}
                              </Button>
                            ) : undefined}
                          />
                        ))}
                      </div>
                    </div>

                    {!environmentReady && importCandidates.length > 0 ? (
                      <div className="rounded-xl border border-border/60 bg-background/74 p-4 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.72)] dark:border-white/10 dark:bg-zinc-900/72 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
                        <div className="text-sm font-medium text-foreground dark:text-zinc-100">Detected logins</div>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground dark:text-zinc-300">
                          Import one of these after reviewing it. Secret values stay hidden.
                        </p>
                        <div className="mt-3 grid gap-2">
                          {importCandidates.map((candidate) => (
                            <div
                              key={candidate.id}
                              className="flex flex-col gap-3 rounded-lg bg-card/80 p-3 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.7)] dark:bg-zinc-950/78 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-semibold text-foreground dark:text-zinc-100">{candidate.displayName}</span>
                                  <Badge variant="outline" className="rounded-md border-border/80 bg-background/70 px-1.5 py-0 text-[10px] uppercase tracking-[0.08em] dark:border-white/12 dark:bg-white/8 dark:text-zinc-200">
                                    {candidate.provider}
                                  </Badge>
                                  <Badge variant="secondary" className="rounded-md px-1.5 py-0 text-[10px] dark:bg-zinc-800 dark:text-zinc-200">
                                    {candidate.sourceKind}
                                  </Badge>
                                </div>
                                <div className="mt-1 truncate text-xs text-muted-foreground dark:text-zinc-400">
                                  {candidate.sourceLabel}
                                  {candidate.redactedHint ? ` · ${candidate.redactedHint}` : ''}
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="rounded-lg dark:border-white/12 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                                onClick={() => void importDetectedLogin(candidate)}
                                disabled={Boolean(importingCandidateId)}
                              >
                                {importingCandidateId === candidate.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : null}
                                Import
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {!environmentReady && (
                      <div data-design-part="onboarding-setup-notice" className="flex items-start gap-3 rounded-lg bg-muted/45 px-3.5 py-3 text-sm shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)]">
                        <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <p className="text-pretty leading-5 text-muted-foreground">
                          <span className="font-medium text-foreground">Finish login setup.</span>{' '}
                          Git and one ready Codex, Claude, or OpenCode profile are required to continue.
                        </p>
                      </div>
                    )}

                    <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <Button
                          variant="outline"
                          size="lg"
                          className={outlineButtonClassName}
                          onClick={() => void refreshEnvironment()}
                          disabled={isCheckingEnvironment}
                        >
                          {isCheckingEnvironment ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          Run tests
                        </Button>
                        <Button
                          size="lg"
                          className="h-10 rounded-lg"
                          disabled={!reviewMode && !environmentReady}
                          data-design-review-navigation="true"
                          onClick={() => setCurrentStep('models')}
                        >
                          Continue to models
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {currentStep === 'models' && (
              <motion.div
                key="models"
                initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              >
                <Card data-design-part="onboarding-step-card" className={cn(onboardingCardClassName, 'flex h-[min(760px,calc(100vh-5rem))] flex-col overflow-hidden')}>
                  <CardHeader className="shrink-0 pb-4">
                    <Badge variant="outline" className={stepBadgeClassName}>
                      Step 2 of 3
                    </Badge>
                    <CardTitle className="text-3xl text-balance">Choose your models</CardTitle>
                    <CardDescription className="text-base leading-7 text-pretty dark:text-zinc-300">
                      Choose which model families appear in Agentree. You can change this later in Configuration.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="flex min-h-0 flex-1 flex-col gap-4 pb-6">
                    <div className={cn('flex min-h-0 flex-1 overflow-hidden rounded-xl', onboardingPanelClassName)}>
                      <ModelVisibilitySettingsPanel showHeader={false} />
                    </div>
                    <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <Button variant="outline" size="lg" className={outlineButtonClassName} data-design-review-navigation="true" onClick={() => setCurrentStep('environment')}>
                        Back
                      </Button>
                      <Button size="lg" className="h-10 rounded-lg" data-design-review-navigation="true" onClick={() => setCurrentStep('workspace')}>
                        Continue to workspace
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {currentStep === 'workspace' && (
              <motion.div
                key="workspace"
                initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              >
                <Card data-design-part="onboarding-step-card" className={onboardingCardClassName}>
                  <CardHeader className="pb-4">
                    <Badge variant="outline" className={stepBadgeClassName}>
                      Step 3 of 3
                    </Badge>
                    <CardTitle className="text-3xl text-balance">Select a repository</CardTitle>
                    <CardDescription className="text-base leading-7 text-pretty dark:text-zinc-300">
                      Pick a local git repository. Agentree will import the commits of main and master branch automatically. You can import other branches later using 'track branch' button.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-6">
                    <div className={cn('rounded-xl p-5', onboardingPanelClassName)}>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                          <div className="text-sm font-medium text-foreground dark:text-zinc-100">Project directory</div>
                          <div className="text-sm text-muted-foreground dark:text-zinc-300">
                            {selectedFolderPath ? selectedFolderPath : 'No directory selected yet.'}
                          </div>
                        </div>
                        <Button variant="outline" size="lg" className={outlineButtonClassName} onClick={() => void handlePickFolder()}>
                          <FolderSearch className="h-4 w-4" />
                          {selectedFolderPath ? 'Change folder' : 'Choose folder'}
                        </Button>
                      </div>

                      {existingWorkspaceForSelection?.id && (
                        <Alert className="mt-4 border-border/65 bg-muted/45 text-foreground">
                          <CheckCircle2 className="h-4 w-4" />
                          <AlertTitle>Existing workspace found</AlertTitle>
                          <AlertDescription className="text-muted-foreground">
                            <p>
                              <span className="font-medium">{existingWorkspaceForSelection.name}</span> is already attached to this path.
                            </p>
                            <Button
                              variant="link"
                              className="mt-1 h-auto p-0 text-foreground"
                              onClick={() => completeWithWorkspace(existingWorkspaceForSelection.id)}
                            >
                              Open existing workspace
                            </Button>
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>

                    {setupRequirement?.type === 'git_init' && (
                      <Alert className="border-orange-200 bg-orange-50/80 text-orange-950 dark:border-orange-500/30 dark:bg-orange-950/35 dark:text-orange-100">
                        <GitBranch className="h-4 w-4" />
                        <AlertTitle>This folder is not a Git repository yet</AlertTitle>
                        <AlertDescription className="text-orange-900 dark:text-orange-100/85">
                          <p className="mb-3">Agentree can initialize Git and create the first base commit automatically.</p>
                          <div className="flex flex-wrap gap-3">
                            <Button size="sm" className="h-10 rounded-lg" onClick={() => void handleCreateWorkspace({ allowGitInit: true })}>
                              Initialize Git and continue
                            </Button>
                            <Button size="sm" variant="outline" className={outlineButtonClassName} onClick={() => setSetupRequirement(null)}>
                              Pick another folder
                            </Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    )}

                    {setupRequirement?.type === 'commit_checkpoint' && (
                      <Alert className="border-orange-200 bg-orange-50/80 text-orange-950 dark:border-orange-500/30 dark:bg-orange-950/35 dark:text-orange-100">
                        <Sparkles className="h-4 w-4" />
                        <AlertTitle>This repository has local changes</AlertTitle>
                        <AlertDescription className="text-orange-900 dark:text-orange-100/85">
                          <p className="mb-3">
                            Choose whether Agentree should use the current last commit as the base, or create a checkpoint commit before workspace creation.
                          </p>
                          <ChangedFilesSummary files={setupRequirement.workspace.changed_files} />
                          <div className="mt-3 space-y-3">
                            <Input
                              value={checkpointMessage}
                              onChange={(event) => setCheckpointMessage(event.target.value)}
                              placeholder="Checkpoint commit message"
                              className="h-10 rounded-lg border-orange-200 bg-white text-orange-950 dark:border-orange-500/30 dark:bg-background/80 dark:text-foreground"
                            />
                            <div className="flex flex-wrap gap-3">
                              <Button
                                size="sm"
                                className="h-10 rounded-lg"
                                onClick={() => void handleCreateWorkspace({
                                  dirtyStrategy: 'checkpoint',
                                  commitMessage: checkpointMessage,
                                })}
                              >
                                Create checkpoint commit
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-10 rounded-lg border-orange-200 bg-white text-orange-950 hover:bg-orange-50 dark:border-orange-500/35 dark:bg-zinc-950/80 dark:text-orange-100 dark:hover:bg-orange-950/55"
                                onClick={() => void handleCreateWorkspace({ dirtyStrategy: 'last-commit' })}
                              >
                                Use last commit
                              </Button>
                            </div>
                          </div>
                        </AlertDescription>
                      </Alert>
                    )}

                    {workspaceError && (
                      <Alert variant="destructive">
                        <AlertTitle>Workspace setup failed</AlertTitle>
                        <AlertDescription>{workspaceError}</AlertDescription>
                      </Alert>
                    )}

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <Button variant="outline" size="lg" className={outlineButtonClassName} data-design-review-navigation="true" onClick={() => setCurrentStep('models')}>
                        Back
                      </Button>
                      <Button
                        size="lg"
                        className="h-10 rounded-lg"
                        disabled={!selectedFolderPath || createWorkspace.isPending}
                        onClick={() => void handleCreateWorkspace()}
                      >
                        {createWorkspace.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ArrowRight className="h-4 w-4" />
                        )}
                        {selectedFolderName ? `Create workspace for ${selectedFolderName}` : 'Create workspace'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <LoginProfileEditor
        open={isLoginEditorOpen}
        provider={editorProvider}
        profile={editingProfile}
        isSaving={isMutatingLoginProfiles}
        error={loginProfilesError}
        onOpenChange={(open) => {
          setIsLoginEditorOpen(open);
          if (!open) {
            void refreshLoginProfiles();
          }
        }}
        onSave={saveEditorProfile}
        onConnectCodex={connectCodexProfile}
        onConnectClaudeOauth={connectClaudeOauthProfile}
        onPollClaudeOauth={pollClaudeOauthProfile}
        onSubmitClaudeOauthCode={submitClaudeOauthCode}
      />
    </div>
  );
}
