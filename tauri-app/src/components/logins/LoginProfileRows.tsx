import { CheckCircle2, Clock3, KeyRound, MoreHorizontal, ShieldAlert, Trash2 } from 'lucide-react';
import type { ActiveLoginProfileRun } from '../../lib/agentClient';
import {
  getLoginProfileAuthTypeLabel,
  getLoginProfileProviderLabel,
  getLoginProfileStatusTone,
  type LoginProfileSummary,
} from '../../lib/loginProfiles';
import { cn } from '../../lib/utils';

interface LoginProfileRowsProps {
  profiles: LoginProfileSummary[];
  activeRunsByProfile: Record<string, ActiveLoginProfileRun[]>;
  pendingProfileId: string | null;
  onCheck: (profile: LoginProfileSummary) => void;
  onEdit: (profile: LoginProfileSummary) => void;
  onDelete: (profile: LoginProfileSummary) => void;
  onSetDefault: (profile: LoginProfileSummary) => void;
}

const statusClasses = {
  success: 'bg-emerald-50 text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.2)] dark:bg-emerald-950/35 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-800 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.18)] dark:bg-amber-950/35 dark:text-amber-300',
  danger: 'bg-red-50 text-red-700 shadow-[inset_0_0_0_1px_rgba(220,38,38,0.18)] dark:bg-red-950/35 dark:text-red-300',
  muted: 'bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68)]',
};

const StatusIcon = ({ status }: { status: string }) => {
  if (status === 'ready') return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === 'unchecked') return <Clock3 className="h-3.5 w-3.5" />;
  return <ShieldAlert className="h-3.5 w-3.5" />;
};

export function LoginProfileRows({
  profiles,
  activeRunsByProfile,
  pendingProfileId,
  onCheck,
  onEdit,
  onDelete,
  onSetDefault,
}: LoginProfileRowsProps) {
  return (
    <div className="space-y-2">
      {profiles.map((profile) => {
        const tone = getLoginProfileStatusTone(profile.status);
        const activeRuns = activeRunsByProfile[profile.id] ?? [];
        const isPending = pendingProfileId === profile.id;
        return (
          <article
            key={profile.id}
            className="rounded-lg bg-background/78 p-4 shadow-[0_18px_44px_-34px_rgba(15,23,42,0.56),inset_0_0_0_1px_hsl(var(--app-border)/0.74)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-[14px] font-semibold leading-tight text-foreground">
                    {profile.displayName}
                  </h3>
                  {profile.isDefault ? (
                    <span className="rounded bg-[hsl(var(--app-accent-soft))] px-1.5 py-0.5 text-[10px] font-semibold text-[hsl(var(--app-accent))]">
                      Active
                    </span>
                  ) : null}
                  <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold', statusClasses[tone])}>
                    <StatusIcon status={profile.status} />
                    {profile.status.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{getLoginProfileProviderLabel(profile.provider)}</span>
                  <span>{getLoginProfileAuthTypeLabel(profile.authType)}</span>
                  {profile.redactedHint ? (
                    <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                      <KeyRound className="h-3 w-3" />
                      {profile.redactedHint}
                    </span>
                  ) : null}
                  {profile.planType ? <span>{profile.planType}</span> : null}
                  {activeRuns.length > 0 ? (
                    <span className="font-medium text-foreground">{activeRuns.length} active</span>
                  ) : null}
                </div>
                {profile.statusMessage ? (
                  <p className="mt-2 max-w-2xl text-[12px] leading-5 text-muted-foreground">
                    {profile.statusMessage}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onCheck(profile)}
                  disabled={isPending}
                  className="h-8 rounded-md bg-muted px-2.5 text-[11px] font-semibold text-foreground transition-[background-color,transform,opacity] hover:bg-muted/80 active:scale-[0.96] disabled:opacity-50"
                >
                  Check
                </button>
                <button
                  type="button"
                  onClick={() => onSetDefault(profile)}
                  disabled={profile.isDefault || isPending}
                  className="h-8 rounded-md bg-muted px-2.5 text-[11px] font-semibold text-foreground transition-[background-color,transform,opacity] hover:bg-muted/80 active:scale-[0.96] disabled:opacity-45"
                >
                  Set active
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
                  disabled={activeRuns.length > 0 || isPending}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform,opacity] hover:bg-red-50 hover:text-red-600 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-35 dark:hover:bg-red-950/35 dark:hover:text-red-300"
                  aria-label={`Delete ${profile.displayName}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
