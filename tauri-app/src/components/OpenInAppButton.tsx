import { useState, useEffect, useCallback } from 'react';
import { Command } from '@tauri-apps/plugin-shell';
import { cn } from '../lib/utils';
import { Button } from '../../@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../@/components/ui/dropdown-menu';
import { ExternalLink, Terminal, Code2, ChevronDown, Loader2 } from 'lucide-react';

interface AppOption {
  id: string;
  name: string;
  /** Shell command name (must match Tauri capabilities) */
  cmd: string;
  /** Args builder: given the path, return the args array */
  args: (path: string) => string[];
  icon: React.ReactNode;
  category: 'editor' | 'terminal';
}

const ALL_APPS: AppOption[] = [
  // Terminals
  { id: 'terminal', name: 'Terminal', cmd: 'open', args: (p) => ['-a', 'Terminal', p], icon: <Terminal size={14} />, category: 'terminal' },
  { id: 'iterm', name: 'iTerm', cmd: 'open', args: (p) => ['-a', 'iTerm', p], icon: <Terminal size={14} />, category: 'terminal' },
  { id: 'warp', name: 'Warp', cmd: 'open', args: (p) => ['-a', 'Warp', p], icon: <Terminal size={14} />, category: 'terminal' },
  { id: 'kitty', name: 'Kitty', cmd: 'open', args: (p) => ['-a', 'kitty', p], icon: <Terminal size={14} />, category: 'terminal' },
  { id: 'alacritty', name: 'Alacritty', cmd: 'open', args: (p) => ['-a', 'Alacritty', p], icon: <Terminal size={14} />, category: 'terminal' },
  // Editors
  { id: 'vscode', name: 'VS Code', cmd: 'code', args: (p) => [p], icon: <Code2 size={14} />, category: 'editor' },
  { id: 'cursor', name: 'Cursor', cmd: 'cursor', args: (p) => [p], icon: <Code2 size={14} />, category: 'editor' },
  { id: 'zed', name: 'Zed', cmd: 'zed', args: (p) => [p], icon: <Code2 size={14} />, category: 'editor' },
  { id: 'sublime', name: 'Sublime Text', cmd: 'subl', args: (p) => [p], icon: <Code2 size={14} />, category: 'editor' },
  { id: 'idea', name: 'IntelliJ IDEA', cmd: 'idea', args: (p) => [p], icon: <Code2 size={14} />, category: 'editor' },
  { id: 'finder', name: 'Finder', cmd: 'open', args: (p) => [p], icon: <ExternalLink size={14} />, category: 'editor' },
];

// App names as they appear in /Applications (for detection)
const APP_DETECTION: Record<string, string> = {
  terminal: 'Terminal',
  iterm: 'iTerm',
  warp: 'Warp',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  zed: 'Zed',
  sublime: 'Sublime Text',
  idea: 'IntelliJ IDEA',
  finder: 'Finder',
};

let cachedAvailableApps: string[] | null = null;

async function detectAvailableApps(): Promise<string[]> {
  if (cachedAvailableApps) return cachedAvailableApps;

  const available: string[] = ['terminal', 'finder']; // Always available on macOS

  // Check for CLI tools that indicate editor availability
  const cliChecks: { id: string; cmd: string }[] = [
    { id: 'vscode', cmd: 'code' },
    { id: 'cursor', cmd: 'cursor' },
    { id: 'zed', cmd: 'zed' },
    { id: 'sublime', cmd: 'subl' },
    { id: 'idea', cmd: 'idea' },
  ];

  // Check CLI tools in parallel
  const cliResults = await Promise.allSettled(
    cliChecks.map(async ({ id, cmd }) => {
      try {
        const result = await Command.create('open', ['-Ra', APP_DETECTION[id] || cmd]).execute();
        if (result.code === 0) return id;
      } catch { /* not available */ }
      return null;
    })
  );

  for (const r of cliResults) {
    if (r.status === 'fulfilled' && r.value) available.push(r.value);
  }

  // Check terminal apps via open -Ra
  const terminalApps: { id: string }[] = [
    { id: 'iterm' },
    { id: 'warp' },
    { id: 'kitty' },
    { id: 'alacritty' },
  ];

  const termResults = await Promise.allSettled(
    terminalApps.map(async ({ id }) => {
      try {
        const result = await Command.create('open', ['-Ra', APP_DETECTION[id] || id]).execute();
        if (result.code === 0) return id;
      } catch { /* not available */ }
      return null;
    })
  );

  for (const r of termResults) {
    if (r.status === 'fulfilled' && r.value) available.push(r.value);
  }

  cachedAvailableApps = available;
  return available;
}

interface OpenInAppButtonProps {
  path: string;
  className?: string;
  /** Compact mode for inline use in chat messages */
  compact?: boolean;
  /** Which categories to show. Defaults to both. */
  categories?: ('editor' | 'terminal')[];
}

export function OpenInAppButton({
  path,
  className,
  compact = false,
  categories = ['editor', 'terminal'],
}: OpenInAppButtonProps) {
  const [availableApps, setAvailableApps] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    detectAvailableApps().then((apps) => {
      setAvailableApps(apps);
      setLoading(false);
    });
  }, []);

  const handleOpen = useCallback(async (app: AppOption) => {
    setOpening(app.id);
    try {
      await Command.create(app.cmd, app.args(path)).execute();
    } catch (e) {
      console.error(`Failed to open ${app.name}:`, e);
    } finally {
      setTimeout(() => setOpening(null), 500);
    }
  }, [path]);

  const filteredApps = ALL_APPS.filter(
    (app) => categories.includes(app.category) && availableApps.includes(app.id)
  );

  const terminals = filteredApps.filter((a) => a.category === 'terminal');
  const editors = filteredApps.filter((a) => a.category === 'editor');

  if (loading) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className={cn(compact ? 'h-8 gap-1 px-2 text-[10px]' : 'h-10 gap-1.5 text-xs', 'rounded-lg', className)}
      >
        <Loader2 size={compact ? 10 : 12} className="animate-spin motion-reduce:animate-none" />
        {!compact && 'Open'}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            compact
              ? 'h-8 gap-1 px-2 text-[10px] hover:border-primary/30 hover:bg-primary/5 hover:text-primary'
              : 'h-10 flex-1 gap-1.5 text-xs hover:border-primary/30 hover:bg-primary/5 hover:text-primary',
            'rounded-lg transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none',
            className
          )}
        >
          <ExternalLink size={compact ? 10 : 12} />
          Open
          <ChevronDown size={compact ? 8 : 10} className="opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {editors.length > 0 && (
          <>
            <DropdownMenuLabel className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Editors
            </DropdownMenuLabel>
            {editors.map((app) => (
              <DropdownMenuItem
                key={app.id}
                onClick={() => handleOpen(app)}
                disabled={opening === app.id}
                className="min-h-9 cursor-pointer"
              >
                {opening === app.id ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : app.icon}
                {app.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {editors.length > 0 && terminals.length > 0 && <DropdownMenuSeparator />}
        {terminals.length > 0 && (
          <>
            <DropdownMenuLabel className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Terminals
            </DropdownMenuLabel>
            {terminals.map((app) => (
              <DropdownMenuItem
                key={app.id}
                onClick={() => handleOpen(app)}
                disabled={opening === app.id}
                className="min-h-10 cursor-pointer gap-2 rounded-lg text-xs"
              >
                {opening === app.id ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : app.icon}
                {app.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
