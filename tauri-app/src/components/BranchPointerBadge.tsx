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
            className={cn('h-5 rounded-full px-2 py-0 text-[10px] font-medium', isShipPath && 'bg-emerald-600 hover:bg-emerald-600')}
        >
            {isShipPath ? `ship:${name}` : name}
        </Badge>
    );
}
