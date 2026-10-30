/* @vitest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readCachedTrackedRefs,
  useCreateTrackedRef,
  useTrackedRefs,
  useUpdateTrackedRef,
  writeCachedTrackedRefs,
} from './useTrackedRefs';
import { createQueryWrapper } from '../test/queryTestUtils';
import { agentClient } from '../lib/agentClient';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    hasRuntime: vi.fn(),
  },
}));

const trackedRef = {
  id: 'tracked-main',
  workspace_id: 'workspace-1',
  git_ref: 'refs/heads/main',
  display_name: 'main',
  enabled: true,
  is_acceptance_branch: true,
  last_seen_commit_sha: 'main-tip',
  createdAt: '2026-05-19T00:00:00.000Z',
  updatedAt: '2026-05-19T00:00:00.000Z',
};

describe('useTrackedRefs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
        removeItem: vi.fn((key: string) => storage.delete(key)),
        clear: vi.fn(() => storage.clear()),
      },
    });
    window.localStorage.clear();
    vi.mocked(agentClient.hasRuntime).mockReturnValue(true);
  });

  it('uses cached local tracked refs in native runtime without blocking on the server', async () => {
    writeCachedTrackedRefs('workspace-1', [trackedRef]);
    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(() => useTrackedRefs('workspace-1'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual([trackedRef]);
    });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('creates tracked refs locally in native runtime without calling the server mutation path', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { ...trackedRef, id: 'server-id' } });
    const { Wrapper } = createQueryWrapper();

    const { result } = renderHook(() => useCreateTrackedRef(), { wrapper: Wrapper });
    const created = await result.current.mutateAsync({
      workspaceId: 'workspace-1',
      gitRef: 'refs/heads/main',
      displayName: 'main',
      enabled: true,
    });

    expect(created).toEqual(expect.objectContaining({
      id: 'local:workspace-1:refs/heads/main',
      workspace_id: 'workspace-1',
      git_ref: 'refs/heads/main',
      enabled: true,
      is_acceptance_branch: true,
    }));
    expect(readCachedTrackedRefs('workspace-1')).toEqual([created]);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('defaults HEAD and feature branches to non-acceptance while main remains accepted', async () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useCreateTrackedRef(), { wrapper: Wrapper });

    const head = await result.current.mutateAsync({ workspaceId: 'workspace-1', gitRef: 'HEAD' });
    const feature = await result.current.mutateAsync({ workspaceId: 'workspace-1', gitRef: 'refs/heads/feature' });
    const main = await result.current.mutateAsync({ workspaceId: 'workspace-1', gitRef: 'refs/heads/main' });

    expect(head.is_acceptance_branch).toBe(false);
    expect(feature.is_acceptance_branch).toBe(false);
    expect(main.is_acceptance_branch).toBe(true);
  });

  it('updates acceptance locally without a server mutation in native runtime', async () => {
    writeCachedTrackedRefs('workspace-1', [{ ...trackedRef, is_acceptance_branch: false }]);
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useUpdateTrackedRef(), { wrapper: Wrapper });

    const updated = await result.current.mutateAsync({
      workspaceId: 'workspace-1',
      refId: trackedRef.id,
      isAcceptanceBranch: true,
    });

    expect(updated.is_acceptance_branch).toBe(true);
    expect(readCachedTrackedRefs('workspace-1')[0]?.is_acceptance_branch).toBe(true);
    expect(api.patch).not.toHaveBeenCalled();
  });
});
