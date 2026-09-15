import {
  buildTemplateRegistry,
  normalizeTemplateId,
  type OrchestrationPromptTemplate,
} from '../orchestration/templates';

export interface ActiveTemplateMention {
  start: number;
  end: number;
  query: string;
}

export interface TemplateMentionRange {
  start: number;
  end: number;
  text: string;
  template: OrchestrationPromptTemplate;
}

export const getActiveTemplateMention = (
  value: string,
  cursorPosition: number | null | undefined,
): ActiveTemplateMention | null => {
  if (cursorPosition == null) return null;
  const beforeCursor = value.slice(0, cursorPosition);
  const mentionMatch = beforeCursor.match(/(^|\s)#([^\s#]*)$/);
  if (!mentionMatch) return null;

  const query = mentionMatch[2] ?? '';
  return {
    start: beforeCursor.length - query.length - 1,
    end: cursorPosition,
    query,
  };
};

export const getTemplateMentionText = (template: OrchestrationPromptTemplate): string => {
  const normalizedId = normalizeTemplateId(template.id);
  return normalizedId ? `#${normalizedId.replace(/^@/, '')}` : template.label.replace(/^@/, '#');
};

export const getTemplateMentionRanges = (
  value: string,
  templates: OrchestrationPromptTemplate[],
): TemplateMentionRange[] => {
  if (!value || templates.length === 0) return [];

  const templatesById = buildTemplateRegistry(templates);
  const ranges: TemplateMentionRange[] = [];
  for (const match of value.matchAll(/#([a-zA-Z0-9_-]+)/g)) {
    const start = match.index;
    if (start == null) continue;
    const text = match[0];
    const template = templatesById.get(normalizeTemplateId(match[1]));
    if (!template) continue;
    ranges.push({
      start,
      end: start + text.length,
      text,
      template,
    });
  }
  return ranges;
};

export const promptIncludesOrchestrationTemplate = (
  value: string,
  templates: OrchestrationPromptTemplate[],
): boolean => (
  getTemplateMentionRanges(value, templates).some((range) => range.template.kind === 'orchestration')
);
