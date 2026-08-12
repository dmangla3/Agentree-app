import { getFuzzyMatchScore } from './fuzzySearch';

export interface RepoMentionFile {
  path: string;
  name: string;
}

export interface RepoMentionSearchEntry {
  file: RepoMentionFile;
  normalizedPath: string;
  normalizedName: string;
  collapsedPath: string;
  collapsedName: string;
  pathSegments: string[];
  basenameTokens: string[];
}

const collapseFuzzyText = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

export const extractRepoMentionPaths = (value: string): string[] => {
  const matches = value.match(/(^|\s)@([^\s@]+)/g) ?? [];
  return matches.map((match) => match.trim().slice(1));
};

export const buildRepoMentionSearchIndex = (files: RepoMentionFile[]): RepoMentionSearchEntry[] => (
  files
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      const normalizedName = file.name.toLowerCase();
      return {
        file,
        normalizedPath,
        normalizedName,
        collapsedPath: collapseFuzzyText(normalizedPath),
        collapsedName: collapseFuzzyText(normalizedName),
        pathSegments: normalizedPath
          .split('/')
          .map((segment) => collapseFuzzyText(segment))
          .filter(Boolean),
        basenameTokens: normalizedName
          .split(/[^a-z0-9]+/)
          .map((segment) => collapseFuzzyText(segment))
          .filter(Boolean),
      };
    })
    .sort((left, right) => left.file.path.localeCompare(right.file.path))
);

const rankRepoMentionEntry = (
  query: string,
  entry: RepoMentionSearchEntry
): number | null => {
  const normalizedQuery = query.trim().toLowerCase();
  const collapsedQuery = collapseFuzzyText(normalizedQuery);
  if (!collapsedQuery) return 0;

  const candidateScores = [
    getFuzzyMatchScore(normalizedQuery, entry.normalizedName),
    getFuzzyMatchScore(normalizedQuery, entry.normalizedPath),
    getFuzzyMatchScore(collapsedQuery, entry.collapsedName),
    getFuzzyMatchScore(collapsedQuery, entry.collapsedPath),
  ].filter((score): score is number => score !== null);

  if (candidateScores.length === 0) return null;

  let score = Math.min(...candidateScores.map((value, index) => {
    if (index === 0) return value - 40;
    if (index === 2) return value - 25;
    if (index === 3) return value - 10;
    return value;
  }));

  if (entry.normalizedName.startsWith(normalizedQuery) || entry.collapsedName.startsWith(collapsedQuery)) {
    score -= 60;
  }
  if (entry.pathSegments.some((segment) => segment.startsWith(collapsedQuery))) {
    score -= 35;
  }
  if (entry.basenameTokens.some((token) => token.startsWith(collapsedQuery))) {
    score -= 45;
  }

  for (let splitIndex = 2; splitIndex <= collapsedQuery.length - 2; splitIndex += 1) {
    const left = collapsedQuery.slice(0, splitIndex);
    const right = collapsedQuery.slice(splitIndex);
    if (
      entry.pathSegments.some((segment) => segment.startsWith(left)) &&
      entry.basenameTokens.some((token) => token.startsWith(right))
    ) {
      score -= 80;
      break;
    }
  }

  return score;
};

export const getRepoMentionMatches = (
  index: RepoMentionSearchEntry[],
  query: string,
  limit = 8
): RepoMentionFile[] => {
  if (limit <= 0) return [];

  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return index.slice(0, limit).map((entry) => entry.file);
  }

  const best: Array<{ entry: RepoMentionSearchEntry; score: number }> = [];

  for (const entry of index) {
    const score = rankRepoMentionEntry(normalizedQuery, entry);
    if (score === null) continue;

    const ranked = { entry, score };
    const insertionIndex = best.findIndex((candidate) => (
      score < candidate.score ||
      (score === candidate.score && entry.file.path.localeCompare(candidate.entry.file.path) < 0)
    ));

    if (insertionIndex === -1) {
      if (best.length < limit) best.push(ranked);
    } else {
      best.splice(insertionIndex, 0, ranked);
      if (best.length > limit) best.pop();
    }
  }

  return best.map((candidate) => candidate.entry.file);
};

export const getMentionedRepoPathSet = (
  prompt: string,
  filePathSet: Set<string>
): Set<string> => (
  new Set(extractRepoMentionPaths(prompt).filter((path) => filePathSet.has(path)))
);
