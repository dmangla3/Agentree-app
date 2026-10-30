import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Card } from '../../../@/components/ui/card';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { useKindeAuth } from "@kinde-oss/kinde-auth-react";
import { AlertCircle, ArrowRight } from 'lucide-react';
import { Alert, AlertDescription } from '../../../@/components/ui/alert';
import logoSrc from '../../assets/logo.png';
import { devLogLazy } from '../../lib/appLogger';
import { openKindeAuthInSystemBrowser, shouldUseDesktopBrowserAuth } from '../../lib/kindeDesktopAuth';
import { hasAppAccess } from '../../lib/appAccess';
import { usesMacOSOverlayTitleBar } from '../../hooks/useTauriWorkspace';

export function LoginPage() {
  const { authErrorReason, clearAuthErrorReason, desktopSession, setAuthErrorReason, user } = useAuthStore();
  const { isAuthenticated, login, register } = useKindeAuth();
  const devBypass = import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isDesignReviewPreview = import.meta.env.DEV && searchParams.get('designReview') === 'auth';
  const usesDesktopAuth = shouldUseDesktopBrowserAuth();
  const canAccessApp = hasAppAccess({
    devAuthBypass: devBypass,
    usesDesktopAuth,
    hasDesktopUser: Boolean(user),
    hasDesktopSession: Boolean(desktopSession),
    isKindeAuthenticated: isAuthenticated,
  });
  devLogLazy(() => [
    `[ROUTE][LoginPage] render devBypass=${devBypass} user=${!!user} desktopSession=${!!desktopSession} authError=${!!authErrorReason}`
  ]);

  const startAuth = async (intent: 'login' | 'register') => {
    if (isDesignReviewPreview) return;
    try {
      clearAuthErrorReason();
      if (usesDesktopAuth) {
        await openKindeAuthInSystemBrowser(intent);
        return;
      }

      if (intent === 'register') {
        await register();
      } else {
        await login();
      }
    } catch (error) {
      console.error(`[LoginPage] Failed to start ${intent}:`, error);
      setAuthErrorReason('Could not open authentication in your browser. Please try again.');
    }
  };

  useEffect(() => {
    if (authErrorReason) {
      const timer = setTimeout(() => {
        clearAuthErrorReason();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [authErrorReason, clearAuthErrorReason]);

  useEffect(() => {
    if (canAccessApp && !isDesignReviewPreview) {
      navigate('/', { replace: true });
    }
  }, [canAccessApp, isDesignReviewPreview, navigate]);


  return (
    <div
      data-design-scope="auth"
      data-design-part="auth-root"
      className="app-shell-background relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-5 py-8 text-foreground"
    >
      {usesMacOSOverlayTitleBar() ? (
        <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-20 h-12" aria-hidden="true" />
      ) : null}
      <div data-design-part="auth-layout" className="contents">
        <motion.div
          data-design-part="auth-after"
          initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          className="relative w-full max-w-sm"
        >
        <div data-design-part="auth-brand" className="mb-6 flex items-center justify-center gap-2.5">
          <img src={logoSrc} alt="Agentree" className="h-8 w-auto" />
          <span className="rounded-md bg-muted/65 px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]">
            Beta
          </span>
        </div>

        <div data-design-part="auth-heading" className="mb-5 text-center">
          <h1 className="text-balance text-2xl font-semibold tracking-[-0.025em]">Sign in to Agentree</h1>
          <p className="mt-2 text-pretty text-sm leading-6 text-muted-foreground">
            Continue in your browser, then return to the app.
          </p>
        </div>

        <Card data-design-part="auth-card" className="gap-0 overflow-hidden border-0 bg-[hsl(var(--app-panel-strong))] p-0 shadow-[var(--app-shadow-floating)] ring-1 ring-border/65">
          <div data-design-part="auth-card-content" className="p-5 sm:p-6">
            {authErrorReason && (
              <Alert variant="destructive" className="mb-4 rounded-lg">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{authErrorReason}</AlertDescription>
              </Alert>
            )}

            <button
              type="button"
              onClick={() => startAuth('login')}
              className={cn(
                'flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground',
                'shadow-[0_8px_20px_-16px_hsl(var(--foreground)/0.5)] transition-[background-color,box-shadow,transform] duration-150 ease-out hover:bg-primary/90 active:scale-[0.96]'
              )}
            >
              Sign in
              <ArrowRight className="h-4 w-4" />
            </button>

            <div data-design-part="auth-divider" className="my-5 flex items-center gap-3">
              <div aria-hidden="true" className="h-px flex-1 bg-border/65" />
              <span className="text-xs text-muted-foreground">New to Agentree?</span>
              <div aria-hidden="true" className="h-px flex-1 bg-border/65" />
            </div>

            <button
              type="button"
              onClick={() => startAuth('register')}
              className={cn(
                'flex h-10 w-full items-center justify-center rounded-lg border border-input bg-background px-4 text-sm font-medium',
                'transition-[background-color,color,transform] duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:scale-[0.96]'
              )}
            >
              Create account
            </button>
          </div>
        </Card>

        <p data-design-part="auth-terms" className="mx-auto mt-5 max-w-xs text-center text-pretty text-xs leading-5 text-muted-foreground">
          Your local work remains available offline. By creating an account, you agree to our{' '}
          <a
            href="https://agentree.app/terms"
            target="_blank"
            rel="noreferrer"
            className="transition-colors duration-150 hover:text-foreground hover:underline hover:underline-offset-4"
          >
            Terms of Service
          </a>{' '}
          and{' '}
          <a
            href="https://agentree.app/privacy"
            target="_blank"
            rel="noreferrer"
            className="transition-colors duration-150 hover:text-foreground hover:underline hover:underline-offset-4"
          >
            Privacy Policy
          </a>
          .
        </p>
        </motion.div>

        {import.meta.env.DEV ? <div data-design-part="auth-before" aria-hidden="true" className="hidden">
        <div className="flex items-center gap-3">
          <img src={logoSrc} alt="" className="h-8 w-auto" />
          <span className="rounded-full border border-white/10 bg-white/8 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-sky-100">
            Beta
          </span>
        </div>

        <div className="mt-6 space-y-4">
          <h1 className="max-w-md text-balance text-4xl font-semibold leading-tight">
            <span
              className="block text-[2.9rem] font-normal italic leading-[0.95] tracking-[-0.05em] text-sky-100"
              style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
            >
              Welcome
            </span>
            <span className="mt-2 block text-slate-50">to Agentree</span>
          </h1>
          <p className="max-w-md text-pretty text-base leading-7 text-slate-300">
            Work locally by default. Connect Agentree Cloud when you want backup, sync, sharing, or collaboration.
          </p>
        </div>

        <div className="mt-10 grid gap-3">
          {[
            'Local work remains available when cloud is disconnected.',
            'Backup stays off until you enable it for a workspace.',
            'Sharing starts only after you explicitly publish.',
          ].map((item) => (
            <div key={item} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-slate-200">
              {item}
            </div>
          ))}
        </div>
        </div> : null}
      </div>
    </div>
  );
}
