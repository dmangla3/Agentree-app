import { convertFileSrc } from '@tauri-apps/api/core';
import type { AttachmentMetadata, Message } from '../stores/workspaceStore';

export type ArtifactRole = 'input' | 'output';
export type ArtifactKind = 'image' | 'screenshot' | 'pdf' | 'html' | 'text' | 'video' | 'audio' | 'file';
export type ArtifactStorageBackend = 'local' | 'r2' | 'remote' | 'inline';
export type ArtifactSource =
  | 'user_upload'
  | 'agent_file'
  | 'provider_image_generation'
  | 'screenshot_tool'
  | 'message_attachment'
  | string;

export interface ArtifactStorageRef {
  backend: ArtifactStorageBackend;
  path?: string;
  key?: string;
  url?: string;
}

export interface ArtifactThumbnailRef {
  path?: string;
  url?: string;
  width?: number;
  height?: number;
}

export interface ArtifactRef {
  id: string;
  nodeId: string;
  role: ArtifactRole;
  kind: ArtifactKind;
  mimeType: string;
  title?: string;
  caption?: string;
  filename?: string;
  storage: ArtifactStorageRef;
  thumbnail?: ArtifactThumbnailRef;
  width?: number;
  height?: number;
  sizeBytes?: number;
  isPrimary?: boolean;
  publicSafe?: boolean;
  source?: ArtifactSource;
  sourceCommitSha?: string;
  createdAt?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const cleanString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const cleanNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const cleanBoolean = (value: unknown): boolean | undefined => (
  typeof value === 'boolean' ? value : undefined
);

const artifactKindFromMimeType = (mimeType: string | undefined): ArtifactKind => {
  if (!mimeType) return 'file';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/html') return 'html';
  if (mimeType.startsWith('text/')) return 'text';
  return 'file';
};

const normalizeKind = (value: unknown, mimeType: string | undefined): ArtifactKind => {
  const raw = cleanString(value);
  if (
    raw === 'image' ||
    raw === 'screenshot' ||
    raw === 'pdf' ||
    raw === 'html' ||
    raw === 'text' ||
    raw === 'video' ||
    raw === 'audio' ||
    raw === 'file'
  ) {
    return raw;
  }
  return artifactKindFromMimeType(mimeType);
};

const normalizeRole = (value: unknown, fallback: ArtifactRole): ArtifactRole => (
  value === 'input' || value === 'output' ? value : fallback
);

const normalizeStorage = (value: unknown, fallback: Partial<ArtifactStorageRef> = {}): ArtifactStorageRef => {
  const raw = isRecord(value) ? value : {};
  const url = cleanString(raw.url) ?? cleanString((raw as any).publicUrl) ?? cleanString(fallback.url);
  const path = cleanString(raw.path) ?? cleanString(fallback.path);
  const key = cleanString(raw.key) ?? cleanString(fallback.key);
  const backendRaw = cleanString(raw.backend) ?? fallback.backend;
  const backend: ArtifactStorageBackend = backendRaw === 'local' || backendRaw === 'r2' || backendRaw === 'remote' || backendRaw === 'inline'
    ? backendRaw
    : url?.startsWith('data:')
      ? 'inline'
      : url
        ? 'remote'
        : path
          ? 'local'
          : 'remote';
  return {
    backend,
    ...(path ? { path } : {}),
    ...(key ? { key } : {}),
    ...(url ? { url } : {}),
  };
};

const normalizeThumbnail = (value: unknown): ArtifactThumbnailRef | undefined => {
  if (!isRecord(value)) return undefined;
  const url = cleanString(value.url);
  const path = cleanString(value.path);
  const width = cleanNumber(value.width);
  const height = cleanNumber(value.height);
  if (!url && !path && width === undefined && height === undefined) return undefined;
  return {
    ...(url ? { url } : {}),
    ...(path ? { path } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
};

export const normalizeArtifactRef = (
  value: unknown,
  fallback: {
    nodeId: string;
    role?: ArtifactRole;
    index?: number;
  },
): ArtifactRef | null => {
  if (!isRecord(value)) return null;
  const storage = normalizeStorage(value.storage, {
    path: cleanString(value.path),
    key: cleanString(value.key),
    url: cleanString(value.url) ?? cleanString((value as any).publicUrl),
  });
  const mimeType = cleanString(value.mimeType)
    ?? cleanString((value as any).mime_type)
    ?? cleanString(value.contentType)
    ?? 'application/octet-stream';
  const id = cleanString(value.id)
    ?? cleanString((value as any).artifactId)
    ?? cleanString((value as any).artifact_id)
    ?? `${fallback.nodeId}:artifact:${fallback.index ?? 0}`;
  const nodeId = cleanString(value.nodeId)
    ?? cleanString((value as any).node_id)
    ?? fallback.nodeId;
  const role = normalizeRole(value.role, fallback.role ?? 'output');
  const kind = normalizeKind(value.kind ?? value.type, mimeType);
  const title = cleanString(value.title) ?? cleanString(value.name);
  const filename = cleanString(value.filename) ?? cleanString((value as any).fileName);
  const thumbnail = normalizeThumbnail(value.thumbnail);
  const width = cleanNumber(value.width) ?? cleanNumber((value as any).displayWidth);
  const height = cleanNumber(value.height) ?? cleanNumber((value as any).displayHeight);
  const sizeBytes = cleanNumber(value.sizeBytes)
    ?? cleanNumber((value as any).size_bytes)
    ?? cleanNumber(value.originalSize);
  const isPrimary = cleanBoolean(value.isPrimary)
    ?? cleanBoolean((value as any).is_primary);
  const publicSafe = cleanBoolean(value.publicSafe)
    ?? cleanBoolean((value as any).public_safe);

  return {
    id,
    nodeId,
    role,
    kind,
    mimeType,
    storage,
    ...(title ? { title } : {}),
    ...(cleanString(value.caption) ? { caption: cleanString(value.caption) } : {}),
    ...(filename ? { filename } : {}),
    ...(thumbnail ? { thumbnail } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(isPrimary !== undefined ? { isPrimary } : {}),
    ...(publicSafe !== undefined ? { publicSafe } : {}),
    ...(cleanString(value.source) ? { source: cleanString(value.source) } : {}),
    ...(cleanString(value.sourceCommitSha) ? { sourceCommitSha: cleanString(value.sourceCommitSha) } : {}),
    ...(cleanString((value as any).source_commit_sha) ? { sourceCommitSha: cleanString((value as any).source_commit_sha) } : {}),
    ...(cleanString(value.createdAt) ? { createdAt: cleanString(value.createdAt) } : {}),
    ...(cleanString((value as any).created_at) ? { createdAt: cleanString((value as any).created_at) } : {}),
  };
};

export const attachmentToArtifact = (
  attachment: AttachmentMetadata,
  message: Pick<Message, 'id' | 'createdAt'>,
): ArtifactRef => {
  const mimeType = attachment.contentType || 'application/octet-stream';
  return {
    id: `${message.id}:attachment:${attachment.path}`,
    nodeId: message.id,
    role: 'input',
    kind: artifactKindFromMimeType(mimeType),
    mimeType,
    title: attachment.filename,
    filename: attachment.filename,
    storage: {
      backend: attachment.localPath ? 'local' : 'r2',
      path: attachment.localPath || attachment.path,
      ...(attachment.publicUrl ? { url: attachment.publicUrl } : {}),
      ...(attachment.localPath ? { key: attachment.path } : {}),
    },
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
    ...(attachment.sizeBytes ? { sizeBytes: attachment.sizeBytes } : {}),
    source: 'message_attachment',
    createdAt: message.createdAt,
  };
};

export const extractArtifactsFromExecutionData = (
  executionData: unknown,
  fallback: { nodeId: string; role?: ArtifactRole },
): ArtifactRef[] => {
  if (!isRecord(executionData)) return [];
  const rawArtifacts = Array.isArray(executionData.artifacts)
    ? executionData.artifacts
    : isRecord(executionData.artifact)
      ? [executionData.artifact]
      : [];
  return rawArtifacts
    .map((artifact, index) => normalizeArtifactRef(artifact, {
      nodeId: fallback.nodeId,
      role: fallback.role,
      index,
    }))
    .filter((artifact): artifact is ArtifactRef => Boolean(artifact));
};

export const getMessageArtifacts = (
  message: Message | null | undefined,
  options: { includeAttachments?: boolean; role?: ArtifactRole } = {},
): ArtifactRef[] => {
  if (!message) return [];
  const role = options.role ?? (message.role === 'user' ? 'input' : 'output');
  const artifacts = extractArtifactsFromExecutionData(message.execution_data, {
    nodeId: message.id,
    role,
  });
  if (options.includeAttachments === false || !Array.isArray(message.attachments)) {
    return artifacts;
  }
  const attachmentArtifacts = message.attachments.map((attachment) => attachmentToArtifact(attachment, message));
  return [...attachmentArtifacts, ...artifacts];
};

export const getPrimaryArtifact = (artifacts: ArtifactRef[]): ArtifactRef | null => {
  if (artifacts.length === 0) return null;
  return artifacts.find((artifact) => artifact.isPrimary) ?? artifacts[0] ?? null;
};

export const upsertArtifact = (artifacts: ArtifactRef[], artifact: ArtifactRef): ArtifactRef[] => {
  const next = artifacts
    .filter((existing) => existing.id !== artifact.id)
    .map((existing) => ({ ...existing }));
  const shouldMakePrimary = artifact.isPrimary || next.length === 0;
  const normalizedExisting = shouldMakePrimary
    ? next.map((existing) => ({ ...existing, isPrimary: false }))
    : next;
  normalizedExisting.push({
    ...artifact,
    ...(shouldMakePrimary ? { isPrimary: true } : {}),
  });
  return normalizedExisting;
};

const isAbsoluteLocalPath = (value: string): boolean => (
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
);

const localArtifactPathToPreviewUrl = (path: string | undefined): string | null => {
  if (!path) return null;
  if (path.startsWith('data:')) return path;
  if (!isAbsoluteLocalPath(path)) return null;
  // Local artifact paths are durable handles; render them through Tauri's asset protocol.
  try {
    return convertFileSrc(path);
  } catch {
    return `asset://localhost${path.startsWith('/') ? '' : '/'}${encodeURI(path)}`;
  }
};

export const getArtifactPreviewUrl = (artifact: ArtifactRef | null | undefined): string | null => {
  if (!artifact) return null;
  return artifact.thumbnail?.url
    ?? localArtifactPathToPreviewUrl(artifact.thumbnail?.path)
    ?? artifact.storage.url
    ?? localArtifactPathToPreviewUrl(artifact.storage.path)
    ?? null;
};

export const getArtifactDisplayTitle = (artifact: ArtifactRef): string => (
  artifact.title
  ?? artifact.filename
  ?? artifact.caption
  ?? artifact.kind.replace(/_/g, ' ')
);

export const buildArtifactContextText = (artifacts: ArtifactRef[]): string => {
  if (artifacts.length === 0) return '';
  return artifacts.map((artifact, index) => {
    const lines = [
      `Artifact ${index + 1}: ${getArtifactDisplayTitle(artifact)}`,
      `Role: ${artifact.role}`,
      `Kind: ${artifact.kind}`,
      `MIME type: ${artifact.mimeType}`,
    ];
    if (artifact.filename) lines.push(`Filename: ${artifact.filename}`);
    if (artifact.caption) lines.push(`Caption: ${artifact.caption}`);
    if (artifact.storage.path) lines.push(`Path: ${artifact.storage.path}`);
    if (artifact.storage.key) lines.push(`Storage key: ${artifact.storage.key}`);
    if (artifact.storage.url) lines.push(`URL: ${artifact.storage.url}`);
    if (artifact.width && artifact.height) lines.push(`Dimensions: ${artifact.width}x${artifact.height}`);
    if (artifact.sizeBytes) lines.push(`Size bytes: ${artifact.sizeBytes}`);
    return lines.join('\n');
  }).join('\n\n');
};

export const appendInputArtifactsToPrompt = (
  prompt: string,
  attachments: AttachmentMetadata[] | null | undefined,
): string => {
  if (!Array.isArray(attachments) || attachments.length === 0) return prompt;
  const artifacts = attachments.map((attachment) => attachmentToArtifact(attachment, {
    id: 'current-user-message',
    createdAt: new Date().toISOString(),
  })).map((artifact, index) => ({
    ...artifact,
    id: `current-input-artifact:${index}`,
  }));
  const contextText = buildArtifactContextText(artifacts);
  if (!contextText) return prompt;
  return `${prompt.trim()}\n\n[Current User Uploaded Files]\n${contextText}`.trim();
};
