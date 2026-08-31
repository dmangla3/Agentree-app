import { useSyncExternalStore } from 'react';
import { parseFlowParamTypes } from './flowParamTypes';
import { FLOW_NODE_REGISTRY, type FlowNodeDefinition, type FlowNodeRegistry } from './flowNodeRegistry';

export const USER_FLOW_NODE_REGISTRY_STORE_KEY = 'agentree.user-flow-node-registry.v1';
const USER_FLOW_NODE_REGISTRY_EVENT = 'agentree:user-flow-node-registry-changed';
let cachedSnapshotKey = '';
let cachedSnapshotDefinitions: UserFlowNodeDefinition[] = [];

export interface UserFlowNodeDefinition extends FlowNodeDefinition {
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type UserFlowNodeRegistryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SaveUserFlowNodeDefinitionsInput {
  definitions: FlowNodeDefinition[];
  now?: string;
}

export function normalizeFlowNodeDefinition(input: unknown): FlowNodeDefinition | null {
  if (!isRecord(input)) return null;
  if (!isNonEmptyString(input.id) || !isNonEmptyString(input.label)) return null;
  if (!isNonEmptyString(input.parent) || !isNonEmptyString(input.prompt)) return null;
  const params = normalizeParams(input.params);
  if (!params) return null;
  if (input.requiresFinalizedCommit !== undefined && typeof input.requiresFinalizedCommit !== 'boolean') return null;
  const returns = normalizeReturns(input.returns);
  if (input.returns !== undefined && !returns) return null;

  return {
    id: input.id.trim(),
    label: input.label.trim(),
    params,
    parent: input.parent.trim(),
    ...(returns ? { returns } : {}),
    prompt: input.prompt,
    ...(typeof input.requiresFinalizedCommit === 'boolean' ? { requiresFinalizedCommit: input.requiresFinalizedCommit } : {}),
  };
}

export function normalizeUserFlowNodeDefinitions(input: unknown): UserFlowNodeDefinition[] {
  const values = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.definitions) ? input.definitions : [];
  const byId = new Map<string, UserFlowNodeDefinition>();

  for (const value of values) {
    const definition = normalizeUserFlowNodeDefinition(value);
    if (!definition) continue;
    const existing = byId.get(definition.id);
    if (!existing || definition.version > existing.version || definition.updatedAt > existing.updatedAt) {
      byId.set(definition.id, definition);
    }
  }

  return [...byId.values()].sort(compareUserFlowNodeDefinitions);
}

