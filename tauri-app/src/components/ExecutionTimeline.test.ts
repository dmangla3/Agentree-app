import { describe, expect, it } from 'vitest';
import { buildTimelineRows, formatToolPayload, getToolSummary, isEmptyToolPayload, summarizeExplorationItems, summarizeFileChangesPayload } from './ExecutionTimeline';

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

  it('does not summarize empty tool inputs as raw empty JSON', () => {
    expect(isEmptyToolPayload({})).toBe(true);
    expect(getToolSummary('Skill', {})).toBe('');
    expect(getToolSummary('Skill', 'Launching skill: agentree-debug-flow')).toBe('Launching skill: agentree-debug-flow');
  });

  it('summarizes Claude Read outputs as line ranges instead of raw file content', () => {
    const summary = getToolSummary('Read', '817\tfn normalize_timeline_event(event: &JsonValue) -> Option<JsonValue> {\n818\t    let event_type = event.get("type")?.as_str()?;\n915\t    };\n');

    expect(summary).toBe('lines 817-915');
  });

  it('summarizes Read inputs with filenames and line ranges when Claude provides input', () => {
    const summary = getToolSummary('Read', {
      file_path: '/Users/example/.agentree/worktrees/07d85467cbd7b183/nodes/e9c72cb6-3696-485f-b6dc-f290bcbeb45b/tauri-app/src-tauri/src/agents.rs',
      offset: 817,
      limit: 99,
    });

    expect(summary).toBe('tauri-app/src-tauri/src/agents.rs:817-915');
  });

  it('summarizes Claude Grep file-list output compactly', () => {
    const summary = getToolSummary('Grep', 'Found 4 files\ntauri-app/src/components/NodeHoverCardContent.tsx\ntauri-app/src/components/NodeHoverCardContent.test.tsx\ntauri-app/src/components/AppNodeHoverPreview.tsx\ntauri-app/src/components/AppNodeHoverPreview.test.tsx');

    expect(summary).toBe('Found 4 files: tauri-app/src/components/NodeHoverCardContent.tsx, tauri-app/src/components/NodeHoverCardContent.test.tsx, tauri-app/src/components/AppNodeHoverPreview.tsx, +1 more');
  });

  it('summarizes Claude Edit and Bash outputs', () => {
    expect(getToolSummary('Edit', 'The file tauri-app/src-tauri/src/agents.rs has been updated successfully.')).toBe('Updated tauri-app/src-tauri/src/agents.rs');
    expect(getToolSummary('Edit', '<tool_use_error>File does not exist. Note: your current working directory is /tmp/project.</tool_use_error>')).toBe('File does not exist. Note: your current working directory is /tmp/project.');
    expect(getToolSummary('Bash', 'warning: unused variable\nwarning: dead code\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.29s')).toBe('Build completed with 2 warnings');
    expect(getToolSummary('TodoWrite', 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.')).toBe('Updated todos');
  });

  it('unwraps MCP text tool results before summarizing or formatting payloads', () => {
    const payload = {
      _meta: null,
      content: [
        {
          type: 'text',
          text: 'Workspace Graph Overview\nTotal: 62 nodes | Branch points: 0',
        },
      ],
    };

    expect(getToolSummary('get_workspace_graph', payload)).toBe('Workspace Graph Overview');
    expect(formatToolPayload(payload)).toBe('Workspace Graph Overview\nTotal: 62 nodes | Branch points: 0');
    expect(formatToolPayload(payload)).not.toContain('"_meta"');
    expect(formatToolPayload(payload)).not.toContain('"content"');
  });

  it('summarizes Agentree orchestration MCP calls without raw JSON', () => {
    const summary = getToolSummary('agentree.start_orchestration_run', {
      template_id: '@synthesizer',
      decision_id: 'synthesizer-commits',
      prompt: 'Look at the shared commits.\n\nCompare them.',
    });

    expect(summary).toBe('Start @synthesizer: Look at the shared commits.');
    expect(summary).not.toContain('{"template_id"');
  });

  it('summarizes Agentree wait and completion MCP calls', () => {
    expect(getToolSummary('agentree.wait_for_runs', {
      assistant_node_ids: ['a', 'b'],
      condition: 'terminal',
    })).toBe('Wait for 2 runs (terminal)');
    expect(getToolSummary('agentree.complete_orchestration', {
      terminal_orchestration_run_assistant_node_ids: ['a'],
    })).toBe('Complete orchestration with 1 terminal run');
  });

  it('keeps MCP server and tool names available on timeline rows', () => {
    const rows = buildTimelineRows([
      {
        type: 'tool_use',
        timestamp: 1,
        toolName: 'agentree.get_graph_overview',
        toolInput: {},
        toolUseId: 'call-1',
      } as any,
      {
        type: 'tool_result',
        timestamp: 2,
        toolName: 'agentree.get_graph_overview',
        toolUseId: 'call-1',
        toolOutput: {
          _meta: null,
          content: [{ type: 'text', text: 'Workspace Graph Overview\nTotal: 62 nodes' }],
        },
      } as any,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: 'tool',
      toolName: 'agentree.get_graph_overview',
    }));
    expect(getToolSummary((rows[0] as any).toolName, (rows[0] as any).toolOutput)).toBe('Workspace Graph Overview');
  });
});

