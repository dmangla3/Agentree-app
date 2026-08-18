import { cn } from './utils';

export type ChatInputSurface = 'chat-panel';

export interface ChatInputSurfaceClasses {
  root: string;
  shell: string;
  textarea: string;
}

export function getChatInputSurfaceLabel(surface: ChatInputSurface): string {
  void surface;
  return 'Chat composer';
}

export function getChatInputSurfaceClasses(surface: ChatInputSurface): ChatInputSurfaceClasses {
  void surface;

  return {
    root: cn('w-full max-w-full'),
    shell: cn('rounded-[18px]'),
    textarea: cn('max-h-[172px]'),
  };
}
