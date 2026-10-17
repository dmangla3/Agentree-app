import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken } from './authSession';
import { workspaceCloudClient } from './workspaceCloudClient';

vi.mock('./authSession', () => ({
  getAccessToken: vi.fn(async () => 'token-1'),
  handleSessionExpired: vi.fn(),
}));

describe('workspaceCloudClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('exposes public-share operations without enabling the legacy API client', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ share: { publicId: 'public-1' } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(workspaceCloudClient.createNodePublicShare('node/1')).resolves.toEqual({
      share: { publicId: 'public-1' },
    });

    expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: false });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/nodes/node%2F1/public-share'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
