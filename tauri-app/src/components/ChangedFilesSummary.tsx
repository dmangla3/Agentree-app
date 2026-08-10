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
    <div className="mt-3 rounded-md border border-orange-200/80 bg-white/65 p-3 text-sm text-orange-950 dark:border-orange-500/30 dark:bg-orange-950/35 dark:text-orange-100">
      <div className="flex items-center gap-2 font-medium">
        <FileText className="h-4 w-4 text-orange-700 dark:text-orange-300" />
        <span>{files.length === 1 ? '1 changed file' : `${files.length} changed files`}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {visibleFiles.map((file, index) => (
          <li key={`${file.status}-${file.path}-${index}`} className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-orange-100 px-1.5 py-0.5 text-[11px] font-medium text-orange-800 dark:bg-orange-500/12 dark:text-orange-200">
              {file.status}
            </span>
            <span className="truncate font-mono text-xs text-orange-950/85 dark:text-orange-100/80" title={file.path}>
              {file.path}
            </span>
          </li>
        ))}
      </ul>
      {remainingCount > 0 && (
        <p className="mt-2 text-xs text-orange-800 dark:text-orange-200/80">
          +{remainingCount} more {remainingCount === 1 ? 'file' : 'files'}
        </p>
      )}
    </div>
  );
}
