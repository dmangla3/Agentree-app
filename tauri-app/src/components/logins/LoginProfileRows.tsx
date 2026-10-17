import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleGauge,
  Clock3,
  KeyRound,
  Loader2,
  MoreHorizontal,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../@/components/ui/popover';
import type { ActiveLoginProfileRun } from '../../lib/agentClient';
import {
  getLoginProfileAuthTypeLabel,
  getLoginProfileStatusTone,
  type LoginProfileSummary,
} from '../../lib/loginProfiles';
import type { ProviderLimitSeverity } from '../../stores/providerLimitsStore';
import { cn } from '../../lib/utils';

interface LoginProfileRowsProps {
  activeRunsByProfile: Record<string, ActiveLoginProfileRun[]>;
  limitSummaryByProfile?: Record<string, string | null>;
  limitSeverityByProfile?: Record<string, ProviderLimitSeverity>;
  onCheck: (profile: LoginProfileSummary) => void;
  onDelete: (profile: LoginProfileSummary) => void;
  onEdit: (profile: LoginProfileSummary) => void;
  onSelect?: (profile: LoginProfileSummary) => void;
  onSetDefault: (profile: LoginProfileSummary) => void;
  pendingProfileId: string | null;
  profiles: LoginProfileSummary[];
  selectedProfileId?: string | null;
}

const statusClasses = {
  success: 'bg-emerald-50 text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.2)] dark:bg-emerald-950/35 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-800 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)] dark:bg-amber-950/35 dark:text-amber-300',
  danger: 'bg-red-50 text-red-700 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.18)] dark:bg-red-950/35 dark:text-red-300',
  muted: 'bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68)]',
};

const limitClasses: Record<ProviderLimitSeverity, string> = {
  normal: 'bg-muted/70 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]',
  warning: 'bg-amber-50 text-amber-800 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)] dark:bg-amber-950/35 dark:text-amber-300',
  critical: 'bg-red-50 text-red-700 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.18)] dark:bg-red-950/35 dark:text-red-300',
};

const StatusIcon = ({ status }: { status: string }) => {
  if (status === 'ready') return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === 'checking') return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (status === 'unchecked') return <Clock3 className="h-3.5 w-3.5" />;
  return <ShieldAlert className="h-3.5 w-3.5" />;
};

const formatStatus = (status: string) => status.replace(/_/g, ' ');

const STATUS_MESSAGE_POPOVER_CLOSE_DELAY_MS = 140;

function StatusMessagePopover({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const show = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const scheduleHide = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, STATUS_MESSAGE_POPOVER_CLOSE_DELAY_MS);
  };

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <p
          className="mt-1 line-clamp-2 min-w-0 cursor-help break-words text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]"
          onFocus={show}
          onBlur={scheduleHide}
          onPointerEnter={show}
          onPointerLeave={scheduleHide}
          tabIndex={0}
        >
          {message}
        </p>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-72 w-[min(28rem,calc(100vw-2rem))] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 select-text [overflow-wrap:anywhere]"
        onPointerEnter={show}
        onPointerLeave={scheduleHide}
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="bottom"
      >
        {message}
      </PopoverContent>
    </Popover>
  );
}

