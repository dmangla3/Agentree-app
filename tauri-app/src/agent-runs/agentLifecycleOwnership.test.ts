import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readComposerSource = () => readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');
const readHeadlessSendSource = () => readFileSync(join(process.cwd(), 'src/composer/headlessComposerSend.ts'), 'utf8');
const readAgentsSource = () => readFileSync(join(process.cwd(), 'src-tauri/src/agents.rs'), 'utf8');
const readGeneratedBindingsSource = () => readFileSync(join(process.cwd(), 'src/generated/tauri-bindings.ts'), 'utf8');
const readStreamDispatchSource = () => readFileSync(join(process.cwd(), 'src/agent-runs/agentRunStreamDispatch.ts'), 'utf8');
const readLiveStreamCoordinatorSource = () => readFileSync(join(process.cwd(), 'src/agent-runs/agentRunLiveStreamCoordinator.ts'), 'utf8');
const readHomePageSource = () => readFileSync(join(process.cwd(), 'src/pages/HomePage.tsx'), 'utf8');
const readHoverHydrationSource = () => readFileSync(join(process.cwd(), 'src/hooks/useAgentRunHoverHydration.ts'), 'utf8');
const readClaudeAdapterSource = () => readFileSync(join(process.cwd(), 'src-tauri/scripts/claude-agent-sdk-adapter.mjs'), 'utf8');
const readCodexAdapterSource = () => readFileSync(join(process.cwd(), 'src-tauri/src/codex_adapter.rs'), 'utf8');

