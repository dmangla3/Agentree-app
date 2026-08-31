import { useSyncExternalStore } from 'react';
import type { UserFlowSource } from './types';

export const USER_FLOW_STORE_KEY = 'agentree.user-flow-sources.v1';
const USER_FLOW_STORE_EVENT = 'agentree:user-flow-sources-changed';
let cachedSnapshotKey = '';
let cachedSnapshotSources: UserFlowSource[] = [];

export interface UserFlowStoreSnapshot {
  sources: UserFlowSource[];
}

export type UserFlowStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface CreateUserFlowSourceInput {
  id: string;
  label: string;
  source: string;
  scope?: UserFlowSource['scope'];
  workspaceId?: string | null;
  enabled?: boolean;
  now?: string;
}

export interface UpdateUserFlowSourceInput {
  id: string;
  source?: string;
  label?: string;
  scope?: UserFlowSource['scope'];
  workspaceId?: string | null;
  enabled?: boolean;
  now?: string;
}

export function normalizeUserFlowSources(input: unknown): UserFlowSource[] {
  const values = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.sources) ? input.sources : [];
  const byKey = new Map<string, UserFlowSource>();

  for (const value of values) {
    const source = normalizeUserFlowSource(value);
    if (!source) continue;
    const key = userFlowStorageKey(source);
    const existing = byKey.get(key);
    if (!existing || source.version > existing.version || source.updatedAt > existing.updatedAt) {
      byKey.set(key, source);
    }
  }

  return [...byKey.values()].sort(compareUserFlowSources);
}

export function listUserFlowSources(input?: { workspaceId?: string | null; includeGlobal?: boolean; storage?: UserFlowStorage | null }): UserFlowSource[] {
  const sources = readUserFlowSources(input?.storage);
  const workspaceId = input?.workspaceId ?? null;
  const includeGlobal = input?.includeGlobal ?? true;
  return sources.filter((source) => (
    (includeGlobal && source.scope === 'global') ||
    (source.scope === 'workspace' && source.workspaceId === workspaceId)
  ));
}

export function listEnabledUserFlowSources(input?: { workspaceId?: string | null; includeGlobal?: boolean; storage?: UserFlowStorage | null }): UserFlowSource[] {
  return listUserFlowSources(input).filter((source) => source.enabled);
}

