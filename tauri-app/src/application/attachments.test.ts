import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandsMock = vi.hoisted(() => ({
  saveComposerAttachment: vi.fn(),
}));
const apiMock = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));
const axiosMock = vi.hoisted(() => ({
  put: vi.fn(),
}));

vi.mock('../generated/tauri-bindings', () => ({ commands: commandsMock }));
vi.mock('../lib/api', () => ({
  AGENTREE_DATA_PLANE_ENABLED: false,
  api: apiMock,
}));
vi.mock('axios', () => ({ default: axiosMock }));

import { attachmentApplication } from './attachments';

describe('attachment application boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandsMock.saveComposerAttachment.mockResolvedValue({
      path: '/local/attachment.png',
      size_bytes: 42,
    });
  });

  it('persists composer attachments locally without touching the disabled cloud data plane', async () => {
    const file = new File(['image'], 'attachment.png', { type: 'image/png' });

    const result = await attachmentApplication.save({
      workspaceId: 'workspace-1',
      attachmentId: 'attachment-1',
      file,
      dataUrl: 'data:image/png;base64,aW1hZ2U=',
    });

    expect(commandsMock.saveComposerAttachment).toHaveBeenCalledWith(
      'workspace-1',
      'attachment-1',
      'attachment.png',
      'data:image/png;base64,aW1hZ2U=',
    );
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(axiosMock.put).not.toHaveBeenCalled();
    expect(result).toEqual({
      localPath: '/local/attachment.png',
      remotePath: null,
      publicUrl: null,
      sizeBytes: 42,
    });
  });
});
