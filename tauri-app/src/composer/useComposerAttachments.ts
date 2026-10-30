import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentMetadata } from '../stores/workspaceStore';
import { attachmentApplication } from '../application/attachments';

export type ComposerAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export interface ComposerFileAttachment {
  id: string;
  file: File;
  status: ComposerAttachmentStatus;
  path?: string;
  publicUrl?: string | null;
  localPath?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  error?: string;
  objectUrl?: string;
}

export type ComposerAttachment = ComposerFileAttachment | AttachmentMetadata;

export const getComposerAttachmentId = (attachment: ComposerAttachment): string => (
  'id' in attachment ? attachment.id : attachment.path
);

const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      resolve(reader.result);
      return;
    }
    reject(new Error('Could not read attachment as data URL.'));
  };
  reader.onerror = () => reject(reader.error || new Error('Could not read attachment.'));
  reader.readAsDataURL(file);
});

const getImageDimensions = (objectUrl: string | undefined): Promise<{ width: number; height: number } | null> => new Promise((resolve) => {
  if (!objectUrl) {
    resolve(null);
    return;
  }
  const image = new Image();
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => resolve(null);
  image.src = objectUrl;
});

const revokeObjectUrl = (attachment: ComposerAttachment): void => {
  if ('objectUrl' in attachment && attachment.objectUrl) {
    URL.revokeObjectURL(attachment.objectUrl);
  }
};

const toMetadata = (attachment: ComposerAttachment): AttachmentMetadata | null => {
  if ('file' in attachment) {
    if (attachment.status !== 'uploaded' || !attachment.path) return null;
    return {
      path: attachment.path,
      publicUrl: attachment.publicUrl || null,
      filename: attachment.file.name,
      contentType: attachment.file.type || 'application/octet-stream',
      localPath: attachment.localPath || null,
      sizeBytes: attachment.sizeBytes ?? null,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
    };
  }
  return {
    ...attachment,
    publicUrl: attachment.publicUrl || null,
    localPath: attachment.localPath || null,
    sizeBytes: attachment.sizeBytes ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
  };
};

export function useComposerAttachments({ workspaceId, onError }: {
  workspaceId: string | null;
  onError: (message: string) => void;
}) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach(revokeObjectUrl);
  }, []);

  const uploadFile = useCallback(async (attachmentId: string, file: File) => {
    if (!workspaceId) {
      setAttachments((current) => current.map((attachment) => (
        getComposerAttachmentId(attachment) === attachmentId && 'file' in attachment
          ? { ...attachment, status: 'error', error: 'Select a workspace before attaching files.' }
          : attachment
      )));
      return;
    }

    setAttachments((current) => current.map((attachment) => (
      getComposerAttachmentId(attachment) === attachmentId && 'file' in attachment
        ? { ...attachment, status: 'uploading', error: undefined }
        : attachment
    )));

    try {
      const pending = attachmentsRef.current.find((attachment) => getComposerAttachmentId(attachment) === attachmentId);
      const objectUrl = pending && 'objectUrl' in pending ? pending.objectUrl : undefined;
      const [dataUrl, dimensions] = await Promise.all([
        fileToDataUrl(file),
        getImageDimensions(objectUrl),
      ]);
      const saved = await attachmentApplication.save({
        workspaceId,
        attachmentId,
        file,
        dataUrl,
      });

      setAttachments((current) => current.map((attachment) => (
        getComposerAttachmentId(attachment) === attachmentId && 'file' in attachment
          ? {
            ...attachment,
            status: 'uploaded',
            path: saved.remotePath || saved.localPath,
            publicUrl: saved.publicUrl,
            localPath: saved.localPath,
            sizeBytes: saved.sizeBytes ?? file.size ?? null,
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
            error: undefined,
          }
          : attachment
      )));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Upload failed';
      setAttachments((current) => current.map((attachment) => (
        getComposerAttachmentId(attachment) === attachmentId && 'file' in attachment
          ? { ...attachment, status: 'error', error: message }
          : attachment
      )));
      onError(message);
    }
  }, [onError, workspaceId]);

  const addFiles = useCallback((files: Iterable<File>) => {
    for (const file of files) {
      const id = crypto.randomUUID();
      let objectUrl: string | undefined;
      if (file.type.startsWith('image/')) {
        try {
          objectUrl = URL.createObjectURL(file);
        } catch {
          objectUrl = undefined;
        }
      }
      const attachment: ComposerFileAttachment = {
        id,
        file,
        status: 'pending',
        objectUrl,
      };
      attachmentsRef.current = [...attachmentsRef.current, attachment];
      setAttachments((current) => [...current, attachment]);
      void uploadFile(id, file);
    }
  }, [uploadFile]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => getComposerAttachmentId(attachment) === id);
      if (removed) revokeObjectUrl(removed);
      return current.filter((attachment) => getComposerAttachmentId(attachment) !== id);
    });
  }, []);

  const replaceAttachments = useCallback((next: readonly AttachmentMetadata[]) => {
    attachmentsRef.current.forEach(revokeObjectUrl);
    const snapshot = next.map((attachment) => ({ ...attachment }));
    attachmentsRef.current = snapshot;
    setAttachments(snapshot);
  }, []);

  const clearAttachments = useCallback(() => {
    attachmentsRef.current.forEach(revokeObjectUrl);
    attachmentsRef.current = [];
    setAttachments([]);
  }, []);

  const metadata = useMemo(
    () => attachments.map(toMetadata).filter((attachment): attachment is AttachmentMetadata => attachment != null),
    [attachments],
  );
  const hasPendingUploads = attachments.some((attachment) => (
    'file' in attachment && (attachment.status === 'pending' || attachment.status === 'uploading')
  ));
  const hasUploadErrors = attachments.some((attachment) => 'file' in attachment && attachment.status === 'error');

  return {
    attachments,
    metadata,
    hasPendingUploads,
    hasUploadErrors,
    addFiles,
    removeAttachment,
    replaceAttachments,
    clearAttachments,
  };
}
