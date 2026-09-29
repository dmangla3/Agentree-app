import type {
  Annotation,
  Message,
  MessageHighlightAnnotation,
  MessageHighlightColor,
  MessageHighlightRange,
} from '../stores/workspaceStore';

export const MESSAGE_HIGHLIGHT_COLORS: MessageHighlightColor[] = ['yellow', 'green', 'blue', 'rose'];

const MESSAGE_HIGHLIGHT_COLOR_SET = new Set<MessageHighlightColor>(MESSAGE_HIGHLIGHT_COLORS);

export const normalizeHighlightColor = (color: unknown): MessageHighlightColor => {
  return MESSAGE_HIGHLIGHT_COLOR_SET.has(color as MessageHighlightColor)
    ? color as MessageHighlightColor
    : 'yellow';
};

export const computeHighlightTextHash = (text: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const isFiniteOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const isMessageHighlightAnnotation = (
  annotation: Annotation | null | undefined
): annotation is MessageHighlightAnnotation => {
  if (!annotation || annotation.type !== 'highlight') return false;
  const maybeHighlight = annotation as Partial<MessageHighlightAnnotation>;
  const range = maybeHighlight.range as Partial<MessageHighlightRange> | undefined;
  return (
    typeof maybeHighlight.id === 'string' &&
    maybeHighlight.id.length > 0 &&
    MESSAGE_HIGHLIGHT_COLOR_SET.has(maybeHighlight.color as MessageHighlightColor) &&
    Boolean(range) &&
    isFiniteOffset(range?.start) &&
    isFiniteOffset(range?.end) &&
    typeof range?.exact === 'string' &&
    typeof range?.textHash === 'string' &&
    range.end > range.start
  );
};

export const getMessageHighlights = (
  messageOrAnnotations: Pick<Message, 'annotations'> | Annotation[] | null | undefined
): MessageHighlightAnnotation[] => {
  const annotations = Array.isArray(messageOrAnnotations)
    ? messageOrAnnotations
    : messageOrAnnotations?.annotations;
  if (!Array.isArray(annotations)) return [];
  return annotations
    .filter(isMessageHighlightAnnotation)
    .sort((left, right) => left.range.start - right.range.start || left.createdAt.localeCompare(right.createdAt));
};

export const addOrUpdateMessageHighlight = (
  annotations: Annotation[] | null | undefined,
  highlight: MessageHighlightAnnotation
): Annotation[] => {
  const current = Array.isArray(annotations) ? annotations : [];
  const didReplace = current.some((annotation) =>
    isMessageHighlightAnnotation(annotation) && annotation.id === highlight.id
  );
  if (didReplace) {
    return current.map((annotation) =>
      isMessageHighlightAnnotation(annotation) && annotation.id === highlight.id
        ? highlight
        : annotation
    );
  }
  return [...current, highlight];
};

export const updateMessageHighlightColor = (
  annotations: Annotation[] | null | undefined,
  highlightId: string,
  color: MessageHighlightColor,
  updatedAt = new Date().toISOString()
): Annotation[] => {
  const current = Array.isArray(annotations) ? annotations : [];
  return current.map((annotation) => {
    if (!isMessageHighlightAnnotation(annotation) || annotation.id !== highlightId) {
      return annotation;
    }
    return {
      ...annotation,
      color,
      updatedAt,
    };
  });
};

export const removeMessageHighlight = (
  annotations: Annotation[] | null | undefined,
  highlightId: string
): Annotation[] => {
  const current = Array.isArray(annotations) ? annotations : [];
  return current.filter((annotation) =>
    !isMessageHighlightAnnotation(annotation) || annotation.id !== highlightId
  );
};

export const createMessageHighlight = ({
  color,
  range,
  id = crypto.randomUUID(),
  now = new Date().toISOString(),
}: {
  color: MessageHighlightColor;
  range: MessageHighlightRange;
  id?: string;
  now?: string;
}): MessageHighlightAnnotation => ({
  type: 'highlight',
  id,
  color,
  range,
  createdAt: now,
  updatedAt: now,
});

export const createHighlightRangeFromOffsets = (
  fullText: string,
  start: number,
  end: number
): MessageHighlightRange | null => {
  if (!isFiniteOffset(start) || !isFiniteOffset(end) || end <= start || end > fullText.length) {
    return null;
  }
  const exact = fullText.slice(start, end);
  if (!exact.trim()) return null;
  return {
    start,
    end,
    exact,
    textHash: computeHighlightTextHash(fullText),
  };
};
