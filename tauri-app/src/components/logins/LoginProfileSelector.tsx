import { KeyRound } from 'lucide-react';
import { useMemo } from 'react';
import { useLoginProfilesStore } from '../../stores/loginProfilesStore';
import { isLoginProfileActive, isLoginProfileCompatibleWithProvider } from '../../lib/loginProfiles';

interface LoginProfileSelectorProps {
  provider: string | null;
  value: string | null;
  onChange: (profileId: string | null) => void;
}

export function LoginProfileSelector({ provider, value, onChange }: LoginProfileSelectorProps) {
  const profiles = useLoginProfilesStore((state) => state.profiles);
  const compatible = useMemo(
    () => profiles.filter((profile) => isLoginProfileCompatibleWithProvider(profile, provider)),
    [profiles, provider]
  );
  const readyCompatible = compatible.filter(isLoginProfileActive);

  if (!provider || compatible.length === 0) return null;

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <KeyRound className="h-3.5 w-3.5" />
      <select
        className="h-8 max-w-[150px] rounded-md border border-border bg-background px-2 text-sm text-foreground"
        value={value ?? compatible.find((profile) => profile.isDefault)?.id ?? compatible[0]?.id ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        aria-label="Login profile"
      >
        {compatible.map((profile) => (
          <option key={profile.id} value={profile.id} disabled={!isLoginProfileActive(profile)}>
            {profile.displayName}{profile.isDefault ? ' (active)' : ''}
            {!isLoginProfileActive(profile) ? ` (${profile.status})` : ''}
          </option>
        ))}
      </select>
      {readyCompatible.length === 0 ? (
        <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">Login inactive</span>
      ) : null}
    </label>
  );
}
