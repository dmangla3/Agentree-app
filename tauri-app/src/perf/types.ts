export type PerfEvent = {
  ts: string;
  name: string;
  source?: string;
  durationMs?: number;
  sessionId?: string | null;
  sessionLabel?: string | null;
  details?: Record<string, unknown>;
};

export type PerfSession = {
  id: string;
  label: string;
  startedAt: string;
};

export type PerfExportStatus =
  | {
      state: 'idle';
      sessionId: string | null;
      exportPath: null;
      error: null;
      exportedAt: null;
    }
  | {
      state: 'exporting' | 'succeeded' | 'failed';
      sessionId: string;
      exportPath: string | null;
      error: string | null;
      exportedAt: string | null;
    };

export type SendFlowFinding = {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  flowId: string;
  relatedEventNames: string[];
  nodeId?: string | null;
};

export type SendFlowSummary = {
  flowId: string;
  sessionId: string | null;
  sessionLabel: string | null;
  startedAt: string | null;
  terminalAt: string | null;
  status: 'completed' | 'failed' | 'cancelled' | 'incomplete';
  workspaceId: string | null;
  promptLength: number | null;
  usedAgent: boolean | null;
  optimisticUserMessageId: string | null;
  optimisticAssistantMessageId: string | null;
  persistedUserMessageId: string | null;
  persistedAssistantMessageId: string | null;
  finalFocusedMessageId: string | null;
  milestones: Record<string, string>;
  durationsMs: Record<string, number>;
  counts: Record<string, number>;
  findings: SendFlowFinding[];
};

export type SendFlowSessionReport = {
  generatedAt: string;
  sessionId: string | null;
  sessionLabel: string | null;
  flowCount: number;
  runtime: {
    eventLoopStallCount: number;
    eventLoopFreezeCount: number;
    maxEventLoopStallMs: number | null;
    rafStallCount: number;
    rafFreezeCount: number;
    maxRafStallMs: number | null;
    longTaskCount: number;
    maxLongTaskMs: number | null;
  };
  flows: SendFlowSummary[];
  findings: SendFlowFinding[];
};

export type PerfCaptureExportResult = {
  exportDir: string;
  files: string[];
};
