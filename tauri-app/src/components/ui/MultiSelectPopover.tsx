
import React, { useState, useMemo } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../../@/components/ui/popover';
import { Button } from '../../../@/components/ui/button';
import { Input } from '../../../@/components/ui/input';
import { Badge } from '../../../@/components/ui/badge';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import { X, ChevronDown } from 'lucide-react';

interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectPopoverProps {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  triggerLabel: string;
}

export const MultiSelectPopover: React.FC<MultiSelectPopoverProps> = ({
  options,
  selected,
  onChange,
  placeholder = 'Search...',
  triggerLabel,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const filteredOptions = useMemo(() => {
    return options.filter(option =>
      option.label.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [options, searchTerm]);

  const handleToggle = (value: string) => {
    const newSelected = selected.includes(value)
      ? selected.filter(item => item !== value)
      : [...selected, value];
    onChange(newSelected);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between">
          <span>{triggerLabel}</span>
          <ChevronDown className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] overflow-hidden p-0">
        <div className="border-b border-border/55 p-2.5">
          <Input
            placeholder={placeholder}
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
        <ScrollArea style={{ height: '200px' }}>
          <div className="space-y-1 p-2">
            {filteredOptions.map(option => (
              <button
                type="button"
                key={option.value}
                className="flex min-h-10 w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition-[background-color,transform] duration-150 hover:bg-muted active:scale-[0.98]"
                onClick={() => handleToggle(option.value)}
                aria-pressed={selected.includes(option.value)}
              >
                <span>{option.label}</span>
                {selected.includes(option.value) && (
                  <Badge variant="secondary">Selected</Badge>
                )}
              </button>
            ))}
          </div>
        </ScrollArea>
        {selected.length > 0 && (
          <div className="border-t border-border/55 p-2.5">
            <div className="flex flex-wrap gap-1">
              {selected.map(value => {
                const option = options.find(opt => opt.value === value);
                return (
                  <Badge key={value} variant="secondary">
                    {option?.label}
                    <button
                      type="button"
                      className="ml-1 rounded-full transition-[background-color,transform] duration-150 hover:bg-foreground/10 active:scale-[0.96]"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleToggle(value);
                      }}
                      aria-label={`Remove ${option?.label ?? value}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
