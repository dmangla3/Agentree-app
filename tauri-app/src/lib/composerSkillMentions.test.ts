import { describe, expect, it } from 'vitest';
import {
  getActiveSkillMention,
  getSkillMentionNames,
  getSkillMentionSuggestions,
  insertSkillMention,
} from './composerSkillMentions';
import type { ComposerSkill } from './composerSkillMentions';

const skills: ComposerSkill[] = [
  {
    id: 'skill-frontend',
    name: 'Frontend Polish',
    description: 'Improve UI details and interactions',
  },
  {
    id: 'skill-debug',
    name: 'Systematic Debugging',
    description: 'Trace bugs to root cause',
  },
  {
    id: 'skill-plan',
    name: 'Writing Plans',
    description: 'Create implementation plans',
  },
];

describe('composer skill mentions', () => {
  it('detects the active $ skill mention at the cursor', () => {
    expect(getActiveSkillMention('Use $front', 10)).toEqual({
      start: 4,
      end: 10,
      query: 'front',
    });
  });

  it('inserts selected skill names and returns the next cursor position', () => {
    const activeMention = getActiveSkillMention('Use $front please', 10);

    expect(insertSkillMention('Use $front please', activeMention!, 'Frontend Polish')).toEqual({
      value: 'Use $Frontend Polish please',
      cursor: 20,
    });
  });

  it('adds a separator when inserting a selected skill at the end of the prompt', () => {
    const activeMention = getActiveSkillMention('Use $front', 10);

    expect(insertSkillMention('Use $front', activeMention!, 'Frontend Polish')).toEqual({
      value: 'Use $Frontend Polish ',
      cursor: 21,
    });
  });

  it('does not keep searching inside an inserted multi-word skill mention', () => {
    const prompt = 'Use $Frontend Polish please';

    expect(getActiveSkillMention(prompt, prompt.length)).toBeNull();
  });

  it('extracts skill names from explicit $ mentions', () => {
    expect(getSkillMentionNames('Use $Frontend Polish and $Systematic Debugging')).toEqual([
      'Frontend Polish',
      'Systematic Debugging',
    ]);
  });

  it('extracts known selected skill names before regular prompt text', () => {
    expect(getSkillMentionNames(
      'Use $Frontend Polish please and $Systematic Debugging',
      skills.map((skill) => skill.name)
    )).toEqual([
      'Frontend Polish',
      'Systematic Debugging',
    ]);
  });

  it('sorts skill suggestions by fuzzy name match', () => {
    expect(getSkillMentionSuggestions(skills, 'debug').map((skill) => skill.name)).toEqual([
      'Systematic Debugging',
    ]);
  });

  it('returns every skill when no explicit limit is passed', () => {
    const manySkills = Array.from({ length: 12 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${String(index).padStart(2, '0')}`,
      description: 'Available provider skill',
    }));

    expect(getSkillMentionSuggestions(manySkills, '')).toHaveLength(12);
  });
});
