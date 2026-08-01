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
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="w-full max-w-lg rounded-xl border border-border/50 bg-card p-5 shadow-lg">
          <h2 className="text-base font-semibold text-foreground">Recovering from a crash</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The app hit a runtime error and is attempting automatic recovery.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/90">
            Attempt: {retryCount}
          </p>
          {error?.message ? (
            <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {error.message}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleRetryNow}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
            >
              Retry now
            </button>
            <button
              type="button"
              onClick={this.handleReloadNow}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
