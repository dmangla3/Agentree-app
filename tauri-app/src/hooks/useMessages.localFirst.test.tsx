// @vitest-environment jsdom
import '../test/setup';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryWrapper } from '../test/queryTestUtils';
import { agentClient } from '../lib/agentClient';
import { useMessages } from './useMessages';

vi.mock('../lib/api', () => ({
  AGENTREE_DATA_PLANE_ENABLED: false,
  api: { get: vi.fn() },
}));

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    hasRuntime: vi.fn(() => true),
    listLocalNodes: vi.fn(async () => []),
    hydrateLocalNodesFromServer: vi.fn(),
  },
}));

vi.mock('../lib/perfRecorder', () => ({
  getElapsedSinceAppStartMs: vi.fn(() => 0),
  recordPerfEvent: vi.fn(),
}));

describe('useMessages local-first reads', () => {
  it('loads native nodes when the server data plane is disabled', async () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useMessages('workspace-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(agentClient.listLocalNodes).toHaveBeenCalledWith('workspace-1');
    expect(result.current.data).toEqual([]);
  });
});
