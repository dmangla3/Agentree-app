#!/usr/bin/env node
import { writeTraceForCapture } from './perf-trace-lib.mjs';

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.findIndex((arg) => arg === name);
  return index >= 0 ? args[index + 1] : null;
};

const root = valueAfter('--root') ?? process.cwd();
const captureDir = valueAfter('--capture-dir');
const pilotReportPath = valueAfter('--pilot-report');
const outputPath = valueAfter('--out');
const json = args.includes('--json');

try {
  const result = await writeTraceForCapture({
    root,
    captureDir,
    pilotReportPath,
    outputPath,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Trace written: ${result.outputPath}`);
    console.log(`Events: ${result.eventCount}`);
    console.log(`Capture: ${result.captureDir}`);
    if (result.pilotReportPath) console.log(`Pilot report: ${result.pilotReportPath}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
