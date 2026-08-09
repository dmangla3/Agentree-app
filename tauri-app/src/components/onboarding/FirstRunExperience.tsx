import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { Button } from '../../../@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../../../@/components/ui/alert';
import { Badge } from '../../../@/components/ui/badge';
import { Input } from '../../../@/components/ui/input';
import { cn } from '../../lib/utils';
import { useCreateWorkspace, RepoPrepareActionRequiredError } from '../../hooks/useWorkspaces';
import { agentClient, type CliToolStatus, type LocalEnvironmentStatus, type RuntimeReadiness } from '../../lib/agentClient';
import { getErrorMessage } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { finalizeCreatedWorkspace } from '../../lib/finalizeCreatedWorkspace';
import { useToast } from '../Toast';
import { ChangedFilesSummary } from '../ChangedFilesSummary';
import type { Workspace } from '../../stores/workspaceStore';
import logoSrc from '../../assets/logo.png';
import { track, trackOnboardingStepViewed } from '../../lib/analytics';

type StepId = 'environment' | 'workspace';

interface FirstRunExperienceProps {
  userName: string;
  workspaces: Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onComplete: (workspaceId?: string | null) => void;
}

const onboardingTips = [
  {
    icon: MessageSquare,
    eyebrow: 'Tip 01',
    title: 'Start with one concrete ask.',
    body: 'Use the first run to test a narrow task on a real repository so you can see how Agentree records context, outputs, and branch history.',
    caption: 'Best first prompt: a contained bug fix, refactor, or code review.',
  },
  {
    icon: GitBranch,
    eyebrow: 'Tip 02',
    title: 'Branch when ideas diverge.',
    body: 'If one thread turns into multiple approaches, branch from the relevant node instead of forcing everything into one linear conversation.',
    caption: 'Parallel runs stay easier to compare when each branch has a clear intent.',
  },
  {
    icon: FolderSearch,
    eyebrow: 'Tip 03',
    title: 'Start from any commit you choose.',
    body: 'Select a commit as the base state and let Agentree branch agent work from that exact point, instead of always starting from the latest checkout.',
    caption: 'Useful when you want to compare approaches, revisit older states, or run parallel work from a stable base.',
  },
] as const;

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
};

