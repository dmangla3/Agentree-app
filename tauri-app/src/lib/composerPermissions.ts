export type ComposerPermissionMode = 'fully-isolated' | 'safe-write' | 'full-access';

export interface ComposerPermissionOption {
  id: ComposerPermissionMode;
  label: string;
  description: string;
}

export const DEFAULT_COMPOSER_PERMISSION_MODE: ComposerPermissionMode = 'full-access';

export const COMPOSER_PERMISSION_OPTIONS: ComposerPermissionOption[] = [
  {
    id: 'fully-isolated',
    label: 'Fully Isolated',
    description: 'Read and write only inside the worktree. Network unavailable.',
  },
  {
    id: 'safe-write',
    label: 'Safe write',
    description: 'Full read and network access. Writes stay inside the worktree.',
  },
  {
    id: 'full-access',
    label: 'Full access',
    description: 'No filesystem or network restrictions.',
  },
];

export const normalizeComposerPermissionMode = (
  value: string | null | undefined
): ComposerPermissionMode => (
  COMPOSER_PERMISSION_OPTIONS.some((option) => option.id === value)
    ? value as ComposerPermissionMode
    : DEFAULT_COMPOSER_PERMISSION_MODE
);

export const getComposerPermissionOption = (
  mode: ComposerPermissionMode
): ComposerPermissionOption => (
  COMPOSER_PERMISSION_OPTIONS.find((option) => option.id === mode)
    ?? COMPOSER_PERMISSION_OPTIONS.find((option) => option.id === DEFAULT_COMPOSER_PERMISSION_MODE)!
);

const claudePermissionModeForComposerMode = (mode: ComposerPermissionMode): string => {
  if (mode === 'full-access') return 'bypassPermissions';
  if (mode === 'safe-write') return 'acceptEdits';
  return 'default';
};

const providerPermissionArgs = (
  agentType: string | null | undefined,
  mode: ComposerPermissionMode
): string[] => {
  if (agentType === 'claude') {
    return ['--permission-mode', claudePermissionModeForComposerMode(mode)];
  }
  if (agentType === 'codex') {
    return ['--permission-mode', mode];
  }
  return [];
};

export const removeProviderPermissionArgs = (args: string[]): string[] => {
  const cleaned: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--permission-mode') {
      index += 1;
      continue;
    }
    if (arg === '--dangerously-skip-permissions') {
      continue;
    }
    cleaned.push(arg);
  }
  return cleaned;
};

export const applyComposerPermissionArgs = (
  args: string[],
  agentType: string | null | undefined,
  mode: ComposerPermissionMode
): string[] => [
  ...removeProviderPermissionArgs(args),
  ...providerPermissionArgs(agentType, mode),
];
