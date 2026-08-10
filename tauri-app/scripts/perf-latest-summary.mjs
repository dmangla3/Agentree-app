#!/usr/bin/env node
import { collectLatestPerfSummary, formatPerfSummary } from './perf-latest-summary-lib.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const rootArgIndex = args.findIndex((arg) => arg === '--root');
const root = rootArgIndex >= 0 ? args[rootArgIndex + 1] : process.cwd();

try {
  const summary = await collectLatestPerfSummary(root);
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    process.stdout.write(formatPerfSummary(summary));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
