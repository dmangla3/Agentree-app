import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  workspaceCloudClient,
  type PublicShareRootNode,
  type WorkspacePublicShare,
} from '../lib/workspaceCloudClient';

export type { PublicShareRootNode, WorkspacePublicShare };

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
    queryFn: async () => workspaceId
      ? workspaceCloudClient.listPublicShares(workspaceId)
      : { shares: [] },
    staleTime: 30_000,
  })
);

export const useCreateNodePublicShare = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ nodeId }: { nodeId: string; workspaceId: string }) => (
      workspaceCloudClient.createNodePublicShare(nodeId)
    ),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: publicShareKeys.workspace(variables.workspaceId) });
    },
  });
};

export const useRevokePublicShare = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ shareId }: { shareId: string; workspaceId: string }) => {
      await workspaceCloudClient.revokePublicShare(shareId);
      return shareId;
    },
    onSuccess: (_shareId, variables) => {
      queryClient.invalidateQueries({ queryKey: publicShareKeys.workspace(variables.workspaceId) });
    },
  });
};
