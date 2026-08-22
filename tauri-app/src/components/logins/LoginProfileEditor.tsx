import { useEffect, useMemo, useState, type FormEvent } from 'react';
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
import type { UpsertLoginProfileRequest } from '../../lib/agentClient';
import type { LoginProfileSummary } from '../../lib/loginProfiles';

interface LoginProfileEditorProps {
  open: boolean;
  provider: 'codex' | 'claude';
  profile: LoginProfileSummary | null;
  isSaving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (request: UpsertLoginProfileRequest) => Promise<void>;
}

const authTypesByProvider = {
  codex: [
    ['codex_api_key', 'OpenAI API key'],
    ['codex_chatgpt_session', 'ChatGPT session JSON'],
  ],
  claude: [
    ['claude_api_key', 'Anthropic API key'],
    ['claude_auth_token', 'Anthropic auth token'],
    ['claude_bedrock', 'Bedrock advanced JSON'],
    ['claude_vertex', 'Vertex advanced JSON'],
    ['claude_azure_foundry', 'Azure Foundry advanced JSON'],
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

export function LoginProfileEditor({
  open,
  provider,
  profile,
  isSaving,
  error,
  onOpenChange,
  onSave,
}: LoginProfileEditorProps) {
  const authTypes = authTypesByProvider[provider];
  const [displayName, setDisplayName] = useState('');
  const [authType, setAuthType] = useState<string>(authTypes[0][0]);
  const [secret, setSecret] = useState('');
  const [configJson, setConfigJson] = useState('{}');
  const [makeDefault, setMakeDefault] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDisplayName(profile?.displayName ?? (provider === 'codex' ? 'Codex login' : 'Claude login'));
    setAuthType(profile?.authType ?? authTypes[0][0]);
    setSecret('');
    setConfigJson(JSON.stringify(profile?.config ?? {}, null, 2));
    setMakeDefault(profile?.isDefault ?? true);
    setLocalError(null);
  }, [authTypes, open, profile, provider]);

  const secretPlaceholder = useMemo(() => {
    if (profile?.redactedHint) return `Leave blank to keep ${profile.redactedHint}`;
    if (authType === 'codex_chatgpt_session') return 'Paste Codex auth.json contents';
    if (authType.includes('bedrock') || authType.includes('vertex') || authType.includes('foundry')) {
      return 'Paste secret JSON for this provider';
    }
    return 'Paste API key or token';
  }, [authType, profile?.redactedHint]);

  const showConfigJson = advancedConfigAuthTypes.has(authType) || hasConfigValues(profile?.config);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    let config: Record<string, any> = {};
    if (showConfigJson) {
      try {
        config = JSON.parse(configJson || '{}');
      } catch {
        setLocalError('Config must be valid JSON.');
        return;
      }
    }
    await onSave({
      id: profile?.id ?? null,
      provider,
      displayName,
      authType,
      secret: secret.trim() ? secret : null,
      config,
      makeDefault,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{profile ? 'Edit login' : `Add ${provider === 'codex' ? 'Codex' : 'Claude'} login`}</DialogTitle>
            <DialogDescription>
              Secrets are stored by Tauri in the OS credential store. This form does not re-render saved secret values.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="login-display-name">Name</Label>
              <Input
                id="login-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="login-auth-type">Authentication</Label>
              <select
                id="login-auth-type"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                value={authType}
                onChange={(event) => setAuthType(event.target.value)}
              >
                {authTypes.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="login-secret">Secret</Label>
              <Textarea
                id="login-secret"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={secretPlaceholder}
                className="min-h-24 font-mono text-xs"
                required={!profile}
              />
            </div>

            {showConfigJson ? (
              <div className="grid gap-2">
                <Label htmlFor="login-config">Advanced config JSON</Label>
                <Textarea
                  id="login-config"
                  value={configJson}
                  onChange={(event) => setConfigJson(event.target.value)}
                  className="min-h-20 font-mono text-xs"
                />
              </div>
            ) : null}

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(event) => setMakeDefault(event.target.checked)}
              />
              Use as active login for this provider
            </label>
          </div>

          {localError || error ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/35 dark:text-red-300">
              {localError ?? error}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              Save login
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
