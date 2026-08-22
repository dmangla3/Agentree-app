import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeSource, MergeTarget } from './integrationStore';

const source = (id: string, commitSha = id): MergeSource => ({
  id,
  type: 'graph-node',
  label: id,
  commitSha,
  nodeId: id,
});

const target = (id: string, commitSha = id): MergeTarget => ({
  id,
  type: 'tracked-ref',
  label: id,
  commitSha,
  branchName: id,
});

const loadIntegrationStore = async () => {
  vi.resetModules();
  return import('./integrationStore');
};

const installMemoryLocalStorage = () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
    clear: vi.fn(() => {
      data.clear();
    }),
  });
};

describe('integration merge session persistence', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    localStorage.clear();
    vi.resetModules();
  });

  it('rehydrates a queued merge draft after an app restart', async () => {
    const firstModule = await loadIntegrationStore();
    const firstStore = firstModule.useIntegrationStore;

    firstStore.getState().ensureMergeSession('workspace-1', '/repo');
    firstStore.getState().addSource(source('source-1', 'abc123'));
    firstStore.getState().setTarget(target('main', 'def456'));
    firstStore.getState().setResolutionMode('manual');
    firstStore.getState().setApplyState({ status: 'running', log: 'applying' });

    const secondModule = await loadIntegrationStore();
    const session = secondModule.useIntegrationStore.getState().session;

    expect(session?.workspaceId).toBe('workspace-1');
    expect(session?.repoPath).toBe('/repo');
    expect(session?.sources).toEqual([source('source-1', 'abc123')]);
    expect(session?.target).toEqual(target('main', 'def456'));
    expect(session?.resolutionMode).toBe('manual');
    expect(session?.stage).toBe('setup');
    expect(session?.applyState).toEqual({ status: 'not-run' });
    expect(secondModule.useIntegrationStore.getState().isApplying).toBe(false);
    expect(secondModule.useIntegrationStore.getState().applyError).toBeNull();
  });
});
