import { describe, expect, it } from 'vitest';
import { hasChatMath, parseChatMathSegments, remarkChatMath } from './chatMathParser';

describe('chat math parsing', () => {
  it('recognizes the bare LaTeX lines commonly emitted by agents', () => {
    const content = '\\text{decompose} \\rightarrow \\text{execute} \\rightarrow \\text{evaluate} \\rightarrow \\text{adapt}';

    expect(hasChatMath(content)).toBe(true);
    expect(parseChatMathSegments(content)).toEqual([
      { value: content, formula: content, displayMode: true },
    ]);
  });

  it('supports standard inline and display math delimiters', () => {
    expect(parseChatMathSegments('Use $x^2$ and $$y = \\frac{1}{2}$$.')).toEqual([
      { value: 'Use ' },
      { value: '$x^2$', formula: 'x^2', displayMode: false },
      { value: ' and ' },
      { value: '$$y = \\frac{1}{2}$$', formula: 'y = \\frac{1}{2}', displayMode: true },
      { value: '.' },
    ]);
    expect(hasChatMath('$x$')).toBe(true);
  });

  it('does not classify prose containing an isolated LaTeX command as a bare equation', () => {
    const content = 'Use \\text{label} when you want upright text.';

    expect(hasChatMath(content)).toBe(false);
  });

  it('leaves code nodes untouched while transforming message text', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: '$x^2$' }] },
        { type: 'code', value: '$not_math$' },
      ],
    };

    remarkChatMath()(tree);

    expect(tree.children[0]).toMatchObject({
      children: [{
        type: 'chatMath',
        value: 'x^2',
        data: { hProperties: { 'data-chat-math': 'x^2' } },
      }],
    });
    expect(tree.children[1]).toEqual({ type: 'code', value: '$not_math$' });
  });
});
