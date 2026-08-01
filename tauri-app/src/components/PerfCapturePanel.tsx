import { useEffect, useMemo, useState } from 'react';
import { Activity, Bug, Clipboard, Eye, EyeOff, Pause, Play, Trash2 } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import {
  getActivePerfSession,
  getPerfExportStatus,
  readLatestPerfSessionEvents,
  startPerfCapture,
  stopPerfCapture,
  subscribePerfExport,
  subscribePerfSession,
} from '../lib/perfRecorder';
import {
  captureGraphDiagnostics,
  readLatestGraphDiagnosticCapture,
  subscribeGraphDiagnosticCaptures,
} from '../lib/graphDiagnostics';

const PERF_PANEL_VISIBILITY_KEY = 'agentree.perf.panel.visible.v1';

export function PerfCapturePanel() {
  const [label, setLabel] = useState('send-message-capture');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => getActivePerfSession()?.id ?? null);
  const [latestEventCount, setLatestEventCount] = useState(() => readLatestPerfSessionEvents().length);
  const [latestGraphCapture, setLatestGraphCapture] = useState(() => readLatestGraphDiagnosticCapture());
  const [exportStatus, setExportStatus] = useState(() => getPerfExportStatus());
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(PERF_PANEL_VISIBILITY_KEY) !== 'false';
  });

  useEffect(() => subscribePerfSession(() => {
    setActiveSessionId(getActivePerfSession()?.id ?? null);
    setLatestEventCount(readLatestPerfSessionEvents().length);
  }), []);

  useEffect(() => subscribeGraphDiagnosticCaptures(() => {
    setLatestGraphCapture(readLatestGraphDiagnosticCapture());
  }), []);

  useEffect(() => subscribePerfExport(() => {
    setExportStatus(getPerfExportStatus());
  }), []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PERF_PANEL_VISIBILITY_KEY, isVisible ? 'true' : 'false');
  }, [isVisible]);

  const activeSession = useMemo(() => getActivePerfSession(), [activeSessionId]);
  const logPath = (window as Window & { __AGENTREE_LOG_PATHS__?: { frontend_log?: string } }).__AGENTREE_LOG_PATHS__?.frontend_log ?? null;

  if (!isVisible) {
    return (
      <div className="fixed bottom-4 left-4 z-[120]">
        <Button
          size="sm"
          variant="outline"
          className="h-9 rounded-lg border-emerald-500/25 bg-background/95 px-3 shadow-sm"
          onClick={() => setIsVisible(true)}
        >
          <Eye className="mr-1.5 h-3.5 w-3.5" />
          Perf Capture
        </Button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-[120] w-[320px] rounded-xl border border-emerald-500/25 bg-background/95 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Activity className="h-4 w-4 text-emerald-600" />
            Perf Capture
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Start capture, reproduce the issue, stop capture, then tell me the session label.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`mt-0.5 h-2.5 w-2.5 rounded-full ${activeSession ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setIsVisible(false)}
            aria-label="Hide perf capture"
            title="Hide perf capture"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs outline-none"
          placeholder="capture label"
        />
        <div className="flex gap-2">
          {!activeSession ? (
            <Button size="sm" className="flex-1" onClick={() => startPerfCapture(label.trim() || 'interactive-capture')}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Start
            </Button>
          ) : (
            <Button size="sm" variant="secondary" className="flex-1" onClick={() => void stopPerfCapture()}>
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Stop
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              window.__AGENTREE_PERF__?.clear();
              setLatestEventCount(0);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            onClick={() => {
              const capture = captureGraphDiagnostics(label.trim() || 'graph-layout-capture');
              (window as Window & {
                __AGENTREE_GRAPH_DEBUG__?: {
                  captureGeometry?: (reason?: string) => unknown;
                };
              }).__AGENTREE_GRAPH_DEBUG__?.captureGeometry?.(label.trim() || 'perf-panel-graph');
              setLatestGraphCapture(capture ?? readLatestGraphDiagnosticCapture());
            }}
          >
            <Bug className="mr-1.5 h-3.5 w-3.5" />
            Graph
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!latestGraphCapture}
            onClick={() => {
              if (!latestGraphCapture) return;
              navigator.clipboard?.writeText(JSON.stringify(latestGraphCapture, null, 2));
            }}
            title="Copy latest graph diagnostic JSON"
          >
            <Clipboard className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => {
            (window as Window & {
              __AGENTREE_GRAPH_DEBUG__?: {
                captureGeometry?: (reason?: string) => unknown;
              };
            }).__AGENTREE_GRAPH_DEBUG__?.captureGeometry?.(label.trim() || 'perf-panel-geometry');
            setLatestEventCount(readLatestPerfSessionEvents().length);
          }}
        >
          <Bug className="mr-1.5 h-3.5 w-3.5" />
          Capture Graph Geometry
        </Button>
      </div>

      <div className="mt-3 space-y-1 rounded-lg border border-border/60 bg-muted/20 p-2 text-[11px]">
        <div><span className="font-medium">Active:</span> {activeSession ? `${activeSession.label} (${activeSession.id})` : 'none'}</div>
        <div><span className="font-medium">Latest events:</span> {latestEventCount}</div>
        <div><span className="font-medium">Export:</span> {exportStatus.state}</div>
        <div>
          <span className="font-medium">Graph diag:</span>{' '}
          {latestGraphCapture
            ? `${latestGraphCapture.id} (${latestGraphCapture.summary.domOverlapCount} DOM overlaps, ${latestGraphCapture.summary.staleMeasuredHeightCount} stale heights)`
            : 'none'}
        </div>
        {exportStatus.exportPath ? (
          <div className="break-all"><span className="font-medium">Capture path:</span> {exportStatus.exportPath}</div>
        ) : null}
        {exportStatus.error ? (
          <div className="break-all text-destructive"><span className="font-medium">Export error:</span> {exportStatus.error}</div>
        ) : null}
        {logPath ? <div className="break-all"><span className="font-medium">Log file:</span> {logPath}</div> : null}
      </div>
    </div>
  );
}