function StatusRow({
  label,
  detail,
  command,
  status,
}: {
  label: string;
  detail: string;
  command: string;
  status: CheckStatus;
}) {
  const iconClassName = 'h-4 w-4';
  const statusLabel = {
    pending: 'Pending',
    checking: 'Checking',
    ready: 'Ready',
    missing: 'Action needed',
  }[status];

  return (
    <div
      className={cn(
        'flex min-h-16 items-start gap-3 rounded-xl border px-4 py-3 transition-colors',
        status === 'ready' && 'border-emerald-200 bg-emerald-50/70',
        status === 'missing' && 'border-amber-200 bg-amber-50/70',
        status === 'checking' && 'border-sky-200 bg-sky-50/70',
        status === 'pending' && 'border-border/60 bg-background/80'
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-background',
          status === 'ready' && 'border-emerald-200 text-emerald-700',
          status === 'missing' && 'border-amber-200 text-amber-700',
          status === 'checking' && 'border-sky-200 text-sky-700',
          status === 'pending' && 'border-border text-muted-foreground'
        )}
      >
        {status === 'ready' && <CheckCircle2 className={iconClassName} />}
        {status === 'missing' && <XCircle className={iconClassName} />}
        {status === 'checking' && <Loader2 className={cn(iconClassName, 'animate-spin')} />}
        {status === 'pending' && <CircleDashed className={iconClassName} />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <Badge
            variant="outline"
            className={cn(
              'w-fit rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em]',
              status === 'ready' && 'border-emerald-200 bg-emerald-50 text-emerald-700',
              status === 'missing' && 'border-amber-200 bg-amber-50 text-amber-700',
              status === 'checking' && 'border-sky-200 bg-sky-50 text-sky-700',
              status === 'pending' && 'border-border bg-muted/40 text-muted-foreground'
            )}
          >
            {statusLabel}
          </Badge>
        </div>
        <div className="mt-1 break-words text-sm text-muted-foreground">{detail}</div>
        <div className="mt-2 font-mono text-xs text-muted-foreground/80">{command}</div>
      </div>
    </div>
  );
}

function toolDetail(label: string, tool: CliToolStatus | null, missingMessage: string) {
  if (!tool) return `${label} has not been checked yet.`;
  if (tool.installed) return tool.version || `${label} is available.`;
  return tool.error || missingMessage;
}

function runtimeReadinessDetail(readiness: RuntimeReadiness | null, label: string): string {
  if (!readiness) return `${label} app access has not been checked yet.`;
  if (readiness.status === 'ready') {
    const plan = readiness.planType ? ` ${readiness.planType}` : '';
    const mode = readiness.authMode ? ` via ${readiness.authMode}` : '';
    return `Agentree can use ${label}${mode}${plan ? ` (${plan})` : ''}.`;
  }
  return readiness.message;
}

export function FirstRunExperience({
  userName,
  workspaces,
  onSelectWorkspace,
  onComplete,
}: FirstRunExperienceProps) {
  const [currentStep, setCurrentStep] = useState<StepId>('environment');
  const [activeTipIndex, setActiveTipIndex] = useState(0);
  const [environment, setEnvironment] = useState<LocalEnvironmentStatus | null>(null);
  const [runtimeReadiness, setRuntimeReadiness] = useState<Record<string, RuntimeReadiness>>({});
  const [isCheckingEnvironment, setIsCheckingEnvironment] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [checkpointMessage, setCheckpointMessage] = useState('WIP: pre-agentree checkpoint');
  const [setupRequirement, setSetupRequirement] = useState<RepoPrepareActionRequiredError['requirement'] | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const createWorkspace = useCreateWorkspace();
  const queryClient = useQueryClient();
  const dispatchFocus = useWorkspaceStore((state) => state.dispatchFocus);
  const { addToast } = useToast();

  const selectedFolderName = useMemo(() => {
    if (!selectedFolderPath) return null;
    return selectedFolderPath.split(/[/\\]/).pop() || selectedFolderPath;
  }, [selectedFolderPath]);

  const codexReadiness = runtimeReadiness.codex ?? null;
  const claudeReadiness = runtimeReadiness.claude ?? null;
  const hasReadyAgentRuntime = codexReadiness?.status === 'ready' || claudeReadiness?.status === 'ready';

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

    return [
      {
        label: 'Git',
        command: 'git --version',
        detail: toolDetail('Git', environment?.git ?? null, 'Git is not installed or not available on PATH.'),
        status: getStatus(environment?.git),
      },
      {
        label: 'Codex app access',
        command: codexReadiness?.recommendedCommand || 'Agentree Codex app-server readiness check',
        detail: runtimeReadinessDetail(codexReadiness, 'Codex'),
        status: isCheckingEnvironment ? 'checking' : codexReadiness ? (codexReadiness.status === 'ready' ? 'ready' : 'missing') : 'pending',
      },
      {
        label: 'Claude Code app access',
        command: claudeReadiness?.recommendedCommand || 'Agentree Claude Code readiness check',
        detail: runtimeReadinessDetail(claudeReadiness, 'Claude Code'),
        status: isCheckingEnvironment ? 'checking' : claudeReadiness ? (claudeReadiness.status === 'ready' ? 'ready' : 'missing') : 'pending',
      },
    ];
  }, [claudeReadiness, codexReadiness, environment, isCheckingEnvironment]);

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
    if (currentStep !== 'environment' || environment) return;
    void refreshEnvironment();
  }, [currentStep]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    trackOnboardingStepViewed(currentStep);
  }, [currentStep]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActiveTipIndex((index) => (index + 1) % onboardingTips.length);
    }, 9000);

    return () => window.clearInterval(interval);
  }, [onboardingTips.length]);

  const refreshEnvironment = async () => {
    setIsCheckingEnvironment(true);
    try {
      const [localEnvironment, runtimeReadinessList] = await Promise.all([
        agentClient.checkLocalEnvironment(),
        agentClient.checkAllRuntimeReadiness(),
      ]);
      const readinessByProvider = Object.fromEntries(
        runtimeReadinessList.map((readiness) => [readiness.provider, readiness])
      );
      setEnvironment(localEnvironment);
      setRuntimeReadiness(readinessByProvider);
      track('Onboarding Environment Checked', {
        git_installed: localEnvironment.git.installed,
        codex_authenticated: readinessByProvider.codex?.status === 'ready',
        codex_readiness_status: readinessByProvider.codex?.status ?? 'unknown',
        codex_auth_file: readinessByProvider.codex?.hasAuthFile ?? null,
        claude_authenticated: readinessByProvider.claude?.status === 'ready',
        claude_readiness_status: readinessByProvider.claude?.status ?? 'unknown',
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
      track('Onboarding Existing Workspace Selected', {
        workspace_id: existingWorkspaceForSelection.id,
      });
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
        track('Onboarding Completed', {
          workspace_id: created.id,
        });
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
          changed_files_count: error.requirement.workspace.changed_files.length,
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
    <div className="relative flex min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.18),_transparent_32%),linear-gradient(135deg,_hsl(var(--background))_0%,_hsl(215_45%_98%)_46%,_hsl(205_55%_96%)_100%)] text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[size:72px_72px] opacity-50" />
      <div className="relative hidden w-[38%] flex-col justify-between border-r border-border/50 bg-slate-950 px-10 py-12 text-slate-50 lg:flex">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
          className="space-y-8"
        >
          <div className="inline-flex w-fit items-center gap-3">
            <img src={logoSrc} alt="Agentree" className="h-8 w-auto" />
            <span className="rounded-full border border-white/12 bg-white/6 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-sky-100/80">
              Beta
            </span>
          </div>

          <div className="space-y-4">
            <div className="text-xs uppercase tracking-[0.22em] text-sky-100/70">Agentree Tips</div>
            <h2 className="max-w-sm text-4xl font-semibold leading-tight text-balance">
              Track What You Explored.
              <br />
              Branch from Any Message.
            </h2>
            <p className="max-w-md text-base leading-7 text-slate-300 text-pretty">
              Every branch. Every agent. Every failed attempt. All visible, all connected, all explorable across your entire team.
            </p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.1, ease: [0.2, 0, 0, 1] }}
          className="space-y-4"
        >
          <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.05] p-6 shadow-[0_28px_70px_-42px_rgba(14,165,233,0.35)]">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTipIndex}
                initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
                transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
                className="space-y-4"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-300/10 text-sky-100">
                  {(() => {
                    const Icon = onboardingTips[activeTipIndex].icon;
                    return <Icon className="h-5 w-5" />;
                  })()}
                </div>
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-300/70">
                    {onboardingTips[activeTipIndex].eyebrow}
                  </div>
                  <div className="text-2xl font-semibold leading-tight text-balance">
                    {onboardingTips[activeTipIndex].title}
                  </div>
                  <p className="text-sm leading-7 text-slate-300/85 text-pretty">
                    {onboardingTips[activeTipIndex].body}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-slate-200/80">
                  {onboardingTips[activeTipIndex].caption}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex gap-2">
            {onboardingTips.map((tip, index) => (
              <button
                key={tip.eyebrow}
                type="button"
                aria-label={`Show ${tip.eyebrow}`}
                onClick={() => setActiveTipIndex(index)}
                className={cn(
                  'h-2.5 rounded-full transition-all duration-200',
                  index === activeTipIndex ? 'w-10 bg-sky-300' : 'w-2.5 bg-white/25 hover:bg-white/40'
                )}
              />
            ))}
          </div>
        </motion.div>
      </div>
      <div className="relative flex flex-1 items-center justify-center px-5 py-10 sm:px-8 lg:px-12">
        <div className="w-full max-w-3xl">
          <AnimatePresence initial={false} mode="wait">
            {currentStep === 'environment' && (
              <motion.div
                key="environment"
                initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              >
                <Card className="border-border/60 bg-background/92 shadow-[0_28px_90px_-42px_rgba(15,23,42,0.45)] backdrop-blur-xl">
                  <CardHeader className="pb-4">
                    <Badge variant="outline" className="w-fit rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.18em]">
                      Step 1 of 2
                    </Badge>
                    <CardTitle className="text-3xl text-balance">Checking requirements</CardTitle>
                    <CardDescription className="text-base leading-7 text-pretty">
                      {userName ? `${userName}, ` : ''}Agentree checks Git locally, then verifies app access and authentication readiness for Codex and Claude Code before the first run. You can continue once Git is ready and at least one runtime is available.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-6">
                    <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-[0_18px_48px_-32px_rgba(15,23,42,0.35)]">
                      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-medium text-foreground">Machine checks</div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {isCheckingEnvironment
                              ? 'Agentree is checking each local requirement now.'
                              : environmentReady
                                ? 'Git is ready and at least one agent runtime is available.'
                                : 'Agentree needs Git plus at least one available agent runtime before continuing.'}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            'w-fit rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.14em]',
                            environmentReady
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                              : 'border-border bg-background text-muted-foreground'
                          )}
                        >
                          {completedEnvironmentChecks} of {environmentChecks.length} ready
                        </Badge>
                      </div>

                      <div className="grid gap-3">
                        {environmentChecks.map((check) => (
                          <StatusRow
                            key={check.label}
                            label={check.label}
                            command={check.command}
                            detail={check.detail}
                            status={check.status}
                          />
                        ))}
                      </div>
                    </div>

                    {!environmentReady && (
                      <Alert className="border-amber-200 bg-amber-50/80 text-amber-950">
                        <Terminal className="h-4 w-4" />
                        <AlertTitle>Finish the local setup</AlertTitle>
                        <AlertDescription>
                          <p>Run the missing checks above. Agentree requires Git plus at least one authenticated runtime: Codex or Claude Code.</p>
                          <p className="font-mono text-xs text-amber-900/90">git --version</p>
                          <p className="break-all font-mono text-xs text-amber-900/90">
                            {codexReadiness?.recommendedCommand || 'CODEX_HOME=~/.codex codex -c \'cli_auth_credentials_store="file"\' login --device-auth'}
                          </p>
                          <p className="break-all font-mono text-xs text-amber-900/90">
                            {claudeReadiness?.recommendedCommand || 'claude auth login'}
                          </p>
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <Button
                          variant="outline"
                          size="lg"
                          className="rounded-xl"
                          onClick={() => void refreshEnvironment()}
                          disabled={isCheckingEnvironment}
                        >
                          {isCheckingEnvironment ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          Run checks
                        </Button>
                        <Button
                          size="lg"
                          className="rounded-xl"
                          disabled={!environmentReady}
                          onClick={() => setCurrentStep('workspace')}
                        >
                          Continue to workspace
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </div>
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
                <Card className="border-border/60 bg-background/92 shadow-[0_28px_90px_-42px_rgba(15,23,42,0.45)] backdrop-blur-xl">
                  <CardHeader className="pb-4">
                    <Badge variant="outline" className="w-fit rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.18em]">
                      Step 2 of 2
                    </Badge>
                    <CardTitle className="text-3xl text-balance">Select a repository</CardTitle>
                    <CardDescription className="text-base leading-7 text-pretty">
                      Pick a local git repository. Agentree will import the commits of main and master branch automatically. You can import other branches later using 'track branch' button.
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-6">
                    <div className="rounded-3xl border border-border/60 bg-card/80 p-5 shadow-[0_18px_48px_-32px_rgba(15,23,42,0.35)]">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                          <div className="text-sm font-medium text-foreground">Project directory</div>
                          <div className="text-sm text-muted-foreground">
                            {selectedFolderPath ? selectedFolderPath : 'No directory selected yet.'}
                          </div>
                        </div>
                        <Button variant="outline" size="lg" className="rounded-xl" onClick={() => void handlePickFolder()}>
                          <FolderSearch className="h-4 w-4" />
                          {selectedFolderPath ? 'Change folder' : 'Choose folder'}
                        </Button>
                      </div>

                      {existingWorkspaceForSelection?.id && (
                        <Alert className="mt-4 border-sky-200 bg-sky-50/80 text-sky-950">
                          <CheckCircle2 className="h-4 w-4" />
                          <AlertTitle>Existing workspace found</AlertTitle>
                          <AlertDescription>
                            <p>
                              <span className="font-medium">{existingWorkspaceForSelection.name}</span> is already attached to this path.
                            </p>
                            <Button
                              variant="link"
                              className="mt-1 h-auto p-0 text-sky-800"
                              onClick={() => completeWithWorkspace(existingWorkspaceForSelection.id)}
                            >
                              Open existing workspace
                            </Button>
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>

                    {setupRequirement?.type === 'git_init' && (
                      <Alert className="border-orange-200 bg-orange-50/80 text-orange-950">
                        <GitBranch className="h-4 w-4" />
                        <AlertTitle>This folder is not a Git repository yet</AlertTitle>
                        <AlertDescription>
                          <p className="mb-3">Agentree can initialize Git and create the first base commit automatically.</p>
                          <div className="flex flex-wrap gap-3">
                            <Button size="sm" className="rounded-xl" onClick={() => void handleCreateWorkspace({ allowGitInit: true })}>
                              Initialize Git and continue
                            </Button>
                            <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setSetupRequirement(null)}>
                              Pick another folder
                            </Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    )}

                    {setupRequirement?.type === 'commit_checkpoint' && (
                      <Alert className="border-orange-200 bg-orange-50/80 text-orange-950">
                        <Sparkles className="h-4 w-4" />
                        <AlertTitle>This repository has local changes</AlertTitle>
                        <AlertDescription>
                          <p className="mb-3">
                            Choose whether Agentree should use the current last commit as the base, or create a checkpoint commit before workspace creation.
                          </p>
                          <ChangedFilesSummary files={setupRequirement.workspace.changed_files} />
                          <div className="mt-3 space-y-3">
                            <Input
                              value={checkpointMessage}
                              onChange={(event) => setCheckpointMessage(event.target.value)}
                              placeholder="Checkpoint commit message"
                              className="rounded-xl border-orange-200 bg-white"
                            />
                            <div className="flex flex-wrap gap-3">
                              <Button
                                size="sm"
                                className="rounded-xl"
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
                                className="rounded-xl border-orange-200 bg-white"
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
                      <Button variant="outline" size="lg" className="rounded-xl" onClick={() => setCurrentStep('environment')}>
                        Back
                      </Button>
                      <Button
                        size="lg"
                        className="rounded-xl"
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
    </div>
  );
}