export function readUserFlowNodeDefinitions(storage?: UserFlowNodeRegistryStorage | null): UserFlowNodeDefinition[] {
  const backingStore = storage === undefined ? getBrowserStorage() : storage;
  if (!backingStore) return [];
  const raw = backingStore.getItem(USER_FLOW_NODE_REGISTRY_STORE_KEY);
  if (!raw) return [];
  try {
    return normalizeUserFlowNodeDefinitions(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeUserFlowNodeDefinitions(
  definitions: UserFlowNodeDefinition[],
  storage?: UserFlowNodeRegistryStorage | null
): void {
  const backingStore = storage === undefined ? getBrowserStorage() : storage;
  if (!backingStore) return;
  const normalized = normalizeUserFlowNodeDefinitions(definitions);
  if (normalized.length === 0) {
    backingStore.removeItem(USER_FLOW_NODE_REGISTRY_STORE_KEY);
  } else {
    backingStore.setItem(USER_FLOW_NODE_REGISTRY_STORE_KEY, JSON.stringify({ definitions: normalized }));
  }
  emitUserFlowNodeRegistryChanged();
}

export function saveUserFlowNodeDefinitions(
  input: SaveUserFlowNodeDefinitionsInput,
  storage?: UserFlowNodeRegistryStorage | null
): UserFlowNodeDefinition[] {
  const now = input.now ?? new Date().toISOString();
  const existing = readUserFlowNodeDefinitions(storage);
  const byId = new Map(existing.map((definition) => [definition.id, definition]));
  const saved: UserFlowNodeDefinition[] = [];

  for (const rawDefinition of input.definitions) {
    const definition = normalizeFlowNodeDefinition(rawDefinition);
    if (!definition) {
      throw new Error('User flow node definition is invalid.');
    }
    if (FLOW_NODE_REGISTRY[definition.id]) {
      throw new Error(`Reusable node "${definition.id}" is already built in.`);
    }
    const previous = byId.get(definition.id);
    const next: UserFlowNodeDefinition = {
      ...definition,
      version: previous ? previous.version + 1 : 1,
      enabled: true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    byId.set(next.id, next);
    saved.push(next);
  }

  writeUserFlowNodeDefinitions([...byId.values()], storage);
  return saved;
}

export function buildUserFlowNodeRegistry(
  definitions: UserFlowNodeDefinition[],
  baseRegistry: FlowNodeRegistry = FLOW_NODE_REGISTRY
): FlowNodeRegistry {
  const registry: FlowNodeRegistry = { ...baseRegistry };
  for (const definition of definitions) {
    if (!definition.enabled || baseRegistry[definition.id]) continue;
    registry[definition.id] = {
      id: definition.id,
      label: definition.label,
      params: definition.params,
      parent: definition.parent,
      ...(definition.returns ? { returns: definition.returns } : {}),
      prompt: definition.prompt,
      ...(typeof definition.requiresFinalizedCommit === 'boolean'
        ? { requiresFinalizedCommit: definition.requiresFinalizedCommit }
        : {}),
    };
  }
  return registry;
}

export function subscribeUserFlowNodeRegistry(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === USER_FLOW_NODE_REGISTRY_STORE_KEY) listener();
  };
  window.addEventListener(USER_FLOW_NODE_REGISTRY_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(USER_FLOW_NODE_REGISTRY_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useUserFlowNodeDefinitions(): UserFlowNodeDefinition[] {
  return useSyncExternalStore(
    subscribeUserFlowNodeRegistry,
    getCachedUserFlowNodeDefinitions,
    () => []
  );
}

function getCachedUserFlowNodeDefinitions(): UserFlowNodeDefinition[] {
  const storage = getBrowserStorage();
  const raw = storage?.getItem(USER_FLOW_NODE_REGISTRY_STORE_KEY) ?? '';
  if (raw === cachedSnapshotKey) {
    return cachedSnapshotDefinitions;
  }
  cachedSnapshotKey = raw;
  cachedSnapshotDefinitions = readUserFlowNodeDefinitions(storage);
  return cachedSnapshotDefinitions;
}

function normalizeUserFlowNodeDefinition(input: unknown): UserFlowNodeDefinition | null {
  const definition = normalizeFlowNodeDefinition(input);
  if (!definition || !isRecord(input)) return null;
  if (!Number.isInteger(input.version) || Number(input.version) < 1) return null;
  if (typeof input.enabled !== 'boolean') return null;
  if (!isNonEmptyString(input.createdAt) || !isNonEmptyString(input.updatedAt)) return null;

  return {
    ...definition,
    version: Number(input.version),
    enabled: input.enabled,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function normalizeReturns(input: unknown): FlowNodeDefinition['returns'] | undefined | null {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return null;
  const result: NonNullable<FlowNodeDefinition['returns']> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === 'string' || value === 'integer' || value === 'node') {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every(isNonEmptyString)) {
      result[key] = value.map((entry) => entry.trim());
      continue;
    }
    return null;
  }
  return result;
}

function normalizeParams(input: unknown): Record<string, string> | null {
  if (!isRecord(input)) return null;
  const paramTypes: Record<string, string> = {};
  for (const [param, rawType] of Object.entries(input)) {
    if (!isNonEmptyString(param)) return null;
    const types = parseFlowParamTypes(rawType);
    if (!types) return null;
    const trimmed = param.trim();
    paramTypes[trimmed] = types.join(' | ');
  }
  return Object.keys(paramTypes).length > 0 ? paramTypes : null;
}

function compareUserFlowNodeDefinitions(left: UserFlowNodeDefinition, right: UserFlowNodeDefinition): number {
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  const labelCompare = left.label.localeCompare(right.label);
  if (labelCompare !== 0) return labelCompare;
  return left.id.localeCompare(right.id);
}

function emitUserFlowNodeRegistryChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(USER_FLOW_NODE_REGISTRY_EVENT));
}

function getBrowserStorage(): UserFlowNodeRegistryStorage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
