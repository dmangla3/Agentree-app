export interface TrackableGitRef {
  git_ref: string;
  short_name: string;
  commit_sha: string;
  committed_at?: string | null;
}

const parseCommitTime = (value: string | null | undefined): number => {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};

export const sortTrackableRefsByRecentCommit = <T extends TrackableGitRef>(refs: T[]): T[] => {
  return [...refs].sort((left, right) => {
    const timeDelta = parseCommitTime(right.committed_at) - parseCommitTime(left.committed_at);
    if (timeDelta !== 0) return timeDelta;
    return left.short_name.localeCompare(right.short_name, undefined, { sensitivity: 'base' });
  });
};
