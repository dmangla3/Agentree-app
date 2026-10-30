import React, { useState, useCallback } from 'react';
import { Button } from "../../../@/components/ui/button";
import { Input } from "../../../@/components/ui/input";
import { Label } from "../../../@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../@/components/ui/popover";
import { Check, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

interface TagInputPopoverProps {
  messageId: string;
  existingTags?: string[] | null;
  onAddTags: (messageId: string, tags: string[]) => Promise<void>; // Make async
  triggerClassName?: string;
  children?: React.ReactNode; // Allow passing children for custom trigger content (icon)
}

export function TagInputPopover({
    messageId,
    existingTags = [],
    onAddTags,
    triggerClassName,
    children, // Destructure children
}: TagInputPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleAdd = useCallback(async () => {
    const tagsToAdd = inputValue
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean); // Remove empty strings

    if (tagsToAdd.length > 0) {
      setIsLoading(true);
      try {
        await onAddTags(messageId, tagsToAdd);
        setInputValue(''); // Clear input on success
        setIsOpen(false); // Close popover on success
      } catch (error) {
        console.error("Error adding tags:", error);
        // Optionally show error to user within the popover
      } finally {
        setIsLoading(false);
      }
    }
  }, [inputValue, messageId, onAddTags]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAdd();
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        {/* Use the passed children as the button content */}
        <Button
          variant="ghost"
          size="icon" // Use size="icon" for consistent padding if an icon is expected
          className={cn(
             // Default styling, can be overridden by triggerClassName
             "h-8 w-8 text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-[0.96]",
             triggerClassName
           )}
          aria-label="Add tags"
          title="Add Tags"
        >
          {children} {/* Render the children passed to the component */}
        </Button>
      </PopoverTrigger>
      {/* Add z-[60] to ensure it's above the typical z-50 of dialogs/hovercards */}
      {/* Change side to "top" */}
      <PopoverContent
        className="w-60 p-3 z-[60]" // Increased z-index
        align="end"
        side="top" // Set side to top
        sideOffset={5}
      >
        {/* Keep existing PopoverContent structure */}
        <div className="grid gap-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold leading-none tracking-[-0.01em]">Add tags</h4>
            <p className="text-xs text-muted-foreground">
              Enter tags separated by commas.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`tags-input-${messageId}`} className="sr-only">
              Tags
            </Label>
            <Input
              id={`tags-input-${messageId}`}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="idea, important"
              className="h-10 text-xs"
              disabled={isLoading}
            />
            <Button
                size="sm"
                onClick={handleAdd}
                disabled={!inputValue.trim() || isLoading}
                className="h-10 text-xs"
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Add tags
            </Button>
          </div>
           {/* Optionally display existing tags */}
           {existingTags && existingTags.length > 0 && (
             <div className="mt-2 border-t border-border/55 pt-2">
                <p className="text-xs font-medium text-muted-foreground mb-1">Existing:</p>
                <div className="flex flex-wrap gap-1">
                    {existingTags.map(tag => (
                        <span key={tag} className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                            {tag}
                        </span>
                    ))}
                </div>
             </div>
           )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