export function LoginProfileRows({
  activeRunsByProfile,
  limitSummaryByProfile = {},
  limitSeverityByProfile = {},
  onCheck,
  onDelete,
  onEdit,
  onSelect,
  onSetDefault,
  pendingProfileId,
  profiles,
  selectedProfileId,
}: LoginProfileRowsProps) {
  return (
    <div className="overflow-hidden rounded-xl bg-background/86 shadow-[0_18px_52px_-44px_rgba(15,23,42,0.65),inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
      <div className="grid grid-cols-[minmax(13rem,1.35fr)_minmax(8rem,0.7fr)_minmax(8rem,0.8fr)_auto] gap-3 border-b border-[hsl(var(--app-border)/0.62)] bg-muted/35 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground max-md:hidden">
        <span>Account</span>
        <span>Status</span>
        <span>Limit</span>
        <span className="text-right">Actions</span>
      </div>
      <div className="divide-y divide-[hsl(var(--app-border)/0.58)]">
        {profiles.map((profile) => {
          const tone = getLoginProfileStatusTone(profile.status);
          const activeRuns = activeRunsByProfile[profile.id] ?? [];
          const hasPendingMutation = pendingProfileId === profile.id;
          const isPending = hasPendingMutation || profile.status === 'checking';
          const selected = selectedProfileId === profile.id;
          const limitSummary = limitSummaryByProfile[profile.id] ?? null;
          const limitSeverity = limitSeverityByProfile[profile.id] ?? 'normal';
          const showSecretHint = !['codex_chatgpt_session', 'claude_oauth'].includes(profile.authType) && Boolean(profile.redactedHint);
          return (
            <article
              key={profile.id}
              className={cn(
                'grid cursor-pointer grid-cols-[minmax(13rem,1.35fr)_minmax(8rem,0.7fr)_minmax(8rem,0.8fr)_auto] items-center gap-3 px-3 py-3 transition-[background-color,box-shadow] max-md:grid-cols-1 max-md:gap-2',
                selected ? 'bg-[hsl(var(--app-accent-soft))]/58 shadow-[inset_3px_0_0_hsl(var(--app-accent))]' : 'hover:bg-muted/38'
              )}
              onClick={() => onSelect?.(profile)}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-semibold leading-tight text-foreground">
                    {profile.displayName}
                  </span>
                  {profile.isDefault ? (
                    <span className="inline-flex h-5 items-center gap-1 rounded-md bg-[hsl(var(--app-accent-soft))] px-1.5 text-[10px] font-semibold text-[hsl(var(--app-accent))]">
                      <Star className="h-3 w-3 fill-current" />
                      Active
                    </span>
                  ) : null}
                  {activeRuns.length > 0 ? (
                    <span className="rounded-md bg-foreground px-1.5 py-0.5 text-[10px] font-semibold text-background">
                      {activeRuns.length} running
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{getLoginProfileAuthTypeLabel(profile.authType)}</span>
                  {showSecretHint ? (
                    <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                      <KeyRound className="h-3 w-3" />
                      {profile.redactedHint}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0">
                <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold capitalize', statusClasses[tone])}>
                  <StatusIcon status={profile.status} />
                  {formatStatus(profile.status)}
                </span>
                {profile.statusMessage ? (
                  <StatusMessagePopover message={profile.statusMessage} />
                ) : null}
              </div>

              <div className="min-w-0">
                {limitSummary ? (
                  <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold tabular-nums', limitClasses[limitSeverity])}>
                    <CircleGauge className="h-3.5 w-3.5" />
                    {limitSummary}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">No limit data</span>
                )}
              </div>

              <div className="flex shrink-0 items-center justify-end gap-1.5" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => onCheck(profile)}
                  disabled={isPending}
                  className="h-8 rounded-md bg-muted px-2.5 text-[11px] font-semibold text-foreground transition-[background-color,transform,opacity] hover:bg-muted/80 active:scale-[0.96] disabled:opacity-50"
                >
                  {profile.status === 'checking' ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Checking
                    </span>
                  ) : 'Check'}
                </button>
                <button
                  type="button"
                  onClick={() => onSetDefault(profile)}
                  disabled={profile.isDefault || isPending}
                  className="h-8 rounded-md bg-muted px-2.5 text-[11px] font-semibold text-foreground transition-[background-color,transform,opacity] hover:bg-muted/80 active:scale-[0.96] disabled:opacity-45"
                >
                  Use
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(profile)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
                  aria-label={`Edit ${profile.displayName}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(profile)}
                  disabled={activeRuns.length > 0 || hasPendingMutation}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform,opacity] hover:bg-red-50 hover:text-red-600 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35 dark:hover:bg-red-950/35 dark:hover:text-red-300"
                  aria-label={`Delete ${profile.displayName}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
