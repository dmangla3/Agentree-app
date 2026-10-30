// client/src/components/AttachmentPreview.tsx
import { useState, useCallback, useEffect } from 'react';
import { cn } from '../lib/utils';
import { AttachmentMetadata } from '../stores/workspaceStore';
import { FileText, ImageIcon, Link as LinkIcon, Loader2, AlertTriangle, X, Music, Video } from 'lucide-react';
import { api } from '../lib/api';

// --- Types ---
type AttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';
interface FileAttachment {
  id: string;
  file: File;
  status: AttachmentStatus;
  path?: string; // Keep path for potential future use or ID
  publicUrl?: string | null; // Keep publicUrl
  error?: string;
  objectUrl?: string; // Local preview URL
}
interface UrlAttachment {
  id: string;
  url: string;
  status: 'attached';
}
type AttachmentSource = FileAttachment | UrlAttachment | AttachmentMetadata;

interface AttachmentPreviewProps {
  attachment: AttachmentSource;
  onRemove?: (id: string) => void;
  className?: string;
  size?: 'small' | 'medium'; // Retain size prop for flexibility
}

// --- Helper: Get File Type ---
const getFileTypeFromName = (fileName?: string | null): 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'other' => {
  if (!fileName) return 'other';
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext) return 'other';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'wmv'].includes(ext)) return 'video';
  if (['txt', 'md', 'json', 'xml', 'csv', 'html', 'css', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'log', 'rtf'].includes(ext)) return 'text';
  return 'other';
};

