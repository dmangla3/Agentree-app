import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AlertTriangle,
  Keyboard,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import { hasNonModifierKey, normalizeHotkeyFromEvent, normalizeRegisterableHotkey } from '@tanstack/react-hotkeys';
import type { RegisterableHotkey } from '@tanstack/react-hotkeys';
import { Button } from '../../@/components/ui/button';
import {
  getDefaultShortcutDisplayLabels,
  getEffectiveShortcutHotkeys,
  getShortcutDisplayLabels,
  getShortcutOverridesSnapshot,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  setShortcutOverride,
  SHORTCUTS,
  subscribeShortcutOverrides,
  type ShortcutDefinition,
  type ShortcutId,
} from '../hotkeys/shortcutRegistry';
import { cn } from '../lib/utils';

const scopeLabels = {
  global: 'Global',
  search: 'Search',
  graph: 'Graph',
  integration: 'Integration',
} as const;

const shortcutEntries = Object.entries(SHORTCUTS) as Array<[ShortcutId, ShortcutDefinition]>;

function shortcutConflictLabel(id: ShortcutId, hotkey: string): string | null {
  const normalized = normalizeRegisterableHotkey(hotkey as RegisterableHotkey);
  const conflict = shortcutEntries.find(([otherId]) => (
    otherId !== id &&
    getEffectiveShortcutHotkeys(otherId).some((candidate) => (
      normalizeRegisterableHotkey(candidate) === normalized
    ))
  ));

  return conflict ? conflict[1].label : null;
}

export function ShortcutSettingsPanel() {
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const overrides = useSyncExternalStore(
    subscribeShortcutOverrides,
    getShortcutOverridesSnapshot,
    getShortcutOverridesSnapshot,
  );

  useEffect(() => {
    if (!recordingId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const hotkey = normalizeHotkeyFromEvent(event);
      if (!hasNonModifierKey(hotkey)) return;

      setShortcutOverride(recordingId, hotkey);
      setRecordingId(null);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [recordingId]);

  const groupedShortcuts = useMemo(() => {
    const groups = new Map<ShortcutDefinition['scope'], Array<[ShortcutId, ShortcutDefinition]>>();
    for (const entry of shortcutEntries) {
      const scope = entry[1].scope;
      groups.set(scope, [...(groups.get(scope) ?? []), entry]);
    }
    return Array.from(groups.entries());
  }, []);

  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className="border-b border-border/70 px-5 py-3.5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Keyboard size={17} className="text-muted-foreground" />
              <h2 className="text-base font-semibold leading-6 text-foreground">Keyboard shortcuts</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Review active bindings and replace them with local overrides.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              resetAllShortcutOverrides();
              setRecordingId(null);
            }}
            disabled={overrideCount === 0}
          >
            <RotateCcw size={15} />
            Reset all
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <SlidersHorizontal size={14} className="shrink-0" />
          <span>{overrideCount} override{overrideCount === 1 ? '' : 's'} active</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-4">
        <div className="space-y-4">
          {groupedShortcuts.map(([scope, shortcuts]) => (
            <section key={scope} className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {scopeLabels[scope]}
              </div>
              <div className="overflow-hidden rounded-lg border border-border/70 bg-background shadow-[0_10px_30px_-24px_hsl(var(--foreground)/0.35)] divide-y divide-border/50">
                {shortcuts.map(([id, shortcut]) => {
                  const isRecording = recordingId === id;
                  const effective = getEffectiveShortcutHotkeys(id, overrides);
                  const override = overrides[id];
                  const conflictLabel = override
                    ? shortcutConflictLabel(id, String(override))
                    : null;

                  return (
                    <div
                      key={id}
                      className="grid items-center gap-2.5 px-3 py-2 transition-colors hover:bg-muted/25 md:grid-cols-[minmax(0,1fr)_minmax(160px,0.38fr)_auto]"
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium leading-4 text-foreground">{shortcut.label}</div>
                        <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                          {shortcut.description}
                        </div>
                        {conflictLabel ? (
                          <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium leading-4 text-amber-700 dark:text-amber-300">
                            <AlertTriangle size={13} />
                            Also used by {conflictLabel}
                          </div>
                        ) : null}
                      </div>

                      <div className="min-w-0 space-y-1">
                        <div
                          className={cn(
                            'inline-flex min-h-7 max-w-full items-center rounded-md border px-2.5 py-0.5 font-mono text-[11px] leading-4',
                            override
                              ? 'border-primary/30 bg-primary/10 text-primary'
                              : 'border-border/70 bg-muted/40 text-foreground/85'
                          )}
                          title={getShortcutDisplayLabels(effective)}
                        >
                          <span className="truncate">{getShortcutDisplayLabels(effective)}</span>
                        </div>
                        <div className="truncate text-[10px] leading-4 text-muted-foreground">
                          Default: {getDefaultShortcutDisplayLabels(id)}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 md:justify-end">
                        {isRecording ? (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 min-w-24 justify-center border-primary/35 bg-primary/10 px-2 text-xs text-primary"
                              onClick={() => setRecordingId(null)}
                            >
                              Listening
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => setRecordingId(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              onClick={() => setRecordingId(id)}
                            >
                              Change
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => resetShortcutOverride(id)}
                              disabled={!override}
                            >
                              <RotateCcw size={14} />
                              Reset
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
