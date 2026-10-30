import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getName, getTauriVersion, getVersion } from '@tauri-apps/api/app';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Check, ClipboardList, Loader2 } from 'lucide-react';
import { Question } from '@phosphor-icons/react';
import { Button } from '../../@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../@/components/ui/dropdown-menu';
import { useToastHelpers } from './Toast';
import { cn } from '../lib/utils';
import { RailIcon } from './RailIcon';

type LogPaths = {
  log_dir: string;
  frontend_log: string;
  backend_log: string;
};

type DiagnosticsLogBundle = {
  logPaths: LogPaths;
  frontendExcerpt: string;
  backendExcerpt: string;
  metricKitExcerpt: string;
  metricKitDiagnosticFiles: string[];
  maxLinesPerLog: number;
};

interface DiagnosticsButtonProps {
  selectedWorkspaceId: string | null;
  selectedWorkspaceName: string | null;
  className?: string;
}

const readDiagnosticsLogs = async (): Promise<DiagnosticsLogBundle | null> => {
  try {
    return await invoke<DiagnosticsLogBundle>('get_diagnostics_logs', { maxLinesPerLog: 200 });
  } catch {
    return null;
  }
};

const readAppInfo = async () => {
  const [appName, appVersion, tauriVersion] = await Promise.all([
    getName().catch(() => 'Agentree'),
    getVersion().catch(() => 'unknown'),
    getTauriVersion().catch(() => 'unknown'),
  ]);

  return { appName, appVersion, tauriVersion };
};

const formatDiagnostics = ({
  appName,
  appVersion,
  tauriVersion,
  diagnosticsLogs,
  selectedWorkspaceId,
  selectedWorkspaceName,
}: {
  appName: string;
  appVersion: string;
  tauriVersion: string;
  diagnosticsLogs: DiagnosticsLogBundle | null;
  selectedWorkspaceId: string | null;
  selectedWorkspaceName: string | null;
}) => {
  const logPaths = diagnosticsLogs?.logPaths ?? null;
  const excerptLineCount = diagnosticsLogs?.maxLinesPerLog ?? 0;
  const lines = [
    'Agentree Diagnostics',
    `Generated: ${new Date().toISOString()}`,
    `App: ${appName}`,
    `App version: ${appVersion}`,
    `Tauri version: ${tauriVersion}`,
    `Mode: ${import.meta.env.DEV ? 'development' : 'production'}`,
    `Location: ${typeof window !== 'undefined' ? window.location.href : 'unknown'}`,
    `User agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
    `Workspace: ${selectedWorkspaceName || 'none selected'}`,
    `Workspace ID: ${selectedWorkspaceId || 'none'}`,
    '',
    'Local logs',
    `Log directory: ${logPaths?.log_dir ?? 'unavailable'}`,
    `Frontend log: ${logPaths?.frontend_log ?? 'unavailable'}`,
    `Backend log: ${logPaths?.backend_log ?? 'unavailable'}`,
    `MetricKit diagnostics: ${diagnosticsLogs?.metricKitDiagnosticFiles?.length ? diagnosticsLogs.metricKitDiagnosticFiles.join(', ') : 'none captured'}`,
    '',
    `Recent frontend log${excerptLineCount ? ` (last ${excerptLineCount} lines)` : ''}`,
    diagnosticsLogs?.frontendExcerpt?.trim() || 'unavailable',
    '',
    `Recent backend log${excerptLineCount ? ` (last ${excerptLineCount} lines)` : ''}`,
    diagnosticsLogs?.backendExcerpt?.trim() || 'unavailable',
    '',
    `Recent MetricKit log${excerptLineCount ? ` (last ${excerptLineCount} lines)` : ''}`,
    diagnosticsLogs?.metricKitExcerpt?.trim() || 'no MetricKit diagnostics captured',
  ];

  return lines.join('\n');
};

export function DiagnosticsButton({
  selectedWorkspaceId,
  selectedWorkspaceName,
  className,
}: DiagnosticsButtonProps) {
  const toast = useToastHelpers();
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (copying) return;

    setCopying(true);
    try {
      const [appInfo, diagnosticsLogs] = await Promise.all([
        readAppInfo(),
        readDiagnosticsLogs(),
      ]);
      const diagnostics = formatDiagnostics({
        ...appInfo,
        diagnosticsLogs,
        selectedWorkspaceId,
        selectedWorkspaceName,
      });

      await writeText(diagnostics);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      toast.success('Diagnostics copied', 'Paste this into a support note when reporting an issue.');
    } catch (error) {
      console.error('[DiagnosticsButton] Failed to copy diagnostics:', error);
      toast.error(
        'Unable to copy diagnostics',
        error instanceof Error ? error.message : 'Clipboard access failed.'
      );
    } finally {
      setCopying(false);
    }
  }, [copying, selectedWorkspaceId, selectedWorkspaceName, toast]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('app-rail-button app-focus-ring', className)}
          title="Help"
          aria-label="Help"
        >
          <RailIcon icon={Question} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-52">
        <DropdownMenuItem
          disabled={copying}
          className="min-h-9"
          onSelect={() => {
            void handleCopy();
          }}
        >
          {copying ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <ClipboardList className="h-4 w-4" />
          )}
          Copy diagnostics
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
