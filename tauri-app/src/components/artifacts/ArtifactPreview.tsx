import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ExternalLink,
  FileText,
  Globe2,
  Image as ImageIcon,
  Layers,
  Music,
  Video,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  type ArtifactRef,
  getArtifactDisplayTitle,
  getArtifactPreviewUrl,
  getPrimaryArtifact,
} from '../../lib/artifacts';

const isImageArtifact = (artifact: ArtifactRef) => (
  artifact.kind === 'image' || artifact.kind === 'screenshot' || artifact.mimeType.startsWith('image/')
);

const iconForArtifact = (artifact: ArtifactRef) => {
  if (artifact.kind === 'video') return Video;
  if (artifact.kind === 'audio') return Music;
  if (artifact.kind === 'html') return Globe2;
  if (artifact.kind === 'image' || artifact.kind === 'screenshot') return ImageIcon;
  return FileText;
};

const canOpenUrl = (url: string | null): url is string => (
  Boolean(url && (/^https?:\/\//i.test(url) || /^data:/i.test(url) || /^blob:/i.test(url) || /^asset:/i.test(url)))
);

export function ArtifactGraphPreview({
  artifacts,
  className,
}: {
  artifacts: ArtifactRef[];
  className?: string;
}) {
  const primary = getPrimaryArtifact(artifacts);
  const previewUrl = getArtifactPreviewUrl(primary);
  if (!primary) return null;
  const title = getArtifactDisplayTitle(primary);
  const Icon = iconForArtifact(primary);
  const extraCount = Math.max(0, artifacts.length - 1);

  return (
    <div
      className={cn(
        'relative z-10 mb-2 h-11 overflow-hidden rounded-lg bg-muted/45 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.62)]',
        className,
      )}
      title={title}
    >
      {previewUrl && isImageArtifact(primary) ? (
        <img
          src={previewUrl}
          alt={title}
          loading="lazy"
          className="h-full w-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        />
      ) : (
        <div className="flex h-full w-full items-center gap-2 px-2 text-[10px] font-medium text-muted-foreground">
          <Icon size={14} strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </div>
      )}
      {extraCount > 0 ? (
        <div className="absolute right-1 top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground/85 px-1.5 text-[9px] font-semibold tabular-nums text-background shadow-sm">
          +{extraCount}
        </div>
      ) : null}
    </div>
  );
}

export function ArtifactChipList({
  artifacts,
  className,
}: {
  artifacts: ArtifactRef[];
  className?: string;
}) {
  if (artifacts.length === 0) return null;

  return (
    <div className={cn('flex min-w-0 flex-wrap gap-1.5', className)}>
      {artifacts.map((artifact) => {
        const title = getArtifactDisplayTitle(artifact);
        const previewUrl = getArtifactPreviewUrl(artifact);
        const Icon = iconForArtifact(artifact);
        return (
          <span
            key={artifact.id}
            className="inline-flex h-7 max-w-[220px] min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/80 px-2 text-[11px] font-medium text-muted-foreground shadow-sm"
            title={title}
          >
            {previewUrl && isImageArtifact(artifact) ? (
              <img
                src={previewUrl}
                alt=""
                loading="lazy"
                className="h-4 w-4 shrink-0 rounded object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
              />
            ) : (
              <Icon size={13} strokeWidth={2} className="shrink-0" />
            )}
            <span className="min-w-0 truncate">{title}</span>
          </span>
        );
      })}
    </div>
  );
}

export function ArtifactGallery({
  artifacts,
  defaultOpen = true,
  className,
}: {
  artifacts: ArtifactRef[];
  defaultOpen?: boolean;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const primary = useMemo(() => (
    artifacts.find((artifact) => artifact.id === selectedId)
    ?? getPrimaryArtifact(artifacts)
  ), [artifacts, selectedId]);

  if (!primary) return null;

  const title = getArtifactDisplayTitle(primary);
  const previewUrl = getArtifactPreviewUrl(primary);
  const canOpen = canOpenUrl(previewUrl);
  const Icon = iconForArtifact(primary);

  return (
    <section
      className={cn(
        'relative z-10 mb-4 min-w-0 max-w-full overflow-hidden rounded-xl bg-[hsl(var(--app-panel-strong))] shadow-[var(--app-shadow-panel)]',
        className,
      )}
      data-design-scope="panels"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <button
          type="button"
          onClick={() => setIsOpen((value) => !value)}
          className="inline-flex min-h-10 min-w-0 items-center gap-2 rounded-lg text-left text-[11px] font-semibold text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:text-foreground active:scale-[0.96]"
          aria-expanded={isOpen}
        >
          <Layers size={13} strokeWidth={2.2} className="shrink-0" />
          <span className="min-w-0 truncate">Previews</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
            {artifacts.length}
          </span>
          <ChevronDown
            size={13}
            strokeWidth={2.2}
            className={cn('shrink-0 transition-transform duration-150 ease-out', isOpen && 'rotate-180')}
          />
        </button>
        {canOpen ? (
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.96]"
            aria-label="Open preview"
            title="Open preview"
          >
            <ExternalLink size={13} strokeWidth={2.1} />
          </a>
        ) : null}
      </div>

      {isOpen ? (
        <div className="min-w-0 max-w-full p-3">
          <div className="min-w-0 overflow-hidden rounded-lg bg-muted/20 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)]">
            {previewUrl && isImageArtifact(primary) ? (
              <img
                src={previewUrl}
                alt={title}
                loading="lazy"
                className="max-h-[320px] w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
              />
            ) : (
              <div className="flex min-h-[120px] items-center justify-center gap-2 px-4 text-sm font-medium text-muted-foreground">
                <Icon size={22} strokeWidth={1.8} />
                <span className="min-w-0 truncate">{title}</span>
              </div>
            )}
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium text-foreground">{title}</div>
              {primary.caption ? (
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                  {primary.caption}
                </div>
              ) : null}
            </div>
            {primary.width && primary.height ? (
              <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
                {primary.width}x{primary.height}
              </span>
            ) : null}
          </div>
          {artifacts.length > 1 ? (
            <div className="mt-3 flex min-w-0 gap-2 overflow-x-auto pb-1">
              {artifacts.map((artifact) => {
                const artifactTitle = getArtifactDisplayTitle(artifact);
                const artifactPreviewUrl = getArtifactPreviewUrl(artifact);
                const ArtifactIcon = iconForArtifact(artifact);
                const selected = artifact.id === primary.id;
                return (
                  <button
                    type="button"
                    key={artifact.id}
                    onClick={() => setSelectedId(artifact.id)}
                    className={cn(
                      'h-12 w-16 shrink-0 overflow-hidden rounded-lg border bg-muted/20 text-muted-foreground transition-[border-color,box-shadow,transform] duration-150 ease-out active:scale-[0.96]',
                      selected ? 'border-primary/70 ring-2 ring-primary/20' : 'border-border/60 hover:border-border',
                    )}
                    title={artifactTitle}
                    aria-label={`Select preview ${artifactTitle}`}
                  >
                    {artifactPreviewUrl && isImageArtifact(artifact) ? (
                      <img
                        src={artifactPreviewUrl}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center">
                        <ArtifactIcon size={17} strokeWidth={1.8} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
