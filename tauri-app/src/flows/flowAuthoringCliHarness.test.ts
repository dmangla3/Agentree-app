import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { authorFlowFromNaturalLanguage, type FlowAuthoringAgent } from './flowAuthoring';

const provider = process.env.AGENTREE_FLOW_AUTHORING_PROVIDER;
const requestedModel = process.env.AGENTREE_FLOW_AUTHORING_MODEL;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const timeout = Number(process.env.AGENTREE_FLOW_AUTHORING_TIMEOUT_MS ?? 300_000);
const scenarioFilter = process.env.AGENTREE_FLOW_AUTHORING_SCENARIO;
const shouldLogGeneratedYaml = process.env.AGENTREE_FLOW_AUTHORING_LOG === '1';

const allScenarios = [
  {
    name: 'branch-parallel checks report',
    request: 'Create a flow that runs three checks in parallel: dependency audit, lint, and targeted tests. Continue only after all three finish, then produce one combined risk report and handoff summary.',
  },
  {
    name: 'parallel planning synthesis review fix',
    request: 'Create a planning system with 3 parallel planners, a synthesizer after them, then loop max 3 over 3 parallel reviewers and a fixer that takes all reviews. Break the loop only if all 3 reviewers are satisfied. The planner and fixer should create committed plan artifacts, not implement code.',
  },
  {
    name: 'analysis implementation multi review',
    request: 'Create a flow for a complex feature request: first run three branch-specific analysis agents in parallel for architecture risk, data model impact, and UX workflow impact. Synthesize those analysis commits into one implementation brief. Then run two implementers in parallel using that brief, synthesize their commits into one implementation, and loop max 2 over three branch-specific reviewers for correctness, regression risk, and UX fit. A fixer should take all reviewer feedback and revise the implementation only when any reviewer fails. Finish with a handoff summary.',
  },
  {
    name: 'support ticket triage routed remediation',
    request: 'Create a support-ticket triage flow that invents any needed reusable nodes. It should triage the ticket into one of three routes: user_question, documentation_gap, or product_bug, with a declared route return field. For user_question, draft a direct answer without a commit. For documentation_gap, create a committed documentation patch. For product_bug, create a committed fix plan, then run a reviewer on that plan and revise the plan once if the reviewer fails. Finish with a handoff that summarizes which route was taken and what the user should check next.',
  },
];

const scenarios = scenarioFilter
  ? allScenarios.filter((scenario, index) => scenario.name.includes(scenarioFilter) || String(index + 1) === scenarioFilter)
  : allScenarios;

describe.skipIf(!provider)('flow authoring CLI harness', () => {
  it.each(scenarios)('generates and validates $name with a real CLI agent', async ({ name, request }) => {
    const agent = createCliAgent(provider!);

    const result = await authorFlowFromNaturalLanguage({
      request,
      agent,
      maxRepairAttempts: 2,
    });

    expect(result.status, result.status === 'failed' ? result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n') : '').toBe('ready');
    if (result.status !== 'ready') return;
    if (shouldLogGeneratedYaml) {
      console.info(`\n--- ${name} generated YAML ---\n${result.source.source}\n--- end generated YAML ---`);
    }
    expect(result.source.source).toContain('flow:');
    expect(result.definition.run.length).toBeGreaterThanOrEqual(3);
  }, timeout * 3);
});

function createCliAgent(name: string): FlowAuthoringAgent {
  if (name === 'codex') {
    return { complete: runCodexCompletion };
  }
  if (name === 'claude') {
    return { complete: runClaudeCompletion };
  }
  throw new Error(`Unsupported AGENTREE_FLOW_AUTHORING_PROVIDER "${name}". Use codex or claude.`);
}

async function runCodexCompletion(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentree-flow-codex-'));
  const promptPath = join(dir, 'prompt.txt');
  const outputPath = join(dir, 'response.txt');
  await writeFile(promptPath, prompt);
  try {
    const args = [
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--cd',
      repoRoot,
      '--sandbox',
      'read-only',
      '--output-last-message',
      outputPath,
      '--model',
      requestedModel ?? 'gpt-5.5',
      '-',
    ];
    const input = await readFile(promptPath, 'utf8');
    await runProcess('codex', args, {
      cwd: repoRoot,
      input,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return readFile(outputPath, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runClaudeCompletion(prompt: string): Promise<string> {
  const args = [
    '--print',
    '--no-session-persistence',
    '--disallowedTools',
    'Bash,Edit,Write,MultiEdit,Read,Grep,Glob,LS,WebFetch,WebSearch',
    ...(requestedModel ? ['--model', requestedModel] : []),
  ];
  const { stdout } = await runProcess('claude', args, {
    cwd: repoRoot,
    input: prompt,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    timeout: number;
    maxBuffer: number;
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let bufferedBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${options.timeout}ms`));
    }, options.timeout);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      bufferedBytes += chunk.byteLength;
      if (bufferedBytes > options.maxBuffer) {
        finish(() => {
          child.kill('SIGTERM');
          reject(new Error(`${command} exceeded maxBuffer ${options.maxBuffer}`));
        });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorChunks.push(chunk);
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code, signal) => {
      finish(() => {
        const stdout = Buffer.concat(chunks).toString('utf8');
        const stderr = Buffer.concat(errorChunks).toString('utf8');
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}\n${stderr}`));
      });
    });

    child.stdin.end(options.input ?? '');
  });
}
