import { useState, useEffect, createContext, useContext, useCallback, useMemo, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { X, CheckCircle2, AlertCircle, Info, ExternalLink } from 'lucide-react';
import { Button } from '../../@/components/ui/button';

export interface Toast {
    id: string;
    title: string;
    description?: string;
    variant?: 'default' | 'success' | 'error' | 'warning' | 'info';
    duration?: number;
    action?: {
        label?: string;
        onClick?: () => void;
        component?: ReactNode;
    };
    persistent?: boolean;
}

interface ToastContextValue {
    toasts: Toast[];
    addToast: (toast: Omit<Toast, 'id'>) => string;
    removeToast: (id: string) => void;
    clearAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}

// Helper function for common toast scenarios
export function useToastHelpers() {
    const { addToast } = useToast();

    return {
        success: (title: string, description?: string) =>
            addToast({ title, description, variant: 'success' }),
        error: (title: string, description?: string) =>
            addToast({ title, description, variant: 'error', duration: 8000 }),
        info: (title: string, description?: string) =>
            addToast({ title, description, variant: 'info' }),
        mounted: (mountPath: string) =>
            addToast({
                title: 'Worktree Ready',
                description: 'Git worktree is ready for editing',
                variant: 'success',
                duration: 10000,
                action: {
                    label: 'Open Terminal',
                    onClick: async () => {
                        try {
                            const { Command } = await import('@tauri-apps/plugin-shell');
                            await Command.create('open', ['-a', 'Terminal', mountPath]).execute();
                        } catch (e) {
                            console.error('Failed to open:', e);
                        }
                    },
                },
            }),
    };
}

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
        const id = Math.random().toString(36).slice(2, 9);
        setToasts((prev) => [...prev, { ...toast, id }]);
        return id;
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const clearAll = useCallback(() => {
        setToasts([]);
    }, []);

    const value = useMemo(
        () => ({ toasts, addToast, removeToast, clearAll }),
        [toasts, addToast, removeToast, clearAll]
    );

    return (
        <ToastContext.Provider value={value}>
            {children}
            <ToastContainer toasts={toasts} onRemove={removeToast} />
        </ToastContext.Provider>
    );
}

function ToastContainer({
    toasts,
    onRemove,
}: {
    toasts: Toast[];
    onRemove: (id: string) => void;
}) {
    return (
        <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md">
            {toasts.map((toast) => (
                <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
            ))}
        </div>
    );
}

function ToastItem({
    toast,
    onRemove,
}: {
    toast: Toast;
    onRemove: (id: string) => void;
}) {
    const [isExiting, setIsExiting] = useState(false);

    useEffect(() => {
        if (!toast.persistent && toast.duration !== 0) {
            const timer = setTimeout(() => {
                setIsExiting(true);
                setTimeout(() => onRemove(toast.id), 200);
            }, toast.duration || 5000);
            return () => clearTimeout(timer);
        }
    }, [toast, onRemove]);

    const handleRemove = () => {
        setIsExiting(true);
        setTimeout(() => onRemove(toast.id), 200);
    };

    const variantConfig = {
        default: {
            icon: Info,
            iconClass: 'text-muted-foreground',
            borderClass: 'border-border',
            bgClass: 'bg-card',
        },
        success: {
            icon: CheckCircle2,
            iconClass: 'text-emerald-500',
            borderClass: 'border-emerald-500/30',
            bgClass: 'bg-emerald-500/5',
        },
        error: {
            icon: AlertCircle,
            iconClass: 'text-red-500',
            borderClass: 'border-red-500/30',
            bgClass: 'bg-red-500/5',
        },
        warning: {
            icon: AlertCircle,
            iconClass: 'text-amber-500',
            borderClass: 'border-amber-500/30',
            bgClass: 'bg-amber-500/5',
        },
        info: {
            icon: Info,
            iconClass: 'text-sky-500',
            borderClass: 'border-sky-500/30',
            bgClass: 'bg-sky-500/5',
        },
    };

    const config = variantConfig[toast.variant || 'default'];
    const Icon = config.icon;

    return (
        <div
            className={cn(
                'relative flex items-start gap-3 p-4 rounded-xl border shadow-lg backdrop-blur-xl',
                'animate-in slide-in-from-right-full duration-300',
                isExiting && 'animate-out slide-out-to-right-full duration-200',
                config.borderClass,
                config.bgClass,
                'bg-background/95'
            )}
        >
            {/* Icon */}
            <div className={cn('flex-shrink-0 mt-0.5', config.iconClass)}>
                <Icon size={18} aria-hidden="true" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div
                    role={toast.variant === 'error' ? 'alert' : 'status'}
                    aria-atomic="true"
                >
                    <p className="font-medium text-sm text-foreground">{toast.title}</p>
                    {toast.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 break-words">
                            {toast.description}
                        </p>
                    )}
                </div>
                {toast.action && (
                    toast.action.component ? (
                        <div className="mt-2">{toast.action.component}</div>
                    ) : (
                        toast.action.label && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={toast.action.onClick}
                                className="mt-2 h-7 text-xs gap-1"
                            >
                                <ExternalLink size={12} aria-hidden="true" />
                                {toast.action.label}
                            </Button>
                        )
                    )
                )}
            </div>

            {/* Close button */}
            <button
                type="button"
                aria-label={`Dismiss ${toast.title}`}
                onClick={handleRemove}
                className="flex-shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
                <X size={14} aria-hidden="true" />
            </button>

            {/* Progress bar for timed toasts */}
            {!toast.persistent && toast.duration !== 0 && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden rounded-b-xl">
                    <div
                        className={cn(
                            'h-full origin-left',
                            toast.variant === 'success' && 'bg-emerald-500',
                            toast.variant === 'error' && 'bg-red-500',
                            toast.variant === 'warning' && 'bg-amber-500',
                            toast.variant === 'info' && 'bg-sky-500',
                            !toast.variant && 'bg-muted-foreground'
                        )}
                        style={{
                            animation: `shrink ${toast.duration || 5000}ms linear forwards`,
                        }}
                    />
                </div>
            )}

            <style>{`
                @keyframes shrink {
                    from { transform: scaleX(1); }
                    to { transform: scaleX(0); }
                }
            `}</style>
        </div>
    );
}
