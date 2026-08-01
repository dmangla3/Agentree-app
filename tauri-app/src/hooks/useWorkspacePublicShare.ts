import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

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

const publicShareKeys = {
  workspace: (workspaceId: string | null) => ['workspace-public-shares', workspaceId ?? ''] as const,
};

export const getPublicShareUrl = (publicId: string) => {
  const configuredBase = import.meta.env.VITE_PUBLIC_APP_URL;
  const fallbackBase = 'https://agentree.app';
  const base = (configuredBase || fallbackBase).replace(/\/+$/, '');
  return `${base}/share/${publicId}`;
};

export const useWorkspacePublicShares = (workspaceId: string | null) => (
  useQuery<{ shares: WorkspacePublicShare[] }, Error>({
    queryKey: publicShareKeys.workspace(workspaceId),
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      if (!workspaceId) return { shares: [] };
      const response = await api.get(`/workspaces/${workspaceId}/public-shares`);
      return response.data;
    },
    staleTime: 30_000,
  })
);

export const useCreateNodePublicShare = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ nodeId }: { nodeId: string; workspaceId: string }) => {
      const response = await api.post(`/nodes/${nodeId}/public-share`);
      return response.data as { share: WorkspacePublicShare };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: publicShareKeys.workspace(variables.workspaceId) });
    },
  });
};

export const useRevokePublicShare = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ shareId }: { shareId: string; workspaceId: string }) => {
      await api.delete(`/public-shares/${shareId}`);
      return shareId;
    },
    onSuccess: (_shareId, variables) => {
      queryClient.invalidateQueries({ queryKey: publicShareKeys.workspace(variables.workspaceId) });
    },
  });
};
