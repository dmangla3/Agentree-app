import { createContext, lazy, Suspense, useContext, useState, ReactNode } from 'react';

const NodeDiffDialog = lazy(() =>
    import('../components/diff/NodeDiffDialog').then((module) => ({
        default: module.NodeDiffDialog,
    })),
);

interface OpenDiffOptions {
    fromNodeId: string;
    toNodeId: string;
    initialFile?: string;
    /** Path IDs for the target node - enables blame tab */
    toNodePathIds?: string[];
    /** Callback when clicking a node in blame view */
    onNodeClick?: (nodeId: string) => void;
}

interface DiffContextType {
    openDiff: (fromNodeId: string, toNodeId: string, initialFile?: string, toNodePathIds?: string[], onNodeClick?: (nodeId: string) => void) => void;
    openDiffWithOptions: (options: OpenDiffOptions) => void;
    closeDiff: () => void;
}

const DiffContext = createContext<DiffContextType | undefined>(undefined);

export function useDiff() {
    const context = useContext(DiffContext);
    if (!context) {
        throw new Error('useDiff must be used within a DiffProvider');
    }
    return context;
}

interface DiffProviderProps {
    children: ReactNode;
}

export function DiffProvider({ children }: DiffProviderProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [diffState, setDiffState] = useState<{
        fromNodeId: string;
        toNodeId: string;
        initialFile?: string;
        toNodePathIds?: string[];
        onNodeClick?: (nodeId: string) => void;
    } | null>(null);

    const openDiff = (fromNodeId: string, toNodeId: string, initialFile?: string, toNodePathIds?: string[], onNodeClick?: (nodeId: string) => void) => {
        setDiffState({ fromNodeId, toNodeId, initialFile, toNodePathIds, onNodeClick });
        setIsOpen(true);
    };

    const openDiffWithOptions = (options: OpenDiffOptions) => {
        setDiffState(options);
        setIsOpen(true);
    };

    const closeDiff = () => {
        setIsOpen(false);
        // Don't clear state immediately to allow animation to finish
    };

    return (
        <DiffContext.Provider value={{ openDiff, openDiffWithOptions, closeDiff }}>
            {children}
            {diffState && (
                <Suspense fallback={null}>
                    <NodeDiffDialog
                        open={isOpen}
                        onOpenChange={(open) => !open && closeDiff()}
                        fromNodeId={diffState.fromNodeId}
                        toNodeId={diffState.toNodeId}
                        initialFile={diffState.initialFile}
                        toNodePathIds={diffState.toNodePathIds}
                        onNodeClick={diffState.onNodeClick}
                    />
                </Suspense>
            )}
        </DiffContext.Provider>
    );
}
