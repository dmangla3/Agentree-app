import { useEffect, useState } from 'react';
import {
  FileText,
  Keyboard,
  SlidersHorizontal,
  type LucideIcon,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { Gear } from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '../../@/components/ui/dialog';
import { ShortcutSettingsPanel } from './ShortcutSettingsPanel';
import { WorktreePolicyPanel } from './WorktreePolicyButton';
import { DefaultPromptSettingsPanel } from './DefaultPromptSettingsPanel';
import { ModelVisibilitySettingsPanel } from './ModelVisibilitySettingsPanel';
import {
  MODEL_CONFIGURATION_EVENT,
  type ModelConfigurationDetail,
} from '../lib/modelConfigurationEvents';
import { LOGIN_PROFILES_NAVIGATION_EVENT } from '../lib/loginNavigationEvents';
import type { RuntimeProvider } from '../lib/runtimeModels';
import { cn } from '../lib/utils';
import { RailIcon } from './RailIcon';
import { DESIGN_REVIEW_NAVIGATION_EVENT } from '../lib/designReviewNavigation';

interface ConfigButtonProps {
  repoPath: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  allowContinueWithDefaultPolicy?: boolean;
}

type ConfigPanelId = 'worktree-policy' | 'models' | 'keyboard-shortcuts' | 'default-prompts';

const configPanelGroups = [
  {
    label: 'Workspace',
    panels: [
      { id: 'models', label: 'Models', description: 'Choose models shown in selectors', icon: SlidersHorizontal },
      { id: 'worktree-policy', label: 'Worktree policy', description: 'Dependency, env, and output safeguards', icon: ShieldCheck },
    ],
  },
  {
    label: 'App',
    panels: [
      { id: 'keyboard-shortcuts', label: 'Keyboard shortcuts', description: 'Review and override app shortcuts', icon: Keyboard },
      { id: 'default-prompts', label: 'Default prompts', description: 'View and edit built-in prompt text', icon: FileText },
    ],
  },
] as const satisfies Array<{
  label: string;
  panels: Array<{ id: ConfigPanelId; label: string; description: string; icon: LucideIcon }>;
}>;

export function ConfigButton({
  repoPath,
  open,
  onOpenChange,
  allowContinueWithDefaultPolicy = false,
}: ConfigButtonProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [activePanelId, setActivePanelId] = useState<ConfigPanelId>('worktree-policy');
  const [modelProvider, setModelProvider] = useState<RuntimeProvider>('codex');
  const isOpen = open ?? uncontrolledOpen;
  const setIsOpen = onOpenChange ?? setUncontrolledOpen;

  useEffect(() => {
    if (open) {
      setActivePanelId('worktree-policy');
    }
  }, [open]);

  useEffect(() => {
    const handleOpenModels = (event: Event) => {
      const provider = (event as CustomEvent<ModelConfigurationDetail>).detail?.provider;
      if (provider !== 'codex' && provider !== 'claude' && provider !== 'opencode') return;
      setModelProvider(provider);
      setActivePanelId('models');
      setIsOpen(true);
    };
    window.addEventListener(MODEL_CONFIGURATION_EVENT, handleOpenModels);
    return () => window.removeEventListener(MODEL_CONFIGURATION_EVENT, handleOpenModels);
  }, [setIsOpen]);

  useEffect(() => {
    const handleOpenLogins = () => setIsOpen(false);
    window.addEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, handleOpenLogins);
    return () => window.removeEventListener(LOGIN_PROFILES_NAVIGATION_EVENT, handleOpenLogins);
  }, [setIsOpen]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handleDesignReviewNavigation = () => setIsOpen(false);
    window.addEventListener(DESIGN_REVIEW_NAVIGATION_EVENT, handleDesignReviewNavigation);
    return () => window.removeEventListener(DESIGN_REVIEW_NAVIGATION_EVENT, handleDesignReviewNavigation);
  }, [setIsOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="app-rail-button app-focus-ring"
          title="Configuration"
          aria-label="Configuration"
        >
          <RailIcon icon={Gear} />
        </button>
      </DialogTrigger>
      <DialogContent data-design-scope="panels" data-design-part="settings-dialog" className="h-[min(720px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1040px] gap-0 overflow-hidden rounded-xl border-border/70 bg-background p-0 shadow-[0_0_0_1px_hsl(var(--foreground)/0.025),0_24px_72px_-34px_hsl(var(--foreground)/0.58)] dark:border-white/10 dark:bg-[hsl(var(--app-panel))] sm:max-w-[1040px]">
        <DialogTitle className="sr-only">Configuration</DialogTitle>
        <DialogDescription className="sr-only">
          Configure worktree policy, visible models, keyboard shortcuts, and default prompts.
        </DialogDescription>

        <div data-design-part="settings-layout" className="grid h-full min-h-0 grid-cols-1 bg-background dark:bg-[hsl(var(--app-bg))] md:grid-cols-[216px_minmax(0,1fr)]">
          <aside data-design-part="settings-navigation" className="min-h-0 overflow-y-auto border-b border-border/60 bg-muted/20 px-3 py-4 dark:border-white/10 dark:bg-white/[0.025] md:border-b-0 md:border-r">
            <div data-design-part="settings-heading" className="px-2 pb-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Settings size={16} className="text-muted-foreground" />
                <span data-design-part="settings-title">Settings</span>
              </div>
            </div>

            <div className="space-y-4" role="listbox" aria-label="Configuration sections">
              {configPanelGroups.map((group) => (
                <div key={group.label} data-design-part="settings-group">
                  <div data-design-part="settings-group-label" className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {group.label}
                  </div>
                  <div className="space-y-0.5">
                    {group.panels.map((panel) => {
                      const Icon = panel.icon;
                      const isActive = activePanelId === panel.id;
                      return (
                        <button
                          key={panel.id}
                          type="button"
                          data-design-part="settings-option"
                          className={cn(
                            'app-focus-ring flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none',
                            isActive
                              ? 'bg-[hsl(var(--app-accent)/0.11)] text-foreground shadow-[inset_2px_0_0_hsl(var(--app-accent))] dark:bg-white/[0.08] dark:shadow-[inset_2px_0_0_hsl(0_0%_100%)]'
                              : 'text-muted-foreground hover:bg-background/75 hover:text-foreground dark:hover:bg-white/[0.06]'
                          )}
                          role="option"
                          aria-selected={isActive}
                          onClick={() => setActivePanelId(panel.id)}
                        >
                          <Icon size={16} className="shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium leading-5">{panel.label}</span>
                            <span data-design-part="settings-option-description" className="hidden text-xs leading-4 text-muted-foreground">
                              {panel.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0">
            {activePanelId === 'worktree-policy' ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <WorktreePolicyPanel
                  repoPath={repoPath}
                  onContinueWithDefaultPolicy={
                    allowContinueWithDefaultPolicy && onOpenChange
                      ? () => onOpenChange(false)
                      : undefined
                  }
                />
              </div>
            ) : activePanelId === 'models' ? (
              <ModelVisibilitySettingsPanel initialProvider={modelProvider} />
            ) : activePanelId === 'keyboard-shortcuts' ? (
              <ShortcutSettingsPanel />
            ) : (
              <DefaultPromptSettingsPanel />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
