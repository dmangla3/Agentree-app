import { useMemo, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
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

// ═══════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════

const lightStyles = {
    variables: {
        light: {
            diffViewerBackground: '#fafbfc',
            diffViewerColor: '#24292e',
            addedBackground: '#e6ffec',
            addedColor: '#22863a',
            removedBackground: '#ffebe9',
            removedColor: '#cb2431',
            wordAddedBackground: '#acf2bd',
            wordRemovedBackground: '#fdb8c0',
            addedGutterBackground: '#cdffd8',
            removedGutterBackground: '#ffdce0',
            gutterBackground: '#f7f7f7',
            gutterBackgroundDark: '#f3f3f3',
            highlightBackground: '#fffbdd',
            highlightGutterBackground: '#fff5b1',
            codeFoldGutterBackground: '#dbedff',
            codeFoldBackground: '#f1f8ff',
            emptyLineBackground: '#fafbfc',
            gutterColor: '#6a737d',
            addedGutterColor: '#22863a',
            removedGutterColor: '#cb2431',
            codeFoldContentColor: '#0366d6',
            diffViewerTitleBackground: '#f1f8ff',
            diffViewerTitleColor: '#24292e',
            diffViewerTitleBorderColor: '#e1e4e8',
        },
    },
    line: {
        padding: '2px 10px',
        '&:hover': {
            background: '#f1f8ff',
        },
    },
    contentText: {
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: '20px',
        whiteSpace: 'pre',
    },
    gutter: {
        minWidth: '40px',
        padding: '0 10px',
        '&:hover': {
            cursor: 'pointer',
            background: '#d0d0d0',
        },
    },
    marker: {
        padding: '0 6px',
    },
    codeFold: {
        fontSize: '11px',
        fontWeight: 500,
    },
    titleBlock: {
        padding: '8px 10px',
        borderBottom: '1px solid #e1e4e8',
    },
};

const darkStyles = {
    variables: {
        dark: {
            diffViewerBackground: '#0d1117',
            diffViewerColor: '#c9d1d9',
            addedBackground: '#12261e',
            addedColor: '#3fb950',
            removedBackground: '#2d1517',
            removedColor: '#f85149',
            wordAddedBackground: '#033a16',
            wordRemovedBackground: '#67060c',
            addedGutterBackground: '#0a3d1c',
            removedGutterBackground: '#4a1010',
            gutterBackground: '#161b22',
            gutterBackgroundDark: '#0d1117',
            highlightBackground: '#3d3214',
            highlightGutterBackground: '#4d4019',
            codeFoldGutterBackground: '#161b22',
            codeFoldBackground: '#161b22',
            emptyLineBackground: '#0d1117',
            gutterColor: '#8b949e',
            addedGutterColor: '#3fb950',
            removedGutterColor: '#f85149',
            codeFoldContentColor: '#58a6ff',
            diffViewerTitleBackground: '#161b22',
            diffViewerTitleColor: '#c9d1d9',
            diffViewerTitleBorderColor: '#30363d',
        },
    },
    line: {
        padding: '2px 10px',
        '&:hover': {
            background: '#1c2128',
        },
    },
    contentText: {
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: '20px',
        whiteSpace: 'pre',
    },
    gutter: {
        minWidth: '40px',
        padding: '0 10px',
        '&:hover': {
            cursor: 'pointer',
            background: '#30363d',
        },
    },
    marker: {
        padding: '0 6px',
    },
    codeFold: {
        fontSize: '11px',
        fontWeight: 500,
    },
    titleBlock: {
        padding: '8px 10px',
        borderBottom: '1px solid #30363d',
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export function DiffViewer({
    oldCode,
    newCode,
    oldLabel = 'Before',
    newLabel = 'After',
    splitView: initialSplitView = true,
    language,
    highlightLines: _highlightLines = [],
    showLineNumbers = true,
    className,
    showViewToggle = true,
    onViewModeChange,
}: DiffViewerProps) {
    const [splitView, setSplitView] = useState(initialSplitView);
    const [copied, setCopied] = useState<'old' | 'new' | null>(null);

    // Detect dark mode
    const isDarkMode = useMemo(() => {
        if (typeof window === 'undefined') return false;
        return document.documentElement.classList.contains('dark');
    }, []);

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

    // Convert highlight lines to format expected by react-diff-viewer
    // Note: highlighting support can be added in future iterations

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
                className="min-w-0 w-full max-w-full overflow-x-auto"
            >
                <ReactDiffViewer
                    oldValue={oldCode}
                    newValue={newCode}
                    splitView={splitView}
                    useDarkTheme={isDarkMode}
                    styles={isDarkMode ? darkStyles : lightStyles}
                    showDiffOnly={true}
                    extraLinesSurroundingDiff={3}
                    compareMethod={DiffMethod.WORDS}
                    hideLineNumbers={!showLineNumbers}
                    leftTitle={oldLabel}
                    rightTitle={newLabel}
                    renderContent={(source) => {
                        // Basic syntax highlighting could be added here
                        // For now, just return the source with monospace styling
                        return <span>{source}</span>;
                    }}
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
