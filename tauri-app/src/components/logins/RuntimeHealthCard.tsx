import { memo, useCallback, useEffect, useSyncExternalStore, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { AlertCircle, Download, HeartPulse, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../@/components/ui/button';
import { agentClient } from '../../lib/agentClient';
import type { ManagedRuntimeDoctorEntry } from '../../generated/tauri-bindings';
import { cn } from '../../lib/utils';

type DownloadProgress = {
  component: string;
  receivedBytes: number;
  totalBytes: number | null;
};

type RuntimeRepairSnapshot = {
  busyComponent: string | null;
  entriesByComponent: Record<string, ManagedRuntimeDoctorEntry>;
  error: string | null;
  progressByComponent: Record<string, DownloadProgress>;
};

const statusDotClasses: Record<string, string> = {
  ready: 'bg-emerald-500',
  missing: 'bg-amber-500',
  unpublished: 'bg-muted-foreground/50',
};

const emptyRuntimeRepairSnapshot = (): RuntimeRepairSnapshot => ({
  busyComponent: null,
  entriesByComponent: {},
  error: null,
  progressByComponent: {},
});

let runtimeRepairSnapshot = emptyRuntimeRepairSnapshot();
const runtimeRepairListeners = new Set<() => void>();
const runtimeRepairPromises = new Map<string, Promise<ManagedRuntimeDoctorEntry>>();
let pendingProgressByComponent: Record<string, DownloadProgress> = {};
let progressFrame: number | null = null;
let runtimeProgressUnlisten: UnlistenFn | null = null;
let runtimeProgressListenerPromise: Promise<UnlistenFn> | null = null;

const formatMegabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

const progressPercent = (progress?: DownloadProgress | null) => {
  if (!progress?.totalBytes || progress.totalBytes <= 0) return null;
  return Math.max(
    0,
    Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
  );
};

const hasTauriRuntime = () =>
  typeof window !== 'undefined' &&
  Boolean(
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
      (window as unknown as Record<string, unknown>).__TAURI__
  );

const getRuntimeRepairSnapshot = () => runtimeRepairSnapshot;

const subscribeRuntimeRepair = (listener: () => void) => {
  runtimeRepairListeners.add(listener);
  return () => {
    runtimeRepairListeners.delete(listener);
  };
};

const setRuntimeRepairSnapshot = (
  update: (current: RuntimeRepairSnapshot) => RuntimeRepairSnapshot
) => {
  runtimeRepairSnapshot = update(runtimeRepairSnapshot);
  runtimeRepairListeners.forEach((listener) => listener());
};

const clearProgressFrame = () => {
  if (progressFrame === null || typeof window === 'undefined') return;
  window.cancelAnimationFrame?.(progressFrame);
  window.clearTimeout(progressFrame);
  progressFrame = null;
};

const flushRuntimeProgress = () => {
  const pending = pendingProgressByComponent;
  pendingProgressByComponent = {};
  if (Object.keys(pending).length === 0) return;
  setRuntimeRepairSnapshot((current) => ({
    ...current,
    progressByComponent: {
      ...current.progressByComponent,
      ...pending,
    },
  }));
};

const scheduleRuntimeProgressFlush = () => {
  if (progressFrame !== null) return;
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    let flushedSynchronously = false;
    const frame = window.requestAnimationFrame(() => {
      flushedSynchronously = true;
      progressFrame = null;
      flushRuntimeProgress();
    });
    progressFrame = flushedSynchronously ? null : frame;
    return;
  }
  if (typeof window !== 'undefined') {
    progressFrame = window.setTimeout(() => {
      progressFrame = null;
      flushRuntimeProgress();
    }, 16);
    return;
  }
  flushRuntimeProgress();
};

const ensureRuntimeProgressListener = () => {
  if (!hasTauriRuntime() || runtimeProgressUnlisten || runtimeProgressListenerPromise) return;
  runtimeProgressListenerPromise = listen<DownloadProgress>('managed-runtime:download', (event) => {
    pendingProgressByComponent[event.payload.component] = event.payload;
    scheduleRuntimeProgressFlush();
  })
    .then((stop) => {
      runtimeProgressUnlisten = stop;
      return stop;
    })
    .catch((listenError) => {
      runtimeProgressListenerPromise = null;
      setRuntimeRepairSnapshot((current) => ({
        ...current,
        error: listenError instanceof Error ? listenError.message : String(listenError),
      }));
      return () => undefined;
    });
};

const reconcileRuntimeRepairEntries = () => {
  const activeComponent = runtimeRepairSnapshot.busyComponent;
  if (!activeComponent) {
    setRuntimeRepairSnapshot((current) => ({
      ...current,
      entriesByComponent: {},
      error: null,
    }));
    return;
  }
  const activeEntry = runtimeRepairSnapshot.entriesByComponent[activeComponent];
  setRuntimeRepairSnapshot((current) => ({
    ...current,
    entriesByComponent: activeEntry ? { [activeComponent]: activeEntry } : {},
    error: null,
  }));
};

const startRuntimeRepair = (entry: ManagedRuntimeDoctorEntry) => {
  const activeComponent = runtimeRepairSnapshot.busyComponent;
  const existingForComponent = runtimeRepairPromises.get(entry.component);
  if (existingForComponent) return existingForComponent;
  if (activeComponent) return null;

  ensureRuntimeProgressListener();
  setRuntimeRepairSnapshot((current) => ({
    ...current,
    busyComponent: entry.component,
    entriesByComponent: {
      ...current.entriesByComponent,
      [entry.component]: entry,
    },
    error: null,
    progressByComponent: {
      ...current.progressByComponent,
      [entry.component]: { component: entry.component, receivedBytes: 0, totalBytes: null },
    },
  }));

  const repairPromise = agentClient
    .repairManagedRuntimeComponent(entry.component)
    .then((repairedEntry) => {
      setRuntimeRepairSnapshot((current) => {
        const nextProgress = { ...current.progressByComponent };
        delete nextProgress[entry.component];
        return {
          ...current,
          busyComponent: current.busyComponent === entry.component ? null : current.busyComponent,
          entriesByComponent: {
            ...current.entriesByComponent,
            [entry.component]: repairedEntry,
          },
          progressByComponent: nextProgress,
        };
      });
      return repairedEntry;
    })
    .catch((repairError) => {
      setRuntimeRepairSnapshot((current) => {
        const nextProgress = { ...current.progressByComponent };
        delete nextProgress[entry.component];
        return {
          ...current,
          busyComponent: current.busyComponent === entry.component ? null : current.busyComponent,
          error: repairError instanceof Error ? repairError.message : String(repairError),
          progressByComponent: nextProgress,
        };
      });
      throw repairError;
    })
    .finally(() => {
      delete pendingProgressByComponent[entry.component];
      runtimeRepairPromises.delete(entry.component);
    });

  runtimeRepairPromises.set(entry.component, repairPromise);
  return repairPromise;
};

export const __resetRuntimeRepairStateForTests = () => {
  clearProgressFrame();
  runtimeProgressUnlisten?.();
  runtimeProgressUnlisten = null;
  runtimeProgressListenerPromise = null;
  pendingProgressByComponent = {};
  runtimeRepairPromises.clear();
  runtimeRepairSnapshot = emptyRuntimeRepairSnapshot();
  runtimeRepairListeners.forEach((listener) => listener());
};

export function RuntimeHealthCard() {
  const repairSnapshot = useSyncExternalStore(
    subscribeRuntimeRepair,
    getRuntimeRepairSnapshot,
    getRuntimeRepairSnapshot
  );
  const [entries, setEntries] = useState<ManagedRuntimeDoctorEntry[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (forceFingerprint = false) => {
    setIsRefreshing(true);
    setError(null);
    try {
      const refreshedEntries = await agentClient.checkManagedRuntimeDoctor(forceFingerprint);
      setEntries(refreshedEntries);
      reconcileRuntimeRepairEntries();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  useEffect(() => {
    ensureRuntimeProgressListener();
  }, []);

  const installComponent = useCallback((entry: ManagedRuntimeDoctorEntry) => {
    setError(null);
    void startRuntimeRepair(entry)?.catch(() => undefined);
  }, []);

  const displayEntries = entries.map((entry) => (
    repairSnapshot.entriesByComponent[entry.component] ?? entry
  ));
  const displayedComponents = new Set(displayEntries.map((entry) => entry.component));
  Object.values(repairSnapshot.entriesByComponent).forEach((entry) => {
    if (!displayedComponents.has(entry.component)) displayEntries.push(entry);
  });
  const visibleError = error ?? repairSnapshot.error;

  // Hide only when there is genuinely nothing to show (e.g. browser preview);
  // a failed doctor check must surface its error, not blank the card.
  if (displayEntries.length === 0 && !visibleError) return null;

  return (
    <section className="min-w-0 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-foreground">
          <HeartPulse className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">Runtime health</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-10 w-10 rounded-lg px-0"
          aria-label="Refresh runtime health"
          disabled={isRefreshing || Boolean(repairSnapshot.busyComponent)}
          onClick={() => void refresh(true)}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
        </Button>
      </div>
      <p className="mt-1 min-w-0 break-words text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        Agentree-managed provider toolchains. Missing components download on first use.
      </p>

      <div className="mt-3 divide-y divide-border/55 border-y border-border/55">
        {displayEntries.map((entry) => {
          const progress = repairSnapshot.progressByComponent[entry.component];
          const isBusy = repairSnapshot.busyComponent === entry.component;
          return (
            <RuntimeEntryRow
              key={entry.component}
              entry={entry}
              isBusy={isBusy}
              progress={progress}
              disabled={Boolean(repairSnapshot.busyComponent)}
              onInstall={installComponent}
            />
          );
        })}
      </div>

      {visibleError ? (
        <div className="mt-3 flex min-w-0 items-start gap-2 rounded-lg bg-destructive/[0.06] px-3 py-2 text-[11px] leading-5 text-destructive shadow-[inset_0_0_0_1px_hsl(var(--destructive)/0.18)] [overflow-wrap:anywhere]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{visibleError}</span>
        </div>
      ) : null}
    </section>
  );
}

const RuntimeEntryRow = memo(function RuntimeEntryRow({
  entry,
  isBusy,
  progress,
  disabled,
  onInstall,
}: {
  entry: ManagedRuntimeDoctorEntry;
  isBusy: boolean;
  progress: DownloadProgress | undefined;
  disabled: boolean;
  onInstall: (entry: ManagedRuntimeDoctorEntry) => void;
}) {
  const percent = progressPercent(progress);
  const actionLabel = entry.status === 'ready' ? 'Repair' : 'Install';
  const progressLabel = progress?.receivedBytes
    ? 'Downloading runtime archive'
    : `Preparing runtime ${actionLabel.toLowerCase()}`;

  return (
    <div className="min-w-0 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <span className="flex min-w-0 flex-1 items-start gap-2">
          <span
            className={cn(
              'mt-1 h-2 w-2 shrink-0 rounded-full',
              statusDotClasses[entry.status] ?? 'bg-muted-foreground/50'
            )}
          />
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 break-words text-[12px] font-semibold text-foreground [overflow-wrap:anywhere]">
              {entry.label}
            </span>
            <span className="min-w-0 break-words font-mono text-[11px] tabular-nums text-muted-foreground [overflow-wrap:anywhere]">
              {entry.pinnedVersion}
            </span>
          </span>
        </span>
        {entry.downloadable ? (
          <Button
            variant="outline"
            size="sm"
            className="h-10 w-fit shrink-0 rounded-lg px-3 text-[11px]"
            disabled={disabled}
            onClick={() => onInstall(entry)}
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {actionLabel}
          </Button>
        ) : null}
      </div>
      {isBusy ? (
        <div className="mt-2 min-w-0 space-y-1.5">
          <span className="sr-only" aria-live="polite">
            {progressLabel}
          </span>
          <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{progressLabel}</span>
            <span className="shrink-0">
              {progress?.receivedBytes ? (
                <>
                  {formatMegabytes(progress.receivedBytes)}
                  {progress.totalBytes ? ` / ${formatMegabytes(progress.totalBytes)}` : ''} MB
                </>
              ) : (
                'Starting...'
              )}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`${entry.label} ${actionLabel.toLowerCase()} progress`}
            aria-valuemin={0}
            aria-valuemax={percent === null ? undefined : 100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={percent === null ? 'In progress' : `${percent}%`}
            className="h-1.5 overflow-hidden rounded-full bg-background shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.5)]"
          >
            <div
              className={cn(
                'h-full rounded-full bg-foreground/75 transition-[width] duration-300',
                percent === null && 'w-1/3 animate-pulse'
              )}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="mt-1.5 min-w-0 break-words text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
          {entry.detail}
        </p>
      )}
    </div>
  );
});

export default RuntimeHealthCard;
