import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, CheckCircle2, Code2, Copy, KeyRound, Loader2, ShieldCheck, Terminal } from 'lucide-react';
import { Button } from '../../../@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../@/components/ui/dialog';
import { Input } from '../../../@/components/ui/input';
import { Label } from '../../../@/components/ui/label';
import { Textarea } from '../../../@/components/ui/textarea';
import type { ClaudeOAuthLoginStart, CodexLoginStart, UpsertLoginProfileRequest } from '../../lib/agentClient';
import type { LoginProfileSummary } from '../../lib/loginProfiles';
import { cn } from '../../lib/utils';

interface LoginProfileEditorProps {
  open: boolean;
  provider: 'codex' | 'claude';
  profile: LoginProfileSummary | null;
  isSaving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (request: UpsertLoginProfileRequest) => Promise<LoginProfileSummary>;
  onConnectCodex?: (profileId: string) => Promise<CodexLoginStart>;
  onConnectClaudeOauth?: (profileId: string) => Promise<ClaudeOAuthLoginStart>;
  onPollClaudeOauth?: (profileId: string) => Promise<LoginProfileSummary>;
  onSubmitClaudeOauthCode?: (profileId: string, code: string) => Promise<LoginProfileSummary>;
}

const authTypesByProvider = {
  codex: [
    ['codex_api_key', 'OpenAI API key'],
    ['codex_chatgpt_session', 'Managed ChatGPT session'],
  ],
  claude: [
    ['claude_oauth', 'Claude subscription'],
    ['claude_api_key', 'Anthropic API key'],
  ],
} as const;

const advancedConfigAuthTypes = new Set([
  'claude_bedrock',
  'claude_vertex',
  'claude_azure_foundry',
]);

const hasConfigValues = (config: LoginProfileSummary['config'] | undefined) => (
  Boolean(config && typeof config === 'object' && Object.keys(config).length > 0)
);

const authTypeCopy: Record<string, { title: string; body: string }> = {
  codex_api_key: {
    title: 'API key',
    body: 'Direct OpenAI API access for Codex runs.',
  },
  codex_chatgpt_session: {
    title: 'ChatGPT session',
    body: 'A managed profile home with persisted session rotation.',
  },
  claude_api_key: {
    title: 'API key',
    body: 'Direct Anthropic API access for Claude runs.',
  },
  claude_oauth: {
    title: 'Subscription',
    body: 'Browser sign in for a Claude subscription account.',
  },
};

const SecretIcon = ({ authType }: { authType: string }) => {
  if (authType === 'codex_chatgpt_session' || authType === 'claude_oauth') return <ShieldCheck className="h-4 w-4" />;
  if (authType.includes('token')) return <Terminal className="h-4 w-4" />;
  return <KeyRound className="h-4 w-4" />;
};

