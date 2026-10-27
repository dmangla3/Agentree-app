// @vitest-environment jsdom
import '../../../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatCardWrapper } from './ChatCardWrapper';

const baseProps = {
  isFocused: false,
  isSelected: false,
  onFocus: vi.fn(),
  onSelect: vi.fn(),
  onContextMenu: vi.fn(),
};

describe('ChatCardWrapper', () => {
  it('uses blue for selection while theme focus takes precedence', () => {
    const { rerender } = render(
      <ChatCardWrapper {...baseProps} isSelected>
        <div>chat body</div>
      </ChatCardWrapper>
    );

    const card = screen.getByText('chat body').parentElement?.parentElement?.parentElement as HTMLElement;
    expect(card.className).toContain('ring-blue-500/20');
    expect(card.style.borderColor).toBe('rgb(59, 130, 246)');

    rerender(
      <ChatCardWrapper {...baseProps} isSelected isFocused>
        <div>chat body</div>
      </ChatCardWrapper>
    );

    expect(card.className).not.toContain('ring-blue-500/20');
    expect(card.className).toContain('ring-[hsl(var(--app-selection)/0.9)]');
    expect(card.style.borderColor).toBe('hsl(var(--app-selection) / 0.92)');
  });
});
