import { create } from 'zustand';

export interface KnowledgeFile {
    id: string;
    name: string;
    type: 'file' | 'folder';
    parentId: string | null;
    status: 'uploading' | 'processing' | 'ready' | 'error';
    updatedAt: string;
    metadata?: {
        vectorCount?: number;
        tokenCount?: number;
        [key: string]: unknown;
    };
}

interface KnowledgeState {
    // Preview Pane
    activeFile: KnowledgeFile | null;
    setActiveFile: (file: KnowledgeFile | null) => void;
}

export const useKnowledgeStore = create<KnowledgeState>((set) => ({
    // Preview Pane State & Actions
    activeFile: null,
    setActiveFile: (file) => set({ activeFile: file }),
}));