export function createUserFlowSource(input: CreateUserFlowSourceInput, storage?: UserFlowStorage | null): UserFlowSource {
  const now = input.now ?? new Date().toISOString();
  const source: UserFlowSource = {
    id: input.id.trim(),
    label: input.label.trim() || input.id.trim(),
    scope: input.scope ?? 'workspace',
    source: input.source,
    version: 1,
    enabled: input.enabled ?? true,
    workspaceId: input.workspaceId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  if (!normalizeUserFlowSource(source)) {
    throw new Error('User flow source is invalid.');
  }
  writeUserFlowSources(upsertUserFlowSource(readUserFlowSources(storage), source), storage);
  return source;
}

export function saveUserFlowSource(source: UserFlowSource, storage?: UserFlowStorage | null): UserFlowSource {
  const normalized = normalizeUserFlowSource(source);
  if (!normalized) {
    throw new Error('User flow source is invalid.');
  }
  writeUserFlowSources(upsertUserFlowSource(readUserFlowSources(storage), normalized), storage);
  return normalized;
}

export function updateUserFlowSource(input: UpdateUserFlowSourceInput, storage?: UserFlowStorage | null): UserFlowSource {
  const sources = readUserFlowSources(storage);
  const existing = sources.find((source) => source.id === input.id);
  if (!existing) {
    throw new Error(`User flow source "${input.id}" does not exist.`);
  }
  const now = input.now ?? new Date().toISOString();
  const next: UserFlowSource = {
    ...existing,
    ...(input.label !== undefined ? { label: input.label.trim() || existing.label } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    version: input.source !== undefined ? existing.version + 1 : existing.version,
    updatedAt: now,
  };
  writeUserFlowSources(upsertUserFlowSource(sources, next), storage);
  return next;
}

export function setUserFlowSourceEnabled(id: string, enabled: boolean, storage?: UserFlowStorage | null): UserFlowSource {
  return updateUserFlowSource({ id, enabled }, storage);
}

export function archiveUserFlowSource(id: string, storage?: UserFlowStorage | null): UserFlowSource {
  return setUserFlowSourceEnabled(id, false, storage);
}

export function deleteUserFlowSource(id: string, storage?: UserFlowStorage | null): void {
  writeUserFlowSources(readUserFlowSources(storage).filter((source) => source.id !== id), storage);
}

export function readUserFlowSources(storage?: UserFlowStorage | null): UserFlowSource[] {
  const backingStore = storage === undefined ? getBrowserStorage() : storage;
  if (!backingStore) return [];
  const raw = backingStore.getItem(USER_FLOW_STORE_KEY);
  if (!raw) return [];
  try {
    return normalizeUserFlowSources(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeUserFlowSources(sources: UserFlowSource[], storage?: UserFlowStorage | null): void {
  const backingStore = storage === undefined ? getBrowserStorage() : storage;
  if (!backingStore) return;
  const normalized = normalizeUserFlowSources(sources);
  if (normalized.length === 0) {
    backingStore.removeItem(USER_FLOW_STORE_KEY);
  } else {
    backingStore.setItem(USER_FLOW_STORE_KEY, JSON.stringify({ sources: normalized }));
  }
  emitUserFlowSourcesChanged();
}

export function subscribeUserFlowSources(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === USER_FLOW_STORE_KEY) listener();
  };
  window.addEventListener(USER_FLOW_STORE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(USER_FLOW_STORE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useUserFlowSources(workspaceId?: string | null): UserFlowSource[] {
  return useSyncExternalStore(
    subscribeUserFlowSources,
    () => getCachedUserFlowSources(workspaceId),
    () => []
  );
}

function getCachedUserFlowSources(workspaceId?: string | null): UserFlowSource[] {
  const storage = getBrowserStorage();
  const raw = storage?.getItem(USER_FLOW_STORE_KEY) ?? '';
  const key = `${workspaceId ?? ''}:${raw}`;
  if (key === cachedSnapshotKey) {
    return cachedSnapshotSources;
  }
  cachedSnapshotKey = key;
  cachedSnapshotSources = listUserFlowSources({ workspaceId, storage });
  return cachedSnapshotSources;
}

function normalizeUserFlowSource(input: unknown): UserFlowSource | null {
  if (!isRecord(input)) return null;
  if (!isNonEmptyString(input.id) || !isNonEmptyString(input.label) || !isNonEmptyString(input.source)) return null;
  if (input.scope !== 'workspace' && input.scope !== 'global') return null;
  if (!Number.isInteger(input.version) || Number(input.version) < 1) return null;
  if (typeof input.enabled !== 'boolean') return null;
  if (!isNonEmptyString(input.createdAt) || !isNonEmptyString(input.updatedAt)) return null;
  if (input.workspaceId !== undefined && input.workspaceId !== null && typeof input.workspaceId !== 'string') return null;

  return {
    id: input.id.trim(),
    label: input.label.trim(),
    scope: input.scope,
    source: input.source,
    version: Number(input.version),
    enabled: input.enabled,
    workspaceId: input.workspaceId ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function upsertUserFlowSource(sources: UserFlowSource[], source: UserFlowSource): UserFlowSource[] {
  return normalizeUserFlowSources([...sources.filter((candidate) => candidate.id !== source.id), source]);
}

function compareUserFlowSources(left: UserFlowSource, right: UserFlowSource): number {
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  const labelCompare = left.label.localeCompare(right.label);
  if (labelCompare !== 0) return labelCompare;
  return left.id.localeCompare(right.id);
}

function userFlowStorageKey(source: UserFlowSource): string {
  return `${source.scope}:${source.workspaceId ?? ''}:${source.id}`;
}

function emitUserFlowSourcesChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(USER_FLOW_STORE_EVENT));
}

function getBrowserStorage(): UserFlowStorage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
