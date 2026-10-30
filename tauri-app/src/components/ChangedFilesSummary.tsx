import { FileText } from 'lucide-react';

interface ChangedFilesSummaryProps {
  files: string[];
  maxVisible?: number;
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Unmerged',
  '?': 'Untracked',
};

function parsePorcelainStatus(line: string): { status: string; path: string } {
  const trimmed = line.trim();
  if (!trimmed) return { status: 'Changed', path: line };

  if (trimmed === 'Repository has no commits yet.') {
    return { status: 'Git', path: trimmed };
  }

  const rawStatus = line.slice(0, 2);
  const path = line.slice(3).trim() || trimmed;
  const statusKey = rawStatus.replace(/\s/g, '').charAt(0);

  return {
    status: STATUS_LABELS[statusKey] ?? 'Changed',
    path,
  };
}

export function ChangedFilesSummary({ files, maxVisible = 5 }: ChangedFilesSummaryProps) {
  const visibleFiles = files.slice(0, maxVisible).map(parsePorcelainStatus);
  const remainingCount = Math.max(files.length - visibleFiles.length, 0);

  if (files.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg bg-[hsl(var(--app-warning)/0.08)] p-3 text-sm text-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-warning)/0.22)]">
      <div className="flex items-center gap-2 font-medium">
        <FileText className="h-4 w-4 text-[hsl(var(--app-warning))]" />
        <span className="tabular-nums">{files.length === 1 ? '1 changed file' : `${files.length} changed files`}</span>
      </div>
      <ul className="mt-2 divide-y divide-[hsl(var(--app-warning)/0.14)]">
        {visibleFiles.map((file, index) => (
          <li key={`${file.status}-${file.path}-${index}`} className="flex min-w-0 items-center gap-2 py-1 first:pt-0 last:pb-0">
            <span className="shrink-0 rounded-md bg-[hsl(var(--app-warning)/0.11)] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--app-warning))]">
              {file.status}
            </span>
            <span className="truncate font-mono text-xs text-foreground/80" title={file.path}>
              {file.path}
            </span>
          </li>
        ))}
      </ul>
      {remainingCount > 0 && (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          +{remainingCount} more {remainingCount === 1 ? 'file' : 'files'}
        </p>
      )}
    </div>
  );
}
