import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { Puzzle, Workflow } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../@/components/ui/hover-card';
import { cn } from '../../lib/utils';
import {
  getTemplateMentionRanges,
  getTemplateMentionText,
  type TemplateMentionRange,
} from '../../lib/composerTemplateMentions';
import type { OrchestrationPromptTemplate } from '../../orchestration/templates';

type TextareaAutosizeProps = ComponentProps<typeof TextareaAutosize>;

interface TemplateMentionTextareaProps extends Omit<TextareaAutosizeProps, 'ref'> {
  highlightValue?: string;
  templates: OrchestrationPromptTemplate[];
}

const TemplateMentionHoverCard = memo(function TemplateMentionHoverCard({
  range,
}: {
  range: TemplateMentionRange;
}) {
  const template = range.template;
  const mentionText = getTemplateMentionText(template);

  return (
    <HoverCard openDelay={160} closeDelay={80}>
      <HoverCardTrigger asChild>
        <span
          className={cn(
            'pointer-events-auto rounded-[4px] bg-[hsl(var(--app-accent-soft)/0.88)] text-[hsl(var(--app-accent))]',
            'shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.22)]'
          )}
        >
          {range.text}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        className="w-[min(34rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[hsl(var(--app-border))] bg-[hsl(var(--app-panel-strong)/0.98)] p-0 shadow-[0_20px_60px_-28px_rgba(15,23,42,0.45)]"
      >
        <div className="border-b border-border/60 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-[12px] font-semibold text-foreground">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
              {template.kind === 'orchestration' ? <Workflow className="h-3.5 w-3.5" /> : <Puzzle className="h-3.5 w-3.5" />}
            </span>
            <span className="truncate">{mentionText}</span>
            <span className="shrink-0 rounded border border-border/65 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
              {template.kind === 'orchestration' ? 'Orchestration' : 'Node'}
            </span>
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto px-3 py-2.5">
          <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-5 text-muted-foreground">
            {template.prompt}
          </pre>
          {template.kind === 'node' && template.requiresCommit ? (
            <div className="mt-2 inline-flex rounded-md border border-border/65 bg-background/68 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
              Requires commit
            </div>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
});

const renderHighlightedText = (
  value: string,
  ranges: TemplateMentionRange[],
): ReactNode[] => {
  if (ranges.length === 0) return [value];

  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) {
      nodes.push(value.slice(cursor, range.start));
    }
    nodes.push(<TemplateMentionHoverCard key={`${range.start}:${range.end}:${index}`} range={range} />);
    cursor = range.end;
  });
  if (cursor < value.length) {
    nodes.push(value.slice(cursor));
  }
  return nodes;
};

export const TemplateMentionTextarea = forwardRef<HTMLTextAreaElement, TemplateMentionTextareaProps>(
  function TemplateMentionTextarea({
    className,
    highlightValue,
    templates,
    value,
    defaultValue,
    disabled,
    onChange,
    onScroll,
    ...props
  }, forwardedRef) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [uncontrolledValue, setUncontrolledValue] = useState(() => (
      typeof defaultValue === 'string' ? defaultValue : ''
    ));
    const [scrollTop, setScrollTop] = useState(0);
    const displayValue = highlightValue ?? (typeof value === 'string' ? value : uncontrolledValue);
    const mentionRanges = useMemo(
      () => getTemplateMentionRanges(displayValue, templates),
      [displayValue, templates],
    );
    const highlightedText = useMemo(
      () => renderHighlightedText(displayValue, mentionRanges),
      [displayValue, mentionRanges],
    );

    useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement, []);

    useEffect(() => {
      if (typeof value === 'string' || highlightValue != null) return;
      setUncontrolledValue(typeof defaultValue === 'string' ? defaultValue : '');
    }, [defaultValue, highlightValue, value]);

    return (
      <div className="relative w-full">
        {displayValue ? (
          <div
            aria-hidden="true"
            className={cn(
              className,
              'pointer-events-none absolute inset-0 z-10 resize-none overflow-hidden whitespace-pre-wrap break-words border-transparent bg-transparent text-foreground shadow-none outline-none transition-none',
              disabled && 'opacity-50',
            )}
          >
            <div style={{ transform: scrollTop ? `translateY(-${scrollTop}px)` : undefined }}>
              {highlightedText}
            </div>
          </div>
        ) : null}
        <TextareaAutosize
          {...props}
          ref={textareaRef}
          value={value}
          defaultValue={defaultValue}
          disabled={disabled}
          onChange={(event) => {
            if (highlightValue == null && typeof value !== 'string') {
              setUncontrolledValue(event.currentTarget.value);
            }
            onChange?.(event);
          }}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            onScroll?.(event);
          }}
          className={cn(
            className,
            displayValue && 'text-transparent caret-foreground selection:bg-[hsl(var(--app-focus)/0.18)]',
          )}
        />
      </div>
    );
  }
);
