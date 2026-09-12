import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '../../../@/components/ui/card';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { useKindeAuth } from "@kinde-oss/kinde-auth-react";
import { AlertCircle, ArrowRight } from 'lucide-react';
import { Alert, AlertDescription } from '../../../@/components/ui/alert';
import logoSrc from '../../assets/logo.png';
import { devLogLazy } from '../../lib/appLogger';
import { openKindeAuthInSystemBrowser, shouldUseDesktopBrowserAuth } from '../../lib/kindeDesktopAuth';

export function LoginPage() {
  const { authErrorReason, clearAuthErrorReason, desktopSession, setAuthErrorReason, user } = useAuthStore();
  const { login, register } = useKindeAuth();
  const devBypass = import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';
  const navigate = useNavigate();
  devLogLazy(() => [
    `[ROUTE][LoginPage] render devBypass=${devBypass} user=${!!user} desktopSession=${!!desktopSession} authError=${!!authErrorReason}`
  ]);

  const startAuth = async (intent: 'login' | 'register') => {
    try {
      if (shouldUseDesktopBrowserAuth()) {
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
    if (devBypass || (shouldUseDesktopBrowserAuth() && user && desktopSession)) {
      navigate('/', { replace: true });
    }
  }, [desktopSession, devBypass, navigate, user]);


  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.16),_transparent_28%),linear-gradient(135deg,_hsl(var(--background))_0%,_hsl(214_45%_98%)_46%,_hsl(201_50%_96%)_100%)] p-4 text-foreground dark:bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.12),_transparent_30%),linear-gradient(135deg,_hsl(var(--background))_0%,_hsl(var(--app-bg-elevated))_48%,_hsl(var(--app-bg-muted))_100%)] dark:text-zinc-50">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[size:72px_72px] opacity-50 dark:opacity-20" />

      <motion.div
        initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
        className="relative w-full max-w-5xl"
      >
        <Card className="grid overflow-hidden border-border/60 bg-background/92 p-0 text-foreground shadow-[0_28px_90px_-42px_rgba(15,23,42,0.45)] backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/94 dark:text-zinc-50 dark:shadow-[0_28px_90px_-42px_rgba(0,0,0,0.82)] md:grid-cols-[1.05fr_0.95fr]">
          <div className="border-b border-border/60 bg-slate-950 px-8 py-10 text-slate-50 md:border-b-0 md:border-r">
            <div className="flex items-center gap-3">
              <img src={logoSrc} alt="Agentree" className="h-8 w-auto" />
              <span className="rounded-full border border-white/10 bg-white/8 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-sky-100">
                Beta
              </span>
            </div>

            <div className="mt-6 space-y-4">
              <h1 className="max-w-md text-4xl font-semibold leading-tight text-balance">
                <span
                  className="block text-[2.9rem] font-normal italic leading-[0.95] tracking-[-0.05em] text-sky-100"
                  style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
                >
                  Welcome
                </span>
                <span className="mt-2 block text-slate-50">
                  to Agentree
                </span>
              </h1>
              <p className="max-w-md text-base leading-7 text-slate-300 text-pretty">
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
          </div>

          <div className="bg-card/70 px-6 py-8 dark:bg-zinc-950/90 sm:px-8 sm:py-10">
            <CardHeader className="px-0 pb-6">
              <CardTitle className="text-2xl text-foreground dark:text-zinc-50">Connect Agentree Cloud</CardTitle>
              <p className="text-sm leading-6 text-muted-foreground dark:text-zinc-300">
                Authentication opens in your browser, then returns you to the app. Your local work stays local until backup is enabled.
              </p>
            </CardHeader>
            <CardContent className="px-0">
              {authErrorReason && (
                <Alert variant="destructive" className="mb-4">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{authErrorReason}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-3">
                <button
                  onClick={() => startAuth('login')}
                  className={cn(
                    "w-full rounded-xl bg-primary px-4 py-3 text-primary-foreground hover:bg-primary/90",
                    "flex items-center justify-center gap-2 text-sm font-medium shadow-[0_12px_30px_-18px_rgba(37,99,235,0.55)]"
                  )}
                >
                  Connect Cloud
                  <ArrowRight className="h-4 w-4" />
                </button>

                <button
                  onClick={() => startAuth('register')}
                  className={cn(
                    "w-full rounded-xl border border-input bg-background px-4 py-3 hover:bg-accent hover:text-accent-foreground dark:border-white/12 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
                    "flex items-center justify-center gap-2 text-sm font-medium"
                  )}
                >
                  Create Cloud Account
                </button>
              </div>

              <p className="mt-6 text-xs leading-5 text-muted-foreground dark:text-zinc-400">
                By creating an account, you agree to our{' '}
                <a
                  href="https://agentree.app/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4 hover:text-foreground dark:hover:text-zinc-100"
                >
                  Terms of Service
                </a>{' '}
                and{' '}
                <a
                  href="https://agentree.app/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4 hover:text-foreground dark:hover:text-zinc-100"
                >
                  Privacy Policy
                </a>
                .
              </p>
            </CardContent>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}
