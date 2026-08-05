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

export function UpdateManager({ children }: { children: ReactNode }) {
  const { addToast, removeToast } = useToast();
  const updateRef = useRef<Update | null>(null);
  const availableToastIdRef = useRef<string | null>(null);
  const autoCheckStartedRef = useRef(false);
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
    if (!updateRef.current || installing) return;

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
      addToast({
        title: 'Update install failed',
        description: error instanceof Error ? error.message : 'Failed to download and install the update.',
        variant: 'error',
        duration: 8000,
      });
    } finally {
      setInstalling(false);
    }
  }, [addToast, clearAvailableToast, installing]);

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
                className="h-8 rounded-lg"
                onClick={() => {
                  void installUpdate();
                }}
                disabled={installing}
              >
                {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Install
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 rounded-lg"
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
    [addToast, clearAvailableToast, installUpdate, installing]
  );

  const checkForUpdates = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (checking || installing || import.meta.env.DEV) return;

      setChecking(true);
      try {
        const update = await check();
        if (!update) {
          if (!silent) {
            addToast({
              title: 'No updates found',
              description: currentVersion ? `You are already on version ${currentVersion}.` : 'This build is already current.',
              variant: 'success',
            });
          }
          clearAvailableToast();
          updateRef.current = null;
          setAvailableVersion(null);
          return;
        }

        updateRef.current = update;
        setCurrentVersion(update.currentVersion);
        setAvailableVersion(update.version);
        notifyUpdateAvailable(update);
      } catch (error) {
        if (!silent) {
          addToast({
            title: 'Update check failed',
            description: error instanceof Error ? error.message : 'Failed to check for updates.',
            variant: 'error',
            duration: 8000,
          });
        }
      } finally {
        setChecking(false);
      }
    },
    [addToast, checking, clearAvailableToast, currentVersion, installing, notifyUpdateAvailable]
  );

  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (autoCheckStartedRef.current) return;
    autoCheckStartedRef.current = true;
    void checkForUpdates({ silent: true });
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

  if (import.meta.env.DEV) return null;

  const label = availableVersion ? `Update ${availableVersion}` : 'Updates';

  return (
    <Button
      variant={availableVersion ? 'default' : 'outline'}
      size="sm"
      onClick={() => {
        if (availableVersion) {
          void installUpdate();
          return;
        }
        void checkForUpdates();
      }}
      disabled={checking || installing}
      className={cn(
        'flex items-center gap-2 h-8 rounded-lg',
        availableVersion && 'shadow-[0_12px_30px_-18px_rgba(37,99,235,0.55)]'
      )}
      title={availableVersion ? `Install version ${availableVersion}` : 'Check for updates'}
    >
      {checking || installing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : availableVersion ? (
        <ArrowUpCircle className="h-3.5 w-3.5" />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline text-xs">{label}</span>
    </Button>
  );
}
