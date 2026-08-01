#!/usr/bin/env node
const { spawn } = require('child_process');

// Parse args to find -p or --prompt
const args = process.argv.slice(2);
let promptIndex = args.indexOf('-p');
if (promptIndex === -1) promptIndex = args.indexOf('--prompt');

let command = '';
if (promptIndex !== -1 && args[promptIndex + 1]) {
    command = args[promptIndex + 1];
} else if (args.length > 0) {
    // If no -p, use the last argument as the command
    command = args[args.length - 1];
} else {
    console.error('Error: No command provided');
    process.exit(1);
}

// Helper to emit JSON event
const emit = (event) => {
    console.log(JSON.stringify(event));
};

console.error(`[BashAdapter] Running: bash -c "${command}"`);

// Run bash -c command
// We capture stdio to wrap it in JSON events
const child = spawn('bash', ['-c', command], {
    stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', (data) => {
    // Emit stdout as assistant message content
    emit({ type: 'message', role: 'assistant', content: data.toString() });
});

child.stderr.on('data', (data) => {
    // Emit stderr as assistant message content (or could be separate error event)
    // Using message content ensures it's visible in the UI
    emit({ type: 'message', role: 'assistant', content: data.toString() });
});

child.on('error', (err) => {
    console.error(`[BashAdapter] Failed to start bash: ${err.message}`);
    emit({ type: 'message', role: 'assistant', content: `Error starting bash: ${err.message}` });
    process.exit(1);
});

child.on('exit', (code) => {
    emit({
        type: 'provider_stop',
        provider_stop_reason: 'exit',
        provider_status: code === 0 ? 'completed' : 'failed',
        exit_code: code
    });
    process.exit(code || 0);
});
