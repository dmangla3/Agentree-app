import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, X, Filter, Clock, Tag, User, Bot, Code, Bookmark, ExternalLink, ArrowLeft, Trash2, Brain, FileText, GitBranch, SlidersHorizontal, ChevronDown } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { Input } from '../../@/components/ui/input';
import { Badge } from '../../@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../@/components/ui/card';
import { ScrollArea } from '../../@/components/ui/scroll-area';
import { Toggle } from '../../@/components/ui/toggle';
import { useModels } from '../hooks/useModels';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { MultiSelectPopover } from './ui/MultiSelectPopover';
import { useWorkspaceStore, Workspace, Message } from '../stores/workspaceStore';
import { RuntimeCatalogModel } from '../stores/modelStore';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

interface SearchResult {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  llmModel?: string;
  llmProvider?: string;
  tags?: string[];
  createdAt: string;
  workspaceId: string;
  workspaceName?: string;
  aiLabel?: string;
  similarity?: number;
  relevance?: number;
  searchType?: 'semantic' | 'text' | 'hybrid';
}

interface SearchFilters {
  contentTypes: string[];
  dateRange?: {
    start?: string;
    end?: string;
  };
  models: string[];
  tags: string[];
  tokenRange?: {
    min?: number;
    max?: number;
  };
  workspaceId?: string;
}

interface AdvancedOptions {
  includeContext: boolean;
  fuzzyMatching: boolean;
  caseSensitive: boolean;
  relevanceThreshold: number;
}

interface AdvancedSearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToMessage?: (messageId: string, workspaceId: string) => void;
}

// Segmented control component for cleaner toggle groups
const SegmentedControl = <T extends string>({
  value,
  onChange,
  options,
  size = 'md'
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode; disabled?: boolean }[];
  size?: 'sm' | 'md';
}) => (
  <div className={cn(
    "inline-flex bg-muted/60 rounded-lg p-1 gap-0.5",
    size === 'sm' ? 'p-0.5' : 'p-1'
  )}>
    {options.map((option) => (
      <button
        key={option.value}
        onClick={() => !option.disabled && onChange(option.value)}
        disabled={option.disabled}
        className={cn(
          "relative flex items-center gap-1.5 font-medium transition-all duration-200",
          "rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
          value === option.value
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
          option.disabled && "opacity-40 cursor-not-allowed hover:text-muted-foreground hover:bg-transparent"
        )}
      >
        {option.icon && <span className="opacity-80">{option.icon}</span>}
        {option.label}
      </button>
    ))}
  </div>
);

// Filter chip component for content type toggles
const FilterChip = ({
  pressed,
  onPressedChange,
  icon,
  label
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  icon: React.ReactNode;
  label: string;
}) => (
  <Toggle
    pressed={pressed}
    onPressedChange={onPressedChange}
    className={cn(
      "h-auto px-3 py-2 rounded-lg border transition-all duration-200",
      "data-[state=on]:bg-primary/10 data-[state=on]:border-primary/30 data-[state=on]:text-primary",
      "data-[state=off]:bg-card data-[state=off]:border-border data-[state=off]:hover:border-muted-foreground/30",
      "flex flex-col items-center gap-1.5 min-w-[90px]"
    )}
  >
    <span className={cn(
      "p-1.5 rounded-md transition-colors",
      pressed ? "bg-primary/20" : "bg-muted"
    )}>
      {icon}
    </span>
    <span className="text-xs font-medium">{label}</span>
  </Toggle>
);

