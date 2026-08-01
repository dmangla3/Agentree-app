import { invoke } from '@tauri-apps/api/core';

export interface WorkspaceInfo {
    path: string;
    name: string;
    config_path: string;
}

export const workspaceClient = {
    attach: async (path: string): Promise<WorkspaceInfo> => {
        return await invoke('attach_workspace', { path });
    }
};
