import { useMemo, type FC, type ReactNode } from 'react';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { cn } from '../lib/utils';
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from '../../@/components/ui/hover-card';
import { useMessages, useSummaries } from '../hooks/useMessages';
import { useWorkspaceProjection } from '../hooks/useWorkspaceProjection';
import { NodeHoverCardContent } from './NodeHoverCardContent';

interface NodeLinkProps {
    shortId: string;
    workspaceId: string;
    nodeMapping?: Record<string, string>; // shortId -> actual UUID
}

/**
 * Renders a clickable node reference (like n12) that navigates to the node
 * and shows a preview on hover using the same HoverCard as graph nodes
 */
export const NodeLink: FC<NodeLinkProps> = ({
    shortId,
    workspaceId,
    nodeMapping
}) => {
    const dispatchFocus = useWorkspaceStore(state => state.dispatchFocus);

    // Try to resolve the actual message ID from the mapping object
    const actualId = nodeMapping?.[shortId];

    // Get messages from cache (already loaded by workspace view)
    const { data: messages = [] } = useMessages(workspaceId);
    const { data: summaries = [] } = useSummaries(workspaceId);
    const disabledSummaryIds = useMemo(() => new Set<string>(), []);
    const projection = useWorkspaceProjection(messages, summaries, actualId ?? null, disabledSummaryIds, 'node-link-hover');

    const hoverEntity = useMemo(
        () => actualId ? projection.entitiesByMessageId.get(actualId) ?? null : null,
        [actualId, projection]
    );

    const handleNavigate = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (actualId) {
            dispatchFocus({ messageId: actualId, source: 'chat', metadata: { sourceShortId: shortId } });
            // Scroll to the message
            setTimeout(() => {
                const element = document.querySelector(`[data-message-id="${actualId}"]`);
                element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
        }
    };

    // If we can't resolve the ID, just render as styled text (non-interactive)
    if (!actualId) {
        return (
            <span className="font-mono text-xs px-1 py-0.5 bg-muted text-muted-foreground rounded">
                {shortId}
            </span>
        );
    }

    return (
        <HoverCard openDelay={500} closeDelay={100}>
            <HoverCardTrigger asChild>
                <span
                    role="button"
                    tabIndex={0}
                    onClick={handleNavigate}
                    onKeyDown={(e) => e.key === 'Enter' && handleNavigate(e as unknown as React.MouseEvent)}
                    className={cn(
                        "inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 font-mono text-xs",
                        "border-[hsl(var(--app-accent)/0.3)] bg-[hsl(var(--app-accent-soft)/0.58)] text-[hsl(var(--app-accent))]",
                        "cursor-pointer transition-[background-color,border-color,color,transform] duration-normal ease-out-cubic hover:border-[hsl(var(--app-accent)/0.5)] hover:bg-[hsl(var(--app-accent-soft)/0.82)] active:scale-[0.96] motion-reduce:transition-none",
                        "no-underline" // Ensure no underline from parent
                    )}
                >
                    {shortId}
                </span>
            </HoverCardTrigger>
            <HoverCardContent
                side="right"
                align="start"
                className="w-auto p-0 border-none bg-transparent shadow-none"
            >
                {hoverEntity ? (
                    <NodeHoverCardContent entity={hoverEntity} projection={projection} />
                ) : (
                    <div className="rounded-lg border border-[hsl(var(--app-border)/0.72)] bg-[hsl(var(--app-panel))] p-3 text-card-foreground shadow-[0_16px_40px_-28px_hsl(var(--foreground)/0.42)]">
                        <span className="text-sm text-muted-foreground">Message not found</span>
                    </div>
                )}
            </HoverCardContent>
        </HoverCard>
    );
};

/**
 * Parse content and replace node references (n1, n2, etc.) with clickable links
 * @param content - The text content to parse
 * @param workspaceId - Current workspace ID
 * @param nodeMapping - Object mapping short IDs to UUIDs (from tool call annotations)
 */
export function parseNodeReferences(
    content: string,
    workspaceId: string,
    nodeMapping?: Record<string, string>
): ReactNode {
    // Match patterns like n1, n12, n123 - but not when part of longer words
    const nodePattern = /\b(n\d+)\b/g;

    const parts: ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = nodePattern.exec(content)) !== null) {
        // Add text before the match
        if (match.index > lastIndex) {
            parts.push(content.substring(lastIndex, match.index));
        }

        // Add the node link
        parts.push(
            <NodeLink
                key={`${match[1]}-${match.index}`}
                shortId={match[1]}
                workspaceId={workspaceId}
                nodeMapping={nodeMapping}
            />
        );

        lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < content.length) {
        parts.push(content.substring(lastIndex));
    }

    return parts.length > 0 ? <>{parts}</> : content;
}

/**
 * Extract all nodeMappings from message annotations
 * Combines mappings from all tool calls into a single object
 */
export function extractNodeMappings(annotations?: Array<{
    type: string;
    nodeMapping?: Record<string, string>;
    [key: string]: unknown;
}> | null): Record<string, string> {
    if (!annotations) {
        return {};
    }

    const combined: Record<string, string> = {};
    for (const ann of annotations) {
        if (ann.type === 'tool_call' && ann.nodeMapping) {
            Object.assign(combined, ann.nodeMapping);
        }
    }

    return combined;
}

export default NodeLink;