export const AdvancedSearchPanel: React.FC<AdvancedSearchPanelProps> = ({
  isOpen,
  onClose,
  onNavigateToMessage
}) => {
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<'semantic' | 'text' | 'hybrid'>('hybrid');
  const [scope, setScope] = useState<'all' | 'current_workspace' | 'current_branch'>('all');
  const [filters, setFilters] = useState<SearchFilters>({
    contentTypes: [],
    models: [],
    tags: []
  });
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [savedSearches, setSavedSearches] = useState<string[]>(() => {
    const saved = localStorage.getItem('savedSearches');
    return saved ? JSON.parse(saved) : [];
  });

  useEffect(() => {
    localStorage.setItem('savedSearches', JSON.stringify(savedSearches));
  }, [savedSearches]);
  const [viewMode, setViewMode] = useState<'search' | 'results'>('search');
  const [advancedOptions, setAdvancedOptions] = useState<AdvancedOptions>({
    includeContext: false,
    fuzzyMatching: false,
    caseSensitive: false,
    relevanceThreshold: 0.5,
  });

  const searchInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const selectedWorkspaceId = useWorkspaceStore(state => state.selectedWorkspaceId);
  const { data: allModelsData } = useModels();
  const allModels = useMemo(() => allModelsData ?? [], [allModelsData]);
  const { data: workspacesData } = useWorkspaces();
  const workspaces = useMemo(() => workspacesData ?? [], [workspacesData]);

  const modelOptions = useMemo(() =>
    allModels.map((model: RuntimeCatalogModel) => ({ value: model.id, label: model.name })),
    [allModels]
  );

  const tagOptions = useMemo(() => {
    const allTags = new Set<string>();
    workspaces.forEach((convo: Workspace) => {
      convo.messages?.forEach((msg: Message) => {
        msg.tags?.forEach((tag: string) => allTags.add(tag));
      });
    });
    return Array.from(allTags).map((tag: string) => ({ value: tag, label: tag }));
  }, [workspaces]);

  const currentWorkspace = workspaces.find(
    (c: Workspace) => c.id === selectedWorkspaceId
  );

  // Focus search input when panel opens and reset view mode
  useEffect(() => {
    if (isOpen) {
      setViewMode('search');
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
    }
  }, [isOpen]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Get search suggestions
  const getSuggestions = useCallback(async (searchQuery: string) => {
    if (searchQuery.length < 2) {
      setSuggestions([]);
      return;
    }

    try {
      const response = await api.get('/search/suggestions', {
        params: { q: searchQuery },
      });
      setSuggestions(response.data.suggestions || []);
    } catch (error) {
      console.error('Error fetching suggestions:', error);
    }
  }, []);

  // Debounced suggestions
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query) {
        getSuggestions(query);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, getSuggestions]);

  // Click outside to hide suggestions
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(event.target as Node)
      ) {
        setSuggestions([]);
      }
    };

    if (suggestions.length > 0) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [suggestions.length]);

  // Perform search
  const performSearch = useCallback(async () => {
    if (!query.trim()) return;

    setIsSearching(true);
    setViewMode('results');
    try {
      const searchFilters = { ...filters };

      if (scope === 'current_workspace' && currentWorkspace?.id) {
        searchFilters.workspaceId = currentWorkspace.id;
      }

      const response = await api.post('/search', {
        query,
        searchType,
        scope,
        filters: searchFilters,
        advancedOptions,
        limit: 50
      });
      setResults(response.data.results || []);
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [query, searchType, scope, filters, currentWorkspace?.id, advancedOptions]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    performSearch();
  };

  const handleSaveSearch = () => {
    const searchToSave = JSON.stringify({ query, filters, scope, advancedOptions });
    if (!savedSearches.includes(searchToSave)) {
      setSavedSearches(prev => [...prev, searchToSave]);
    }
  };

  const handleLoadSearch = (searchToLoad: string) => {
    const { query, filters, scope, advancedOptions } = JSON.parse(searchToLoad);
    setQuery(query);
    setFilters(filters);
    setScope(scope);
    setAdvancedOptions(advancedOptions);
  };

  const handleDeleteSearch = (searchToDelete: string) => {
    setSavedSearches(prev => prev.filter(s => s !== searchToDelete));
  };

  const handleSuggestionClick = (suggestion: string) => {
    setQuery(suggestion);
    setSuggestions([]);
    performSearch();
  };

  const updateFilters = (key: keyof SearchFilters, value: SearchFilters[keyof SearchFilters]) => {
    setFilters(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const truncateContent = (content: string, maxLength: number = 200) => {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  };

  const highlightSearchTerms = (content: string, searchQuery: string) => {
    if (!searchQuery) return content;

    const terms = searchQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    let highlighted = content;

    terms.forEach(term => {
      try {
        const regex = new RegExp(`(${term})`, 'gi');
        highlighted = highlighted.replace(regex, '<mark class="bg-primary/20 text-primary dark:bg-primary/30 rounded px-0.5 font-medium">$1</mark>');
      } catch (e) {
        console.error("Error creating regex for highlighting:", e);
      }
    });

    return highlighted;
  };

  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (filters.contentTypes.length) count++;
    if (filters.models.length) count++;
    if (filters.tags.length) count++;
    if (filters.dateRange?.start || filters.dateRange?.end) count++;
    if (filters.tokenRange?.min || filters.tokenRange?.max) count++;
    return count;
  }, [filters]);

  if (!isOpen) return null;

  const renderSearchForm = () => (
    <CardHeader className="pb-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2.5 text-xl">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Search className="h-5 w-5 text-primary" />
          </div>
          Advanced Search
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full h-8 w-8">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <form onSubmit={handleSearch} className="space-y-6">
        {/* Search Input - Large and prominent */}
        <div className="relative">
          <div className={cn(
            "relative flex items-center rounded-xl border bg-card transition-all duration-200",
            "focus-within:border-primary/50 focus-within:ring-4 focus-within:ring-primary/10 focus-within:shadow-lg"
          )}>
            <Search className="absolute left-4 h-5 w-5 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces with natural language..."
              className="border-0 bg-transparent text-lg pl-12 pr-32 py-4 h-auto focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/60"
            />
            <div className="absolute right-2 flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleSaveSearch}
                disabled={!query.trim()}
                className="h-9 px-2.5 text-muted-foreground hover:text-foreground"
              >
                <Bookmark className="h-4 w-4" />
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={isSearching || !query.trim()}
                className="h-9 px-4 gap-2"
              >
                {isSearching ? (
                  <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                Search
              </Button>
            </div>
          </div>

          {/* Suggestions dropdown */}
          {suggestions.length > 0 && (
            <div
              ref={suggestionsRef}
              className="absolute top-full left-0 right-0 mt-2 bg-popover border rounded-xl shadow-xl z-10 overflow-hidden"
            >
              {suggestions.map((suggestion, index) => (
                <button
                  key={index}
                  type="button"
                  className="w-full text-left px-4 py-3 hover:bg-muted transition-colors text-sm flex items-center gap-3"
                  onClick={() => handleSuggestionClick(suggestion)}
                >
                  <Search className="h-4 w-4 text-muted-foreground" />
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Controls Row */}
        <div className="flex flex-wrap items-center gap-6">
          {/* Search Type */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">Search</span>
            <SegmentedControl
              value={searchType}
              onChange={(v) => setSearchType(v)}
              options={[
                { value: 'semantic', label: 'Semantic' },
                { value: 'text', label: 'Text' },
                { value: 'hybrid', label: 'Hybrid' },
              ]}
              size="sm"
            />
          </div>

          {/* Divider */}
          <div className="h-6 w-px bg-border hidden sm:block" />

          {/* Search location */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">Search in</span>
            <SegmentedControl
              value={scope}
              onChange={(v) => setScope(v)}
              options={[
                { value: 'all', label: 'All', icon: <Search className="h-3.5 w-3.5" /> },
                { value: 'current_workspace', label: 'Current', icon: <FileText className="h-3.5 w-3.5" />, disabled: !currentWorkspace },
                { value: 'current_branch', label: 'Branch', icon: <GitBranch className="h-3.5 w-3.5" /> },
              ]}
              size="sm"
            />
          </div>

          {/* Filters Toggle */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              "gap-2 ml-auto",
              showFilters && "bg-accent text-accent-foreground",
              activeFiltersCount > 0 && "border-primary/50 text-primary"
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {activeFiltersCount > 0 && (
              <Badge variant="default" className="h-5 min-w-5 px-1.5 text-[10px]">
                {activeFiltersCount}
              </Badge>
            )}
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showFilters && "rotate-180")} />
          </Button>
        </div>

        {/* Filters Panel */}
        {showFilters && (
          <div className="rounded-xl border bg-muted/30 p-5 space-y-5 animate-in slide-in-from-top-2 duration-200">
            {/* Content Types */}
            <div>
              <label className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Filter className="h-4 w-4 text-muted-foreground" />
                Content Types
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'user', label: 'User', icon: <User className="h-4 w-4" /> },
                  { id: 'assistant', label: 'Assistant', icon: <Bot className="h-4 w-4" /> },
                  { id: 'code', label: 'Code', icon: <Code className="h-4 w-4" /> },
                ].map((type) => (
                  <FilterChip
                    key={type.id}
                    pressed={filters.contentTypes.includes(type.id)}
                    onPressedChange={(pressed) => {
                      const newTypes = pressed
                        ? [...filters.contentTypes, type.id]
                        : filters.contentTypes.filter((t) => t !== type.id);
                      updateFilters('contentTypes', newTypes);
                    }}
                    icon={type.icon}
                    label={type.label}
                  />
                ))}
              </div>
            </div>

            {/* Grid for other filters */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2">
              {/* Date Range */}
              <div className="space-y-2">
                <label className="text-sm font-semibold flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  Date Range
                </label>
                <div className="flex gap-2">
                  <Input
                    type="date"
                    value={filters.dateRange?.start || ''}
                    onChange={(e) => updateFilters('dateRange', { ...filters.dateRange, start: e.target.value })}
                    className="flex-1 text-sm bg-background"
                  />
                  <span className="text-muted-foreground self-center">→</span>
                  <Input
                    type="date"
                    value={filters.dateRange?.end || ''}
                    onChange={(e) => updateFilters('dateRange', { ...filters.dateRange, end: e.target.value })}
                    className="flex-1 text-sm bg-background"
                  />
                </div>
              </div>

              {/* Token Range */}
              <div className="space-y-2">
                <label className="text-sm font-semibold">Token Range</label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder="Min"
                    value={filters.tokenRange?.min || ''}
                    onChange={(e) => updateFilters('tokenRange', { ...filters.tokenRange, min: e.target.value ? parseInt(e.target.value) : undefined })}
                    className="flex-1 text-sm bg-background"
                  />
                  <span className="text-muted-foreground self-center">→</span>
                  <Input
                    type="number"
                    placeholder="Max"
                    value={filters.tokenRange?.max || ''}
                    onChange={(e) => updateFilters('tokenRange', { ...filters.tokenRange, max: e.target.value ? parseInt(e.target.value) : undefined })}
                    className="flex-1 text-sm bg-background"
                  />
                </div>
              </div>

              {/* Models */}
              <div className="space-y-2">
                <label className="text-sm font-semibold">Models</label>
                <MultiSelectPopover
                  options={modelOptions}
                  selected={filters.models}
                  onChange={(selected: string[]) => updateFilters('models', selected)}
                  triggerLabel={filters.models.length ? `${filters.models.length} selected` : "Select models"}
                  placeholder="Search models..."
                />
              </div>

              {/* Tags */}
              <div className="space-y-2">
                <label className="text-sm font-semibold flex items-center gap-2">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  Tags
                </label>
                <MultiSelectPopover
                  options={tagOptions}
                  selected={filters.tags}
                  onChange={(selected: string[]) => updateFilters('tags', selected)}
                  triggerLabel={filters.tags.length ? `${filters.tags.length} selected` : "Select tags"}
                  placeholder="Search tags..."
                />
              </div>
            </div>

            {/* Advanced Options */}
            <div className="pt-3 border-t border-border/50">
              <label className="text-sm font-semibold mb-3 block">Advanced Options</label>
              <div className="flex flex-wrap gap-3">
                {[
                  { key: 'includeContext', label: 'Include Context', description: '±2 messages' },
                  { key: 'fuzzyMatching', label: 'Fuzzy Matching' },
                  { key: 'caseSensitive', label: 'Case Sensitive' },
                ].map((opt) => (
                  <Toggle
                    key={opt.key}
                    pressed={advancedOptions[opt.key as keyof AdvancedOptions] as boolean}
                    onPressedChange={(pressed) =>
                      setAdvancedOptions(prev => ({ ...prev, [opt.key]: pressed }))
                    }
                    className={cn(
                      "h-auto px-3 py-2 rounded-lg border text-sm transition-all",
                      "data-[state=on]:bg-primary/10 data-[state=on]:border-primary/30 data-[state=on]:text-primary",
                      "data-[state=off]:bg-background data-[state=off]:border-border"
                    )}
                  >
                    {opt.label}
                    {'description' in opt && (
                      <span className="text-xs text-muted-foreground ml-1">({opt.description})</span>
                    )}
                  </Toggle>
                ))}
              </div>

              {/* Relevance Threshold */}
              <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border/30">
                <span className="text-sm font-medium min-w-[120px]">Relevance Threshold</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={advancedOptions.relevanceThreshold}
                  onChange={(e) => setAdvancedOptions(prev => ({ ...prev, relevanceThreshold: parseFloat(e.target.value) }))}
                  className="flex-1 h-1.5 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
                />
                <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded min-w-[40px] text-center">
                  {Math.round(advancedOptions.relevanceThreshold * 100)}%
                </span>
              </div>
            </div>

            {/* Clear Filters */}
            {activeFiltersCount > 0 && (
              <div className="flex justify-end pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFilters({ contentTypes: [], models: [], tags: [] });
                    setAdvancedOptions(prev => ({ ...prev, includeContext: false, fuzzyMatching: false, caseSensitive: false }));
                  }}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-2"
                >
                  <Trash2 className="h-4 w-4" />
                  Clear all filters
                </Button>
              </div>
            )}
          </div>
        )}
      </form>
    </CardHeader>
  );

  const renderResults = () => (
    <>
      <CardHeader className="pb-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setViewMode('search')}
              className="gap-2 rounded-full px-4"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <div className="h-4 w-px bg-border" />
            <span className="text-sm text-muted-foreground">
              {isSearching ? (
                <span className="flex items-center gap-2">
                  <div className="h-3.5 w-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  Searching for "{query}"...
                </span>
              ) : (
                <>
                  <span className="font-semibold text-foreground">{results.length}</span>
                  {" "}results for "{query}"
                </>
              )}
            </span>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <ScrollArea className="h-[calc(80vh-120px)] px-6 pb-6">
          {isSearching ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-4">
                <div className="h-10 w-10 border-3 border-primary border-t-transparent rounded-full animate-spin" />
                <span className="text-muted-foreground">Searching...</span>
              </div>
            </div>
          ) : results.length > 0 ? (
            <div className="space-y-3">
              {results.map((result: SearchResult, index: number) => (
                <Card
                  key={result.id}
                  className={cn(
                    "group p-4 rounded-xl border transition-all duration-200",
                    "hover:border-primary/30 hover:shadow-md hover:bg-muted/30",
                    "cursor-pointer"
                  )}
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        {/* Role Badge */}
                        <div className={cn(
                          "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold",
                          result.role === 'user'
                            ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                            : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        )}>
                          {result.role === 'user' ? (
                            <User className="h-3.5 w-3.5" />
                          ) : (
                            <Bot className="h-3.5 w-3.5" />
                          )}
                          {result.role === 'user' ? 'User' : 'Assistant'}
                        </div>

                        {/* Model Badge */}
                        {result.llmModel && (
                          <Badge variant="outline" className="rounded-full text-xs font-normal bg-background">
                            {result.llmModel}
                          </Badge>
                        )}

                        {/* Match Score */}
                        {(result.relevance || result.similarity) && (
                          <Badge
                            variant="default"
                            className={cn(
                              "rounded-full text-xs",
                              (result.relevance || result.similarity || 0) > 0.8
                                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                                : (result.relevance || result.similarity || 0) > 0.5
                                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
                                  : "bg-muted text-muted-foreground"
                            )}
                          >
                            {Math.round((result.relevance || result.similarity || 0) * 100)}% match
                          </Badge>
                        )}
                      </div>

                      {/* Date */}
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
                        <Clock className="h-3.5 w-3.5" />
                        {formatDate(result.createdAt)}
                      </div>
                    </div>

                    {/* Content */}
                    <div
                      className="text-sm leading-relaxed text-foreground/90 line-clamp-3"
                      dangerouslySetInnerHTML={{ __html: highlightSearchTerms(truncateContent(result.content), query) }}
                    />

                    {/* Footer */}
                    <div className="flex items-center justify-between pt-1">
                      <div className="flex items-center gap-2">
                        {/* Tags */}
                        {result.tags && result.tags.length > 0 && (
                          <div className="flex items-center gap-1">
                            {result.tags.slice(0, 3).map((tag: string) => (
                              <Badge
                                key={tag}
                                variant="secondary"
                                className="rounded-full text-[10px] px-2 py-0.5 font-normal"
                              >
                                {tag}
                              </Badge>
                            ))}
                            {result.tags.length > 3 && (
                              <Badge variant="secondary" className="rounded-full text-[10px] px-2 py-0.5 font-normal">
                                +{result.tags.length - 3}
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        {/* Workspace Name */}
                        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {result.workspaceName || 'Untitled'}
                        </span>

                        {/* View Button */}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onNavigateToMessage?.(result.id, result.workspaceId)}
                          className="h-7 px-2.5 text-xs gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-primary/10 hover:text-primary"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          View
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="p-4 bg-muted/50 rounded-full mb-4">
                <Search className="h-8 w-8 text-muted-foreground/60" />
              </div>
              <p className="text-lg font-medium text-foreground mb-1">No results found</p>
              <p className="text-sm text-muted-foreground max-w-sm">
                We couldn&apos;t find any matches for &quot;{query}&quot;. Try adjusting your search terms or filters.
              </p>
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-start justify-center pt-16 animate-in fade-in duration-200">
      <Card className="w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col shadow-2xl border-border/50 animate-in zoom-in-95 slide-in-from-top-4 duration-300">
        {viewMode === 'search' && renderSearchForm()}
        {viewMode === 'results' && renderResults()}
        {viewMode === 'search' && !showFilters && (
          <CardContent className="flex-1 pt-0">
            {/* Saved Searches */}
            {savedSearches.length > 0 && (
              <div className="py-4 border-t border-border/50">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  Saved Searches
                </h3>
                <div className="flex flex-wrap gap-2">
                  {savedSearches.map((search: string, index: number) => {
                    const parsed = JSON.parse(search);
                    return (
                      <Badge
                        key={index}
                        variant="outline"
                        className="group cursor-pointer rounded-full px-3 py-1.5 hover:border-primary/50 hover:bg-primary/5 transition-colors"
                      >
                        <span onClick={() => handleLoadSearch(search)} className="flex items-center gap-2">
                          <Bookmark className="h-3 w-3 text-muted-foreground" />
                          {parsed.query}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSearch(search);
                          }}
                          className="ml-2 p-0.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Empty State */}
            {savedSearches.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="p-4 bg-primary/5 rounded-2xl mb-4">
                  <Brain className="h-8 w-8 text-primary/60" />
                </div>
                <p className="text-sm font-medium text-foreground mb-1">Start searching</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Enter a query above to search across your workspaces using semantic or text-based search.
                </p>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
};

export default AdvancedSearchPanel;
