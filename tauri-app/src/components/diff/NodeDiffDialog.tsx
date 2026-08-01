import { useState, useMemo, useEffect } from 'react';
import { useDiffNodes } from '../../hooks/useDiff';
import { FileDiff, DiffRelationship } from '../../lib/agentClient';
import { FileDiffPanel } from './FileDiffPanel';
import { cn } from '../../lib/utils';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useMessages } from '../../hooks/useMessages';
import {
    buildMessageMap,
    findCommonAncestorMessageId,
    getMessageById,
    getRepoPathFromWorkspace,
    inferDiffRelationship,
    resolveNodeCommit,
} from '../../lib/gitNodeUtils';
import { getMessageOutputCommitSha } from '../../lib/graph/commitAccessors';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '../../../@/components/ui/dialog';
import { Button } from '../../../@/components/ui/button';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuCheckboxItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from '../../../@/components/ui/dropdown-menu';
import {
    GitCompare,
    ArrowRight,
    Filter,
    Loader2,
    AlertCircle,
    FileCode2,
    FilePlus,
    FileX,
    FilePen,
    ChevronDown,
    Search,
    X,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface NodeDiffDialogProps {
    /** Whether the dialog is open */
    open: boolean;
    /** Callback when open state changes */
    onOpenChange: (open: boolean) => void;
    /** ID of the source (from) node */
    fromNodeId: string;
    /** ID of the target (to) node */
    toNodeId: string;
    /** Optional label for the from node */
    fromLabel?: string;
    /** Optional label for the to node */
    toLabel?: string;
    /** Optional file path to expand and scroll to initially */
    initialFile?: string;
    /** Path IDs (ancestry chain) for the target node - enables blame tab */
    toNodePathIds?: string[];
    /** Callback when clicking a node in blame view */
    onNodeClick?: (nodeId: string) => void;
}

type StatusFilter = 'all' | 'added' | 'modified' | 'deleted' | 'renamed';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getRelationshipLabel(relationship: DiffRelationship): string {
    switch (relationship) {
        case 'parent-child':
            return 'Parent → Child';
        case 'ancestor-descendant':
            return 'Ancestor → Descendant';
        case 'siblings':
            return 'Sibling Branches';
        case 'unrelated':
            return 'Unrelated Nodes';
        default:
            return 'Unknown';
    }
}

function getRelationshipColor(relationship: DiffRelationship): string {
    switch (relationship) {
        case 'parent-child':
            return 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30';
        case 'ancestor-descendant':
            return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30';
        case 'siblings':
            return 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30';
        case 'unrelated':
            return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30';
        default:
            return 'bg-muted text-muted-foreground border-border';
    }
}

function truncateNodeId(id: string, maxLen: number = 8): string {
    if (id.length <= maxLen) return id;
    return id.slice(0, maxLen) + '...';
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function NodeDiffDialog({
    open,
    onOpenChange,
    fromNodeId,
    toNodeId,
    fromLabel,
    toLabel,
    initialFile,
    toNodePathIds: _toNodePathIds,
    onNodeClick,
}: NodeDiffDialogProps) {
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
        initialFile ? new Set([initialFile]) : new Set()
    );
    const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
    const [fullDiffs, setFullDiffs] = useState<Record<string, FileDiff>>({});
    const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
    const { data: workspaces = [] } = useWorkspaces();
    const { data: messages = [] } = useMessages(selectedWorkspaceId);

    const selectedWorkspace = useMemo(
        () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
        [workspaces, selectedWorkspaceId]
    );
    const repoPath = getRepoPathFromWorkspace(selectedWorkspace);
    const baseCommitSha = selectedWorkspace?.base_commit_sha ?? null;
    const messageMap = useMemo(() => buildMessageMap(messages), [messages]);
    const fromMessage = useMemo(() => getMessageById(messageMap, fromNodeId), [messageMap, fromNodeId]);
    const toMessage = useMemo(() => getMessageById(messageMap, toNodeId), [messageMap, toNodeId]);
    const fromCommit = useMemo(
        () => resolveNodeCommit(fromMessage, messageMap, baseCommitSha),
        [fromMessage, messageMap, baseCommitSha]
    );
    const toCommit = useMemo(
        () => resolveNodeCommit(toMessage, messageMap, baseCommitSha),
        [toMessage, messageMap, baseCommitSha]
    );
    const relationship = useMemo<DiffRelationship | null>(
        () => (fromMessage && toMessage ? inferDiffRelationship(messageMap, fromNodeId, toNodeId) : null),
        [fromMessage, toMessage, messageMap, fromNodeId, toNodeId]
    );
    const commonAncestorCommit = useMemo(() => {
        const ancestorId = findCommonAncestorMessageId(messageMap, fromNodeId, toNodeId);
        const ancestor = ancestorId ? messageMap.get(ancestorId) ?? null : null;
        return getMessageOutputCommitSha(ancestor) ?? baseCommitSha;
    }, [messageMap, fromNodeId, toNodeId, baseCommitSha]);

    const handleRequestFullDiff = async (filePath: string) => {
        if (loadingFiles.has(filePath)) return;

        setLoadingFiles(prev => {
            const next = new Set(prev);
            next.add(filePath);
            return next;
        });

        try {
            if (!repoPath || !fromCommit || !toCommit) {
                throw new Error('Missing git context for file diff');
            }
            const result = await import('../../lib/agentClient').then(m =>
                m.agentClient.diffFileBetweenCommits(repoPath, fromCommit, toCommit, filePath)
            );

            setFullDiffs(prev => ({
                ...prev,
                [filePath]: result
            }));
        } catch (error) {
            console.error('Failed to load full diff:', error);
        } finally {
            setLoadingFiles(prev => {
                const next = new Set(prev);
                next.delete(filePath);
                return next;
            });
        }
    };

    // Fetch diff with content
    const {
        data: diffResult,
        isLoading,
        error,
    } = useDiffNodes(repoPath, fromCommit, toCommit, true);

    // Scroll to initial file when diff loads
    useEffect(() => {
        if (initialFile && diffResult?.files) {
            // Ensure the file is expanded
            setExpandedFiles(prev => {
                const next = new Set(prev);
                next.add(initialFile);
                return next;
            });

            // Small timeout to ensure DOM is ready
            setTimeout(() => {
                const element = document.getElementById(`file-diff-${initialFile}`);
                if (element) {
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 100);
        }
    }, [initialFile, diffResult?.files]);

    // Filter files based on status and search
    const filteredFiles = useMemo(() => {
        if (!diffResult?.files) return [];

        return diffResult.files.filter((file: FileDiff) => {
            // Status filter
            if (statusFilter !== 'all' && file.status !== statusFilter) {
                return false;
            }

            // Search filter
            if (searchQuery) {
                const query = searchQuery.toLowerCase();
                return file.path.toLowerCase().includes(query);
            }

            return true;
        });
    }, [diffResult?.files, statusFilter, searchQuery]);

    // Stats counts
    const stats = diffResult?.stats;
    const fileCountByStatus = useMemo(() => {
        if (!diffResult?.files) return { added: 0, modified: 0, deleted: 0, renamed: 0 };
        return diffResult.files.reduce(
            (acc: Record<string, number>, file: FileDiff) => {
                acc[file.status] = (acc[file.status] || 0) + 1;
                return acc;
            },
            { added: 0, modified: 0, deleted: 0, renamed: 0 }
        );
    }, [diffResult?.files]);

    const handleExpandAll = () => {
        if (filteredFiles.length > 0) {
            setExpandedFiles(new Set(filteredFiles.map((f: FileDiff) => f.path)));
        }
    };

    const handleCollapseAll = () => {
        setExpandedFiles(new Set());
    };

    // Labels for display
    const displayFromLabel = fromLabel || truncateNodeId(fromNodeId);
    const displayToLabel = toLabel || truncateNodeId(toNodeId);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="!max-w-[95vw] !w-[95vw] !h-[90vh] max-w-none sm:max-w-[95vw] flex flex-col p-0">
                {/* Header */}
                <DialogHeader className="px-6 py-4 border-b border-border/50 flex-shrink-0">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <GitCompare size={20} className="text-primary" />
                            <DialogTitle className="text-lg">Compare Nodes</DialogTitle>
                        </div>
                    </div>
                    <DialogDescription className="sr-only">
                        Compare file changes between two workspace nodes
                    </DialogDescription>

                    {/* Node comparison info */}
                    <div className="flex items-center gap-3 mt-3">
                        <div className="flex items-center gap-2 text-sm">
                            <span className="px-2 py-1 rounded bg-muted font-mono text-xs">
                                {displayFromLabel}
                            </span>
                            <ArrowRight size={14} className="text-muted-foreground" />
                            <span className="px-2 py-1 rounded bg-muted font-mono text-xs">
                                {displayToLabel}
                            </span>
                        </div>

                                {diffResult && (
                            <>
                                <span
                                    className={cn(
                                        "px-2 py-0.5 rounded-full text-[10px] font-medium border",
                                        getRelationshipColor(relationship ?? diffResult.relationship)
                                    )}
                                >
                                    {getRelationshipLabel(relationship ?? diffResult.relationship)}
                                </span>

                                {commonAncestorCommit && (
                                    <span className="text-xs text-muted-foreground">
                                        Common ancestor: {truncateNodeId(commonAncestorCommit)}
                                    </span>
                                )}
                            </>
                        )}
                    </div>
                </DialogHeader>

                {/* Stats bar */}
                {stats && (
                    <div className="px-6 py-3 bg-muted/30 border-b border-border/50 flex items-center justify-between flex-shrink-0">
                        <div className="flex items-center gap-4 text-sm">
                            <span className="text-muted-foreground">
                                {diffResult?.files.length || 0} files changed
                            </span>
                            <span className="text-green-600 dark:text-green-400 font-medium">
                                +{stats.total_additions}
                            </span>
                            <span className="text-red-600 dark:text-red-400 font-medium">
                                -{stats.total_deletions}
                            </span>
                        </div>

                        <div className="flex items-center gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleExpandAll}
                                className="h-7 text-xs"
                            >
                                Expand All
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleCollapseAll}
                                className="h-7 text-xs"
                            >
                                Collapse All
                            </Button>
                        </div>
                    </div>
                )}

                {/* Filters */}
                <div className="px-6 py-2 border-b border-border/50 flex items-center gap-3 flex-shrink-0">
                    {/* Search */}
                    <div className="relative flex-1 max-w-xs">
                        <Search
                            size={14}
                            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                        />
                        <input
                            type="text"
                            placeholder="Filter files..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className={cn(
                                "w-full h-8 pl-8 pr-8 text-sm rounded-md",
                                "bg-muted/50 border border-border/50",
                                "focus:outline-none focus:ring-2 focus:ring-ring",
                                "placeholder:text-muted-foreground"
                            )}
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                                <X size={14} />
                            </button>
                        )}
                    </div>

                    {/* Status filter */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="h-8">
                                <Filter size={14} className="mr-1.5" />
                                {statusFilter === 'all' ? 'All Files' : statusFilter}
                                <ChevronDown size={14} className="ml-1.5" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem
                                checked={statusFilter === 'all'}
                                onCheckedChange={() => setStatusFilter('all')}
                            >
                                <FileCode2 size={14} className="mr-2" />
                                All ({diffResult?.files.length || 0})
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem
                                checked={statusFilter === 'added'}
                                onCheckedChange={() => setStatusFilter('added')}
                            >
                                <FilePlus size={14} className="mr-2 text-green-500" />
                                Added ({fileCountByStatus.added})
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem
                                checked={statusFilter === 'modified'}
                                onCheckedChange={() => setStatusFilter('modified')}
                            >
                                <FilePen size={14} className="mr-2 text-amber-500" />
                                Modified ({fileCountByStatus.modified})
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem
                                checked={statusFilter === 'deleted'}
                                onCheckedChange={() => setStatusFilter('deleted')}
                            >
                                <FileX size={14} className="mr-2 text-red-500" />
                                Deleted ({fileCountByStatus.deleted})
                            </DropdownMenuCheckboxItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                {/* Content */}
                <ScrollArea className="flex-1 min-h-0">
                    <div className="p-4 space-y-2">
                        {isLoading ? (
                            <div className="flex items-center justify-center py-16">
                                <Loader2 size={24} className="animate-spin text-muted-foreground mr-3" />
                                <span className="text-muted-foreground">Loading diff...</span>
                            </div>
                        ) : error ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <AlertCircle size={32} className="mb-3 text-muted-foreground" />
                                <span className="font-medium text-foreground">
                                    {error.message?.includes('git context')
                                        ? 'No file changes available'
                                        : 'Failed to load diff'}
                                </span>
                                <span className="text-sm text-muted-foreground mt-1 max-w-md">
                                    {error.message?.includes('git context')
                                        ? 'This node does not have a finalized git commit yet. Complete the agent run before opening a diff.'
                                        : error.message}
                                </span>
                            </div>
                        ) : filteredFiles.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                                <FileCode2 size={32} className="mb-3" />
                                <span className="font-medium">No files match your filter</span>
                                <span className="text-sm mt-1">
                                    {searchQuery
                                        ? 'Try a different search term'
                                        : 'No changes found between these nodes'}
                                </span>
                            </div>
                        ) : (
                            filteredFiles.map((file: FileDiff) => (
                                <FileDiffPanel
                                    key={file.path}
                                    id={`file-diff-${file.path}`}
                                    fileDiff={fullDiffs[file.path] || file}
                                    fromLabel={displayFromLabel}
                                    toLabel={displayToLabel}
                                    defaultExpanded={expandedFiles.has(file.path)}
                                    isLoadingFullDiff={loadingFiles.has(file.path)}
                                    onRequestFullDiff={() => handleRequestFullDiff(file.path)}
                                    nodeId={toNodeId}
                                    repoPath={repoPath ?? undefined}
                                    commit={toCommit ?? undefined}
                                    messages={messages}
                                    baseCommitSha={baseCommitSha}
                                    showBlameTab={Boolean(toNodeId && repoPath && toCommit)}
                                    onNodeClick={onNodeClick}
                                />
                            ))
                        )}
                    </div>
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
}

export default NodeDiffDialog;
