import { describe, expect, it } from 'vitest';
import { getChatInputSurfaceClasses, getChatInputSurfaceLabel } from './chatInputSurface';

describe('chat input surface helpers', () => {
  it('keeps the chat-panel surface as the default full-width composer', () => {
    const classes = getChatInputSurfaceClasses('chat-panel');

    expect(getChatInputSurfaceLabel('chat-panel')).toBe('Chat composer');
    expect(classes.root).toContain('w-full');
    expect(classes.root).toContain('max-w-full');
    expect(classes.shell).toContain('rounded-[18px]');
    expect(classes.textarea).toContain('max-h-[172px]');
  });

  it('keeps chat surface labels independent from graph dock behavior', () => {
    expect(getChatInputSurfaceLabel('chat-panel')).toBe('Chat composer');
  });
});
