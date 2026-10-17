// @vitest-environment jsdom
import '../../../test/setup';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';

describe('ChatMarkdown math rendering', () => {
  it('renders bare agent LaTeX through KaTeX', async () => {
    const formula = '\\text{decompose} \\rightarrow \\text{execute}';
    const { container } = render(<ChatMarkdown>{formula}</ChatMarkdown>);

    await waitFor(() => {
      expect(container.querySelector('[data-chat-math-rendered="true"] .katex')).not.toBeNull();
    });
  });

  it('renders standard inline math without changing ordinary prose', async () => {
    const { container } = render(<ChatMarkdown>Result: $x^2$. Price: $5.</ChatMarkdown>);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-chat-math-rendered="true"]')).toHaveLength(1);
    });
    expect(container.textContent).toContain('Price: $5.');
  });
});
