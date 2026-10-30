import { useState, useEffect } from 'react';
import { Button } from '../../@/components/ui/button';
import { Label } from '../../@/components/ui/label';
import { Textarea } from '../../@/components/ui/textarea';
import { ExternalLink, Save, RotateCcw, Bot, Folder } from 'lucide-react';
import { Workspace } from '../stores/workspaceStore';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';

interface AgentConfigPanelProps {
    workspace: Workspace | null;
    agentName?: string;
    agentType?: string;
}

// Quick toggle presets
const PERMISSION_PRESETS = [
    { label: 'Read-Only', args: '--permission-mode readonly' },
    { label: 'Plan Mode', args: '--permission-mode plan' },
    { label: 'Full Auto', args: '--dangerously-skip-permissions' },
];

const DEFAULT_ARGS = '--permission-mode plan';

export function AgentConfigPanel({ workspace, agentName = 'Claude Code', agentType = 'claude' }: AgentConfigPanelProps) {
    const [args, setArgs] = useState<string>(workspace?.agentArgs || DEFAULT_ARGS);
    const [isDirty, setIsDirty] = useState(false);
    const queryClient = useQueryClient();

    // Sync with workspace when it changes
    useEffect(() => {
        if (workspace?.agentArgs !== undefined) {
            setArgs(workspace.agentArgs || DEFAULT_ARGS);
            setIsDirty(false);
        }
    }, [workspace?.agentArgs]);

    // Update mutation
    const updateArgs = useMutation({
        mutationFn: async (newArgs: string) => {
            if (!workspace) return;
            const response = await api.patch(`/workspaces/${workspace.id}`, { agentArgs: newArgs });
            return response.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['workspaces'] });
            setIsDirty(false);
        },
    });

    const handleSave = () => {
        updateArgs.mutate(args);
    };

    const handleReset = () => {
        setArgs(DEFAULT_ARGS);
        setIsDirty(true);
    };

    const handlePresetClick = (presetArgs: string) => {
        // Replace permission mode in current args with preset
        let newArgs = args;

        // Remove existing permission flags
        newArgs = newArgs.replace(/--permission-mode\s+\w+/g, '');
        newArgs = newArgs.replace(/--dangerously-skip-permissions/g, '');
        newArgs = newArgs.trim();

        // Add preset
        newArgs = presetArgs + (newArgs ? ' ' + newArgs : '');

        setArgs(newArgs.trim());
        setIsDirty(true);
    };

    const getDocsUrl = () => {
        if (agentType === 'claude') {
            return 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview';
        }
        return '#';
    };

    if (!workspace) {
        return (
            <div className="rounded-xl border border-border/70 bg-[hsl(var(--app-panel))] p-5 shadow-[var(--app-shadow-soft)]">
                <p className="text-pretty text-sm text-muted-foreground">Select a workspace to configure the agent.</p>
            </div>
        );
    }

    return (
        <section className="overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--app-panel-strong))] shadow-[var(--app-shadow-panel)]">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
                <div className="flex items-center gap-2">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                        <Bot className="h-5 w-5" />
                    </span>
                    <div>
                        <div className="text-sm font-medium text-foreground">{agentName}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">Agent configuration</div>
                    </div>
                </div>
            </div>

            <div className="space-y-5 p-5">
                {/* CLI Arguments */}
                <div className="space-y-2">
                    <Label htmlFor="cli-args" className="text-xs font-medium">
                        CLI arguments
                    </Label>
                    <Textarea
                        id="cli-args"
                        value={args}
                        onChange={(e) => {
                            setArgs(e.target.value);
                            setIsDirty(true);
                        }}
                        placeholder="--model sonnet --permission-mode plan --max-turns 20"
                        className="min-h-24 rounded-lg font-mono text-xs leading-5 transition-[border-color,box-shadow] duration-150"
                    />
                </div>

                {/* Quick Toggles */}
                <div className="space-y-2">
                    <span className="text-xs font-medium text-muted-foreground">Permission preset</span>
                    <div className="flex flex-wrap items-center gap-2">
                        {PERMISSION_PRESETS.map((preset) => (
                            <Button
                                key={preset.label}
                                variant={args.includes(preset.args.split(' ')[0]) ? 'secondary' : 'outline'}
                                size="sm"
                                onClick={() => handlePresetClick(preset.args)}
                                className="h-10 rounded-lg px-3 text-xs"
                            >
                                {preset.label}
                            </Button>
                        ))}
                    </div>
                </div>

                {/* Workspace */}
                {workspace.folderPath && (
                    <div className="flex min-h-10 items-center gap-2 rounded-lg bg-muted/35 px-3 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)]">
                        <Folder className="h-4 w-4 shrink-0" />
                        <span className="truncate font-mono text-xs">{workspace.folderPath}</span>
                    </div>
                )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-5 py-4">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(getDocsUrl(), '_blank')}
                    className="h-10 rounded-lg"
                >
                    <ExternalLink className="h-4 w-4" />
                    Docs
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleReset}
                    className="h-10 rounded-lg"
                >
                    <RotateCcw className="h-4 w-4" />
                    Reset
                </Button>
                <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={!isDirty || updateArgs.isPending}
                    className="h-10 rounded-lg"
                >
                    <Save className="h-4 w-4" />
                    {updateArgs.isPending ? 'Saving...' : 'Save'}
                </Button>
            </div>
        </section>
    );
}
