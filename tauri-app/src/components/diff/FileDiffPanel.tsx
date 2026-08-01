import { useState, useMemo, useEffect } from 'react';
import { FileDiff, FileStatus, DiffHunk } from '../../lib/agentClient';
import { DiffViewer } from './DiffViewer';
import { BlameViewer } from './BlameViewer';
import { useBlame, useBlameContext } from '../../hooks/useBlame';
import { cn } from '../../lib/utils';
import { Message } from '../../stores/workspaceStore';
import { Button } from '../../../@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../@/components/ui/tabs';
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '../../../@/components/ui/collapsible';
import {
    ChevronDown,
    ChevronRight,
    FilePlus,
    FileX,
    FilePen,
    FileCode2,
    ArrowRight,
    Binary,
    AlertTriangle,
    Loader2,
    GitBranch,
    SplitSquareHorizontal,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface FileDiffPanelProps {
    /** File diff data */
    fileDiff: FileDiff;
    /** Label for the source (from) version */
    fromLabel?: string;
    /** Label for the target (to) version */
    toLabel?: string;
    /** Start expanded */
    defaultExpanded?: boolean;
    /** Callback to request full diff content (for lazy loading) */
    onRequestFullDiff?: () => void;
    /** Whether full diff is currently loading */
    isLoadingFullDiff?: boolean;
    /** Extra CSS classes */
    className?: string;
    /** Optional ID for scrolling */
    id?: string;
    /** Node ID for blame computation (enables blame tab) */
    nodeId?: string;
    /** Repo path for blame computation */
    repoPath?: string;
    /** Commit for blame computation */
    commit?: string;
    /** Workspace messages for commit-to-node mapping */
    messages?: Message[];
    /** Base commit for base blame entries */
    baseCommitSha?: string | null;
    /** Callback when clicking a node in blame view */
    onNodeClick?: (nodeId: string) => void;
    /** Whether to show blame tab */
    showBlameTab?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getStatusIcon(status: FileStatus) {
    switch (status) {
        case 'added':
            return <FilePlus size={14} className="text-green-500" />;
        case 'deleted':
            return <FileX size={14} className="text-red-500" />;
        case 'modified':
            return <FilePen size={14} className="text-amber-500" />;
        case 'renamed':
            return <ArrowRight size={14} className="text-blue-500" />;
        default:
            return <FileCode2 size={14} className="text-muted-foreground" />;
    }
}

function getStatusBadge(status: FileStatus) {
    const badges: Record<FileStatus, { label: string; className: string }> = {
        added: {
            label: 'Added',
            className: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
        },
        deleted: {
            label: 'Deleted',
            className: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
        },
        modified: {
            label: 'Modified',
            className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
        },
        renamed: {
            label: 'Renamed',
            className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
        },
        unchanged: {
            label: 'Unchanged',
            className: 'bg-muted text-muted-foreground border-border',
        },
    };
    return badges[status] || badges.unchanged;
}

function getFileExtension(path: string): string {
    const parts = path.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
}

function getLanguageFromExtension(ext: string): string | undefined {
    const languageMap: Record<string, string> = {
        js: 'javascript',
        jsx: 'javascript',
        ts: 'typescript',
        tsx: 'typescript',
        py: 'python',
        rs: 'rust',
        go: 'go',
        java: 'java',
        kt: 'kotlin',
        swift: 'swift',
        rb: 'ruby',
        php: 'php',
        cpp: 'cpp',
        c: 'c',
        h: 'c',
        hpp: 'cpp',
        cs: 'csharp',
        css: 'css',
        scss: 'scss',
        less: 'less',
        html: 'html',
        xml: 'xml',
        json: 'json',
        yaml: 'yaml',
        yml: 'yaml',
        md: 'markdown',
        sql: 'sql',
        sh: 'bash',
        bash: 'bash',
        zsh: 'bash',
        fish: 'bash',
        dockerfile: 'dockerfile',
        toml: 'toml',
    };
    return languageMap[ext.toLowerCase()];
}

function hunksToCode(hunks: DiffHunk[] | null | undefined): { oldCode: string; newCode: string } {
    if (!hunks || hunks.length === 0) {
        return { oldCode: '', newCode: '' };
    }

    // Combine all hunk contents
    // Each hunk.content is a unified diff snippet
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const hunk of hunks) {
        const lines = hunk.content.split('\n');
        for (const line of lines) {
            if (line.startsWith('-')) {
                oldLines.push(line.slice(1));
            } else if (line.startsWith('+')) {
                newLines.push(line.slice(1));
            } else if (line.startsWith(' ')) {
                oldLines.push(line.slice(1));
                newLines.push(line.slice(1));
            } else if (line.length > 0 && !line.startsWith('\\')) {
                // Context line without prefix
                oldLines.push(line);
                newLines.push(line);
            }
        }
    }

    return {
        oldCode: oldLines.join('\n'),
        newCode: newLines.join('\n'),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function FileDiffPanel({
    fileDiff,
    fromLabel = 'Before',
    toLabel = 'After',
    defaultExpanded = false,
    onRequestFullDiff,
    isLoadingFullDiff = false,
    className,
    id,
    nodeId,
    repoPath,
    commit,
    messages = [],
    baseCommitSha = null,
    onNodeClick,
    showBlameTab = false,
}: FileDiffPanelProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const [activeTab, setActiveTab] = useState<'diff' | 'blame'>('diff');

    // Blame data - only fetch when blame tab is active and we have required props
    const blameEnabled = showBlameTab && Boolean(nodeId && repoPath && commit);
    const { data: blameResult, isLoading: blameLoading, error: blameError } = useBlame(
        activeTab === 'blame' && blameEnabled ? nodeId ?? null : null,
        repoPath ?? null,
        commit ?? null,
        fileDiff.path,
        messages,
        baseCommitSha
    );
    const { data: blameContext } = useBlameContext(
        activeTab === 'blame' && blameEnabled && blameResult ? nodeId ?? null : null,
        fileDiff.path
    );

    // Sync with defaultExpanded prop when it changes (for Expand/Collapse All)
    useEffect(() => {
        setIsExpanded(defaultExpanded);
    }, [defaultExpanded]);

    const statusBadge = getStatusBadge(fileDiff.status);
    const extension = getFileExtension(fileDiff.path);
    const language = getLanguageFromExtension(extension);

    const hasHunks = fileDiff.hunks && fileDiff.hunks.length > 0;
    const isTruncated = fileDiff.truncated;

    const { oldCode, newCode } = useMemo(() => {
        if (!hasHunks) return { oldCode: '', newCode: '' };
        return hunksToCode(fileDiff.hunks);
    }, [fileDiff.hunks, hasHunks]);

    // File basename for display
    const fileName = fileDiff.path.split('/').pop() || fileDiff.path;
    const dirPath = fileDiff.path.slice(0, -fileName.length);

    const handleExpand = () => {
        setIsExpanded(!isExpanded);
        // Request full diff if expanding and we don't have hunks
        if (!isExpanded && !hasHunks && onRequestFullDiff) {
            onRequestFullDiff();
        }
    };

    return (
        <Collapsible
            id={id}
            open={isExpanded}
            onOpenChange={setIsExpanded}
            className={cn(
                "min-w-0 max-w-full border border-border/60 rounded-lg overflow-hidden",
                "bg-background/50 hover:bg-background/80 transition-colors",
                className
            )}
        >
            {/* Header */}
            <CollapsibleTrigger asChild>
                <button
                    className={cn(
                        "min-w-0 w-full max-w-full flex items-center gap-3 px-3 py-2.5",
                        "hover:bg-muted/50 transition-colors text-left",
                        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                    onClick={handleExpand}
                >
                    {/* Expand chevron */}
                    <span className="text-muted-foreground">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>

                    {/* Status icon */}
                    {getStatusIcon(fileDiff.status)}

                    {/* File path */}
                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                        {fileDiff.status === 'renamed' && fileDiff.old_path ? (
                            <>
                                <span className="text-sm text-muted-foreground truncate">
                                    {fileDiff.old_path}
                                </span>
                                <ArrowRight size={12} className="text-muted-foreground flex-shrink-0" />
                                <span className="text-sm font-medium truncate">
                                    {fileDiff.path}
                                </span>
                            </>
                        ) : (
                            <>
                                <span className="text-xs text-muted-foreground truncate">
                                    {dirPath}
                                </span>
                                <span className="min-w-0 truncate text-sm font-medium">
                                    {fileName}
                                </span>
                            </>
                        )}
                    </div>

                    {/* Binary indicator */}
                    {fileDiff.is_binary && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Binary size={12} />
                            Binary
                        </span>
                    )}

                    {/* Truncation warning */}
                    {isTruncated && (
                        <span className="flex items-center gap-1 text-xs text-amber-500">
                            <AlertTriangle size={12} />
                            Truncated
                        </span>
                    )}

                    {/* Stats */}
                    <div className="flex items-center gap-2 text-xs">
                        {fileDiff.additions > 0 && (
                            <span className="text-green-600 dark:text-green-400 font-medium">
                                +{fileDiff.additions}
                            </span>
                        )}
                        {fileDiff.deletions > 0 && (
                            <span className="text-red-600 dark:text-red-400 font-medium">
                                -{fileDiff.deletions}
                            </span>
                        )}
                    </div>

                    {/* Status badge */}
                    <span
                        className={cn(
                            "px-2 py-0.5 rounded-full text-[10px] font-medium border",
                            statusBadge.className
                        )}
                    >
                        {statusBadge.label}
                    </span>
                </button>
            </CollapsibleTrigger>

            {/* Content */}
            <CollapsibleContent>
                <div className="min-w-0 max-w-full overflow-hidden border-t border-border/40">
                    {fileDiff.is_binary ? (
                        /* Binary file indicator */
                        <div className="flex items-center justify-center p-8 text-muted-foreground">
                            <Binary size={20} className="mr-2" />
                            <span className="text-sm">Binary file - diff not available</span>
                        </div>
                    ) : blameEnabled ? (
                        /* Tabs for Diff and Blame */
                        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'diff' | 'blame')}>
                            <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border/40">
                                <TabsList className="h-7 bg-transparent p-0 gap-1">
                                    <TabsTrigger
                                        value="diff"
                                        className="h-6 px-2.5 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm"
                                    >
                                        <SplitSquareHorizontal size={12} className="mr-1.5" />
                                        Diff
                                    </TabsTrigger>
                                    <TabsTrigger
                                        value="blame"
                                        className="h-6 px-2.5 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm"
                                    >
                                        <GitBranch size={12} className="mr-1.5" />
                                        Blame
                                    </TabsTrigger>
                                </TabsList>
                            </div>

                            <TabsContent value="diff" className="m-0">
                                {!hasHunks && !isLoadingFullDiff ? (
                                    <div className="flex flex-col items-center justify-center p-8 gap-3">
                                        <span className="text-sm text-muted-foreground">
                                            Diff content not loaded
                                        </span>
                                        {onRequestFullDiff && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={onRequestFullDiff}
                                            >
                                                Load Diff
                                            </Button>
                                        )}
                                    </div>
                                ) : isLoadingFullDiff ? (
                                    <div className="flex items-center justify-center p-8 text-muted-foreground">
                                        <Loader2 size={20} className="mr-2 animate-spin" />
                                        <span className="text-sm">Loading diff...</span>
                                    </div>
                                ) : (
                                    <DiffViewer
                                        oldCode={oldCode}
                                        newCode={newCode}
                                        oldLabel={fromLabel}
                                        newLabel={toLabel}
                                        language={language}
                                        showViewToggle={true}
                                        maxHeight="500px"
                                    />
                                )}
                            </TabsContent>

                            <TabsContent value="blame" className="m-0">
                                {blameLoading ? (
                                    <div className="flex items-center justify-center p-8 text-muted-foreground">
                                        <Loader2 size={20} className="mr-2 animate-spin" />
                                        <span className="text-sm">Computing blame...</span>
                                    </div>
                                ) : blameError ? (
                                    <div className="flex flex-col items-center justify-center p-8 text-red-500">
                                        <AlertTriangle size={20} className="mb-2" />
                                        <span className="text-sm">{blameError.message}</span>
                                    </div>
                                ) : blameResult ? (
                                    <BlameViewer
                                        blameResult={blameResult}
                                        blameContext={blameContext}
                                        onNodeClick={onNodeClick}
                                        maxHeight="500px"
                                    />
                                ) : null}
                            </TabsContent>
                        </Tabs>
                    ) : !hasHunks && !isLoadingFullDiff ? (
                        /* No diff content yet - offer to load */
                        <div className="flex flex-col items-center justify-center p-8 gap-3">
                            <span className="text-sm text-muted-foreground">
                                Diff content not loaded
                            </span>
                            {onRequestFullDiff && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={onRequestFullDiff}
                                >
                                    Load Diff
                                </Button>
                            )}
                        </div>
                    ) : isLoadingFullDiff ? (
                        /* Loading state */
                        <div className="flex items-center justify-center p-8 text-muted-foreground">
                            <Loader2 size={20} className="mr-2 animate-spin" />
                            <span className="text-sm">Loading diff...</span>
                        </div>
                    ) : (
                        /* Diff viewer (no blame available) */
                        <DiffViewer
                            oldCode={oldCode}
                            newCode={newCode}
                            oldLabel={fromLabel}
                            newLabel={toLabel}
                            language={language}
                            showViewToggle={true}
                            maxHeight="500px"
                        />
                    )}

                    {/* Truncation warning with load more option */}
                    {isTruncated && hasHunks && (
                        <div className="flex items-center justify-center p-3 bg-amber-500/10 border-t border-amber-500/20">
                            <AlertTriangle size={14} className="mr-2 text-amber-500" />
                            <span className="text-xs text-amber-600 dark:text-amber-400 mr-3">
                                Diff truncated for large file
                            </span>
                            {onRequestFullDiff && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 text-xs"
                                    onClick={onRequestFullDiff}
                                    disabled={isLoadingFullDiff}
                                >
                                    {isLoadingFullDiff ? (
                                        <Loader2 size={12} className="mr-1 animate-spin" />
                                    ) : null}
                                    Load Full Diff
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}

export default FileDiffPanel;
