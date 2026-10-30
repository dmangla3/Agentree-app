import type { Icon } from '@phosphor-icons/react';
import { cn } from '../lib/utils';

interface FillIconProps {
  icon: Icon;
  size?: number;
  className?: string;
}

export function FillIcon({ icon: IconComponent, size = 18, className }: FillIconProps) {
  return (
    <span
      className={cn('app-fill-icon relative shrink-0', className)}
      style={{ height: size, width: size }}
      aria-hidden="true"
    >
      <IconComponent className="app-fill-icon-outline" size={size} weight="regular" />
      <IconComponent className="app-fill-icon-filled" size={size} weight="fill" />
    </span>
  );
}

export function RailIcon(props: FillIconProps) {
  return <FillIcon {...props} />;
}
