// @vitest-environment jsdom
import '../../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TemplateMentionTextarea } from './TemplateMentionTextarea';
import type { OrchestrationPromptTemplate } from '../../orchestration/templates';

const templates: OrchestrationPromptTemplate[] = [
  {
    id: '@planner',
    kind: 'node',
    label: '#planner',
    prompt: 'Plan the work.',
  },
];

describe('TemplateMentionTextarea', () => {
  it('keeps the textarea value plain while rendering known template mentions', () => {
    render(
      <TemplateMentionTextarea
        aria-label="Prompt"
        value="Use #planner"
        templates={templates}
        onChange={() => undefined}
      />
    );

    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Use #planner');
    expect(screen.getByText('#planner')).toBeTruthy();
  });
});
