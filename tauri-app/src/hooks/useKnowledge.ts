import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { KnowledgeFile } from '../stores/knowledgeStore';

export const useKnowledgeTree = () => {
    return useQuery<KnowledgeFile[]>({
        queryKey: ['knowledge-tree'],
        queryFn: async () => {
            const response = await api.get('/knowledge/tree');
            return response.data;
        },
    });
};

export interface FileContent {
    file: KnowledgeFile;
    content: string;
    signedUrl?: string;
    usage?: {
        messageId: string;
        workspaceId: string;
        workspaceName: string;
        date: string;
        snippet: string;
    }[];
}

export const useFileContent = (fileId: string | null) => {
    return useQuery<FileContent>({
        queryKey: ['file-content', fileId],
        queryFn: async () => {
            if (!fileId) throw new Error('File ID is required');
            const response = await api.get(`/knowledge/${fileId}/content`);
            return response.data;
        },
        enabled: !!fileId,
    });
};

export const useUploadFiles = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (formData: FormData) => {
            const response = await api.post('/knowledge/upload', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['knowledge-tree'] });
        },
        onError: (error) => {
            console.error("Upload mutation failed:", error);
        },
    });
};

export const useCreateFolder = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ name, parentId }: { name: string; parentId?: string | null }) => {
            const response = await api.post('/knowledge/folders', { name, parentId });
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['knowledge-tree'] });
        },
    });
};

export const useDeleteFile = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            await api.delete(`/knowledge/${id}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['knowledge-tree'] });
        },
    });
};
