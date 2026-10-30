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

export const getComposerPermissionOption = (
  mode: ComposerPermissionMode
): ComposerPermissionOption => (
  COMPOSER_PERMISSION_OPTIONS.find((option) => option.id === mode)
    ?? COMPOSER_PERMISSION_OPTIONS.find((option) => option.id === DEFAULT_COMPOSER_PERMISSION_MODE)!
);