describe('agent lifecycle ownership boundaries', () => {
  it('does not persist terminal agent payloads directly from the composer', () => {
    const source = readComposerSource();
    expect(source).not.toContain('const finalizeAgentRunMessage =');
    expect(source).not.toContain('patchPersistedMessageLocally');
  });

  it('limits composer local-node writes to the shared optimistic send boundary', () => {
    const composerSource = readComposerSource();
    const sendSource = readHeadlessSendSource();
    expect(composerSource).toContain('persistLocalNode:');
    expect(composerSource).not.toContain('patchPersistedMessageLocally');
    expect(sendSource).toContain('await Promise.all(createdMessages.map');
    expect(sendSource).not.toContain('patchFinalizedMessages');
  });

  it('keeps stream projection dispatch outside the composer', () => {
    const source = readComposerSource();
    expect(source).not.toContain('const processAgentEvent');
    expect(source).not.toContain('const addTimelineEvent');
    expect(source).not.toContain('const updateAgentRunUsage');
    expect(source).not.toContain('agentRunStreamDispatch');
    expect(source).not.toContain('dispatchProviderStreamEvent');
  });

  it('does not patch terminal finalize caches directly from the composer', () => {
    const source = readComposerSource();
    expect(source).not.toContain('patchFinalizedMessages');
    expect(source).not.toContain('patchFinalizedLocalNodes');
    expect(source).not.toContain("queryClient.setQueryData<Message[]>(\n                        ['messages', workspaceId]");
    expect(source).not.toContain('finalize-ack:refetch');
  });

  it('does not let user message lifecycle metadata drive the composer cancel state', () => {
    const source = readComposerSource();
    expect(source).toContain("import { isSteerableAssistantNode } from '../lib/agentRunSteering';");
    expect(source).toContain('const isSteeringRunningAssistant = isSteerableAssistantNode({');
  });

  it('keeps start_agent_run off a synchronous async-runtime block for worktree preview', () => {
    const source = readAgentsSource();
    const commandStart = source.indexOf('pub async fn start_agent_run');
    const commandEnd = source.indexOf('fn run_agent_lifecycle_background', commandStart);
    expect(commandStart).toBeGreaterThan(-1);
    expect(commandEnd).toBeGreaterThan(commandStart);

    const commandRegion = source.slice(commandStart, commandEnd);
    expect(commandRegion).not.toContain(
      'tauri::async_runtime::block_on(crate::git_workspace::preview_agent_worktree'
    );
    expect(commandRegion).toContain('crate::git_workspace::preview_agent_worktree(');
    expect(commandRegion).toContain('.await?');
  });

  it('keeps a stdin control channel for steering active agent runs', () => {
    const source = readAgentsSource();
    expect(source).toContain('stdins: Mutex<HashMap<String, Arc<Mutex<ChildStdin>>>>');
    expect(source).toContain('.stdin(Stdio::piped())');
    expect(source).toContain('child.stdin.take()');
    expect(source).toContain('state.stdins.lock()');
    expect(source).toContain('remove(&session_id_for_wait)');
  });

  it('exposes a native steer command that writes intervention events and control JSON', () => {
    const source = readAgentsSource();
    const libSource = readFileSync(join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
    const bindingsSource = readGeneratedBindingsSource();

    expect(source).toContain('pub fn steer_agent_run(');
    expect(source).toContain('"user_steer_requested"');
    expect(source).toContain('"provider_steer_ack"');
    expect(source).toContain('"steer_agent_run"');
    expect(libSource).toContain('agents::steer_agent_run');
    expect(bindingsSource).toContain('steerAgentRun: (assistantNodeId: string, content: string, idempotencyKey: string)');
  });

  it('routes running-assistant composer submissions through steering instead of child branching', () => {
    const source = readComposerSource();
    expect(source).toContain('const isSteeringRunningAssistant =');
    expect(source).toContain('await agentClient.steerAgentRun(');
    expect(source).toContain("const sendButtonLabel = isSteeringRunningAssistant ? 'Steer'");
    expect(source).toContain('data-testid="graph-dock-cancel-running-agent-button"');
  });

  it('projects steering requests into the assistant timeline', () => {
    const source = readStreamDispatchSource();
    expect(source).toContain("data.type === 'user_steer_requested'");
    expect(source).toContain("type: 'user_steer_requested'");
  });

  it('adapters listen for native steering control messages', () => {
    const claudeSource = readClaudeAdapterSource();
    const codexSource = readCodexAdapterSource();

    expect(claudeSource).toContain('createControlReader');
    expect(claudeSource).toContain("control.type !== 'steer'");
    expect(codexSource).toContain('read_control_stdin');
    expect(codexSource).toContain('"method": "turn/steer"');
  });

  it('uses the last assistant message id as Claude provider stop item identity', () => {
    const source = readClaudeAdapterSource();
    expect(source).toContain('provider_item_id: lastAssistantUuid ?? null');
  });

  it('keeps native stream subscription ownership in the shared coordinator', () => {
    const composerSource = readComposerSource();
    const coordinatorSource = readLiveStreamCoordinatorSource();
    const homePageSource = readHomePageSource();
    expect(composerSource).not.toContain('createAgentRunLiveStreamRuntime');
    expect(composerSource).not.toContain('agentClient.onEvent');
    expect(coordinatorSource).toContain('agentClient.onEvent');
    expect(homePageSource).toContain('<AgentRunLiveStreamCoordinator />');
  });

  it('keeps hover hydration one-shot instead of polling for live updates', () => {
    const source = readHoverHydrationSource();
    expect(source).toContain("ensureAgentRunHydrated(nodeId, 'hover')");
    expect(source).not.toContain('setTimeout');
    expect(source).not.toContain('hasAgentRunLiveStreamRuntimeSubscriber');
  });

  it('seeds shared stream state from actor, projection, or tracked message content', () => {
    const source = readLiveStreamCoordinatorSource();
    expect(source).toContain("output: snapshot?.content ?? projection?.content ?? tracked?.content ?? ''");
    expect(source).toContain('trackAgentRunLiveStreamMessage');
  });

  it('ingests live stream events through the shared hydration semantics', () => {
    const source = readLiveStreamCoordinatorSource();
    expect(source).toContain('ingestAgentRunStreamEvent(nodeId, event, input, state)');
    expect(source).toContain('agentRunManager.snapshot(nodeId)');
  });
});
