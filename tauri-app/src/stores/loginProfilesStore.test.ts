import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/agentClient', () => ({
  agentClient: {
    listLoginProfiles: vi.fn(),
    listActiveLoginProfileRuns: vi.fn(),
    upsertLoginProfile: vi.fn(),
    deleteLoginProfile: vi.fn(),
    setDefaultLoginProfile: vi.fn(),
    checkLoginProfileReadiness: vi.fn(),
    discoverLoginImportCandidates: vi.fn(),
    importDiscoveredLoginProfile: vi.fn(),
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
});
