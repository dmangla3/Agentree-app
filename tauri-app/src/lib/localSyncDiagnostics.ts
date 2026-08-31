import { API_URL } from './api';

export type LocalSyncPauseReason =
    | 'server_schema_not_ready'
    | 'server_unavailable'
    | 'server_timeout'
    | 'server_error'
    | 'unknown';

export type LocalSyncPauseState = {
    paused: boolean;
    reason: LocalSyncPauseReason | null;
    message: string | null;
    detail: string | null;
    failureCount: number;
    pausedAt: string | null;
    serverUrl: string;
};

type ReadinessPayload = {
    status?: string;
    database?: { ok?: boolean; error?: string };
    missingMigrations?: string[];
    missingTables?: string[];
    missingColumns?: string[];
};

const initialState = (): LocalSyncPauseState => ({
    paused: false,
    reason: null,
    message: null,
    detail: null,
    failureCount: 0,
    pausedAt: null,
    serverUrl: API_URL,
});

let pauseState = initialState();
const listeners = new Set<(state: LocalSyncPauseState) => void>();

const emit = () => {
    const snapshot = getLocalSyncPauseState();
    for (const listener of listeners) {
        listener(snapshot);
    }
};

const stringifyError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return 'Unknown local sync failure';
    }
};

const detailFromReadiness = (readiness?: ReadinessPayload | null): string | null => {
    if (!readiness) return null;
    const parts = [
        readiness.database?.error ? `database: ${readiness.database.error}` : null,
        readiness.missingMigrations?.length ? `missing migrations: ${readiness.missingMigrations.join(', ')}` : null,
        readiness.missingTables?.length ? `missing tables: ${readiness.missingTables.join(', ')}` : null,
        readiness.missingColumns?.length ? `missing columns: ${readiness.missingColumns.join(', ')}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' | ') : null;
};

const classifyFailure = (errorText: string, readiness?: ReadinessPayload | null): LocalSyncPauseReason => {
    const readinessError = readiness?.database?.error ?? '';
    const normalized = `${errorText} ${readinessError}`.toLowerCase();
    if (normalized.includes('timed out') || normalized.includes('timeout') || normalized.includes('operation timed out')) {
        return 'server_timeout';
    }
    if (
        readiness?.status === 'not_ready' ||
        (readiness?.missingMigrations?.length ?? 0) > 0 ||
        (readiness?.missingTables?.length ?? 0) > 0 ||
        (readiness?.missingColumns?.length ?? 0) > 0 ||
        normalized.includes('column "thread_id" does not exist') ||
        /relation\s+\\?"/.test(normalized) && normalized.includes('does not exist') ||
        normalized.includes('schema') ||
        normalized.includes('migration')
    ) {
        return 'server_schema_not_ready';
    }
    if (
        normalized.includes('failed to fetch') ||
        normalized.includes('networkerror') ||
        normalized.includes('econnrefused') ||
        normalized.includes('connection refused')
    ) {
        return 'server_unavailable';
    }
    if (normalized.includes('500') || normalized.includes('internal server error') || normalized.includes('503')) {
        return 'server_error';
    }
    return 'unknown';
};

const messageForReason = (reason: LocalSyncPauseReason): string => {
    switch (reason) {
        case 'server_schema_not_ready':
            return 'Local sync is paused because the backend database schema is not ready. Run the dev migrations, restart the server, then retry sync.';
        case 'server_unavailable':
            return 'Local sync is paused because the backend server is unavailable.';
        case 'server_timeout':
            return 'Local sync is paused because backend requests are timing out.';
        case 'server_error':
            return 'Local sync is paused because the backend is returning server errors.';
        default:
            return 'Local sync is paused because the backend returned an unexpected failure.';
    }
};

const isRetryablePauseReason = (reason: LocalSyncPauseReason) => (
    reason === 'server_timeout' ||
    reason === 'server_unavailable' ||
    reason === 'server_error'
);

export const getLocalSyncPauseState = (): LocalSyncPauseState => ({ ...pauseState });

export const subscribeToLocalSyncPause = (listener: (state: LocalSyncPauseState) => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const shouldSkipLocalSync = () => pauseState.paused;

export const reportLocalSyncFailure = (
    error: unknown,
    metadata: { readiness?: ReadinessPayload | null } = {}
) => {
    const errorText = stringifyError(error);
    const readinessDetail = detailFromReadiness(metadata.readiness);
    const reason = classifyFailure(errorText, metadata.readiness);
    const failureCount = pauseState.failureCount + 1;
    const shouldPause = pauseState.paused ||
        Boolean(metadata.readiness) ||
        !isRetryablePauseReason(reason) ||
        failureCount > 1;
    pauseState = {
        paused: shouldPause,
        reason,
        message: shouldPause ? messageForReason(reason) : null,
        detail: readinessDetail || errorText,
        failureCount,
        pausedAt: shouldPause ? new Date().toISOString() : null,
        serverUrl: API_URL,
    };
    emit();
};

export const reportLocalSyncSuccess = () => {
    if (pauseState.paused) return;
    if (pauseState.failureCount === 0) return;
    pauseState = initialState();
    emit();
};

export const clearLocalSyncPause = () => {
    pauseState = initialState();
    emit();
};
