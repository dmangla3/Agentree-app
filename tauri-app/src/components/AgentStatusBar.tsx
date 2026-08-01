import { useState } from 'react';
import { Button } from '../../@/components/ui/button';
import { Square, FileText, Zap, Activity } from 'lucide-react';
import { cn } from '../lib/utils';
import { agentClient } from '../lib/agentClient';
import { Message } from '../stores/workspaceStore';
import { resolveNodeCommit, resolveParentCommit } from '../lib/gitNodeUtils';

interface AgentStatusBarProps {
    sessionId: string | null;
    repoPath: string | null;
    message?: Message | null;
    messages?: Message[];
    baseCommitSha?: string | null;
    isRunning: boolean;
    onStop: () => void;
    onViewChanges?: () => void;
    turnCount?: number;
    maxTurns?: number;
    tokenCount?: number;
}

export function AgentStatusBar({
    sessionId,
    repoPath,
    message = null,
    messages = [],
    baseCommitSha = null,
    isRunning,
    onStop,
    onViewChanges,
    turnCount = 0,
    maxTurns = 20,
    tokenCount,
}: AgentStatusBarProps) {
    const [changes, setChanges] = useState<{ path: string; status: string }[]>([]);
    const [showingChanges, setShowingChanges] = useState(false);

    // Fetch committed git changes for this node when requested.
    const handleViewChanges = async () => {
        if (!sessionId || !repoPath || !message) return;

        if (showingChanges) {
            setShowingChanges(false);
            return;
        }

        try {
            const parentCommit = resolveParentCommit(message, messages, baseCommitSha);
            const nodeCommit = resolveNodeCommit(message, messages, baseCommitSha);
            if (!parentCommit || !nodeCommit) {
                setChanges([]);
                setShowingChanges(true);
                onViewChanges?.();
                return;
            }
            const diff = await agentClient.diffCommits(repoPath, parentCommit, nodeCommit, false);
            setChanges(diff.files.map(f => ({ path: f.path, status: f.status })));
            setShowingChanges(true);
            onViewChanges?.();
        } catch (error) {
            console.error('Failed to get git changes:', error);
            setChanges([]);
        }
    };

    if (!isRunning && !sessionId) {
        return null;
    }

    return (
        <div className="rounded-lg border bg-card overflow-hidden">
            {/* Status Bar */}
            <div className="flex items-center justify-between p-3 bg-muted/30">
                <div className="flex items-center gap-4">
                    {/* Status Indicator */}
                    <div className="flex items-center gap-2">
                        <div className={cn(
                            "h-2 w-2 rounded-full",
                            isRunning ? "bg-green-500 animate-pulse" : "bg-gray-400"
                        )} />
                        <span className="text-sm font-medium">
                            {isRunning ? 'Agent Running' : 'Agent Stopped'}
                        </span>
                    </div>

                    {/* Turn Counter */}
                    {turnCount > 0 && (
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                            <Activity className="h-4 w-4" />
                            <span>Turn {turnCount}/{maxTurns}</span>
                        </div>
                    )}

                    {/* Token Count */}
                    {tokenCount !== undefined && (
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                            <Zap className="h-4 w-4" />
                            <span>{tokenCount.toLocaleString()} tokens</span>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleViewChanges}
                        disabled={!sessionId}
                    >
                        <FileText className="h-4 w-4 mr-1" />
                        {showingChanges ? 'Hide Changes' : 'View Changes'}
                    </Button>

                    {isRunning && (
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={onStop}
                        >
                            <Square className="h-4 w-4 mr-1" />
                            Stop Agent
                        </Button>
                    )}
                </div>
            </div>

            {/* Changes Panel */}
            {showingChanges && changes.length > 0 && (
                <div className="border-t p-3 bg-background">
                    <div className="text-sm font-medium mb-2">Changed Files ({changes.length})</div>
                    <ul className="space-y-1 max-h-32 overflow-y-auto">
                        {changes.map((file, idx) => (
                            <li key={idx} className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                                <span className={cn(
                                    file.status === 'added' && "text-green-600",
                                    file.status === 'modified' && "text-yellow-600",
                                    file.status === 'deleted' && "text-red-600",
                                )}>
                                    {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
                                </span>
                                {file.path}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {showingChanges && changes.length === 0 && (
                <div className="border-t p-3 bg-background">
                    <p className="text-sm text-muted-foreground">No file changes detected.</p>
                </div>
            )}
        </div>
    );
}
