import { describe, expect, it, vi } from 'vitest';
import { getOptionalCloudAuthToken, isMissingCloudAuthError } from './authSession';

describe('authSession optional cloud auth', () => {
  it('treats disconnected Agentree Cloud auth as an empty local token', async () => {
    await expect(getOptionalCloudAuthToken(
      vi.fn(async () => {
        throw new Error('No access token available');
      }),
    )).resolves.toBe('');

    await expect(getOptionalCloudAuthToken(
      vi.fn(async () => {
        throw new Error('Authentication is not initialized');
      }),
    )).resolves.toBe('');

    await expect(getOptionalCloudAuthToken(vi.fn(async () => null))).resolves.toBe('');
  });

  it('does not hide unexpected auth failures', async () => {
    const error = new Error('token refresh failed');

    await expect(getOptionalCloudAuthToken(
      vi.fn(async () => {
        throw error;
      }),
    )).rejects.toBe(error);
    expect(isMissingCloudAuthError(error)).toBe(false);
  });
});
