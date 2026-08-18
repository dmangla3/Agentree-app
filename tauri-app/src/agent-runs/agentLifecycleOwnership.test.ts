import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readChatInputSource = () => readFileSync(join(process.cwd(), 'src/components/ChatInput.tsx'), 'utf8');
const readAgentsSource = () => readFileSync(join(process.cwd(), 'src-tauri/src/agents.rs'), 'utf8');
const readGeneratedBindingsSource = () => readFileSync(join(process.cwd(), 'src/generated/tauri-bindings.ts'), 'utf8');
const readStreamDispatchSource = () => readFileSync(join(process.cwd(), 'src/agent-runs/agentRunStreamDispatch.ts'), 'utf8');
const readClaudeAdapterSource = () => readFileSync(join(process.cwd(), 'src-tauri/scripts/claude-agent-sdk-adapter.mjs'), 'utf8');
const readCodexAdapterSource = () => readFileSync(join(process.cwd(), 'src-tauri/scripts/codex-app-server-adapter.py'), 'utf8');

describe('agent lifecycle ownership boundaries', () => {
  it('does not persist terminal agent payloads directly from ChatInput', () => {
    const source = readChatInputSource();
    const terminalRegionStart = source.indexOf('const finalizeAgentRunMessage =');
    const terminalRegionEnd = source.indexOf('const resolveRunIdForReplay =');
    expect(terminalRegionStart).toBeGreaterThan(-1);
    expect(terminalRegionEnd).toBeGreaterThan(terminalRegionStart);

    const terminalRegion = source.slice(terminalRegionStart, terminalRegionEnd);
    expect(terminalRegion).not.toContain('upsertLocalNode');
    expect(terminalRegion).not.toContain('patchPersistedMessageLocally');
  });

  it('limits ChatInput local-node writes to optimistic node creation', () => {
    const source = readChatInputSource();
    const callIndexes = [...source.matchAll(/agentClient\.upsertLocalNode/g)].map((match) => match.index ?? -1);
    const localFirstRegionStart = source.indexOf(
      'if (hasLocalAgentRuntime && optimisticAssistantMessageIds.length > 0)'
    );
    const localFirstRegionEnd = source.indexOf(
      "releaseSendAcceptance('local-first-persisted');",
      localFirstRegionStart
    );
    expect(localFirstRegionStart).toBeGreaterThan(-1);
    expect(localFirstRegionEnd).toBeGreaterThan(localFirstRegionStart);
    const localFirstRegion = source.slice(localFirstRegionStart, localFirstRegionEnd);

    expect(callIndexes).toHaveLength(2);
    for (const index of callIndexes) {
      expect(index).toBeGreaterThanOrEqual(localFirstRegionStart);
      expect(index).toBeLessThan(localFirstRegionEnd);
    }
    expect(localFirstRegion).toContain('optimisticPair');
    expect(localFirstRegion).toContain('optimisticUserMessages');
    expect(localFirstRegion).toContain('assistantMessages');
  });

  it('keeps stream projection dispatch outside ChatInput', () => {
    const source = readChatInputSource();
    expect(source).not.toContain('const processAgentEvent');
    expect(source).not.toContain('const addTimelineEvent');
    expect(source).not.toContain('const updateAgentRunUsage');
    expect(source).toContain('agentRunStreamDispatch');
  });

  it('does not patch terminal finalize caches directly from ChatInput', () => {
    const source = readChatInputSource();
    expect(source).not.toContain('patchFinalizedMessages');
    expect(source).not.toContain('patchFinalizedLocalNodes');
    expect(source).not.toContain("queryClient.setQueryData<Message[]>(\n                        ['messages', workspaceId]");
    expect(source).not.toContain('finalize-ack:refetch');
  });

  it('does not let user message lifecycle metadata drive the composer cancel state', () => {
    const source = readChatInputSource();
    expect(source).toContain("const selectedNodeRole = selectedProjection?.role ?? selectedNodeMessage?.role ?? null;");
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
    const source = readChatInputSource();
    expect(source).toContain('const isSteeringRunningAssistant =');
    expect(source).toContain('await commands.steerAgentRun(');
    expect(source).toContain("const sendButtonLabel = isSteeringRunningAssistant ? 'Steer'");
    expect(source).toContain('const showPrimaryCancel = showCancel && !isSteeringRunningAssistant;');
    expect(source).toContain('disabled={showPrimaryCancel ? false : isPrimaryActionDisabled}');
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
    expect(codexSource).toContain('_ControlReader');
    expect(codexSource).toContain('"method": "turn/steer"');
  });

  it('paints optimistic send feedback before graph focus and agent status work', () => {
    const source = readChatInputSource();
    const paintWaitIndex = source.indexOf('await waitForOptimisticSendPaint();');
    const optimisticFocusIndex = source.indexOf('dispatchSendFlowFocus({', paintWaitIndex);
    const initialStatusIndex = source.indexOf("setNodeStatus(run.assistantMessageId, 'initializing');");

    expect(paintWaitIndex).toBeGreaterThan(-1);
    expect(optimisticFocusIndex).toBeGreaterThan(paintWaitIndex);
    expect(initialStatusIndex).toBeGreaterThan(paintWaitIndex);
  });

  it('flushes cancel affordance and composer clearing before the pre-optimistic yield', () => {
    const source = readChatInputSource();
    const armStart = source.indexOf('const flowId = createSendFlowId();');
    const preOptimisticYield = source.indexOf('await new Promise<void>((resolve) => window.setTimeout(resolve, 0));', armStart);
    expect(armStart).toBeGreaterThan(-1);
    expect(preOptimisticYield).toBeGreaterThan(armStart);

    const armRegion = source.slice(armStart, preOptimisticYield);
    expect(armRegion).toContain('flushSync(() => {');
    expect(armRegion).toContain('setCurrentAbortController(controller);');
    expect(armRegion).toContain("setComposerPrompt('');");
  });

  it('releases the composer cancel affordance once the send is accepted', () => {
    const source = readChatInputSource();
    const releaseStart = source.indexOf('const releaseSendAcceptance = (reason: string) => {');
    const releaseEnd = source.indexOf("recordSendFlowEvent('queue.acceptance-released'", releaseStart);
    expect(releaseStart).toBeGreaterThan(-1);
    expect(releaseEnd).toBeGreaterThan(releaseStart);

    const releaseRegion = source.slice(releaseStart, releaseEnd);
    expect(releaseRegion).toContain('setActiveComposerSend((current) => current?.flowId === flowId ? null : current);');
    expect(releaseRegion).toContain('setCurrentAbortController((current) => current === controller ? null : current);');
  });

  it('does not eagerly start full streams for restored active agents', () => {
    const source = readChatInputSource();
    expect(source).toContain('registerBackgroundStreamForNode(message)');
    expect(source).not.toContain('void startStreamForNode(message, {\n                waitForReady: false');
  });

  it('promotes background streams from projection watcher transitions', () => {
    const source = readChatInputSource();
    expect(source).toContain('agentRunManager.subscribeProjectionWatchers');
    expect(source).toContain('promoteStreamForNode(event.nodeId');
  });

  it('uses projection or persisted cursor for full replay instead of actor status cursor', () => {
    const source = readChatInputSource();
    expect(source).toContain('resolveFullReplayAfterSeq');
    expect(source).not.toContain('const actorSeq = agentRunManager.snapshot(nodeId)?.lastSeq');
  });

  it('downgrades full stream handlers after watcher grace when runs remain active', () => {
    const source = readChatInputSource();
    expect(source).toContain('FULL_STREAM_UNWATCHED_GRACE_MS');
    expect(source).toContain('scheduleFullStreamDowngrade');
    expect(source).toContain('registerBackgroundStreamForNode(message)');
  });

  it('seeds promoted full streams from the current projection content before persisted message content', () => {
    const source = readChatInputSource();
    expect(source).toContain("const projectedOutput = getAgentRunProjection(nodeId)?.content;");
    expect(source).toContain("let output = typeof projectedOutput === 'string' ? projectedOutput : node.content || '';");
  });

  it('immediately promotes background streams that already have projection watchers', () => {
    const source = readChatInputSource();
    const registerStart = source.indexOf('const registerBackgroundStreamForNode = useCallback((message: Message) => {');
    const registerEnd = source.indexOf('const clearFullStreamDowngrade', registerStart);
    expect(registerStart).toBeGreaterThan(-1);
    expect(registerEnd).toBeGreaterThan(registerStart);

    const registerRegion = source.slice(registerStart, registerEnd);
    expect(registerRegion).toContain('agentRunManager.projectionWatcherSnapshot(message.id).hasWatchers');
    expect(registerRegion).toContain("void promoteStreamForNodeRef.current(message, { reason: 'existing-watcher' });");
  });
});
