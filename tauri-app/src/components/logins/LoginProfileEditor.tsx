import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, CheckCircle2, Code2, Copy, KeyRound, Loader2, Plus, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
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
import { getOpenCodeProviderLabel, type LoginProfileSummary } from '../../lib/loginProfiles';
import { cn } from '../../lib/utils';

interface LoginProfileEditorProps {
  open: boolean;
  provider: 'codex' | 'claude' | 'opencode';
  profile: LoginProfileSummary | null;
  isSaving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (request: UpsertLoginProfileRequest) => Promise<LoginProfileSummary>;
  onLoadOpenCodeAuth?: (profileId: string) => Promise<string>;
  onConnectCodex?: (profileId: string) => Promise<CodexLoginStart>;
  onConnectClaudeOauth?: (profileId: string) => Promise<ClaudeOAuthLoginStart>;
  onPollClaudeOauth?: (profileId: string) => Promise<LoginProfileSummary>;
  onSubmitClaudeOauthCode?: (profileId: string, code: string) => Promise<LoginProfileSummary>;
}

const authTypesByProvider = {
  codex: [
    ['codex_chatgpt_session', 'ChatGPT subscription'],
    ['codex_api_key', 'OpenAI API key'],
  ],
  claude: [
    ['claude_oauth', 'Claude subscription'],
    ['claude_api_key', 'Anthropic API key'],
  ],
  opencode: [
    ['opencode_auth', 'Managed OpenCode environment'],
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
    title: 'ChatGPT subscription',
    body: 'Browser sign in for a ChatGPT subscription account.',
  },
  claude_api_key: {
    title: 'API key',
    body: 'Direct Anthropic API access for Claude runs.',
  },
  claude_oauth: {
    title: 'Claude subscription',
    body: 'Browser sign in for a Claude subscription account.',
  },
  opencode_auth: {
    title: 'OpenCode providers',
    body: 'An isolated OpenCode environment containing your connected provider accounts.',
  },
};

const SecretIcon = ({ authType }: { authType: string }) => {
  if (authType === 'codex_chatgpt_session' || authType === 'claude_oauth') return <ShieldCheck className="h-4 w-4" />;
  if (authType.includes('token')) return <Terminal className="h-4 w-4" />;
  return <KeyRound className="h-4 w-4" />;
};

const formatOpenCodeExpiry = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
};

const formatOpenCodeFieldValue = (value: unknown) => (
  typeof value === 'string' ? value : JSON.stringify(value)
);

