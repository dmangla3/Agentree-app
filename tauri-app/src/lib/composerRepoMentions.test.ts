import { describe, expect, it } from 'vitest';
import {
  buildRepoMentionSearchIndex,
  extractRepoMentionPaths,
  getMentionedRepoPathSet,
  getRepoMentionMatches,
} from './composerRepoMentions';

const files = [
  'src/composer/GraphDockComposer.tsx',
  'src/components/ChatInterface.tsx',
  'src/components/GraphView.tsx',
  'src/lib/composerContext.ts',
  'src/lib/composerModelDefaults.ts',
  'src/lib/composerRepoMentions.ts',
  'src/lib/composerSendParent.ts',
  'src/lib/fuzzySearch.ts',
  'server/effect/services/MessageService.ts',
].map((path) => ({
  path,
  name: path.split('/').pop() || path,
}));

describe('composer repo mentions', () => {
  it('extracts only explicit repo mention tokens from prompt text', () => {
    expect(extractRepoMentionPaths('read @src/composer/GraphDockComposer.tsx and @server/effect/services/MessageService.ts')).toEqual([
      'src/composer/GraphDockComposer.tsx',
      'server/effect/services/MessageService.ts',
    ]);
  });

  it('filters prompt mentions through a prebuilt file path set', () => {
    const pathSet = new Set(files.map((file) => file.path));

    expect(getMentionedRepoPathSet('use @src/composer/GraphDockComposer.tsx and @missing/file.ts', pathSet)).toEqual(
      new Set(['src/composer/GraphDockComposer.tsx'])
    );
  });

  it('returns the best repo mention matches from a prebuilt search index', () => {
    const index = buildRepoMentionSearchIndex(files);

    expect(getRepoMentionMatches(index, 'chat', 4).map((file) => file.path)).toEqual([
      'src/composer/GraphDockComposer.tsx',
      'src/components/ChatInterface.tsx',
    ]);
  });
});
