import axios from 'axios';
import { commands } from '../generated/tauri-bindings';
import { AGENTREE_DATA_PLANE_ENABLED, api } from '../lib/api';

export interface SaveComposerAttachmentInput {
  workspaceId: string;
  attachmentId: string;
  file: File;
  dataUrl: string;
}

export interface SavedComposerAttachmentResult {
  localPath: string;
  remotePath: string | null;
  publicUrl: string | null;
  sizeBytes: number;
}

const save = async (
  input: SaveComposerAttachmentInput,
): Promise<SavedComposerAttachmentResult> => {
  const saved = await commands.saveComposerAttachment(
    input.workspaceId,
    input.attachmentId,
    input.file.name,
    input.dataUrl,
  );
  const result: SavedComposerAttachmentResult = {
    localPath: saved.path,
    remotePath: null,
    publicUrl: null,
    sizeBytes: saved.size_bytes,
  };

  if (!AGENTREE_DATA_PLANE_ENABLED) return result;

  try {
    const contentType = input.file.type || 'application/octet-stream';
    const signedUpload = await api.post<{
      signedUrl: string;
      path: string;
      publicUrl: string | null;
    }>('/attachments/signed-url', {
      filename: input.file.name,
      contentType,
    });
    await axios.put(signedUpload.data.signedUrl, input.file, {
      headers: { 'Content-Type': contentType },
    });
    result.remotePath = signedUpload.data.path;
    result.publicUrl = signedUpload.data.publicUrl || null;
    try {
      const signedDownload = await api.get<{ signedUrl: string }>(
        '/attachments/signed-download-url',
        { params: { path: signedUpload.data.path } },
      );
      result.publicUrl = signedDownload.data.signedUrl || result.publicUrl;
    } catch {
      // The durable local attachment remains usable when refreshing a cloud URL fails.
    }
  } catch {
    // Cloud mirroring is optional. Keep the local cached attachment.
  }

  return result;
};

export const attachmentApplication = { save };
