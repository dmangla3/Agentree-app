import { useEffect, useState } from 'react';
import {
  FileText,
  Keyboard,
  type LucideIcon,
  Settings,
  ShieldCheck,
} from 'lucide-react';
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
import { cn } from '../lib/utils';

interface ConfigButtonProps {
  repoPath: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type ConfigPanelId = 'worktree-policy' | 'keyboard-shortcuts' | 'default-prompts';

const configPanels = [
  {
    id: 'worktree-policy',
    label: 'Worktree policy',
    description: 'Dependency, env, and output safeguards',
    icon: ShieldCheck,
  },
  {
    id: 'keyboard-shortcuts',
    label: 'Keyboard shortcuts',
    description: 'Review and override app shortcuts',
    icon: Keyboard,
  },
  {
    id: 'default-prompts',
    label: 'Default prompts',
    description: 'View and edit built-in prompt text',
    icon: FileText,
  },
] as const satisfies Array<{
  id: ConfigPanelId;
  label: string;
  description: string;
  icon: LucideIcon;
}>;

export function ConfigButton({ repoPath, open, onOpenChange }: ConfigButtonProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [activePanelId, setActivePanelId] = useState<ConfigPanelId>('worktree-policy');
  const isOpen = open ?? uncontrolledOpen;
  const setIsOpen = onOpenChange ?? setUncontrolledOpen;

  useEffect(() => {
    if (open) {
      setActivePanelId('worktree-policy');
    }
  }, [open]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="app-rail-button app-focus-ring"
          title="Configuration"
          aria-label="Configuration"
        >
          <Settings size={18} strokeWidth={2.1} />
        </button>
      </DialogTrigger>
      <DialogContent className="h-[min(720px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1040px] gap-0 overflow-hidden rounded-xl border-border/80 p-0 shadow-[0_28px_90px_-46px_hsl(var(--foreground)/0.65)] sm:max-w-[1040px]">
        <DialogTitle className="sr-only">Configuration</DialogTitle>
        <DialogDescription className="sr-only">
          Configure worktree policy, keyboard shortcuts, and default prompts.
        </DialogDescription>

        <div className="grid h-full min-h-0 grid-cols-1 bg-background md:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-b border-border/70 bg-muted/25 p-3 md:border-b-0 md:border-r">
            <div className="px-2 py-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Settings size={16} className="text-muted-foreground" />
                Configuration
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                App and workspace controls
              </div>
            </div>

            <div className="mt-2 space-y-1" role="listbox" aria-label="Configuration sections">
              {configPanels.map((panel) => {
                const Icon = panel.icon;
                const isActive = activePanelId === panel.id;
                return (
                  <button
                    key={panel.id}
                    type="button"
                    className={cn(
                      'app-focus-ring flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-[background-color,color,transform] active:scale-[0.98]',
                      isActive
                        ? 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
                        : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'
                    )}
                    role="option"
                    aria-selected={isActive}
                    onClick={() => setActivePanelId(panel.id)}
                  >
                    <Icon size={16} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium leading-5">{panel.label}</span>
                      <span className="block text-xs leading-4 text-muted-foreground">
                        {panel.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0">
            {activePanelId === 'worktree-policy' ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <WorktreePolicyPanel repoPath={repoPath} />
              </div>
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
