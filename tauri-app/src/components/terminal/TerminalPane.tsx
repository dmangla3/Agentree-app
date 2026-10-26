import { useEffect, useRef } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import terminalNerdFontUrl from 'nf-droid-sans-mono/Droid Sans Mono Nerd Font Complete Mono.otf?url';
import { commands, type TerminalEvent, type TerminalSessionInfo } from '../../generated/tauri-bindings';

type TerminalExitEvent = Extract<TerminalEvent, { type: 'exit' }>;

const TERMINAL_FONT_NAME = 'Agentree Terminal Nerd Font';
const TERMINAL_FONT_FAMILY = `"${TERMINAL_FONT_NAME}", "Geist Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace`;
let terminalFontLoad: Promise<void> | null = null;

const ensureTerminalFontLoaded = (): Promise<void> => {
  if (typeof FontFace === 'undefined') return Promise.resolve();
  if (!terminalFontLoad) {
    const font = new FontFace(
      TERMINAL_FONT_NAME,
      `url("${terminalNerdFontUrl}") format("opentype")`,
      { style: 'normal', weight: '400' },
    );
    terminalFontLoad = font.load()
      .then((loadedFont) => {
        document.fonts.add(loadedFont);
      })
      .catch(() => {});
  }
  return terminalFontLoad;
};

interface TerminalPaneProps {
  tabId: string;
  repoPath: string;
  commitSha: string;
  active: boolean;
  closeRequested: boolean;
  onSessionReady: (tabId: string, session: TerminalSessionInfo) => void;
  onExit: (tabId: string, event: TerminalExitEvent) => void;
  onError: (tabId: string, message: string) => void;
  onCloseRequestFailed: (tabId: string, message: string) => void;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return window.btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const terminalTheme = () => {
  const styles = window.getComputedStyle(document.documentElement);
  const color = (token: string, fallback: string) => {
    const value = styles.getPropertyValue(token).trim();
    return value ? `hsl(${value})` : fallback;
  };
  return {
    background: color('--app-bg', '#101113'),
    foreground: color('--foreground', '#e8e8e8'),
    cursor: color('--app-accent', '#8b8cf8'),
    cursorAccent: color('--app-bg', '#101113'),
    selectionBackground: color('--app-focus', '#4f51a8'),
    black: '#1d1f21',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d7dae0',
    brightBlack: '#6b7280',
    brightRed: '#f07880',
    brightGreen: '#a8d48b',
    brightYellow: '#f0cf8c',
    brightBlue: '#75bdf2',
    brightMagenta: '#d28ce8',
    brightCyan: '#69c5d0',
    brightWhite: '#f3f4f6',
  };
};

export function TerminalPane({
  tabId,
  repoPath,
  commitSha,
  active,
  closeRequested,
  onSessionReady,
  onExit,
  onError,
  onCloseRequestFailed,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const closeRequestedRef = useRef(closeRequested);
  const exitedRef = useRef(false);
  const inputQueueRef = useRef(Promise.resolve());
  const latestAckRef = useRef(0);
  const ackTimerRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onSessionReady, onExit, onError, onCloseRequestFailed });

  callbacksRef.current = { onSessionReady, onExit, onError, onCloseRequestFailed };
  closeRequestedRef.current = closeRequested;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let resizeFrame: number | null = null;
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 12.5,
      lineHeight: 1.2,
      minimumContrastRatio: 4.5,
      scrollback: 5_000,
      screenReaderMode: true,
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndResize = () => {
      resizeFrame = null;
      if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void commands.resizeTerminalSession(sessionId, terminal.cols, terminal.rows).catch(() => {});
      }
    };
    const scheduleFit = () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(fitAndResize);
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(container);
    void ensureTerminalFontLoaded().then(() => {
      if (disposed) return;
      terminal.refresh(0, terminal.rows - 1);
      scheduleFit();
    });

    const queueInput = (bytes: Uint8Array) => {
      inputQueueRef.current = inputQueueRef.current.then(async () => {
        const sessionId = sessionIdRef.current;
        if (!sessionId || exitedRef.current) return;
        await commands.writeTerminalSession(sessionId, bytesToBase64(bytes));
      }).catch((error) => {
        if (!exitedRef.current) {
          terminal.writeln(`\r\n\x1b[31mAgentree input error: ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
        }
      });
    };
    const dataDisposable = terminal.onData((data) => queueInput(new TextEncoder().encode(data)));
    const binaryDisposable = terminal.onBinary((data) => {
      const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff);
      queueInput(bytes);
    });

    const acknowledgeLatestOutput = () => {
      ackTimerRef.current = null;
      const sessionId = sessionIdRef.current;
      const sequence = latestAckRef.current;
      if (sessionId && sequence > 0) {
        void commands.acknowledgeTerminalOutput(sessionId, sequence).catch(() => {});
      }
    };
    const queueAcknowledgement = (sequence: number) => {
      latestAckRef.current = Math.max(latestAckRef.current, sequence);
      if (ackTimerRef.current === null) {
        ackTimerRef.current = window.setTimeout(acknowledgeLatestOutput, 16);
      }
    };

    const channel = new Channel<TerminalEvent>();
    channel.onmessage = (event) => {
      if (disposed) return;
      if (event.type === 'output') {
        const bytes = base64ToBytes(event.data_base64);
        terminal.write(bytes, () => queueAcknowledgement(event.sequence));
        return;
      }
      exitedRef.current = true;
      callbacksRef.current.onExit(tabId, event);
    };

    // Deferring creation avoids spawning a throwaway shell during React StrictMode's
    // development-only setup/cleanup probe.
    const startTimer = window.setTimeout(async () => {
      scheduleFit();
      try {
        const session = await commands.createTerminalSession(
          repoPath,
          commitSha,
          terminal.cols,
          terminal.rows,
          channel,
        );
        if (disposed) {
          void commands.closeTerminalSession(session.sessionId).catch(() => {});
          return;
        }
        sessionIdRef.current = session.sessionId;
        callbacksRef.current.onSessionReady(tabId, session);
        if (latestAckRef.current > 0) acknowledgeLatestOutput();
        scheduleFit();
        terminal.focus();
        if (closeRequestedRef.current) {
          await commands.closeTerminalSession(session.sessionId);
        }
      } catch (error) {
        if (!disposed) {
          callbacksRef.current.onError(tabId, error instanceof Error ? error.message : String(error));
        }
      }
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(startTimer);
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (ackTimerRef.current !== null) window.clearTimeout(ackTimerRef.current);
      observer.disconnect();
      dataDisposable.dispose();
      binaryDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      const sessionId = sessionIdRef.current;
      if (sessionId && !exitedRef.current) {
        void commands.closeTerminalSession(sessionId).catch(() => {});
      }
    };
  }, [commitSha, repoPath, tabId]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      } catch {
        // A just-opened resizable panel can report zero dimensions for one frame.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!closeRequested || exitedRef.current) return;
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    void commands.closeTerminalSession(sessionId).catch((error) => {
      callbacksRef.current.onCloseRequestFailed(
        tabId,
        error instanceof Error ? error.message : String(error),
      );
    });
  }, [closeRequested, tabId]);

  return (
    <div
      ref={containerRef}
      className="terminal-pane h-full w-full overflow-hidden px-2 pb-2 pt-1"
      aria-label={`Terminal at commit ${commitSha.slice(0, 7)}`}
    />
  );
}
