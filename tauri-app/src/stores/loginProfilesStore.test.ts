import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    listLoginProfiles: vi.fn(),
    listActiveLoginProfileRuns: vi.fn(),
    upsertLoginProfile: vi.fn(),
    deleteLoginProfile: vi.fn(),
    setDefaultLoginProfile: vi.fn(),
    checkLoginProfileReadiness: vi.fn(),
    ensureLoginProfileReady: vi.fn(),
    checkAllLoginProfileReadiness: vi.fn(),
    discoverLoginImportCandidates: vi.fn(),
    importDiscoveredLoginProfile: vi.fn(),
    onLoginProfilesChanged: vi.fn(),
  },
}));

describe('loginProfilesStore', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('loads profiles and active runs together', async () => {
    const { agentClient } = await import('../lib/agentClient');
    vi.mocked(agentClient.listLoginProfiles).mockResolvedValue([
      { id: 'p1', provider: 'codex', displayName: 'Work', status: 'ready', authType: 'codex_api_key', isDefault: true } as any,
    ]);
    vi.mocked(agentClient.listActiveLoginProfileRuns).mockResolvedValue([
      { loginProfileId: 'p1', runId: 'r1', assistantNodeId: 'a1', status: 'running', phase: 'streaming', updatedAt: 1 } as any,
    ]);

    const { useLoginProfilesStore } = await import('./loginProfilesStore');
    await useLoginProfilesStore.getState().refresh();

    expect(useLoginProfilesStore.getState().profiles).toHaveLength(1);
    expect(useLoginProfilesStore.getState().activeRunsByProfile.p1).toHaveLength(1);
  });

  it('discovers redacted import candidates without saving them', async () => {
    const { agentClient } = await import('../lib/agentClient');
    vi.mocked(agentClient.discoverLoginImportCandidates).mockResolvedValue([
      {
        id: 'env:OPENAI_API_KEY',
        provider: 'codex',
        displayName: 'OpenAI API key',
        authType: 'codex_api_key',
        sourceKind: 'env',
        sourceLabel: 'OPENAI_API_KEY',
        redactedHint: 'sk-proj...cdef',
        importable: true,
      },
    ]);

    const { useLoginProfilesStore } = await import('./loginProfilesStore');
    const candidates = await useLoginProfilesStore.getState().discoverImportCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0].redactedHint).toBe('sk-proj...cdef');
    expect(agentClient.importDiscoveredLoginProfile).not.toHaveBeenCalled();
  });

  it('imports only an explicitly selected candidate and refreshes profiles', async () => {
    const { agentClient } = await import('../lib/agentClient');
    vi.mocked(agentClient.importDiscoveredLoginProfile).mockResolvedValue({ id: 'p1' } as any);
    vi.mocked(agentClient.listLoginProfiles).mockResolvedValue([]);
    vi.mocked(agentClient.listActiveLoginProfileRuns).mockResolvedValue([]);

    const { useLoginProfilesStore } = await import('./loginProfilesStore');
    await useLoginProfilesStore.getState().importCandidate({
      candidateId: 'env:ANTHROPIC_API_KEY',
      displayName: 'Anthropic API key',
      makeDefault: true,
    });

    expect(agentClient.importDiscoveredLoginProfile).toHaveBeenCalledWith({
      candidateId: 'env:ANTHROPIC_API_KEY',
      displayName: 'Anthropic API key',
      makeDefault: true,
    });
    expect(agentClient.listLoginProfiles).toHaveBeenCalledOnce();
  });

  it('refreshes when the native login profile change event fires', async () => {
    const { agentClient } = await import('../lib/agentClient');
    const listener: { emit?: () => void } = {};
    const cleanup = vi.fn();
    vi.mocked(agentClient.onLoginProfilesChanged).mockImplementation(async (callback) => {
      listener.emit = () => callback({ profileId: 'p1', status: 'ready' });
      return cleanup;
    });
    vi.mocked(agentClient.listActiveLoginProfileRuns).mockResolvedValue([]);
    vi.mocked(agentClient.listLoginProfiles)
      .mockResolvedValueOnce([
        { id: 'p1', provider: 'codex', displayName: 'Work', status: 'checking', authType: 'codex_api_key', isDefault: true } as any,
      ])
      .mockResolvedValueOnce([
        { id: 'p1', provider: 'codex', displayName: 'Work', status: 'ready', authType: 'codex_api_key', isDefault: true } as any,
      ]);

    const { useLoginProfilesStore } = await import('./loginProfilesStore');
    const stopSync = useLoginProfilesStore.getState().startSync();
    await vi.waitFor(() => expect(agentClient.listLoginProfiles).toHaveBeenCalledTimes(1));

    listener.emit?.();
    await vi.waitFor(() => expect(useLoginProfilesStore.getState().profiles[0]?.status).toBe('ready'));

    stopSync();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('updates the cached profile after a pre-send local eligibility check', async () => {
    const { agentClient } = await import('../lib/agentClient');
    const readyProfile = {
      id: 'p1',
      provider: 'codex',
      displayName: 'Work',
      status: 'ready',
      authType: 'codex_chatgpt_session',
      isDefault: true,
      lastCheckedAt: 123,
    } as any;
    vi.mocked(agentClient.ensureLoginProfileReady).mockResolvedValue(readyProfile);

    const { useLoginProfilesStore } = await import('./loginProfilesStore');
    useLoginProfilesStore.setState({
      profiles: [{ ...readyProfile, status: 'checking' }],
    });
    await useLoginProfilesStore.getState().ensureReady('p1');

    expect(agentClient.ensureLoginProfileReady).toHaveBeenCalledWith('p1');
    expect(useLoginProfilesStore.getState().profiles[0]?.status).toBe('ready');
  });
});
