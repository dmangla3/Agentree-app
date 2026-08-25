import type { GitLocalRefInfo, GitRefSnapshot } from './agentClient';
import type { TrackedGitRef } from '../stores/workspaceStore';

const MAIN_GIT_REF = 'refs/heads/main';

const normalize = (value: string | null | undefined): string => value?.trim() ?? '';

const shortNameForGitRef = (gitRef: string): string => {
  if (gitRef === 'HEAD') return 'HEAD';
  return gitRef
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
    .replace(/^refs\/remotes\//, '')
    .trim() || gitRef;
};

export const getComposerBaseSnapshotGitRefs = (
  enabledTrackedGitRefs: readonly string[]
): string[] => (
  Array.from(new Set([
    MAIN_GIT_REF,
    ...enabledTrackedGitRefs.map((ref) => normalize(ref)).filter(Boolean),
  ])).sort()
);

export interface LiveGitRefs {
  refs: GitLocalRefInfo[];
  trackedRefs: TrackedGitRef[];
  headSha: string | null;
  tipByRef: Map<string, string>;
}

export const buildLiveGitRefs = (input: {
  refs: readonly GitLocalRefInfo[];
  trackedRefs?: readonly TrackedGitRef[];
  snapshot?: GitRefSnapshot | null;
  includeHead?: boolean;
}): LiveGitRefs => {
  const refsByName = new Map<string, GitLocalRefInfo>();

  for (const ref of input.refs) {
    const gitRef = normalize(ref.git_ref);
    const commitSha = normalize(ref.commit_sha);
    if (!gitRef || !commitSha) continue;
    refsByName.set(gitRef, {
      ...ref,
      git_ref: gitRef,
      short_name: normalize(ref.short_name) || shortNameForGitRef(gitRef),
      commit_sha: commitSha,
    });
  }

  const snapshotTipByRef = new Map<string, string>();
  for (const ref of input.snapshot?.refs ?? []) {
    const gitRef = normalize(ref.git_ref);
    const commitSha = normalize(ref.commit_sha);
    if (!gitRef || !commitSha) continue;
    snapshotTipByRef.set(gitRef, commitSha);

    const existing = refsByName.get(gitRef);
    refsByName.set(gitRef, {
      git_ref: gitRef,
      short_name: existing?.short_name ?? shortNameForGitRef(gitRef),
      commit_sha: commitSha,
      committed_at: existing?.committed_at,
    });
  }

  const headSha = normalize(input.snapshot?.head_sha) || null;
  const refs = Array.from(refsByName.values());
  if (input.includeHead !== false && headSha) {
    refs.unshift({ git_ref: 'HEAD', short_name: 'HEAD', commit_sha: headSha });
  }

  const trackedRefs = (input.trackedRefs ?? []).map((ref) => {
    if (ref.enabled === false) return ref;
    const gitRef = normalize(ref.git_ref);
    const liveTip = snapshotTipByRef.get(gitRef);
    if (!gitRef || !liveTip) return ref;
    return {
      ...ref,
      git_ref: gitRef,
      last_seen_commit_sha: liveTip,
    };
  });

  return {
    refs,
    trackedRefs,
    headSha,
    tipByRef: snapshotTipByRef,
  };
};
