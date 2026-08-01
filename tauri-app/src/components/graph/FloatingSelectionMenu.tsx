import { useLayoutEffect, useRef, useState } from 'react';
import { useViewport, useStore } from '@xyflow/react';
import { Button } from '../../../@/components/ui/button';
import { Separator } from '../../../@/components/ui/separator';
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

    return (
        <div
            ref={menuRef}
            className="absolute z-50 pointer-events-auto animate-in fade-in slide-in-from-bottom-2 duration-150"
            style={{
                left: clampedX,
                top: clampedY,
                transform: 'translate(-50%, -100%)',
            }}
        >
            <div className="min-w-[240px] overflow-hidden rounded-2xl border border-sky-200/70 bg-white/97 shadow-sm">
                <div className="border-b border-sky-100/80 bg-gradient-to-b from-sky-50/95 to-white px-3 py-2.5">
                    <div className="flex items-center gap-2">
                        <div className="flex h-6 min-w-6 items-center justify-center rounded-full bg-sky-500 px-2 text-[11px] font-semibold text-white [font-variant-numeric:tabular-nums]">
                            {selectedCount}
                        </div>
                        <div className="min-w-0">
                            <div className="text-[12px] font-semibold text-slate-900">
                                Selection ready
                            </div>
                            <div className="text-[11px] text-slate-500 [font-variant-numeric:tabular-nums]">
                                {selectedCount} node{selectedCount === 1 ? '' : 's'} selected
                            </div>
                        </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        <div className="rounded-full border border-sky-200 bg-sky-100/80 px-2 py-1 text-[11px] font-medium text-sky-900 [font-variant-numeric:tabular-nums]">
                            {selectedMessageCount} message{selectedMessageCount === 1 ? '' : 's'}
                        </div>
                        <div className="rounded-full border border-amber-200 bg-amber-100/80 px-2 py-1 text-[11px] font-medium text-amber-900 [font-variant-numeric:tabular-nums]">
                            {selectedCommitCount} commit{selectedCommitCount === 1 ? '' : 's'}
                        </div>
                    </div>
                    <div className="mt-2 text-[11px] text-slate-500">
                        Esc clears. Shift-drag marquee selects.
                    </div>
                </div>

                <Separator />

                {canViewDiff && (
                    <Button variant="ghost" size="sm" onClick={onViewDiff} className="h-9 w-full justify-start rounded-none px-3 active:scale-[0.98]">
                        <GitCompare className="w-4 h-4 mr-2" />
                        View Diff
                    </Button>
                )}

                {canGenerateSummary && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onGenerateSummary}
                        className="h-9 w-full justify-start rounded-none px-3 active:scale-[0.98]"
                        title="Create a new node containing a summary of the selected workspace branch"
                    >
                        <FileText className="w-4 h-4 mr-2" />
                        Generate Summary Node
                    </Button>
                )}

                {canMerge && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onMerge}
                        className="h-9 w-full justify-start rounded-none px-3 text-primary active:scale-[0.98]"
                        title="Open integration workspace to merge selected nodes"
                    >
                        <GitMerge className="w-4 h-4 mr-2" />
                        Merge Selection
                    </Button>
                )}

                <Separator />

                <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 w-full justify-start rounded-none px-3 text-destructive active:scale-[0.98]"
                    onClick={onDelete}
                >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete Nodes
                </Button>
            </div>
        </div>
    );
}
