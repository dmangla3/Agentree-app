import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '../../@/components/ui/dialog';
import { Button } from '../../@/components/ui/button';
import { Textarea } from '../../@/components/ui/textarea';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { Loader2, Sparkles, PenTool, FileText, Lightbulb } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from "../../@/components/ui/tabs";
import { Label } from "../../@/components/ui/label";
import { useCreateSummary, useGenerateSummary } from '../hooks/useMessages';

interface SummaryCreationDialogProps {
    isOpen: boolean;
    onClose: () => void;
    startMessageId: string | null;
    endMessageId: string | null;
}

export function SummaryCreationDialog({ isOpen, onClose, startMessageId, endMessageId }: SummaryCreationDialogProps) {
    const [content, setContent] = useState('');
    const [activeTab, setActiveTab] = useState('custom');
    const [prompt, setPrompt] = useState('');

    const selectedWorkspaceId = useWorkspaceStore(state => state.selectedWorkspaceId);

    const createSummaryMutation = useCreateSummary();
    const generateSummaryMutation = useGenerateSummary();

    const isSubmitting = createSummaryMutation.isPending;
    const isGenerating = generateSummaryMutation.isPending;

    // Templates for different summary types
    const TEMPLATES = {
        custom: '',
        insights: 'Extract key insights, decisions, and action items from this workspace.',
        executive: 'Provide a high-level executive summary of the discussion, focusing on outcomes and next steps.'
    };

    // Update prompt when tab changes
    const handleTabChange = (value: string) => {
        setActiveTab(value);
        if (value === 'custom') {
            setPrompt('');
        } else {
            setPrompt(TEMPLATES[value as keyof typeof TEMPLATES]);
        }
    };

    const handleGenerate = async () => {
        console.log("[SummaryCreationDialog] handleGenerate called", { selectedWorkspaceId, startMessageId, endMessageId, prompt });
        if (!selectedWorkspaceId || !startMessageId || !endMessageId || !prompt.trim()) {
            console.warn("[SummaryCreationDialog] Missing required fields for generation");
            return;
        }

        try {
            console.log("[SummaryCreationDialog] Calling generateSummary mutation...");
            const generatedContent = await generateSummaryMutation.mutateAsync({
                workspaceId: selectedWorkspaceId,
                startMessageId,
                endMessageId,
                prompt
            });
            console.log("[SummaryCreationDialog] generateSummary returned:", generatedContent);
            if (generatedContent) {
                setContent(generatedContent);
            } else {
                console.warn("[SummaryCreationDialog] Generated content is empty or null");
            }
        } catch (error) {
            console.error("Failed to generate summary:", error);
        }
    };

    // Reset content when dialog opens
    useEffect(() => {
        if (isOpen) {
            setContent('');
            setPrompt('');
            setActiveTab('custom');
        }
    }, [isOpen, startMessageId, endMessageId, setContent, setPrompt, setActiveTab]);

    const handleCreate = async () => {
        if (!selectedWorkspaceId || !startMessageId || !endMessageId || !content.trim()) return;

        try {
            await createSummaryMutation.mutateAsync({
                workspaceId: selectedWorkspaceId,
                startMessageId,
                endMessageId,
                content,
            });
            onClose();
        } catch (error) {
            console.error("Failed to create summary:", error);
            // Error handling is done in the store/UI
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-design-scope="panels" className="gap-0 overflow-hidden bg-[hsl(var(--app-panel-strong))] p-0 sm:max-w-[800px]">
                <div className="border-b border-border/60 px-5 py-4">
                <DialogHeader>
                    <DialogTitle>Create summary</DialogTitle>
                    <DialogDescription>
                        Summarize this workspace range as a parallel path.
                    </DialogDescription>
                </DialogHeader>
                </div>

                <div className="flex h-[400px] gap-4 px-5 py-4">
                    {/* Left Side: Tabs */}
                    <div className="w-1/3 border-r pr-4">
                        <Tabs value={activeTab} onValueChange={handleTabChange} orientation="vertical" className="flex h-full flex-col">
                            <TabsList className="flex h-auto flex-col items-stretch gap-1 rounded-xl bg-muted/30 p-1 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.55)]">
                                <TabsTrigger value="custom" className="h-10 justify-start rounded-lg transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.96] data-[state=active]:bg-background">
                                    <PenTool className="mr-2 h-4 w-4" />
                                    Custom
                                </TabsTrigger>
                                <TabsTrigger value="insights" className="h-10 justify-start rounded-lg transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.96] data-[state=active]:bg-background">
                                    <Lightbulb className="mr-2 h-4 w-4" />
                                    Extract Insights
                                </TabsTrigger>
                                <TabsTrigger value="executive" className="h-10 justify-start rounded-lg transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.96] data-[state=active]:bg-background">
                                    <FileText className="mr-2 h-4 w-4" />
                                    Executive Summary
                                </TabsTrigger>
                            </TabsList>

                            <div className="mt-auto space-y-2 pt-4">
                                <Label htmlFor="prompt" className="text-xs font-semibold text-muted-foreground">
                                    Generation prompt
                                </Label>
                                <Textarea
                                    id="prompt"
                                    placeholder="Enter instructions for the AI..."
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    className="h-32 resize-none rounded-lg text-xs leading-5"
                                />
                                <Button
                                    size="sm"
                                    className="h-10 w-full rounded-lg"
                                    onClick={handleGenerate}
                                    disabled={!prompt.trim() || isGenerating}
                                >
                                    {isGenerating ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Sparkles className="mr-2 h-3 w-3" />}
                                    Generate with AI
                                </Button>
                            </div>
                        </Tabs>
                    </div>

                    {/* Right Side: Content Editor */}
                    <div className="flex w-2/3 flex-col gap-2 pl-2">
                        <Label htmlFor="summary-content" className="text-sm font-medium">
                            Summary content
                        </Label>
                        <Textarea
                            id="summary-content"
                            placeholder="Generated summary will appear here. You can also edit it manually."
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            className="flex-1 resize-none rounded-lg font-mono text-sm leading-6"
                        />
                    </div>
                </div>

                <DialogFooter className="border-t border-border/60 bg-muted/20 px-5 py-4">
                    <Button className="h-10 rounded-lg" variant="outline" onClick={onClose} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button className="h-10 rounded-lg" onClick={handleCreate} disabled={!content.trim() || isSubmitting}>
                        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Create summary
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