// --- Component ---
export function AttachmentPreview({ attachment, onRemove, className, size = 'medium' }: AttachmentPreviewProps) {
  const [imageLoadError, setImageLoadError] = useState(false);
  const [dynamicSignedUrl, setDynamicSignedUrl] = useState<string | null>(null);
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  // Determine Attachment Properties
  const isLocalFile = 'file' in attachment;
  const isUrlAttachment = 'url' in attachment;
  const isSavedAttachment = !isLocalFile && !isUrlAttachment;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (attachment as any).id || (isSavedAttachment ? (attachment as AttachmentMetadata).path : Math.random().toString()); // Use path or random ID for saved
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fileName = isLocalFile ? attachment.file.name : (attachment as any).filename;
  const fileType = isUrlAttachment ? 'other' : getFileTypeFromName(fileName);
  const status = isLocalFile ? attachment.status : (isUrlAttachment ? 'attached' : 'uploaded');
  const error = isLocalFile ? attachment.error : undefined; // Only for local upload errors
  const objectUrl = isLocalFile ? attachment.objectUrl : undefined;
  const publicUrl = 'publicUrl' in attachment ? attachment.publicUrl : undefined;

  // --- Fetch Signed URL Fallback ---
  const fetchSignedUrl = useCallback(async () => {
    if (isFetchingUrl || isLocalFile || isUrlAttachment) return;
    const path = (attachment as AttachmentMetadata).path;
    if (!path) return;

    setIsFetchingUrl(true);
    try {
      const response = await api.get<{ signedUrl: string }>('/attachments/signed-download-url', {
        params: { path },
      });
      setDynamicSignedUrl(response.data.signedUrl);
      setImageLoadError(false); // Reset error if we got a new URL
    } catch (err) {
      console.error(`[AttachmentPreview] Failed to fetch signed URL for ${path}:`, err);
    } finally {
      setIsFetchingUrl(false);
    }
  }, [attachment, isFetchingUrl, isLocalFile, isUrlAttachment]);

  useEffect(() => {
    // If it's a saved image and we don't have a publicUrl, fetch one
    if (isSavedAttachment && fileType === 'image' && !publicUrl && !dynamicSignedUrl && !isFetchingUrl) {
      fetchSignedUrl();
    }
  }, [isSavedAttachment, fileType, publicUrl, dynamicSignedUrl, isFetchingUrl, fetchSignedUrl]);

  // Determine Display URL
  const imageSrc = objectUrl || dynamicSignedUrl || publicUrl; // Use local, dynamic, or public URL
  const linkHref = isUrlAttachment ? attachment.url : (objectUrl || dynamicSignedUrl || publicUrl || '#');

  const showRemoveButton = !!onRemove;

  // --- Styling ---
  const containerSizeClass = size === 'medium' ? "w-24 h-28" : "w-16 h-20";
  const iconSize = size === 'medium' ? 32 : 24;
  const fontSizeClass = size === 'medium' ? "text-xs" : "text-[10px] leading-tight";

  const handleImageError = useCallback(() => {
    console.warn(`[AttachmentPreview ${id}] Failed to load image from src: ${imageSrc}`);
    setImageLoadError(true);
    if (objectUrl) { // Revoke only if it was an object URL that failed
      console.log(`[AttachmentPreview ${id}] Revoking failed object URL: ${objectUrl}`);
      URL.revokeObjectURL(objectUrl);
    }
  }, [id, imageSrc, objectUrl]);

  return (
    <div className={cn(
      "attachment-preview relative group flex flex-col items-center justify-center",
      containerSizeClass,
      "overflow-hidden rounded-xl bg-[hsl(var(--app-panel))] p-1 shadow-[0_8px_24px_-20px_hsl(var(--foreground)/0.35),inset_0_0_0_1px_hsl(var(--app-border)/0.64)]",
      "transition-[box-shadow,transform] duration-150 ease-out hover:shadow-[0_12px_28px_-20px_hsl(var(--foreground)/0.42),inset_0_0_0_1px_hsl(var(--app-border-strong)/0.58)]",
      status === 'error' && 'border-destructive bg-destructive/10',
      className
    )}>
      {/* Remove Button */}
      {showRemoveButton && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(id); }}
          className={cn(
            "absolute right-0.5 top-0.5 z-20 flex h-10 w-10 items-center justify-center rounded-lg bg-background/85 text-muted-foreground shadow-[0_6px_18px_-14px_hsl(var(--foreground)/0.5)]",
            "opacity-50 transition-[background-color,color,opacity,transform] duration-150 ease-out hover:bg-destructive/10 hover:text-destructive active:scale-[0.96] group-hover:opacity-100 focus-visible:opacity-100"
          )}
          aria-label="Remove attachment"
        >
          <X size={12} />
        </button>
      )}

      {/* Main Link/Content Area */}
      <a
        href={linkHref}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col items-center justify-center h-full w-full flex-grow text-center no-underline cursor-pointer"
        title={`View ${fileName || linkHref}${error ? ` (Error: ${error})` : ''}`}
        onClick={async (e) => {
          if (isUrlAttachment) return;
          if (linkHref === '#') {
            e.preventDefault();
            if (isSavedAttachment) {
              await fetchSignedUrl();
              // After fetching, the next click will have the URL
            }
          }
        }}
      >
        <div className="flex-grow flex items-center justify-center w-full overflow-hidden my-1 relative">
          {/* Image Preview */}
          {fileType === 'image' && imageSrc && !imageLoadError && (
            <img
              src={imageSrc}
              alt={`Preview of ${fileName}`}
              loading="lazy"
              className="max-h-full max-w-full rounded-lg object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
              onError={() => {
                handleImageError();
                // If it failed and we haven't tried fetching a fresh one yet, try it
                if (!dynamicSignedUrl && isSavedAttachment) {
                  fetchSignedUrl();
                }
              }}
              onLoad={() => console.log(`[AttachmentPreview ${id}] Image loaded successfully from src: ${imageSrc}`)}
            />
          )}

          {/* Fallback Icon */}
          {(fileType !== 'image' || !imageSrc || imageLoadError) && (
            <div className="flex items-center justify-center p-2 opacity-70">
              {isUrlAttachment && <LinkIcon size={iconSize} className="text-[hsl(var(--app-accent))]" />}
              {!isUrlAttachment && fileType === 'image' && <ImageIcon size={iconSize} className="text-muted-foreground" />}
              {!isUrlAttachment && fileType === 'pdf' && <FileText size={iconSize} className="text-red-500" />}
              {!isUrlAttachment && fileType === 'audio' && <Music size={iconSize} className="text-[hsl(var(--app-accent))]" />}
              {!isUrlAttachment && fileType === 'video' && <Video size={iconSize} className="text-[hsl(var(--app-accent))]" />}
              {!isUrlAttachment && fileType === 'text' && <FileText size={iconSize} className="text-[hsl(var(--app-accent))]" />}
              {!isUrlAttachment && fileType === 'other' && !isUrlAttachment && <FileText size={iconSize} className="text-muted-foreground" />}
            </div>
          )}
        </div>

        {/* Filename/URL */}
        <span className={cn(
          "block font-medium text-foreground/80 dark:text-foreground/70 truncate w-full px-1 pt-1",
          fontSizeClass
        )}>
          {fileName || linkHref}
        </span>
      </a>

      {/* Local Upload Status Overlay */}
      {isLocalFile && (status === 'uploading' || status === 'error') && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/85">
          {status === 'uploading' && <Loader2 size={size === 'medium' ? 24 : 18} className="text-primary animate-spin" />}
          {status === 'error' && <AlertTriangle size={size === 'medium' ? 24 : 18} className="text-destructive" />}
        </div>
      )}
    </div>
  );
}
