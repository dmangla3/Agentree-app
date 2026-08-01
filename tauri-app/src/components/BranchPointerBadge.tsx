import { Badge } from '../../@/components/ui/badge';
import { cn } from '../lib/utils';

interface BranchPointerBadgeProps {
    name: string;
    isShipPath?: boolean;
}

export function BranchPointerBadge({ name, isShipPath = false }: BranchPointerBadgeProps) {
    return (
        <Badge
            variant={isShipPath ? 'default' : 'outline'}
            className={cn('text-[10px] px-1.5 py-0 h-5', isShipPath && 'bg-emerald-600 hover:bg-emerald-600')}
        >
            {isShipPath ? `ship:${name}` : name}
        </Badge>
    );
}
