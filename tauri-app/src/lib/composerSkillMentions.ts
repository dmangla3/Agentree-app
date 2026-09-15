import { getFuzzyMatchScore } from './fuzzySearch';

export interface ComposerSkill {
  id: string;
  name: string;
  description: string;
}

export interface ActiveSkillMention {
  start: number;
  end: number;
  query: string;
}

const collapseFuzzyText = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const SKILL_MENTION_START_PATTERN = /(^|\s)\$/g;

const sortSkillNamesForMatching = (skillNames: readonly string[]): string[] => (
  Array.from(new Set(skillNames.map((name) => name.trim()).filter(Boolean)))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
);

export const getActiveSkillMention = (
  value: string,
  cursorPosition: number | null | undefined
): ActiveSkillMention | null => {
  if (cursorPosition == null) return null;
  const beforeCursor = value.slice(0, cursorPosition);
  const mentionMatch = beforeCursor.match(/(^|\s)\$([^\s\n$]*)$/);
  if (!mentionMatch) return null;

  const query = mentionMatch[2] ?? '';
  return {
    start: beforeCursor.length - query.length - 1,
    end: cursorPosition,
    query,
  };
};

export const insertSkillMention = (
  value: string,
  mention: ActiveSkillMention,
  skillName: string
): { value: string; cursor: number } => {
  const suffix = value.slice(mention.end);
  const separator = suffix.length === 0 ? ' ' : /^\s/.test(suffix) ? '' : ' ';
  const nextValue = `${value.slice(0, mention.start)}$${skillName}${separator}${suffix}`;
  return {
    value: nextValue,
    cursor: mention.start + skillName.length + 1 + separator.length,
  };
};

export const getSkillMentionNames = (value: string, knownSkillNames: readonly string[] = []): string[] => {
  const sortedKnownSkillNames = sortSkillNamesForMatching(knownSkillNames);
  if (sortedKnownSkillNames.length > 0) {
    const names: string[] = [];
    for (const match of value.matchAll(SKILL_MENTION_START_PATTERN)) {
      const leadingLength = match[1]?.length ?? 0;
      const start = (match.index ?? 0) + leadingLength + 1;
      const nextDollar = value.indexOf('$', start);
      const nextNewline = value.indexOf('\n', start);
      const endCandidates = [nextDollar, nextNewline].filter((index) => index >= 0);
      const end = endCandidates.length > 0 ? Math.min(...endCandidates) : value.length;
      const tail = value.slice(start, end);
      const knownName = sortedKnownSkillNames.find((name) => (
        tail === name || (tail.startsWith(name) && /\s/.test(tail.charAt(name.length)))
      ));
      if (knownName) names.push(knownName);
    }
    return names;
  }

  const matches = value.matchAll(/(^|\s)\$([^$\n]+?)(?=\s+and\s+\$|\s+\$|$)/g);
  return Array.from(matches)
    .map((match) => (match[2] ?? '').trim())
    .filter(Boolean);
};

const rankSkillMention = (query: string, skill: ComposerSkill): number | null => {
  const normalizedQuery = query.trim().toLowerCase();
  const collapsedQuery = collapseFuzzyText(normalizedQuery);
  if (!collapsedQuery) return 0;

  const normalizedName = skill.name.toLowerCase();
  const normalizedId = skill.id.toLowerCase();
  const normalizedDescription = skill.description.toLowerCase();
  const collapsedName = collapseFuzzyText(normalizedName);
  const collapsedId = collapseFuzzyText(normalizedId);
  const candidateScores = [
    getFuzzyMatchScore(normalizedQuery, normalizedName),
    getFuzzyMatchScore(normalizedQuery, normalizedId),
    getFuzzyMatchScore(collapsedQuery, collapsedName),
    getFuzzyMatchScore(collapsedQuery, collapsedId),
    normalizedDescription.includes(normalizedQuery) ? 120 : null,
  ].filter((score): score is number => score !== null);

  if (candidateScores.length === 0) return null;

  let score = Math.min(...candidateScores.map((value, index) => {
    if (index === 0) return value - 45;
    if (index === 1) return value - 30;
    if (index === 2) return value - 35;
    if (index === 3) return value - 25;
    return value;
  }));

  if (normalizedName.startsWith(normalizedQuery) || collapsedName.startsWith(collapsedQuery)) {
    score -= 60;
  }
  if (normalizedId.startsWith(normalizedQuery) || collapsedId.startsWith(collapsedQuery)) {
    score -= 50;
  }

  return score;
};

export const getSkillMentionSuggestions = <T extends ComposerSkill>(
  skills: T[],
  query: string,
  limit = Infinity
): T[] => {
  if (limit <= 0) return [];
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [...skills].sort((left, right) => left.name.localeCompare(right.name)).slice(0, limit);
  }

  return skills
    .map((skill) => {
      const score = rankSkillMention(normalizedQuery, skill);
      return score === null ? null : { skill, score };
    })
    .filter((entry): entry is { skill: T; score: number } => entry !== null)
    .sort((left, right) => left.score - right.score || left.skill.name.localeCompare(right.skill.name))
    .map((entry) => entry.skill)
    .slice(0, limit);
};
