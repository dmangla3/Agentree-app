type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
};

export type ChatMathSegment = {
  value: string;
  formula?: string;
  displayMode?: boolean;
};

const LATEX_COMMAND = /\\(?:begin|mathbf|mathrm|mathit|operatorname|text|frac|sqrt|sum|prod|int|lim|left|right|overline|underline|vec|hat|rightarrow|leftarrow|leftrightarrow|Rightarrow|Leftarrow|infty|alpha|beta|gamma|theta|lambda|mu|pi|sigma|omega)\b/;
const MATH_HINT = /(?:\\[a-zA-Z]+|[_^{}]|[=<>±×÷∑∫√∞])/;
const SKIPPED_NODE_TYPES = new Set(['code', 'inlineCode', 'html']);

const isEscaped = (value: string, index: number) => {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
};

const findClosingDelimiter = (value: string, delimiter: string, from: number) => {
  let index = value.indexOf(delimiter, from);
  while (index !== -1) {
    if (!isEscaped(value, index)) return index;
    index = value.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
};

const isLikelyBareMath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || !LATEX_COMMAND.test(trimmed)) return false;
  if (trimmed.startsWith('\\')) return true;
  return /^[A-Za-z0-9()[\]{}]+\s*[=<>±×÷]/.test(trimmed);
};

const splitBareMathLines = (value: string): ChatMathSegment[] => {
  const parts = value.split(/(\n)/);
  return parts.map((part) => {
    if (part !== '\n' && isLikelyBareMath(part)) {
      return { value: part, formula: part.trim(), displayMode: true };
    }
    return { value: part };
  });
};

export const parseChatMathSegments = (value: string): ChatMathSegment[] => {
  const segments: ChatMathSegment[] = [];
  let textStart = 0;
  let cursor = 0;

  const pushText = (end: number) => {
    if (end > textStart) segments.push(...splitBareMathLines(value.slice(textStart, end)));
  };

  while (cursor < value.length) {
    if (isEscaped(value, cursor)) {
      cursor += 1;
      continue;
    }

    let opening = '';
    let closing = '';
    let displayMode = false;
    if (value.startsWith('$$', cursor)) {
      opening = '$$';
      closing = '$$';
      displayMode = true;
    } else if (value[cursor] === '$') {
      opening = '$';
      closing = '$';
    }

    if (!opening) {
      cursor += 1;
      continue;
    }

    const formulaStart = cursor + opening.length;
    const closingIndex = findClosingDelimiter(value, closing, formulaStart);
    if (closingIndex === -1) {
      cursor += opening.length;
      continue;
    }

    const formula = value.slice(formulaStart, closingIndex);
    const invalidInlineWhitespace = opening === '$' && (/^\s|\s$/.test(formula));
    if (!formula.trim() || invalidInlineWhitespace) {
      cursor += opening.length;
      continue;
    }

    pushText(cursor);
    segments.push({ value: value.slice(cursor, closingIndex + closing.length), formula, displayMode });
    cursor = closingIndex + closing.length;
    textStart = cursor;
  }

  pushText(value.length);
  return segments.length > 0 ? segments : [{ value }];
};

export const hasChatMath = (value: string) => {
  const hasDelimiter = value.includes('$');
  if (!hasDelimiter && !MATH_HINT.test(value)) return false;
  return parseChatMathSegments(value).some((segment) => segment.formula !== undefined);
};

const transformNode = (node: MarkdownNode) => {
  if (!node.children || SKIPPED_NODE_TYPES.has(node.type)) return;

  const nextChildren: MarkdownNode[] = [];
  node.children.forEach((child) => {
    if (child.type !== 'text' || typeof child.value !== 'string') {
      transformNode(child);
      nextChildren.push(child);
      return;
    }

    parseChatMathSegments(child.value).forEach((segment) => {
      if (segment.formula === undefined) {
        if (segment.value) nextChildren.push({ type: 'text', value: segment.value });
        return;
      }
      nextChildren.push({
        type: 'chatMath',
        value: segment.formula,
        data: {
          hName: 'span',
          hProperties: {
            'data-chat-math': segment.formula,
            'data-chat-math-display': segment.displayMode ? 'true' : 'false',
          },
        },
      });
    });
  });
  node.children = nextChildren;
};

export const remarkChatMath = () => (tree: MarkdownNode) => {
  transformNode(tree);
};
