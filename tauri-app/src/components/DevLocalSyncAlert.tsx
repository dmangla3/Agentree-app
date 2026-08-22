import React from 'react';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../../@/components/ui/alert';
import { Button } from '../../@/components/ui/button';
import {
    clearLocalSyncPause,
    getLocalSyncPauseState,
    reportLocalSyncFailure,
    subscribeToLocalSyncPause,
    type LocalSyncPauseState,
} from '../lib/localSyncDiagnostics';
import { API_URL } from '../lib/api';

const readReadiness = async (signal?: AbortSignal) => {
    const response = await fetch(`${API_URL}/readyz`, {
        cache: 'no-store',
        signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status === 'not_ready') {
        reportLocalSyncFailure(new Error(`Server readiness check failed with status ${response.status}`), {
            readiness: body,
        });
    }
};

export function DevLocalSyncAlert() {
    const [state, setState] = React.useState<LocalSyncPauseState>(() => getLocalSyncPauseState());

    React.useEffect(() => {
        if (!import.meta.env.DEV) return;
        return subscribeToLocalSyncPause(setState);
    }, []);

    React.useEffect(() => {
        if (!import.meta.env.DEV) return;
        const controller = new AbortController();
        readReadiness(controller.signal).catch((error) => {
            if (!controller.signal.aborted) {
                reportLocalSyncFailure(error);
            }
        });
        return () => controller.abort();
    }, []);

    const handleRetry = React.useCallback(() => {
        clearLocalSyncPause();
        readReadiness().catch((error) => reportLocalSyncFailure(error));
    }, []);

    if (!import.meta.env.DEV || !state.paused) {
        return null;
    }

    return (
        <div className="fixed left-1/2 top-3 z-[120] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2">
            <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-950 shadow-lg backdrop-blur dark:text-amber-100">
                <AlertCircle className="text-amber-500" />
                <AlertTitle>Dev local sync paused</AlertTitle>
                <AlertDescription>
                    <div className="space-y-2">
                        <p>{state.message}</p>
                        <p className="text-xs">
                            Server: <span className="font-mono">{state.serverUrl}</span>
                            {state.reason ? <> · Reason: <span className="font-mono">{state.reason}</span></> : null}
                            {state.failureCount ? <> · Failures: {state.failureCount}</> : null}
                        </p>
                        {state.detail ? (
                            <p className="max-h-20 overflow-auto rounded border border-amber-500/20 bg-background/60 p-2 font-mono text-[11px]">
                                {state.detail}
                            </p>
                        ) : null}
                        <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={handleRetry}>
                                Retry sync
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => window.open(`${API_URL}/readyz`, '_blank')}
                            >
                                Open readiness
                            </Button>
                        </div>
                    </div>
                </AlertDescription>
            </Alert>
        </div>
    );
}
