import { useState, useEffect } from 'react';
import { Button } from '../../@/components/ui/button';
import { Label } from '../../@/components/ui/label';
import { Textarea } from '../../@/components/ui/textarea';
import { ExternalLink, Save, RotateCcw, Bot } from 'lucide-react';
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
            <div className="p-4 rounded-lg border bg-muted/30">
                <p className="text-sm text-muted-foreground">Select a workspace to configure agent.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4 p-4 rounded-lg border bg-card">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Bot className="h-5 w-5 text-primary" />
                    <span className="font-medium">Agent: {agentName}</span>
                </div>
            </div>

            {/* CLI Arguments */}
            <div className="space-y-2">
                <Label htmlFor="cli-args" className="text-sm font-medium">
                    CLI Arguments
                </Label>
                <Textarea
                    id="cli-args"
                    value={args}
                    onChange={(e) => {
                        setArgs(e.target.value);
                        setIsDirty(true);
                    }}
                    placeholder="--model sonnet --permission-mode plan --max-turns 20"
                    className="font-mono text-sm min-h-[60px]"
                />
            </div>

            {/* Quick Toggles */}
            <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Quick:</span>
                {PERMISSION_PRESETS.map((preset) => (
                    <Button
                        key={preset.label}
                        variant={args.includes(preset.args.split(' ')[0]) ? 'secondary' : 'outline'}
                        size="sm"
                        onClick={() => handlePresetClick(preset.args)}
                        className="text-xs"
                    >
                        {preset.label}
                    </Button>
                ))}
            </div>

            {/* Workspace */}
            {workspace.folderPath && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>📁</span>
                    <span className="truncate font-mono text-xs">{workspace.folderPath}</span>
                </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(getDocsUrl(), '_blank')}
                >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    Docs
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleReset}
                >
                    <RotateCcw className="h-4 w-4 mr-1" />
                    Reset
                </Button>
                <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={!isDirty || updateArgs.isPending}
                >
                    <Save className="h-4 w-4 mr-1" />
                    {updateArgs.isPending ? 'Saving...' : 'Save'}
                </Button>
            </div>
        </div>
    );
}
