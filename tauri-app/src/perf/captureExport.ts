import { invoke } from '@tauri-apps/api/core';
import { flushFrontendLogs } from '../lib/appLogger';
import type {
  PerfCaptureExportResult,
  PerfEvent,
  PerfSession,
  SendFlowSessionReport,
} from './types';
import { buildSendFlowSessionReport } from './sendFlow';

type ExportPerfCaptureRequest = {
  session: PerfSession;
  stoppedAt: string;
  startedAtMs: number;
  stoppedAtMs: number;
  perfEvents: PerfEvent[];
  sendFlowReport: SendFlowSessionReport;
};

export const buildCaptureExportRequest = (
  session: PerfSession,
  perfEvents: PerfEvent[],
  stoppedAt: string
): ExportPerfCaptureRequest => ({
  session,
  stoppedAt,
  startedAtMs: Date.parse(session.startedAt),
  stoppedAtMs: Date.parse(stoppedAt),
  perfEvents,
  sendFlowReport: buildSendFlowSessionReport(perfEvents),
});

export const exportPerfCaptureBundle = async (
  session: PerfSession,
  perfEvents: PerfEvent[],
  stoppedAt: string
): Promise<PerfCaptureExportResult> => {
  await flushFrontendLogs();
  const request = buildCaptureExportRequest(session, perfEvents, stoppedAt);
  return await invoke<PerfCaptureExportResult>('export_perf_capture_bundle', { request });
};
