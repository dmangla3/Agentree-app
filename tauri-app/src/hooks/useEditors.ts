import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface Editor {
    name: string;
    command: string;
    icon_key: string;
}

export function useEditors() {
    const [editors, setEditors] = useState<Editor[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchEditors = async () => {
            try {
                const available = await invoke<Editor[]>('get_available_editors');
                setEditors(available);
            } catch (e) {
                console.error('Failed to fetch editors:', e);
                // Fallback to just Finder if failed
                setEditors([{ name: 'Finder', command: 'open', icon_key: 'finder' }]);
            } finally {
                setLoading(false);
            }
        };

        fetchEditors();
    }, []);

    return { editors, loading };
}
