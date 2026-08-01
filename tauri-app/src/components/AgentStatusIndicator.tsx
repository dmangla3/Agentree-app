import { useState } from 'react';
import { cn } from '../lib/utils';
import { Badge } from '../../@/components/ui/badge';
import type { AgentStatus } from '@shared/agentStatus';
import { getAgentVisualState } from '../lib/agentStateUI';
import { Check, Copy } from 'lucide-react';

interface AgentStatusIndicatorProps {
    status: AgentStatus | null | undefined;
    agentId?: string | null;
    nodeId?: string | null;
    className?: string;
}

export function AgentStatusIndicator({ status, agentId, nodeId, className }: AgentStatusIndicatorProps) {
    const [isCopied, setIsCopied] = useState(false);

    if (!status && !agentId && !nodeId) return null;
    const agentLabel = agentId != null ? String(agentId) : null;
    const idToCopy = nodeId || agentLabel;

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (idToCopy) {
            navigator.clipboard.writeText(idToCopy).catch(console.error);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 1500);
        }
    };

    const config = getAgentVisualState(status);
    const Icon = config.icon;

    return (
        <Badge
            variant="outline"
            className={cn(
                "flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium transition-colors group/agentBadge",
                config.colorClass,
                config.bgColorClass,
                config.borderColorClass,
                className
            )}
        >
            <Icon size={12} className={cn(config.animate && "animate-spin")} />
            <span>Agent {config.label}</span>
            {idToCopy && (
                <div className="flex items-center gap-1 opacity-70 ml-1">
                    <span className="text-[10px] font-mono">({idToCopy.substring(0, 8)})</span>
                    <button
                        onClick={handleCopy}
                        className="p-0.5 hover:bg-black/10 dark:hover:bg-white/10 rounded cursor-pointer transition-colors text-muted-foreground hover:text-foreground"
                        title="Copy Node ID"
                    >
                        {isCopied ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
                    </button>
                </div>
            )}
        </Badge>
    );
}
