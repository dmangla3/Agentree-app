import { cn } from "../../../src/lib/utils";
import { DURATION } from "../../../src/lib/animation";

/**
 * Skeleton Component
 * 
 * Loading placeholder that mimics the structure of content while it's loading.
 * Uses pulse animation by default, can be disabled for reduced motion.
 * 
 * @example
 * // Basic usage
 * <Skeleton className="h-4 w-[250px]" />
 * 
 * // Circle avatar skeleton
 * <Skeleton className="h-12 w-12 rounded-full" />
 * 
 * // Card skeleton with multiple elements
 * <div className="space-y-2">
 *   <Skeleton className="h-4 w-[250px]" />
 *   <Skeleton className="h-4 w-[200px]" />
 * </div>
 * 
 * // Without animation (for reduced motion)
 * <Skeleton className="h-4 w-[250px]" animate={false} />
 */

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Whether to show the pulse animation
   * @default true
   */
  animate?: boolean;
  /**
   * The variant of skeleton to render
   * @default "default"
   */
  variant?: "default" | "card" | "avatar" | "text" | "button";
}

function Skeleton({
  className,
  animate = true,
  variant = "default",
  ...props
}: SkeletonProps) {
  const variantClasses = {
    default: "rounded-md",
    card: "rounded-xl",
    avatar: "rounded-full",
    text: "rounded-sm",
    button: "rounded-md",
  };

  return (
    <div
      className={cn(
        "bg-muted",
        variantClasses[variant],
        animate && "animate-pulse",
        className
      )}
      style={{
        // Use CSS custom property for animation duration if needed
        animationDuration: animate ? `${DURATION.slow * 2}s` : undefined,
      }}
      {...props}
    />
  );
}

/**
 * SkeletonCard - Pre-configured skeleton for card layouts
 */
function SkeletonCard({ className, ...props }: Omit<SkeletonProps, "variant">) {
  return (
    <div className={cn("space-y-3 p-4", className)} {...props}>
      <div className="flex items-center space-x-4">
        <Skeleton variant="avatar" className="h-12 w-12" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-4 w-[150px]" />
          <Skeleton className="h-3 w-[100px]" />
        </div>
      </div>
      <div className="space-y-2 pt-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[90%]" />
        <Skeleton className="h-4 w-[80%]" />
      </div>
    </div>
  );
}

/**
 * SkeletonText - Pre-configured skeleton for text blocks
 */
function SkeletonText({ 
  lines = 3, 
  className,
  animate,
}: { 
  lines?: number; 
  className?: string;
  animate?: boolean;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          variant="text"
          className={cn(
            "h-4",
            i === lines - 1 ? "w-[75%]" : "w-full"
          )}
          animate={animate}
        />
      ))}
    </div>
  );
}

/**
 * SkeletonAvatar - Pre-configured skeleton for avatars with optional text
 */
function SkeletonAvatar({ 
  size = "md", 
  withText = false,
  className,
  animate,
}: { 
  size?: "sm" | "md" | "lg" | "xl";
  withText?: boolean;
  className?: string;
  animate?: boolean;
}) {
  const sizeClasses = {
    sm: "h-8 w-8",
    md: "h-10 w-10",
    lg: "h-12 w-12",
    xl: "h-16 w-16",
  };

  if (withText) {
    return (
      <div className={cn("flex items-center space-x-3", className)}>
        <Skeleton variant="avatar" className={sizeClasses[size]} animate={animate} />
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-[120px]" animate={animate} />
          <Skeleton className="h-3 w-[80px]" animate={animate} />
        </div>
      </div>
    );
  }

  return (
    <Skeleton 
      variant="avatar" 
      className={cn(sizeClasses[size], className)} 
      animate={animate} 
    />
  );
}

/**
 * SkeletonGraphNode - Pre-configured skeleton for graph node loading
 */
function SkeletonGraphNode({ className }: { className?: string }) {
  return (
    <div className={cn("w-[180px] rounded-xl overflow-hidden border border-border bg-card", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <Skeleton variant="avatar" className="h-6 w-6" />
        <Skeleton className="h-3 w-[80px]" />
      </div>
      {/* Body */}
      <div className="p-3 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-[90%]" />
        <Skeleton className="h-3 w-[70%]" />
      </div>
    </div>
  );
}

/**
 * SkeletonConversationList - Pre-configured skeleton for conversation list
 */
function SkeletonConversationList({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-1">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 px-3 py-2 rounded-md"
        >
          <Skeleton variant="avatar" className="h-8 w-8" />
          <div className="flex-1 space-y-1.5 min-w-0">
            <Skeleton className="h-4 w-full max-w-[200px]" />
            <Skeleton className="h-3 w-[60%]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * SkeletonTimeline - Pre-configured skeleton for timeline view
 */
function SkeletonTimeline({ count = 8 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-start gap-4">
          {/* Timeline marker */}
          <div className="flex flex-col items-center">
            <Skeleton variant="avatar" className="h-8 w-8" />
            {i < count - 1 && (
              <Skeleton className="w-0.5 h-12 mt-1" />
            )}
          </div>
          {/* Content */}
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-4 w-[150px]" />
            <Skeleton className="h-3 w-[100px]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export {
  Skeleton,
  SkeletonCard,
  SkeletonText,
  SkeletonAvatar,
  SkeletonGraphNode,
  SkeletonConversationList,
  SkeletonTimeline,
};
