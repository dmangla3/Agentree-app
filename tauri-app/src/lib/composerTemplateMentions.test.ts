import { describe, expect, it } from 'vitest';
import {
  getActiveTemplateMention,
  getTemplateMentionRanges,
  getTemplateMentionText,
} from './composerTemplateMentions';
import type { OrchestrationPromptTemplate } from '../orchestration/templates';

const templates: OrchestrationPromptTemplate[] = [
  {
    id: '@planner',
    kind: 'node',
    label: '#planner',
    prompt: 'Plan the work.',
  },
  {
    id: '#parallel_planners',
    kind: 'orchestration',
    label: '#parallel_planners',
    prompt: 'Create parallel planner runs.',
  },
];

describe('composer template mentions', () => {
  it('formats template ids as #mentions', () => {
    expect(getTemplateMentionText(templates[0])).toBe('#planner');
    expect(getTemplateMentionText(templates[1])).toBe('#parallel_planners');
  });

  it('detects active template mentions at the cursor', () => {
    expect(getActiveTemplateMention('Run #plan', 9)).toEqual({
      start: 4,
      end: 9,
      query: 'plan',
    });
    expect(getActiveTemplateMention('Run #planner now', 16)).toBeNull();
  });

  it('returns only known template mention ranges', () => {
    expect(getTemplateMentionRanges('Use #planner then #missing', templates)).toMatchObject([
      {
        start: 4,
        end: 12,
        text: '#planner',
        template: { id: '@planner' },
      },
    ]);
  });
});