describe('summarizeExplorationItems', () => {
  it('compacts repeated exploration actions by type', () => {
    expect(summarizeExplorationItems([
      { label: 'Search', text: 'layout in tauri-app' },
      { label: 'Read', text: 'GraphView.tsx' },
      { label: 'Search', text: 'position in GraphView.tsx' },
      { label: 'Read', text: 'useGraphLayout.ts' },
      { label: 'Search', text: 'localStorage in lib' },
    ])).toBe('3 searches • 2 reads');
  });

  it('keeps a single exploration action descriptive', () => {
    expect(summarizeExplorationItems([
      { label: 'Read', text: 'GraphView.tsx' },
    ])).toBe('Read GraphView.tsx');
  });
});

describe('buildTimelineRows', () => {
  it('coalesces adjacent thinking delta rows for display', () => {
    const rows = buildTimelineRows([
      { type: 'thinking', timestamp: 1, content: 'Reading ', isDelta: true } as any,
      { type: 'thinking', timestamp: 2, content: 'files', is_delta: true } as any,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: 'thinking',
      content: 'Reading files',
    }));
  });

  it('coalesces adjacent legacy thinking fragments that lost delta markers', () => {
    const rows = buildTimelineRows([
      { type: 'thinking', timestamp: 1, content: 'The' } as any,
      { type: 'thinking', timestamp: 2, content: ' user' } as any,
      { type: 'thinking', timestamp: 3, content: ' asked' } as any,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: 'thinking',
      content: 'The user asked',
    }));
  });

  it('bounds very long coalesced thinking display content', () => {
    const rows = buildTimelineRows(
      Array.from({ length: 2000 }, (_, index) => ({
        type: 'thinking',
        timestamp: index + 1,
        content: 'chunk ',
      })) as any,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ kind: 'thinking' }));
    expect((rows[0] as any).content?.length).toBeLessThan(6100);
    expect((rows[0] as any).content).toContain('[truncated for display]');
  });

  it('keeps explicit non-delta thinking snapshots separate', () => {
    const rows = buildTimelineRows([
      { type: 'thinking', timestamp: 1, content: 'First thought', isDelta: false } as any,
      { type: 'thinking', timestamp: 2, content: 'Second thought', isDelta: false } as any,
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({ content: 'First thought' }));
    expect(rows[1]).toEqual(expect.objectContaining({ content: 'Second thought' }));
  });

  it('merges duplicate Claude tool_use updates with later structured input', () => {
    const rows = buildTimelineRows([
      {
        type: 'tool_use',
        timestamp: 1,
        toolName: 'Read',
        toolUseId: 'tool-1',
        toolInput: {},
      } as any,
      {
        type: 'tool_use',
        timestamp: 2,
        toolName: 'Read',
        toolUseId: 'tool-1',
        toolInput: { file_path: 'tauri-app/src-tauri/src/agents.rs', offset: 10, limit: 3 },
      } as any,
      {
        type: 'tool_result',
        timestamp: 3,
        toolUseId: 'tool-1',
        toolOutput: '10\tlet a = 1;\n11\tlet b = 2;\n12\tlet c = 3;',
      } as any,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: 'tool',
      toolName: 'Read',
      toolInput: { file_path: 'tauri-app/src-tauri/src/agents.rs', offset: 10, limit: 3 },
      toolOutput: '10\tlet a = 1;\n11\tlet b = 2;\n12\tlet c = 3;',
    }));
  });

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
