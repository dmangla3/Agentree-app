import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowUpCircle, Download, Loader2, RefreshCw } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Button } from '../../../@/components/ui/button';
import { useToast } from '../Toast';
import { cn } from '../../lib/utils';

interface UpdateContextValue {
  checking: boolean;
  installing: boolean;
  availableVersion: string | null;
  currentVersion: string | null;
  checkForUpdates: (options?: { silent?: boolean }) => Promise<void>;
  installUpdate: () => Promise<void>;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);
const BACKGROUND_UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;
const RESUME_UPDATE_CHECK_MIN_INTERVAL_MS = 15 * 60 * 1000;
const UPDATE_CHECK_STATE_STORAGE_KEY = 'agentree.updater.last-check.v1';
const updatesEnabled = () => import.meta.env.VITE_AGENTREE_OFFICIAL_CLOUD === 'true';

type UpdateCheckOutcome = 'available' | 'current' | 'failed';

interface PersistedUpdateCheckState {
  attemptedAt: string;
  outcome: UpdateCheckOutcome;
  currentVersion?: string;
  availableVersion?: string;
  error?: string;
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;

const persistUpdateCheckState = (state: PersistedUpdateCheckState) => {
  try {
    window.localStorage.setItem(UPDATE_CHECK_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Update checks must continue even when storage is unavailable.
  }
};

export function UpdateManager({ children }: { children: ReactNode }) {
  const { addToast, removeToast } = useToast();
  const updateRef = useRef<Update | null>(null);
  const availableToastIdRef = useRef<string | null>(null);
  const checkInFlightRef = useRef(false);
  const installInFlightRef = useRef(false);
  const lastCheckAttemptAtRef = useRef(0);
  const lastCheckFailedRef = useRef(false);
  const currentVersionRef = useRef<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  const clearAvailableToast = useCallback(() => {
    if (!availableToastIdRef.current) return;
    removeToast(availableToastIdRef.current);
    availableToastIdRef.current = null;
  }, [removeToast]);

  const installUpdate = useCallback(async () => {
    if (!updateRef.current || installInFlightRef.current) return;

    installInFlightRef.current = true;
    setInstalling(true);
    try {
      let downloadedBytes = 0;
      await updateRef.current.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength;
        }
        if (event.event === 'Finished') {
          addToast({
            title: 'Update ready',
            description: `Downloaded ${Math.round(downloadedBytes / 1024)} KB. Relaunching now.`,
            variant: 'success',
            duration: 3500,
          });
        }
      });

      clearAvailableToast();
      setAvailableVersion(null);
      await relaunch();
    } catch (error) {
      console.error('[Updater] Update installation failed', error);
      addToast({
        title: 'Update install failed',
        description: errorMessage(error, 'Failed to download and install the update.'),
        variant: 'error',
        duration: 8000,
      });
    } finally {
      installInFlightRef.current = false;
      setInstalling(false);
    }
  }, [addToast, clearAvailableToast]);

  const notifyUpdateAvailable = useCallback(
    (update: Update) => {
      clearAvailableToast();
      availableToastIdRef.current = addToast({
        title: `Version ${update.version} is available`,
        description: update.body || `You are on ${update.currentVersion}. Install the update to restart into ${update.version}.`,
        variant: 'info',
        persistent: true,
        action: {
          component: (
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                className="h-10 rounded-lg transition-transform duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none dark:bg-white dark:text-black dark:hover:bg-white/90"
                onClick={() => {
                  void installUpdate();
                }}
              >
                <Download className="h-3.5 w-3.5" />
                Install
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-10 rounded-lg transition-transform duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none"
                onClick={() => {
                  clearAvailableToast();
                }}
              >
                Later
              </Button>
            </div>
          ),
        },
      });
    },
    [addToast, clearAvailableToast, installUpdate]
  );

  const checkForUpdates = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (checkInFlightRef.current || installInFlightRef.current || import.meta.env.DEV || !updatesEnabled()) return;

      checkInFlightRef.current = true;
      lastCheckAttemptAtRef.current = Date.now();
      setChecking(true);
      try {
        let resolvedCurrentVersion = currentVersionRef.current;
        if (!resolvedCurrentVersion) {
          try {
            resolvedCurrentVersion = await getVersion();
            currentVersionRef.current = resolvedCurrentVersion;
            setCurrentVersion(resolvedCurrentVersion);
          } catch (error) {
            console.warn('[Updater] Failed to read the current app version', error);
          }
        }

        const update = await check();
        if (!update) {
          lastCheckFailedRef.current = false;
          persistUpdateCheckState({
            attemptedAt: new Date(lastCheckAttemptAtRef.current).toISOString(),
            outcome: 'current',
            ...(resolvedCurrentVersion ? { currentVersion: resolvedCurrentVersion } : {}),
          });
          console.info('[Updater] Update check completed; build is current', { currentVersion: resolvedCurrentVersion });
          if (!silent) {
            addToast({
              title: 'No updates found',
              description: resolvedCurrentVersion
                ? `You are already on version ${resolvedCurrentVersion}.`
                : 'This build is already current.',
              variant: 'success',
            });
          }
          clearAvailableToast();
          updateRef.current = null;
          setAvailableVersion(null);
          return;
        }

        updateRef.current = update;
        currentVersionRef.current = update.currentVersion;
        lastCheckFailedRef.current = false;
        setCurrentVersion(update.currentVersion);
        setAvailableVersion(update.version);
        persistUpdateCheckState({
          attemptedAt: new Date(lastCheckAttemptAtRef.current).toISOString(),
          outcome: 'available',
          currentVersion: update.currentVersion,
          availableVersion: update.version,
        });
        console.info('[Updater] Update available', {
          currentVersion: update.currentVersion,
          availableVersion: update.version,
        });
        notifyUpdateAvailable(update);
      } catch (error) {
        const message = errorMessage(error, 'Failed to check for updates.');
        lastCheckFailedRef.current = true;
        persistUpdateCheckState({
          attemptedAt: new Date(lastCheckAttemptAtRef.current).toISOString(),
          outcome: 'failed',
          ...(currentVersionRef.current ? { currentVersion: currentVersionRef.current } : {}),
          error: message.slice(0, 1000),
        });
        console.warn('[Updater] Update check failed', error);
        if (!silent) {
          addToast({
            title: 'Update check failed',
            description: message,
            variant: 'error',
            duration: 8000,
          });
        }
      } finally {
        checkInFlightRef.current = false;
        setChecking(false);
      }
    },
    [addToast, clearAvailableToast, notifyUpdateAvailable]
  );

  useEffect(() => {
    if (import.meta.env.DEV || !updatesEnabled()) return;
    void checkForUpdates({ silent: true });
  }, [checkForUpdates]);

  useEffect(() => {
    if (import.meta.env.DEV || !updatesEnabled()) return;

    const intervalId = window.setInterval(() => {
      void checkForUpdates({ silent: true });
    }, BACKGROUND_UPDATE_CHECK_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [checkForUpdates]);

  useEffect(() => {
    if (import.meta.env.DEV || !updatesEnabled()) return;

    const checkAfterResume = (forceAfterFailure = false) => {
      const elapsed = Date.now() - lastCheckAttemptAtRef.current;
      if ((!forceAfterFailure || !lastCheckFailedRef.current) && elapsed < RESUME_UPDATE_CHECK_MIN_INTERVAL_MS) return;
      void checkForUpdates({ silent: true });
    };
    const handleFocus = () => checkAfterResume();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkAfterResume();
    };
    const handleOnline = () => checkAfterResume(true);

    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkForUpdates]);

  const value = useMemo<UpdateContextValue>(
    () => ({
      checking,
      installing,
      availableVersion,
      currentVersion,
      checkForUpdates,
      installUpdate,
    }),
    [availableVersion, checkForUpdates, checking, currentVersion, installUpdate, installing]
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdateManager() {
  const context = useContext(UpdateContext);
  if (!context) {
    throw new Error('useUpdateManager must be used within an UpdateManager');
  }
  return context;
}

export function UpdateToolbarButton() {
  const { checking, installing, availableVersion, checkForUpdates, installUpdate } = useUpdateManager();

  if (import.meta.env.DEV || !updatesEnabled()) return null;

  const label = availableVersion ? `Update ${availableVersion}` : 'Updates';

  return (
    <Button
      variant={availableVersion ? 'default' : 'outline'}
      size="icon"
      onClick={() => {
        if (availableVersion) {
          void installUpdate();
          return;
        }
        void checkForUpdates();
      }}
      disabled={checking || installing}
      className={cn(
        'h-10 w-10 rounded-lg p-0 transition-transform duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none',
        availableVersion && 'shadow-[0_12px_30px_-18px_hsl(var(--foreground)/0.35)] dark:bg-white dark:text-black dark:shadow-none dark:hover:bg-white/90'
      )}
      aria-label={availableVersion ? `Install version ${availableVersion}` : 'Check for updates'}
      title={availableVersion ? `Install version ${availableVersion}` : 'Check for updates'}
    >
      {checking || installing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
      ) : availableVersion ? (
        <ArrowUpCircle className="h-3.5 w-3.5" />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">{label}</span>
    </Button>
  );
}
