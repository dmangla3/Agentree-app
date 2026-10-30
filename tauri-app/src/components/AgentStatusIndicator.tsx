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
                "group/agentBadge flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium transition-[background-color,border-color,color] duration-normal ease-out-cubic motion-reduce:transition-none",
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
                        className="cursor-pointer rounded p-0.5 text-muted-foreground transition-[background-color,color,transform] duration-normal ease-out-cubic hover:bg-foreground/10 hover:text-foreground active:scale-[0.96] motion-reduce:transition-none"
                        title="Copy Node ID"
                    >
                        {isCopied ? <Check size={10} className="text-[hsl(var(--app-success))]" /> : <Copy size={10} />}
                    </button>
                </div>
            )}
        </Badge>
    );
}