const parseOpenCodeFieldValue = (value: string, previous: unknown) => {
  if (typeof previous === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (typeof previous === 'boolean') return value === 'true';
  if (previous === null || typeof previous === 'object') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

const isSecretOpenCodeField = (field: string) => (
  /(key|access|refresh|token|secret|password)/i.test(field)
);

export function LoginProfileEditor({
  open,
  provider,
  profile,
  isSaving,
  error,
  onOpenChange,
  onSave,
  onLoadOpenCodeAuth,
  onConnectCodex,
  onConnectClaudeOauth,
  onPollClaudeOauth,
  onSubmitClaudeOauthCode,
}: LoginProfileEditorProps) {
  const authTypes = authTypesByProvider[provider];
  const [displayName, setDisplayName] = useState('');
  const [authType, setAuthType] = useState<string>(authTypes[0][0]);
  const [secret, setSecret] = useState('');
  const [isLoadingOpenCodeAuth, setIsLoadingOpenCodeAuth] = useState(false);
  const [configJson, setConfigJson] = useState('{}');
  const [makeDefault, setMakeDefault] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [codexLoginStart, setCodexLoginStart] = useState<CodexLoginStart | null>(null);
  const [claudeLoginStart, setClaudeLoginStart] = useState<ClaudeOAuthLoginStart | null>(null);
  const [claudeLoginCode, setClaudeLoginCode] = useState('');
  const [showClaudeCodeInput, setShowClaudeCodeInput] = useState(false);
  const [claudeLoginReady, setClaudeLoginReady] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedClaudeUrl, setCopiedClaudeUrl] = useState(false);
  const claudeLoginPollInFlightRef = useRef(false);
  const initialOpenCodeAuthRef = useRef('');

  useEffect(() => {
    if (!open) return;
    setDisplayName(profile?.displayName ?? (
      provider === 'codex' ? 'Codex login' : provider === 'claude' ? 'Claude login' : 'OpenCode environment'
    ));
    setAuthType(profile?.authType ?? authTypes[0][0]);
    setSecret('');
    setIsLoadingOpenCodeAuth(false);
    initialOpenCodeAuthRef.current = '';
    setConfigJson(JSON.stringify(profile?.config ?? {}, null, 2));
    setMakeDefault(profile?.isDefault ?? true);
    setLocalError(null);
    setCodexLoginStart(null);
    setClaudeLoginStart(null);
    setClaudeLoginCode('');
    setShowClaudeCodeInput(false);
    setClaudeLoginReady(false);
    setCopiedCode(false);
    setCopiedClaudeUrl(false);
  }, [authTypes, open, profile?.id, provider]);

  useEffect(() => {
    if (!open || provider !== 'opencode' || !profile?.id || !onLoadOpenCodeAuth) return;
    let cancelled = false;
    setIsLoadingOpenCodeAuth(true);
    void onLoadOpenCodeAuth(profile.id)
      .then((storedAuth) => {
        if (cancelled) return;
        let formatted = storedAuth;
        try {
          formatted = JSON.stringify(JSON.parse(storedAuth), null, 2);
        } catch {
          // Keep the stored text editable if a legacy profile is not formatted JSON.
        }
        initialOpenCodeAuthRef.current = formatted;
        setSecret(formatted);
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setLocalError(caughtError instanceof Error ? caughtError.message : String(caughtError));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingOpenCodeAuth(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onLoadOpenCodeAuth, open, profile?.id, provider]);

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
      if (claudeLoginPollInFlightRef.current) return;
      claudeLoginPollInFlightRef.current = true;
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
          const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
          setLocalError(message);
          if (message.includes('login profile not found') || message.includes('No pending Claude login')) {
            setClaudeLoginStart(null);
          }
        }
      }
      finally {
        claudeLoginPollInFlightRef.current = false;
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
    if (authType === 'opencode_auth') return 'Paste the contents of OpenCode auth.json';
    if (authType.includes('bedrock') || authType.includes('vertex') || authType.includes('foundry')) {
      return 'Paste secret JSON for this provider';
    }
    return 'Paste API key or token';
  }, [authType]);

  const isCodexManagedSession = provider === 'codex' && authType === 'codex_chatgpt_session';
  const isClaudeOAuth = provider === 'claude' && authType === 'claude_oauth';
  const isCodexApiKey = provider === 'codex' && authType === 'codex_api_key';
  const showConfigJson = provider === 'claude' && !isCodexManagedSession && !isClaudeOAuth && (
    advancedConfigAuthTypes.has(authType) || hasConfigValues(profile?.config)
  );
  const providerLabel = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'OpenCode';
  const secretLabel = isCodexApiKey ? 'OpenAI API key' : provider === 'opencode' ? 'OpenCode auth.json' : 'Secret';
  const openCodeAuthEntries = useMemo(() => {
    if (provider !== 'opencode' || !secret.trim()) return [];
    try {
      const parsed = JSON.parse(secret);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return Object.entries(parsed).map(([providerId, value]) => ({
        providerId,
        value: value && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, unknown>
          : null,
      }));
    } catch {
      return null;
    }
  }, [provider, secret]);

  const updateOpenCodeAuth = (mutate: (parsed: Record<string, Record<string, unknown>>) => void) => {
    try {
      const parsed = JSON.parse(secret) as Record<string, Record<string, unknown>>;
      mutate(parsed);
      setSecret(JSON.stringify(parsed, null, 2));
    } catch (caughtError) {
      setLocalError(caughtError instanceof Error ? caughtError.message : 'Fix the Advanced JSON before editing provider fields.');
    }
  };

  const updateOpenCodeAuthField = (providerId: string, field: string, value: string) => {
    updateOpenCodeAuth((parsed) => {
      const entry = parsed[providerId] ?? {};
      parsed[providerId] = {
        ...entry,
        [field]: parseOpenCodeFieldValue(value, entry[field]),
      };
    });
  };

  const renameOpenCodeAuthField = (providerId: string, field: string, nextField: string) => {
    const normalized = nextField.trim();
    if (!normalized || normalized === field) return;
    updateOpenCodeAuth((parsed) => {
      const entry = parsed[providerId] ?? {};
      if (Object.prototype.hasOwnProperty.call(entry, normalized)) {
        throw new Error(`Field ${normalized} already exists`);
      }
      const renamed = Object.fromEntries(Object.entries(entry).map(([key, value]) => (
        key === field ? [normalized, value] : [key, value]
      )));
      parsed[providerId] = renamed;
    });
  };

  const removeOpenCodeAuthField = (providerId: string, field: string) => {
    updateOpenCodeAuth((parsed) => {
      const entry = { ...(parsed[providerId] ?? {}) };
      delete entry[field];
      parsed[providerId] = entry;
    });
  };

  const addOpenCodeAuthField = (providerId: string) => {
    updateOpenCodeAuth((parsed) => {
      const entry = { ...(parsed[providerId] ?? {}) };
      let field = 'newField';
      let suffix = 2;
      while (Object.prototype.hasOwnProperty.call(entry, field)) {
        field = `newField${suffix}`;
        suffix += 1;
      }
      entry[field] = '';
      parsed[providerId] = entry;
    });
  };

  const buildRequest = (): UpsertLoginProfileRequest | null => {
    setLocalError(null);
    let nextSecret = secret.trim() ? secret : null;
    if (provider === 'opencode') {
      if (!secret.trim()) {
        setLocalError('OpenCode auth.json cannot be empty.');
        return null;
      }
      try {
        const parsed = JSON.parse(secret);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
      } catch {
        setLocalError('OpenCode auth.json must be a valid JSON object.');
        return null;
      }
      if (profile && secret === initialOpenCodeAuthRef.current) nextSecret = null;
    }
    let config: Record<string, any> = profile?.config ?? {};
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
      secret: isCodexManagedSession || isClaudeOAuth ? null : nextSecret,
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
        setShowClaudeCodeInput(true);
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

  const copyClaudeLoginUrl = async () => {
    if (!claudeLoginStart?.loginUrl) return;
    await navigator.clipboard?.writeText(claudeLoginStart.loginUrl);
    setCopiedClaudeUrl(true);
    window.setTimeout(() => setCopiedClaudeUrl(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-hidden p-0 sm:max-w-2xl">
        <form onSubmit={handleSubmit} className="flex max-h-[calc(100vh-2rem)] flex-col">
          <DialogHeader className="border-b border-[hsl(var(--app-border)/0.72)] bg-muted/28 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                {provider === 'codex' ? <ShieldCheck className="h-5 w-5" /> : <Terminal className="h-5 w-5" />}
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-lg">{profile ? `Edit ${providerLabel} account` : `Add ${providerLabel} account`}</DialogTitle>
                <DialogDescription className="mt-1">
                  {provider === 'opencode' && profile
                    ? 'Edit the auth.json stored in this isolated OpenCode environment.'
                    : 'Profile secrets stay in the OS credential store; saved secret values are never shown here.'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid gap-5 overflow-y-auto px-5 py-5">
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
                {provider === 'opencode' ? (
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    {profile ? (
                      <>Update provider keys or login data below. Saving replaces the isolated configuration and checks providers again.</>
                    ) : (
                      <>Usually located at <code className="font-mono text-foreground">~/.local/share/opencode/auth.json</code>
                        {' '}(or <code className="font-mono text-foreground">$XDG_DATA_HOME/opencode/auth.json</code>). Paste the entire file contents.</>
                    )}
                  </p>
                ) : null}
                {provider === 'opencode' ? (
                  <div className="grid gap-2">
                    {isLoadingOpenCodeAuth ? (
                      <div className="flex min-h-20 items-center justify-center rounded-lg bg-muted/30 text-[12px] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)]">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading current auth.json
                      </div>
                    ) : openCodeAuthEntries && openCodeAuthEntries.length > 0 ? (
                      openCodeAuthEntries.map((entry) => {
                        const entryType = typeof entry.value?.type === 'string' ? entry.value.type : 'unknown';
                        const expiry = formatOpenCodeExpiry(entry.value?.expires);
                        return (
                          <details key={entry.providerId} className="group overflow-hidden rounded-lg bg-muted/30 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)]">
                            <summary className="cursor-pointer list-none px-3 py-2.5 marker:hidden">
                              <span className="flex items-center justify-between gap-3">
                                <span className="min-w-0">
                                  <span className="block truncate text-[12px] font-semibold text-foreground">{getOpenCodeProviderLabel(entry.providerId)}</span>
                                  {entryType === 'oauth' ? (
                                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                                      Managed session{expiry ? ` · expires ${expiry}` : ''}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="rounded-md bg-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)]">
                                  {entryType === 'api' ? 'API key' : entryType === 'oauth' ? 'OAuth' : entryType}
                                </span>
                              </span>
                            </summary>
                            <div className="grid gap-2 border-t border-[hsl(var(--app-border)/0.5)] p-3">
                              {Object.entries(entry.value ?? {}).map(([field, fieldValue]) => (
                                <div key={field} className="grid grid-cols-[minmax(7rem,0.72fr)_minmax(0,1.4fr)_2.5rem] items-end gap-2">
                                  <div className="grid gap-1">
                                    <Label htmlFor={`opencode-field-name-${entry.providerId}-${field}`} className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Field</Label>
                                    <Input
                                      id={`opencode-field-name-${entry.providerId}-${field}`}
                                      aria-label={`${field} field name for ${getOpenCodeProviderLabel(entry.providerId)}`}
                                      defaultValue={field}
                                      onBlur={(event) => renameOpenCodeAuthField(entry.providerId, field, event.target.value)}
                                      className="h-10 font-mono text-xs"
                                    />
                                  </div>
                                  <div className="grid min-w-0 gap-1">
                                    <Label htmlFor={`opencode-field-value-${entry.providerId}-${field}`} className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Value</Label>
                                    <Input
                                      id={`opencode-field-value-${entry.providerId}-${field}`}
                                      aria-label={`${field} value for ${getOpenCodeProviderLabel(entry.providerId)}`}
                                      type={isSecretOpenCodeField(field) ? 'password' : 'text'}
                                      autoComplete="off"
                                      value={formatOpenCodeFieldValue(fieldValue)}
                                      onChange={(event) => updateOpenCodeAuthField(entry.providerId, field, event.target.value)}
                                      className="h-10 min-w-0 font-mono text-xs"
                                    />
                                  </div>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-10 w-10 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/35 dark:hover:text-red-300"
                                    onClick={() => removeOpenCodeAuthField(entry.providerId, field)}
                                    aria-label={`Remove ${field} from ${getOpenCodeProviderLabel(entry.providerId)}`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-1 h-10 justify-self-start"
                                onClick={() => addOpenCodeAuthField(entry.providerId)}
                              >
                                <Plus className="h-4 w-4" />
                                Add field
                              </Button>
                            </div>
                          </details>
                        );
                      })
                    ) : openCodeAuthEntries === null ? (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800 dark:bg-amber-950/35 dark:text-amber-300">
                        The JSON is invalid. Fix it in Advanced JSON below.
                      </p>
                    ) : null}

                    <details className="group rounded-lg bg-background shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]" open={!profile}>
                      <summary className="cursor-pointer list-none px-3 py-2.5 text-[11px] font-semibold text-foreground marker:hidden">
                        Replace full auth.json
                        <span className="ml-2 font-normal text-muted-foreground">Advanced</span>
                      </summary>
                      <div className="border-t border-[hsl(var(--app-border)/0.55)] p-3">
                        <p className="mb-2 text-pretty text-[11px] leading-5 text-muted-foreground">
                          Paste a complete auth.json here to replace every provider and field. The structured cards update from this JSON.
                        </p>
                        <Textarea
                          id="login-secret"
                          value={secret}
                          onChange={(event) => setSecret(event.target.value)}
                          placeholder={isLoadingOpenCodeAuth ? 'Loading current auth.json…' : secretPlaceholder}
                          className="min-h-36 resize-y font-mono text-xs leading-5"
                          required={!profile}
                          disabled={isLoadingOpenCodeAuth}
                        />
                      </div>
                    </details>
                  </div>
                ) : (
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
                )}
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
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[12px] font-semibold text-foreground">
                          <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--app-accent))]" />
                          Checking sign in
                        </div>
                        <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                          Open the sign in link in any browser, authorize, then paste the code shown there below.
                        </div>
                      </div>
                      {claudeLoginStart.loginUrl ? (
                        <a
                          href={claudeLoginStart.loginUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-[12px] font-medium text-[hsl(var(--app-accent))] hover:underline"
                        >
                          Open sign in
                        </a>
                      ) : null}
                    </div>
                    {claudeLoginStart.loginUrl ? (
                      <div className="mt-2 flex w-full min-w-0 items-center gap-2">
                        <Input
                          readOnly
                          value={claudeLoginStart.loginUrl}
                          onFocus={(event) => event.currentTarget.select()}
                          className="h-9 min-w-0 flex-1 font-mono text-[11px]"
                        />
                        <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={() => void copyClaudeLoginUrl()}>
                          {copiedClaudeUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          {copiedClaudeUrl ? 'Copied' : 'Copy link'}
                        </Button>
                      </div>
                    ) : null}
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
            <Button type="submit" disabled={isSaving || isLoadingOpenCodeAuth}>
              {isSaving || isLoadingOpenCodeAuth ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
