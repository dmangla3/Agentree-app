import { useQuery } from '@tanstack/react-query';
import { agentClient } from '../lib/agentClient';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useMessages } from '../hooks/useMessages';
import { useDiff } from '../contexts/DiffContext';
import { FileText, Plus, Minus, Edit2, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { useMemo } from 'react';
import { Workspace } from '../stores/workspaceStore';
import {
    buildMessageMap,
    getMessageById,
    getRepoPathFromWorkspace,
    resolveNodeCommit,
    resolveParentCommit,
} from '../lib/gitNodeUtils';

interface FileChangePreviewProps {
    messageId: string;
    workspaceId: string;
    initialFiles?: string[];
    className?: string;
}

export function FileChangePreview({
    messageId,
    workspaceId,
    initialFiles = [],
    className
}: FileChangePreviewProps) {
    const { data: workspaces } = useWorkspaces();
    const { data: messages } = useMessages(workspaceId);
    const { openDiff } = useDiff();

    const workspace = useMemo(
        () => workspaces?.find((c: Workspace) => c.id === workspaceId) ?? null,
        [workspaces, workspaceId]
    );
    const repoPath = getRepoPathFromWorkspace(workspace);
    const baseCommitSha = workspace?.base_commit_sha ?? null;
    const messageMap = useMemo(() => buildMessageMap(messages ?? []), [messages]);
    const message = useMemo(() => getMessageById(messageMap, messageId), [messageMap, messageId]);
    const parentId = message?.parentId ?? null;
    const parentCommit = useMemo(
        () => resolveParentCommit(message, messageMap, baseCommitSha),
        [message, messageMap, baseCommitSha]
    );
    const nodeCommit = useMemo(
        () => resolveNodeCommit(message, messageMap, baseCommitSha),
        [message, messageMap, baseCommitSha]
    );

    const { data: diff, isLoading, error } = useQuery({
        queryKey: ['diff', messageId, repoPath, parentCommit, nodeCommit],
        queryFn: async () => {
            if (!repoPath || !parentCommit || !nodeCommit) return null;
            return await agentClient.diffCommits(repoPath, parentCommit, nodeCommit, false);
        },
        enabled: !!repoPath && !!parentCommit && !!nodeCommit,
        staleTime: Infinity, // Diffs are immutable for a given node
    });

    // Fallback to initialFiles if diff is not available yet or failed
    const filesToShow = diff?.files.map(f => ({
        path: f.path,
        status: f.status
    })) || initialFiles.map(path => ({ path, status: 'modified' })); // Default to modified if unknown

    if (filesToShow.length === 0 && !isLoading) return null;

    const handleFileClick = (path: string) => {
        if (parentId) {
            openDiff(parentId, messageId, path);
        }
    };

    return (
        <div className={cn("rounded border border-border/40 bg-muted/20 overflow-hidden", className)}>
            <div className="flex items-center justify-between px-2 py-1.5 bg-muted/30 border-b border-border/30">
                <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    <FileText size={10} />
                    <span>Files Changed</span>
                    <span className="bg-muted px-1 py-0 rounded text-[9px] text-foreground/80 min-w-[16px] text-center">
                        {filesToShow.length}
                    </span>
                </div>
                {isLoading && <Loader2 size={10} className="animate-spin text-muted-foreground" />}
                {error && <AlertCircle size={10} className="text-destructive" />}
            </div>

            <div className="h-auto max-h-[120px] w-full overflow-y-auto overscroll-y-contain custom-scrollbar">
                <div className="p-1 space-y-0.5">
                    {filesToShow.map((file, idx) => (
                        <div
                            key={`${file.path}-${idx}`}
                            onClick={() => handleFileClick(file.path)}
                            className="flex items-center gap-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded hover:bg-muted/50 transition-colors group cursor-pointer"
                        >
                            <span className={cn(
                                "flex items-center justify-center w-3.5 h-3.5 rounded-sm shrink-0",
                                file.status === 'added' && "text-green-600 bg-green-500/10 dark:bg-green-500/20",
                                file.status === 'deleted' && "text-red-600 bg-red-500/10 dark:bg-red-500/20",
                                (file.status === 'modified' || file.status === 'renamed') && "text-amber-600 bg-amber-500/10 dark:bg-amber-500/20"
                            )} title={file.status}>
                                {file.status === 'added' && <Plus size={8} strokeWidth={3} />}
                                {file.status === 'deleted' && <Minus size={8} strokeWidth={3} />}
                                {(file.status === 'modified' || file.status === 'renamed') && <Edit2 size={8} strokeWidth={2.5} />}
                            </span>
                            <span className={cn(
                                "truncate text-foreground/80 group-hover:text-foreground transition-colors",
                                file.status === 'deleted' && "line-through opacity-70"
                            )}>
                                {file.path}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
