import { useCallback, useEffect, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Download, HeartPulse, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../../../@/components/ui/button';
import { agentClient } from '../../lib/agentClient';
import type { ManagedRuntimeDoctorEntry } from '../../generated/tauri-bindings';
import { cn } from '../../lib/utils';

type DownloadProgress = {
  component: string;
  receivedBytes: number;
  totalBytes: number | null;
};

const statusDotClasses: Record<string, string> = {
  ready: 'bg-emerald-500',
  missing: 'bg-amber-500',
  unpublished: 'bg-muted-foreground/50',
};

const formatMegabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

const hasTauriRuntime = () =>
  typeof window !== 'undefined' &&
  Boolean(
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
      (window as unknown as Record<string, unknown>).__TAURI__
  );

export function RuntimeHealthCard() {
  const [entries, setEntries] = useState<ManagedRuntimeDoctorEntry[]>([]);
  const [busyComponent, setBusyComponent] = useState<string | null>(null);
  const [progressByComponent, setProgressByComponent] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setEntries(await agentClient.checkManagedRuntimeDoctor());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<DownloadProgress>('managed-runtime:download', (event) => {
      setProgressByComponent((current) => ({
        ...current,
        [event.payload.component]: event.payload,
      }));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const installComponent = async (component: string) => {
    setBusyComponent(component);
    setError(null);
    try {
      const entry = await agentClient.repairManagedRuntimeComponent(component);
      setEntries((current) =>
        current.map((existing) => (existing.component === component ? entry : existing))
      );
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setBusyComponent(null);
      setProgressByComponent((current) => {
        const next = { ...current };
        delete next[component];
        return next;
      });
    }
  };

  // Hide only when there is genuinely nothing to show (e.g. browser preview);
  // a failed doctor check must surface its error, not blank the card.
  if (entries.length === 0 && !error) return null;

  return (
    <section className="rounded-xl bg-background/82 p-4 shadow-[0_18px_52px_-44px_rgba(15,23,42,0.65),inset_0_0_0_1px_hsl(var(--app-border)/0.72)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <HeartPulse className="h-4 w-4 text-[hsl(var(--app-accent))]" />
          Runtime health
        </div>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => void refresh()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
        Pinned provider toolchains managed by Agentree. Missing components download automatically on
        first use.
      </p>

      <div className="mt-3 space-y-2">
        {entries.map((entry) => {
          const progress = progressByComponent[entry.component];
          const isBusy = busyComponent === entry.component;
          return (
            <div key={entry.component} className="rounded-lg bg-muted/38 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      statusDotClasses[entry.status] ?? 'bg-muted-foreground/50'
                    )}
                  />
                  <span className="truncate text-[12px] font-semibold text-foreground">
                    {entry.label}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {entry.pinnedVersion}
                  </span>
                </span>
                {entry.downloadable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={isBusy}
                    onClick={() => void installComponent(entry.component)}
                  >
                    {isBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {entry.status === 'ready' ? 'Repair' : 'Install'}
                  </Button>
                ) : null}
              </div>
              {isBusy && progress ? (
                <div className="mt-1.5 text-[11px] tabular-nums text-muted-foreground">
                  Downloading… {formatMegabytes(progress.receivedBytes)}
                  {progress.totalBytes ? ` / ${formatMegabytes(progress.totalBytes)}` : ''} MB
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{entry.detail}</p>
              )}
            </div>
          );
        })}
      </div>

      {error ? (
        <div className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:bg-red-950/35 dark:text-red-300">
          {error}
        </div>
      ) : null}
    </section>
  );
}

export default RuntimeHealthCard;
