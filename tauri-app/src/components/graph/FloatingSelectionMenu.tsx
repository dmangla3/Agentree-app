import { useLayoutEffect, useRef, useState } from 'react';
import { useViewport, useStore } from '@xyflow/react';
import { GitCompare, FileText, Trash2, GitMerge } from 'lucide-react';

export interface FloatingSelectionMenuProps {
    position: { x: number; y: number };
    selectedCount: number;
    selectedMessageCount: number;
    selectedCommitCount: number;
    canViewDiff: boolean;
    canGenerateSummary: boolean;
    canMerge: boolean;
    onDelete: () => void;
    onViewDiff: () => void;
    onGenerateSummary: () => void;
    onMerge: () => void;
}

export function FloatingSelectionMenu({
    position,
    selectedCount,
    selectedMessageCount,
    selectedCommitCount,
    canViewDiff,
    canGenerateSummary,
    canMerge,
    onDelete,
    onViewDiff,
    onGenerateSummary,
    onMerge,
}: FloatingSelectionMenuProps) {
    const { x, y, zoom } = useViewport();
    const viewportWidth = useStore((state) => state.width);
    const viewportHeight = useStore((state) => state.height);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [menuSize, setMenuSize] = useState({ width: 0, height: 0 });

    useLayoutEffect(() => {
        if (!menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        if (rect.width !== menuSize.width || rect.height !== menuSize.height) {
            setMenuSize({ width: rect.width, height: rect.height });
        }
    }, [selectedCount, canViewDiff, canGenerateSummary, menuSize.width, menuSize.height]);

    const screenX = position.x * zoom + x;
    const screenY = position.y * zoom + y;
    const padding = 12;
    const safeWidth = menuSize.width || 200;
    const safeHeight = menuSize.height || 160;
    const halfWidth = safeWidth / 2;

    const minX = padding + halfWidth;
    const maxX = Math.max(minX, viewportWidth - padding - halfWidth);
    const clampedX = Math.min(Math.max(screenX, minX), maxX);

    const minY = padding + safeHeight;
    const maxY = Math.max(minY, viewportHeight - padding);
    const clampedY = Math.min(Math.max(screenY, minY), maxY);
    const actionClassName = 'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

    return (
        <div
            ref={menuRef}
            className="pointer-events-auto absolute z-50 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-150"
            style={{
                left: clampedX,
                top: clampedY,
                transform: 'translate(-50%, -100%)',
            }}
        >
            <div className="w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                <div className="px-2 py-1.5">
                    <div className="text-sm font-medium [font-variant-numeric:tabular-nums]">
                        {selectedCount} node{selectedCount === 1 ? '' : 's'} selected
                    </div>
                    <div className="mt-0.5 flex gap-2 text-xs text-muted-foreground [font-variant-numeric:tabular-nums]">
                        <span>
                            {selectedMessageCount} message{selectedMessageCount === 1 ? '' : 's'}
                        </span>
                        <span aria-hidden="true">/</span>
                        <span>
                            {selectedCommitCount} commit{selectedCommitCount === 1 ? '' : 's'}
                        </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                        Esc clears. Shift-drag marquee selects.
                    </div>
                </div>

                <div className="-mx-1 my-1 h-px bg-border" />

                {canViewDiff && (
                    <button type="button" onClick={onViewDiff} className={actionClassName}>
                        <GitCompare />
                        View Diff
                    </button>
                )}

                {canGenerateSummary && (
                    <button
                        type="button"
                        onClick={onGenerateSummary}
                        className={actionClassName}
                        title="Create a new node containing a summary of the selected workspace branch"
                    >
                        <FileText />
                        Generate Summary Node
                    </button>
                )}

                {canMerge && (
                    <button
                        type="button"
                        onClick={onMerge}
                        className={actionClassName}
                        title="Open integration workspace to merge selected nodes"
                    >
                        <GitMerge />
                        Merge Selection
                    </button>
                )}

                <div className="-mx-1 my-1 h-px bg-border" />

                <button
                    type="button"
                    className={`${actionClassName} text-destructive focus:text-destructive [&_svg]:text-destructive`}
                    onClick={onDelete}
                >
                    <Trash2 />
                    Delete Nodes
                </button>
            </div>
        </div>
    );
}
