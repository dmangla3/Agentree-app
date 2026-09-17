import { describe, expect, it } from 'vitest';
import {
  appendInputArtifactsToPrompt,
  buildArtifactContextText,
  getMessageArtifacts,
  getArtifactPreviewUrl,
  getPrimaryArtifact,
} from './artifacts';
import type { Message } from '../stores/workspaceStore';

const baseMessage = (overrides: Partial<Message>): Message => ({
  id: 'message-1',
  role: 'assistant',
  parentId: 'user-1',
  workspaceId: 'workspace-1',
  content: 'Done',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  ...overrides,
});

describe('artifact helpers', () => {
  it('normalizes uploaded files and assistant output artifacts from a message', () => {
    const message = baseMessage({
      role: 'user',
      attachments: [{
        path: 'uploads/input-hero.png',
        publicUrl: 'https://cdn.example.com/input-hero.png',
        filename: 'input-hero.png',
        contentType: 'image/png',
      }],
      execution_data: {
        artifacts: [{
          id: 'artifact-1',
          role: 'output',
          kind: 'screenshot',
          mimeType: 'image/png',
          title: 'Landing page preview',
          storage: { backend: 'local', path: 'screenshots/home.png' },
          thumbnail: { url: 'data:image/png;base64,abcd' },
          width: 1440,
          height: 900,
          isPrimary: true,
        }],
      },
    });

    const artifacts = getMessageArtifacts(message);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({
      role: 'input',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'input-hero.png',
      storage: {
        backend: 'r2',
        path: 'uploads/input-hero.png',
        url: 'https://cdn.example.com/input-hero.png',
      },
    });
    expect(getPrimaryArtifact(artifacts)).toMatchObject({
      id: 'artifact-1',
      title: 'Landing page preview',
      width: 1440,
      height: 900,
    });
  });

  it('builds compact context text for prompt-visible artifacts', () => {
    const prompt = appendInputArtifactsToPrompt('Review this page', [{
      path: 'uploads/page.png',
      publicUrl: 'https://cdn.example.com/page.png',
      filename: 'page.png',
      contentType: 'image/png',
    }]);

    expect(prompt).toContain('[Current User Uploaded Files]');
    expect(prompt).toContain('Filename: page.png');
    expect(prompt).toContain('URL: https://cdn.example.com/page.png');
  });

  it('includes durable handles in artifact context text', () => {
    const context = buildArtifactContextText([{
      id: 'artifact-1',
      nodeId: 'assistant-1',
      role: 'output',
      kind: 'html',
      mimeType: 'text/html',
      title: 'Landing page HTML',
      storage: { backend: 'local', path: 'dist/index.html' },
      publicSafe: false,
    }]);

    expect(context).toContain('Artifact 1: Landing page HTML');
    expect(context).toContain('Path: dist/index.html');
  });

  it('builds preview URLs for local image artifact paths', () => {
    const previewUrl = getArtifactPreviewUrl({
      id: 'artifact-1',
      nodeId: 'assistant-1',
      role: 'output',
      kind: 'image',
      mimeType: 'image/png',
      storage: { backend: 'local', path: '/tmp/generated-image.png' },
    });

    expect(previewUrl).toContain('/tmp/generated-image.png');
    expect(previewUrl).not.toBe('/tmp/generated-image.png');
  });

  it('prefers canonical isPrimary over legacy is_primary when both are present', () => {
    const artifacts = getMessageArtifacts(baseMessage({
      execution_data: {
        artifacts: [{
          id: 'artifact-1',
          role: 'output',
          kind: 'image',
          mimeType: 'image/png',
          storage: { backend: 'local', path: '/tmp/preview.png' },
          isPrimary: false,
          is_primary: true,
        }],
      },
    }));

    expect(artifacts[0].isPrimary).toBe(false);
  });
});
