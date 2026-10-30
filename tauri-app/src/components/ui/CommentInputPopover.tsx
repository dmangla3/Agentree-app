import React, { useState, useCallback } from 'react';
import { Button } from "../../../@/components/ui/button";
import { Textarea } from "../../../@/components/ui/textarea";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "../../../@/components/ui/popover";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "../../../@/components/ui/dropdown-menu";
import { MessageSquarePlus, Loader2, ArrowRightLeft, LogOut, Lightbulb, StickyNote, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

interface CommentInputPopoverProps {
    messageId: string;
    workspaceId: string;
    onAddComment: (params: {
        workspaceId: string;
        messageId: string;
        type: string;
        content: string;
    }) => Promise<void>;
    triggerClassName?: string;
    children?: React.ReactNode;
}

const COMMENT_TYPES = [
    { value: 'transition_reason', label: 'Transition reason', icon: ArrowRightLeft, description: 'Why this branch was chosen' },
    { value: 'exit_reason', label: 'Exit reason', icon: LogOut, description: 'Why this path was stopped' },
    { value: 'scout_summary', label: 'Scout summary', icon: MessageSquarePlus, description: "What's available down this path" },
    { value: 'insight', label: 'Insight', icon: Lightbulb, description: 'Key observation or discovery' },
    { value: 'note', label: 'General note', icon: StickyNote, description: 'Context or a reminder' },
];

export function CommentInputPopover({
    messageId,
    workspaceId,
    onAddComment,
    triggerClassName,
    children,
}: CommentInputPopoverProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [commentType, setCommentType] = useState('note');
    const [contentValue, setContentValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleAdd = useCallback(async () => {
        if (!contentValue.trim() || !commentType) return;

        setIsLoading(true);
        try {
            await onAddComment({
                workspaceId,
                messageId,
                type: commentType,
                content: contentValue.trim(),
            });
            setContentValue('');
            setCommentType('note');
            setIsOpen(false);
        } catch (error) {
            console.error("Error adding comment:", error);
        } finally {
            setIsLoading(false);
        }
    }, [contentValue, commentType, messageId, workspaceId, onAddComment]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Stop propagation to prevent parent elements from intercepting keys
        event.stopPropagation();
        if (event.key === 'Enter' && event.metaKey) {
            event.preventDefault();
            handleAdd();
        }
    };

    const handleSelectType = (value: string) => {
        setCommentType(value);
        setDropdownOpen(false);
    };

    const selectedType = COMMENT_TYPES.find(t => t.value === commentType) || COMMENT_TYPES[4];
    const SelectedIcon = selectedType.icon;

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                        "h-8 w-8 text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-[0.96]",
                        triggerClassName
                    )}
                    aria-label="Add context note"
                    title="Add context note"
                >
                    {children || <MessageSquarePlus size={14} />}
                </Button>
            </PopoverTrigger>
            <PopoverContent
                className="w-80 p-0 z-[60] overflow-hidden"
                align="end"
                side="top"
                sideOffset={5}
                onPointerDownOutside={(e) => {
                    // Prevent popover from closing when clicking inside dropdown
                    if (dropdownOpen) {
                        e.preventDefault();
                    }
                }}
                onInteractOutside={(e) => {
                    // Prevent popover from closing when interacting with dropdown
                    if (dropdownOpen) {
                        e.preventDefault();
                    }
                }}
            >
                {/* Header */}
                <div className="border-b border-border/60 bg-muted/36 px-4 py-3">
                    <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-md bg-primary/10">
                            <MessageSquarePlus size={14} className="text-primary" />
                        </div>
                        <div>
                            <h4 className="text-sm font-semibold tracking-[-0.01em]">Context note</h4>
                            <p className="text-[10px] text-muted-foreground">
                                Help agents understand this branch.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="p-4 space-y-3">
                    {/* Comment Type Selector */}
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">
                            Note type
                        </label>
                        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen} modal={false}>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    className="h-10 w-full justify-between text-xs font-normal"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                    }}
                                >
                                    <div className="flex items-center gap-2">
                                        <SelectedIcon size={12} className="text-primary" />
                                        <span>{selectedType.label}</span>
                                    </div>
                                    <ChevronDown size={12} className="text-muted-foreground" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                className="w-[calc(var(--radix-dropdown-menu-trigger-width))] z-[80]"
                                align="start"
                                onCloseAutoFocus={(e) => e.preventDefault()}
                            >
                                {COMMENT_TYPES.map((type) => (
                                    <DropdownMenuItem
                                        key={type.value}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleSelectType(type.value);
                                        }}
                                        className="py-2 cursor-pointer"
                                    >
                                        <div className="flex items-center gap-2">
                                            <type.icon size={14} className="text-primary/70" />
                                            <div>
                                                <div className="text-xs font-medium">{type.label}</div>
                                                <div className="text-[10px] text-muted-foreground">{type.description}</div>
                                            </div>
                                        </div>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>

                    {/* Content Input */}
                    <div className="space-y-1.5">
                        <label htmlFor={`comment-content-${messageId}`} className="text-xs font-medium text-muted-foreground">
                            Content
                        </label>
                        <Textarea
                            id={`comment-content-${messageId}`}
                            value={contentValue}
                            onChange={(e) => setContentValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={selectedType.description || "Add your note..."}
                            className="min-h-[80px] resize-none text-xs focus-visible:ring-primary/30"
                            disabled={isLoading}
                        />
                        <p className="text-[10px] text-muted-foreground text-right">
                            ⌘ + Enter to save
                        </p>
                    </div>

                    <Button
                        onClick={handleAdd}
                        disabled={!contentValue.trim() || isLoading}
                        className="h-10 w-full text-xs font-medium"
                    >
                        {isLoading ? (
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <MessageSquarePlus className="mr-2 h-3.5 w-3.5" />
                        )}
                        Add note
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
