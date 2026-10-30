import { useState, useMemo, useEffect } from 'react';
import { processFile, type FileDiffMetadata } from '@pierre/diffs';
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
            return <ArrowRight size={14} className="text-[hsl(var(--app-graph-agent))]" />;
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
            className: 'bg-[hsl(var(--app-graph-agent)/0.1)] text-[hsl(var(--app-graph-agent))] border-[hsl(var(--app-graph-agent)/0.3)]',
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

export function buildFileDiffPatch(fileDiff: FileDiff): string {
    const oldPath = fileDiff.old_path ?? fileDiff.path;
    const oldHeader = fileDiff.status === 'added' ? '/dev/null' : `a/${oldPath}`;
    const newHeader = fileDiff.status === 'deleted' ? '/dev/null' : `b/${fileDiff.path}`;
    const hunks = (fileDiff.hunks ?? []).map((hunk: DiffHunk) => {
        const content = hunk.content.endsWith('\n') ? hunk.content : `${hunk.content}\n`;
        return `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@\n${content}`;
    }).join('');

    return [
        `diff --git a/${oldPath} b/${fileDiff.path}`,
        `--- ${oldHeader}`,
        `+++ ${newHeader}`,
        hunks,
    ].join('\n');
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

    const pierreFileDiff = useMemo<FileDiffMetadata | undefined>(() => {
        if (!hasHunks) return undefined;
        const parsed = processFile(buildFileDiffPatch(fileDiff), {
            isGitDiff: true,
            throwOnError: true,
        });
        return parsed && language ? { ...parsed, lang: language } : parsed;
    }, [fileDiff, hasHunks, language]);
    const oldCode = pierreFileDiff?.deletionLines.join('\n') ?? '';
    const newCode = pierreFileDiff?.additionLines.join('\n') ?? '';

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
            data-design-scope="panels"
            className={cn(
                "min-w-0 max-w-full overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)]",
                "bg-background/50 transition-[background-color,box-shadow] duration-150 ease-out hover:bg-background/80",
                className
            )}
        >
            {/* Header */}
            <CollapsibleTrigger asChild>
                <button
                    className={cn(
                        "min-h-10 min-w-0 w-full max-w-full flex items-center gap-2.5 rounded-lg px-3 py-2",
                        "text-left transition-[background-color,transform] duration-150 ease-out hover:bg-muted/50 active:scale-[0.96]",
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
                            "rounded-md border px-2 py-0.5 text-[10px] font-medium",
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
                        <div className="flex items-center justify-center p-6 text-muted-foreground">
                            <Binary size={20} className="mr-2" />
                            <span className="text-sm">Binary file - diff not available</span>
                        </div>
                    ) : blameEnabled ? (
                        /* Tabs for Diff and Blame */
                        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'diff' | 'blame')}>
                            <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border/40">
                                <TabsList className="h-10 gap-1 bg-transparent p-0">
                                    <TabsTrigger
                                        value="diff"
                                        className="h-10 rounded-lg px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm"
                                    >
                                        <SplitSquareHorizontal size={12} className="mr-1.5" />
                                        Diff
                                    </TabsTrigger>
                                    <TabsTrigger
                                        value="blame"
                                        className="h-10 rounded-lg px-3 text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm"
                                    >
                                        <GitBranch size={12} className="mr-1.5" />
                                        Blame
                                    </TabsTrigger>
                                </TabsList>
                            </div>

                            <TabsContent value="diff" className="m-0">
                                {!hasHunks && !isLoadingFullDiff ? (
                                    <div className="flex flex-col items-center justify-center gap-2 p-6">
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
                                    <div className="flex items-center justify-center p-6 text-muted-foreground">
                                        <Loader2 size={20} className="mr-2 animate-spin" />
                                        <span className="text-sm">Loading diff...</span>
                                    </div>
                                ) : (
                                    <DiffViewer
                                        oldCode={oldCode}
                                        newCode={newCode}
                                        fileDiff={pierreFileDiff}
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
                                    <div className="flex items-center justify-center p-6 text-muted-foreground">
                                        <Loader2 size={20} className="mr-2 animate-spin" />
                                        <span className="text-sm">Computing blame...</span>
                                    </div>
                                ) : blameError ? (
                                    <div className="flex flex-col items-center justify-center p-6 text-[hsl(var(--app-danger))]">
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
                        <div className="flex flex-col items-center justify-center gap-2 p-6">
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
                        <div className="flex items-center justify-center p-6 text-muted-foreground">
                            <Loader2 size={20} className="mr-2 animate-spin" />
                            <span className="text-sm">Loading diff...</span>
                        </div>
                    ) : (
                        /* Diff viewer (no blame available) */
                        <DiffViewer
                            oldCode={oldCode}
                            newCode={newCode}
                            fileDiff={pierreFileDiff}
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
                                    className="h-10 rounded-lg text-xs"
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
