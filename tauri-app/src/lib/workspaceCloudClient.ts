import { getAccessToken, handleSessionExpired } from './authSession';
import { API_URL } from './api';

export interface PublicShareRootNode {
  id: string;
  role: 'user' | 'assistant';
  workspaceId: string;
  parentId: string | null;
  aiLabel: string | null;
  contentPreview: string;
  contentLength: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspacePublicShare {
  id: string;
  publicId: string;
  workspaceId: string;
  targetType: 'node';
  rootNodeId: string;
  mode: 'live';
  visibility: 'unlisted' | 'public';
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
  revokedAt?: string | null;
  rootNode?: PublicShareRootNode | null;
}

const requestShareApi = async <T>(
  path: string,
  init: RequestInit = {},
  retryAuth = true,
): Promise<T> => {
  if (!API_URL) {
    throw new Error('Agentree Cloud is not configured for this build.');
  }
  const token = await getAccessToken({ forceRefresh: !retryAuth });
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  if (response.status === 401 && retryAuth) {
    return requestShareApi<T>(path, init, false);
  }
  if (response.status === 401) {
    await handleSessionExpired();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(body?.error || body?.message || `Agentree Cloud request failed (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
};

/** Narrow server capability for consent-gated workspace sharing. */
export const workspaceCloudClient = {
  listPublicShares: (workspaceId: string) => requestShareApi<{ shares: WorkspacePublicShare[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/public-shares`,
  ),
  createNodePublicShare: (nodeId: string) => requestShareApi<{ share: WorkspacePublicShare }>(
    `/nodes/${encodeURIComponent(nodeId)}/public-share`,
    { method: 'POST' },
  ),
  revokePublicShare: (shareId: string) => requestShareApi<void>(
    `/public-shares/${encodeURIComponent(shareId)}`,
    { method: 'DELETE' },
  ),
};
