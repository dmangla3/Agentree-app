import React from 'react';

type AppErrorBoundaryProps = {
  children: React.ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
};

const AUTO_RECOVERY_DELAYS_MS = [250, 1000, 3000];

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  private autoRecoverTimer: number | null = null;
  private hardReloadTimer: number | null = null;
  private hardReloadScheduled = false;

  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[AppErrorBoundary] Caught render crash:', error, errorInfo);
    try {
      window.localStorage.setItem('agentree.last-render-crash.v1', JSON.stringify({
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        at: new Date().toISOString(),
      }));
    } catch {
      // Best-effort diagnostic only.
    }

    this.setState(
      (prev) => ({
        retryCount: prev.retryCount + 1,
      }),
      () => {
        this.scheduleAutoRecovery();
      }
    );
  }

  componentWillUnmount() {
    this.clearTimers();
  }

  private clearTimers() {
    if (this.autoRecoverTimer !== null) {
      window.clearTimeout(this.autoRecoverTimer);
      this.autoRecoverTimer = null;
    }
    if (this.hardReloadTimer !== null) {
      window.clearTimeout(this.hardReloadTimer);
      this.hardReloadTimer = null;
    }
  }

  private scheduleAutoRecovery() {
    this.clearTimers();
    const { retryCount } = this.state;

    if (retryCount <= AUTO_RECOVERY_DELAYS_MS.length) {
      const delay = AUTO_RECOVERY_DELAYS_MS[retryCount - 1] ?? AUTO_RECOVERY_DELAYS_MS[AUTO_RECOVERY_DELAYS_MS.length - 1];
      this.autoRecoverTimer = window.setTimeout(() => {
        this.setState({
          hasError: false,
          error: null,
        });
      }, delay);
      return;
    }

    if (!this.hardReloadScheduled) {
      this.hardReloadScheduled = true;
      this.hardReloadTimer = window.setTimeout(() => {
        window.location.reload();
      }, 1200);
    }
  }

  private handleRetryNow = () => {
    this.clearTimers();
    this.setState({
      hasError: false,
      error: null,
    });
  };

  private handleReloadNow = () => {
    window.location.reload();
  };

  render() {
    const { hasError, retryCount, error } = this.state;

    if (!hasError) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 antialiased">
        <div className="w-full max-w-lg rounded-xl border border-border/60 bg-card p-5 shadow-[0_0_0_1px_hsl(var(--foreground)/0.02),0_12px_32px_-18px_hsl(var(--foreground)/0.32)]">
          <h2 className="text-balance text-base font-semibold text-foreground">Recovering from a crash</h2>
          <p className="mt-2 text-pretty text-sm text-muted-foreground">
            Agentree hit a runtime error and is trying to recover.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/90">
            Attempt: {retryCount}
          </p>
          {error?.message ? (
            <p className="mt-3 rounded-lg bg-muted/45 px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">
              {error.message}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleRetryNow}
              className="min-h-10 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-muted/60 active:scale-[0.96] motion-reduce:transition-none"
            >
              Retry now
            </button>
            <button
              type="button"
              onClick={this.handleReloadNow}
              className="min-h-10 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-muted/60 active:scale-[0.96] motion-reduce:transition-none"
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
