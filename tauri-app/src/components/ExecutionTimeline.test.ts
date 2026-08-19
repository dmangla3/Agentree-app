import { describe, expect, it } from 'vitest';
import { buildTimelineRows, getToolSummary, summarizeFileChangesPayload } from './ExecutionTimeline';

describe('summarizeFileChangesPayload', () => {
  it('summarizes file change payloads without exposing raw worktree paths', () => {
    const summary = summarizeFileChangesPayload({
      changes: [
        {
          path: '/Users/example/work/example/Agentree/.git/agentree/worktrees/c841544b-52e0-4100-b1b0-7f7ec7f39169/tauri-app/src-tauri/src/agents.rs',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,3 +1,4 @@\n use a;\n-old\n+new\n+extra\n',
        },
        {
          path: '/Users/example/work/example/Agentree/.git/agentree/worktrees/c841544b-52e0-4100-b1b0-7f7ec7f39169/tauri-app/src/lib/graph/commitAccessors.test.ts',
          kind: { type: 'add' },
          diff: "import { describe } from 'vitest';\n\ndescribe('x', () => {});\n",
        },
      ],
    });

    expect(summary).toEqual({
      files: [
        {
          path: 'tauri-app/src-tauri/src/agents.rs',
          kind: 'update',
          additions: 2,
          deletions: 1,
        },
        {
          path: 'tauri-app/src/lib/graph/commitAccessors.test.ts',
          kind: 'add',
          additions: 3,
          deletions: 0,
        },
      ],
      totalAdditions: 5,
      totalDeletions: 1,
    });
  });

  it('returns null for non-change payloads', () => {
    expect(summarizeFileChangesPayload({ output: 'plain text' })).toBeNull();
  });
});

describe('getToolSummary', () => {
  it('summarizes write change payloads instead of exposing raw diff JSON', () => {
    const summary = getToolSummary('write', {
      changes: [
        {
          path: '/Users/example/work/example/Agentree/.git/agentree/worktrees/c841544b-52e0-4100-b1b0-7f7ec7f39169/story.txt',
          kind: { type: 'update' },
          diff: '@@ -1 +1,2 @@\n-In a valley\n+In a valley\n+there was light\n',
        },
      ],
    });

    expect(summary).toBe('1 file changed (+2/-1)');
    expect(summary).not.toContain('{"changes"');
    expect(summary).not.toContain('In a valley');
  });

  it('summarizes multiple file reads from one commandExecution shell command', () => {
    const summary = getToolSummary('commandExecution', {
      command: "/bin/zsh -lc \"pwd && sed -n '1,220p' /Users/example/.codex/plugins/cache/openai-curated/superpowers/dc902811/skills/using-superpowers/SKILL.md && printf '\\n--- package.json ---\\n' && sed -n '1,220p' package.json && printf '\\n--- tauri-app/package.json ---\\n' && sed -n '1,220p' tauri-app/package.json && printf '\\n--- tauri-app/src-tauri/Cargo.toml ---\\n' && sed -n '1,260p' tauri-app/src-tauri/Cargo.toml\"",
    });

    expect(summary).toBe('Read SKILL.md, package.json, tauri-app/package.json, tauri-app/src-tauri/Cargo.toml');
  });

  it('deduplicates file reads while preserving first-seen order', () => {
    const summary = getToolSummary('commandExecution', {
      command: "cat package.json tauri-app/package.json && sed -n '1,20p' package.json",
    });

    expect(summary).toBe('Read package.json, tauri-app/package.json');
  });
});

describe('buildTimelineRows', () => {
  it('projects user steering events as user-visible steer rows', () => {
    const rows = buildTimelineRows([
      {
        type: 'user_steer_requested',
        timestamp: 1,
        content: 'Actually use the cached result.',
      },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'user_steer',
        content: 'Actually use the cached result.',
      }),
    ]);
  });
});
