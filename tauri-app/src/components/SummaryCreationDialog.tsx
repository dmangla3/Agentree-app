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
            <DialogContent className="sm:max-w-[800px]">
                <DialogHeader>
                    <DialogTitle>Create Summary Node</DialogTitle>
                    <DialogDescription>
                        Summarize the selected workspace range. This will create a parallel summary path.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex gap-4 py-4 h-[400px]">
                    {/* Left Side: Tabs */}
                    <div className="w-1/3 border-r pr-4">
                        <Tabs value={activeTab} onValueChange={handleTabChange} orientation="vertical" className="h-full flex flex-col">
                            <TabsList className="flex flex-col h-auto bg-transparent p-0 gap-2 items-stretch">
                                <TabsTrigger value="custom" className="justify-start data-[state=active]:bg-accent">
                                    <PenTool className="mr-2 h-4 w-4" />
                                    Custom
                                </TabsTrigger>
                                <TabsTrigger value="insights" className="justify-start data-[state=active]:bg-accent">
                                    <Lightbulb className="mr-2 h-4 w-4" />
                                    Extract Insights
                                </TabsTrigger>
                                <TabsTrigger value="executive" className="justify-start data-[state=active]:bg-accent">
                                    <FileText className="mr-2 h-4 w-4" />
                                    Executive Summary
                                </TabsTrigger>
                            </TabsList>

                            <div className="mt-auto pt-4 space-y-2">
                                <Label htmlFor="prompt" className="text-xs font-semibold text-muted-foreground">
                                    Generation Prompt
                                </Label>
                                <Textarea
                                    id="prompt"
                                    placeholder="Enter instructions for the AI..."
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    className="h-32 resize-none text-xs"
                                />
                                <Button
                                    size="sm"
                                    className="w-full"
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
                    <div className="w-2/3 pl-2 flex flex-col gap-2">
                        <Label htmlFor="summary-content" className="text-sm font-medium">
                            Summary Content
                        </Label>
                        <Textarea
                            id="summary-content"
                            placeholder="Generated summary will appear here. You can also edit it manually."
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            className="flex-1 resize-none font-mono text-sm"
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button onClick={handleCreate} disabled={!content.trim() || isSubmitting}>
                        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Create Summary
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