export function LoginProfileEditor({
  open,
  provider,
  profile,
  isSaving,
  error,
  onOpenChange,
  onSave,
  onConnectCodex,
  onConnectClaudeOauth,
  onPollClaudeOauth,
  onSubmitClaudeOauthCode,
}: LoginProfileEditorProps) {
  const authTypes = authTypesByProvider[provider];
  const [displayName, setDisplayName] = useState('');
  const [authType, setAuthType] = useState<string>(authTypes[0][0]);
  const [secret, setSecret] = useState('');
  const [configJson, setConfigJson] = useState('{}');
  const [makeDefault, setMakeDefault] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [codexLoginStart, setCodexLoginStart] = useState<CodexLoginStart | null>(null);
  const [claudeLoginStart, setClaudeLoginStart] = useState<ClaudeOAuthLoginStart | null>(null);
  const [claudeLoginCode, setClaudeLoginCode] = useState('');
  const [showClaudeCodeInput, setShowClaudeCodeInput] = useState(false);
  const [claudeLoginReady, setClaudeLoginReady] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDisplayName(profile?.displayName ?? (provider === 'codex' ? 'Codex login' : 'Claude login'));
    setAuthType(profile?.authType ?? authTypes[0][0]);
    setSecret('');
    setConfigJson(JSON.stringify(profile?.config ?? {}, null, 2));
    setMakeDefault(profile?.isDefault ?? true);
    setLocalError(null);
    setCodexLoginStart(null);
    setClaudeLoginStart(null);
    setClaudeLoginCode('');
    setShowClaudeCodeInput(false);
    setClaudeLoginReady(false);
    setCopiedCode(false);
  }, [authTypes, open, profile?.id, provider]);

  useEffect(() => {
    if (codexLoginStart && profile?.id === codexLoginStart.profileId && profile.status === 'ready') {
      onOpenChange(false);
    }
  }, [codexLoginStart, onOpenChange, profile?.id, profile?.status]);

  useEffect(() => {
    if (claudeLoginStart && profile?.id === claudeLoginStart.profileId && profile.status === 'ready') {
      setClaudeLoginReady(true);
    }
  }, [claudeLoginStart, onOpenChange, profile?.id, profile?.status]);

  useEffect(() => {
    if (!claudeLoginStart || !onPollClaudeOauth || claudeLoginReady) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await onPollClaudeOauth(claudeLoginStart.profileId);
        if (!cancelled && latest.status === 'ready') {
          setClaudeLoginReady(true);
          setShowClaudeCodeInput(false);
        } else if (!cancelled && latest.status === 'error') {
          setLocalError(latest.statusMessage ?? 'Claude sign in failed.');
          setClaudeLoginStart(null);
        }
      } catch (caughtError) {
        if (!cancelled) {
          setLocalError(caughtError instanceof Error ? caughtError.message : String(caughtError));
          setShowClaudeCodeInput(true);
        }
      }
    };
    const timeoutId = window.setTimeout(() => void poll(), 900);
    const intervalId = window.setInterval(() => void poll(), 1800);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [claudeLoginReady, claudeLoginStart, onPollClaudeOauth]);

  const secretPlaceholder = useMemo(() => {
    if (authType === 'codex_api_key') return 'sk-...';
    if (authType.includes('bedrock') || authType.includes('vertex') || authType.includes('foundry')) {
      return 'Paste secret JSON for this provider';
    }
    return 'Paste API key or token';
  }, [authType]);

  const isCodexManagedSession = provider === 'codex' && authType === 'codex_chatgpt_session';
  const isClaudeOAuth = provider === 'claude' && authType === 'claude_oauth';
  const isCodexApiKey = provider === 'codex' && authType === 'codex_api_key';
  const showConfigJson = provider !== 'codex' && !isCodexManagedSession && !isClaudeOAuth && (
    advancedConfigAuthTypes.has(authType) || hasConfigValues(profile?.config)
  );
  const providerLabel = provider === 'codex' ? 'Codex' : 'Claude';
  const secretLabel = isCodexApiKey ? 'OpenAI API key' : 'Secret';

  const buildRequest = (): UpsertLoginProfileRequest | null => {
    setLocalError(null);
    let config: Record<string, any> = {};
    if (showConfigJson) {
      try {
        config = JSON.parse(configJson || '{}');
      } catch {
        setLocalError('Config must be valid JSON.');
        return null;
      }
    }
    return {
      id: profile?.id ?? null,
      provider,
      displayName,
      authType,
      secret: isCodexManagedSession || isClaudeOAuth ? null : (secret.trim() ? secret : null),
      config,
      makeDefault,
    };
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const request = buildRequest();
    if (!request) return;
    await onSave(request);
    onOpenChange(false);
  };

  const connectCodex = async () => {
    if (!onConnectCodex) return;
    const request = buildRequest();
    if (!request) return;
    try {
      const savedProfile = await onSave(request);
      if (savedProfile.authType === 'codex_chatgpt_session') {
        const started = await onConnectCodex(savedProfile.id);
        setCodexLoginStart(started);
      }
    } catch (caughtError) {
      setLocalError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    }
  };

  const connectClaudeOauth = async () => {
    if (!onConnectClaudeOauth) return;
    const request = buildRequest();
    if (!request) return;
    try {
      const savedProfile = await onSave(request);
      if (savedProfile.authType === 'claude_oauth') {
        const started = await onConnectClaudeOauth(savedProfile.id);
        setClaudeLoginStart(started);
        setClaudeLoginCode('');
        setShowClaudeCodeInput(false);
        setClaudeLoginReady(false);
      }
    } catch (caughtError) {
      setLocalError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    }
  };

  const submitClaudeOauthCode = async () => {
    if (!claudeLoginStart || !onSubmitClaudeOauthCode) return;
    try {
      const latest = await onSubmitClaudeOauthCode(claudeLoginStart.profileId, claudeLoginCode.trim());
      if (latest.status === 'ready') {
        setClaudeLoginReady(true);
        setShowClaudeCodeInput(false);
      } else if (latest.status === 'error') {
        setLocalError(latest.statusMessage ?? 'Claude sign in failed.');
        setClaudeLoginStart(null);
      }
    } catch (caughtError) {
      setLocalError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      setClaudeLoginStart(null);
    }
  };

  const copyCodexCode = async () => {
    if (!codexLoginStart) return;
    await navigator.clipboard?.writeText(codexLoginStart.deviceCode);
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden p-0">
        <form onSubmit={handleSubmit}>
          <DialogHeader className="border-b border-[hsl(var(--app-border)/0.72)] bg-muted/28 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                {provider === 'codex' ? <ShieldCheck className="h-5 w-5" /> : <Terminal className="h-5 w-5" />}
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-lg">{profile ? `Edit ${providerLabel} account` : `Add ${providerLabel} account`}</DialogTitle>
                <DialogDescription className="mt-1">
                  Profile secrets stay in the OS credential store; saved secret values are never shown here.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid gap-5 px-5 py-5">
            <div className="grid gap-2">
              <Label htmlFor="login-display-name" className="text-[12px] font-semibold">Account name</Label>
              <Input
                id="login-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                className="h-10"
              />
            </div>

            <div className="grid gap-2">
              <div className="text-[12px] font-semibold text-foreground">Authentication</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {authTypes.map(([value, label]) => {
                  const selected = authType === value;
                  const copy = authTypeCopy[value] ?? { title: label, body: '' };
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setAuthType(value)}
                      className={cn(
                        'min-h-20 rounded-lg px-3 py-3 text-left shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.7)] transition-[background-color,box-shadow,transform] active:scale-[0.985]',
                        selected
                          ? 'bg-[hsl(var(--app-accent-soft))] shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.28)]'
                          : 'bg-background hover:bg-muted/45'
                      )}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                          <SecretIcon authType={value} />
                          {copy.title}
                        </span>
                        {selected ? <CheckCircle2 className="h-4 w-4 text-[hsl(var(--app-accent))]" /> : null}
                      </span>
                      <span className="mt-2 block text-[12px] leading-5 text-muted-foreground">{copy.body}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {!isCodexManagedSession && !isClaudeOAuth ? (
              <div className="grid gap-2">
                <Label htmlFor="login-secret" className="text-[12px] font-semibold">{secretLabel}</Label>
                <div className="relative">
                  {isCodexApiKey ? (
                    <Input
                      id="login-secret"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder={secretPlaceholder}
                      className="h-10 pl-9 font-mono text-sm"
                      required={!profile}
                    />
                  ) : (
                    <Textarea
                      id="login-secret"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder={secretPlaceholder}
                      className="min-h-28 resize-y pl-9 font-mono text-xs leading-5"
                      required={!profile}
                    />
                  )}
                  <div className="pointer-events-none absolute left-3 top-3 text-muted-foreground">
                    <SecretIcon authType={authType} />
                  </div>
                </div>
              </div>
            ) : null}

            {isCodexManagedSession ? (
              <div className="rounded-lg bg-background px-3 py-3 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68)]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-foreground">Codex sign in</div>
                    <div className="mt-1 text-[12px] text-muted-foreground">
                      {profile?.status === 'ready' ? 'Connected' : 'Not connected'}
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void connectCodex()} disabled={isSaving}>
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    {profile?.status === 'ready' ? 'Reconnect' : 'Connect'}
                  </Button>
                </div>
              </div>
            ) : null}

            {isClaudeOAuth ? (
              <div className="rounded-lg bg-background px-3 py-3 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68)]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-foreground">Claude sign in</div>
                    <div className="mt-1 text-[12px] text-muted-foreground">
                      {profile?.status === 'ready' ? 'Connected' : 'Not connected'}
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void connectClaudeOauth()} disabled={isSaving}>
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    {profile?.status === 'ready' ? 'Reconnect' : 'Connect'}
                  </Button>
                </div>
              </div>
            ) : null}

            {claudeLoginStart ? (
              <div className="rounded-lg bg-background px-3 py-3 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68)]">
                {claudeLoginReady ? (
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-4 w-4" />
                    Logged in
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-[12px] font-semibold text-foreground">
                        <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--app-accent))]" />
                        Checking sign in
                      </div>
                      <a
                        href={claudeLoginStart.loginUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[12px] font-medium text-[hsl(var(--app-accent))] hover:underline"
                      >
                        Open sign in
                      </a>
                    </div>
                    {showClaudeCodeInput ? (
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={claudeLoginCode}
                          onChange={(event) => setClaudeLoginCode(event.target.value)}
                          placeholder="Paste code"
                          className="h-10 font-mono text-sm"
                        />
                        <Button type="button" variant="outline" onClick={() => void submitClaudeOauthCode()} disabled={isSaving || !claudeLoginCode.trim()}>
                          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          Submit code
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="mt-3 h-7 px-2 text-[12px]"
                        onClick={() => setShowClaudeCodeInput(true)}
                      >
                        Enter code manually
                      </Button>
                    )}
                  </>
                )}
              </div>
            ) : null}

            {codexLoginStart ? (
              <div className="rounded-lg bg-background px-3 py-3 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.68)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[12px] font-semibold text-foreground">Codex sign in code</div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void copyCodexCode()}>
                    {copiedCode ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copiedCode ? 'Copied' : 'Copy code'}
                  </Button>
                </div>
                <div className="mt-2 rounded-md bg-muted px-3 py-2 font-mono text-lg font-semibold tracking-[0.16em] text-foreground tabular-nums">
                  {codexLoginStart.deviceCode}
                </div>
                <a
                  href={codexLoginStart.deviceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex text-[12px] font-medium text-[hsl(var(--app-accent))] hover:underline"
                >
                  {codexLoginStart.deviceUrl}
                </a>
              </div>
            ) : null}

            {showConfigJson ? (
              <div className="grid gap-2">
                <Label htmlFor="login-config" className="text-[12px] font-semibold">Advanced config JSON</Label>
                <div className="relative">
                  <Textarea
                    id="login-config"
                    value={configJson}
                    onChange={(event) => setConfigJson(event.target.value)}
                    className="min-h-24 resize-y pl-9 font-mono text-xs leading-5"
                  />
                  <Code2 className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                </div>
              </div>
            ) : null}

            <label className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-2.5 text-sm text-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]">
              <span className="font-medium">Use as active login for {providerLabel}</span>
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(event) => setMakeDefault(event.target.checked)}
                className="h-4 w-4 accent-[hsl(var(--app-accent))]"
              />
            </label>
          </div>

          {localError || error ? (
            <div className="mx-5 mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/35 dark:text-red-300">
              {localError ?? error}
            </div>
          ) : null}

          <DialogFooter className="border-t border-[hsl(var(--app-border)/0.72)] bg-muted/24 px-5 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
