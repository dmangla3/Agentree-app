import { useMemo, useState } from 'react';
import { processFile, type FileDiffMetadata } from '@pierre/diffs';
import { ChevronDown, FileCode2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { DiffViewer } from './DiffViewer';

type ToolFileChange = {
    path: string;
    kind: string;
    diff: string;
    movePath?: string;
};

type RenderableToolFileChange = ToolFileChange & {
    oldCode: string;
    newCode: string;
    fileDiff?: FileDiffMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanChangePath(path: string): string {
    const worktreeMatch = path.match(/\/\.git\/agentree\/worktrees\/[^/]+\/(.+)$/);
    if (worktreeMatch?.[1]) return worktreeMatch[1];
    const agentWorktreeMatch = path.match(/\/\.agentree\/worktrees\/[^/]+\/nodes\/[^/]+\/(.+)$/);
    if (agentWorktreeMatch?.[1]) return agentWorktreeMatch[1];
    if (!path.startsWith('/')) return path;
    const parts = path.split('/').filter(Boolean);
    return parts.slice(-3).join('/') || path;
}

function getChangeKind(change: Record<string, unknown>): { type: string; movePath?: string } {
    if (typeof change.kind === 'string') return { type: change.kind };
    if (!isRecord(change.kind)) return { type: 'update' };
    return {
        type: typeof change.kind.type === 'string' ? change.kind.type : 'update',
        movePath: typeof change.kind.move_path === 'string' ? cleanChangePath(change.kind.move_path) : undefined,
    };
}

export function parseToolFileChanges(payload: unknown): ToolFileChange[] {
    if (!isRecord(payload) || !Array.isArray(payload.changes)) return [];

    return payload.changes.flatMap((change): ToolFileChange[] => {
        if (!isRecord(change) || typeof change.path !== 'string') return [];
        const kind = getChangeKind(change);
        return [{
            path: cleanChangePath(change.path),
            kind: kind.type,
            diff: typeof change.diff === 'string' ? change.diff : '',
            movePath: kind.movePath,
        }];
    });
}

function extractHunkSides(diff: string): { oldCode: string; newCode: string } {
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of diff.split('\n')) {
        if (line.startsWith('@@') || line.startsWith('\\ No newline')) continue;
        if (line.startsWith('+')) {
            newLines.push(line.slice(1));
        } else if (line.startsWith('-')) {
            oldLines.push(line.slice(1));
        } else {
            const content = line.startsWith(' ') ? line.slice(1) : line;
            oldLines.push(content);
            newLines.push(content);
        }
    }

    return { oldCode: oldLines.join('\n'), newCode: newLines.join('\n') };
}

function parseUpdatedFile(change: ToolFileChange): RenderableToolFileChange {
    const hunkSides = extractHunkSides(change.diff);
    if (!change.diff.trim().startsWith('@@')) return { ...change, ...hunkSides };

    const previousPath = change.path;
    const nextPath = change.movePath ?? change.path;
    const patch = [
        `diff --git a/${previousPath} b/${nextPath}`,
        `--- a/${previousPath}`,
        `+++ b/${nextPath}`,
        change.diff,
    ].join('\n');

    try {
        const fileDiff = processFile(patch, { isGitDiff: true, throwOnError: true });
        if (!fileDiff) return { ...change, ...hunkSides };
        return {
            ...change,
            oldCode: fileDiff.deletionLines.join(''),
            newCode: fileDiff.additionLines.join(''),
            fileDiff,
        };
    } catch {
        return { ...change, ...hunkSides };
    }
}

export function makeRenderableToolFileChange(change: ToolFileChange): RenderableToolFileChange {
    const normalizedKind = change.kind.toLowerCase();
    if (normalizedKind === 'add' || normalizedKind === 'added' || normalizedKind === 'create') {
        return { ...change, oldCode: '', newCode: change.diff };
    }
    if (normalizedKind === 'delete' || normalizedKind === 'deleted' || normalizedKind === 'remove') {
        return { ...change, oldCode: change.diff, newCode: '' };
    }
    return parseUpdatedFile(change);
}

function formatKind(kind: string): string {
    const normalized = kind.toLowerCase();
    if (normalized === 'add' || normalized === 'added' || normalized === 'create') return 'Added';
    if (normalized === 'delete' || normalized === 'deleted' || normalized === 'remove') return 'Deleted';
    if (normalized === 'move' || normalized === 'rename') return 'Renamed';
    return 'Modified';
}

function kindTone(kind: string): string {
    const normalized = kind.toLowerCase();
    if (normalized === 'add' || normalized === 'added' || normalized === 'create') {
        return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    }
    if (normalized === 'delete' || normalized === 'deleted' || normalized === 'remove') {
        return 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-300';
    }
    if (normalized === 'move' || normalized === 'rename') {
        return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    }
    return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

function languageFromPath(path: string): string | undefined {
    const extension = path.split('.').pop()?.toLowerCase();
    const languages: Record<string, string> = {
        bash: 'bash', c: 'c', cpp: 'cpp', css: 'css', go: 'go', h: 'c', hpp: 'cpp',
        html: 'html', java: 'java', js: 'javascript', json: 'json', jsx: 'javascript',
        md: 'markdown', mjs: 'javascript', py: 'python', rb: 'ruby', rs: 'rust',
        scss: 'scss', sh: 'bash', sql: 'sql', swift: 'swift', toml: 'toml',
        ts: 'typescript', tsx: 'typescript', xml: 'xml', yaml: 'yaml', yml: 'yaml',
        zsh: 'bash',
    };
    return extension ? languages[extension] : undefined;
}

export function ToolFileChangesDiff({ payload, className }: { payload: unknown; className?: string }) {
    const changes = useMemo(
        () => parseToolFileChanges(payload).map(makeRenderableToolFileChange),
        [payload],
    );
    const [expandedIndexes, setExpandedIndexes] = useState<Set<number>>(
        () => new Set(changes.length === 1 ? [0] : []),
    );

    if (changes.length === 0) return null;

    const toggleExpanded = (index: number) => {
        setExpandedIndexes((current) => {
            const next = new Set(current);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    return (
        <div className={cn(className, 'min-w-0 max-h-none max-w-full space-y-2')} data-tool-file-changes-diff>
            {changes.map((change, index) => {
                const isExpanded = expandedIndexes.has(index);
                const hasTextChanges = change.oldCode !== change.newCode;
                return (
                    <section key={`${change.path}:${index}`} className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background/55">
                        <button
                            type="button"
                            className="flex min-h-10 w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            onClick={() => toggleExpanded(index)}
                            aria-expanded={isExpanded}
                        >
                            <ChevronDown size={12} className={cn('shrink-0 text-muted-foreground/60 transition-transform', !isExpanded && '-rotate-90')} />
                            <FileCode2 size={13} className="shrink-0 text-muted-foreground/65" />
                            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/80" title={change.path}>
                                {change.path}
                                {change.movePath ? ` → ${change.movePath}` : ''}
                            </span>
                            <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide', kindTone(change.kind))}>
                                {formatKind(change.kind)}
                            </span>
                        </button>
                        {isExpanded ? (
                            <div className="border-t border-border/50 p-2">
                                {hasTextChanges ? (
                                    <DiffViewer
                                        oldCode={change.oldCode}
                                        newCode={change.newCode}
                                        fileDiff={change.fileDiff}
                                        oldLabel="Before"
                                        newLabel="After"
                                        splitView={false}
                                        language={languageFromPath(change.path)}
                                        maxHeight="360px"
                                    />
                                ) : (
                                    <div className="rounded-md border border-border/50 bg-muted/25 px-3 py-4 text-center text-[10px] text-muted-foreground">
                                        No textual changes
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </section>
                );
            })}
        </div>
    );
}
