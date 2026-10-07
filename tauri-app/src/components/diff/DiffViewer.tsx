import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
    FileDiff as PierreFileDiff,
    parseDiffFromFile,
    type FileDiffMetadata,
    type FileDiffOptions,
} from '@pierre/diffs';
import { cn } from '../../lib/utils';
import { Button } from '../../../@/components/ui/button';
import { SplitSquareHorizontal, AlignJustify, Copy, Check } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface DiffViewerProps {
    /** Old (before) code content */
    oldCode: string;
    /** New (after) code content */
    newCode: string;
    /** Pre-parsed patch metadata. When provided, preserves original hunk positions. */
    fileDiff?: FileDiffMetadata;
    /** Label for old version (e.g., "Parent Node") */
    oldLabel?: string;
    /** Label for new version (e.g., "Current Node") */
    newLabel?: string;
    /** Show side-by-side (true) or unified (false) view */
    splitView?: boolean;
    /** Programming language for syntax highlighting */
    language?: string;
    /** Lines to highlight (1-indexed) */
    highlightLines?: number[];
    /** Show line numbers */
    showLineNumbers?: boolean;
    /** Extra CSS classes */
    className?: string;
    /** Allow toggling between split and unified views */
    showViewToggle?: boolean;
    /** Callback when view mode changes */
    onViewModeChange?: (splitView: boolean) => void;
    /** Maximum height before scrolling */
    maxHeight?: string;
}

const getIsDarkMode = (): boolean => (
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
);

const diffHostStyle = {
    '--diffs-font-size': '12px',
    '--diffs-line-height': '20px',
    '--diffs-light-bg': '#fafbfc',
    '--diffs-dark-bg': '#0d1117',
    '--diffs-light': '#24292e',
    '--diffs-dark': '#c9d1d9',
    '--diffs-light-addition-color': '#22863a',
    '--diffs-dark-addition-color': '#3fb950',
    '--diffs-light-deletion-color': '#cb2431',
    '--diffs-dark-deletion-color': '#f85149',
} as CSSProperties;

const buildHighlightStyles = (lines: number[]): string => (
    [...new Set(lines)]
        .filter((line) => Number.isInteger(line) && line > 0)
        .map((line) => `
            [data-line="${line}"], [data-column-number="${line}"] {
                --diffs-line-bg: light-dark(#fffbdd, #3d3214);
            }
        `)
        .join('\n')
);

function PierreDiffRenderer({
    fileDiff,
    options,
}: {
    fileDiff: FileDiffMetadata;
    options: FileDiffOptions<undefined>;
}) {
    const containerRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return undefined;

        const renderer = new PierreFileDiff(options);
        renderer.render({ fileDiff, containerWrapper: container });
        return () => renderer.cleanUp();
    }, [fileDiff, options]);

    return <div ref={containerRef} data-diff-renderer="pierre" style={diffHostStyle} />;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function DiffViewer({
    oldCode,
    newCode,
    fileDiff: parsedFileDiff,
    oldLabel = 'Before',
    newLabel = 'After',
    splitView: initialSplitView = true,
    language,
    highlightLines = [],
    showLineNumbers = true,
    className,
    showViewToggle = true,
    onViewModeChange,
    maxHeight,
}: DiffViewerProps) {
    const [splitView, setSplitView] = useState(initialSplitView);
    const [copied, setCopied] = useState<'old' | 'new' | null>(null);
    const [isDarkMode, setIsDarkMode] = useState(getIsDarkMode);

    useEffect(() => {
        const observer = new MutationObserver(() => setIsDarkMode(getIsDarkMode()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    const fileDiff = useMemo(() => parsedFileDiff ?? parseDiffFromFile(
        { name: 'file', contents: oldCode, ...(language ? { lang: language } : {}) },
        { name: 'file', contents: newCode, ...(language ? { lang: language } : {}) },
    ), [language, newCode, oldCode, parsedFileDiff]);
    const highlightStyles = useMemo(() => buildHighlightStyles(highlightLines), [highlightLines]);
    const diffOptions = useMemo<FileDiffOptions<undefined>>(() => ({
        diffStyle: splitView ? 'split' : 'unified',
        disableFileHeader: true,
        disableLineNumbers: !showLineNumbers,
        expandUnchanged: false,
        collapsedContextThreshold: 3,
        lineDiffType: 'word',
        overflow: 'scroll',
        themeType: isDarkMode ? 'dark' : 'light',
        unsafeCSS: highlightStyles,
    }), [highlightStyles, isDarkMode, showLineNumbers, splitView]);

    const handleViewModeChange = (newSplitView: boolean) => {
        setSplitView(newSplitView);
        onViewModeChange?.(newSplitView);
    };

    const handleCopy = async (content: string, type: 'old' | 'new') => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(type);
            setTimeout(() => setCopied(null), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    // No changes check
    const hasChanges = oldCode !== newCode;

    if (!hasChanges) {
        return (
            <div className={cn(
                "flex items-center justify-center p-8 text-muted-foreground",
                "bg-muted/30 rounded-md border border-border/50",
                className
            )}>
                <span className="text-sm">No differences</span>
            </div>
        );
    }

    return (
        <div className={cn("relative min-w-0 max-w-full overflow-hidden rounded-md border border-border/50", className)}>
            {/* Header with controls */}
            {showViewToggle && (
                <div className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 bg-muted/50 border-b border-border/50">
                    <div className="flex min-w-0 items-center gap-4 text-xs text-muted-foreground">
                        <span className="min-w-0 truncate font-medium">{oldLabel}</span>
                        <span>→</span>
                        <span className="min-w-0 truncate font-medium">{newLabel}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        {/* Copy buttons */}
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleCopy(oldCode, 'old')}
                            title="Copy old version"
                        >
                            {copied === 'old' ? <Check size={12} /> : <Copy size={12} />}
                            <span className="ml-1">Old</span>
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleCopy(newCode, 'new')}
                            title="Copy new version"
                        >
                            {copied === 'new' ? <Check size={12} /> : <Copy size={12} />}
                            <span className="ml-1">New</span>
                        </Button>

                        <div className="w-px h-4 bg-border mx-1" />

                        {/* View mode toggle */}
                        <Button
                            variant={splitView ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => handleViewModeChange(true)}
                            title="Side-by-side view"
                        >
                            <SplitSquareHorizontal size={14} />
                        </Button>
                        <Button
                            variant={!splitView ? "secondary" : "ghost"}
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => handleViewModeChange(false)}
                            title="Unified view"
                        >
                            <AlignJustify size={14} />
                        </Button>
                    </div>
                </div>
            )}

            {/* Diff content */}
            <div
                className="min-w-0 w-full max-w-full overflow-auto"
                style={{ maxHeight }}
            >
                <PierreDiffRenderer
                    fileDiff={fileDiff}
                    options={diffOptions}
                />
            </div>

            {/* Language badge */}
            {language && (
                <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded text-[10px] bg-muted/80 text-muted-foreground border border-border/30">
                    {language}
                </div>
            )}
        </div>
    );
}

export default DiffViewer;
