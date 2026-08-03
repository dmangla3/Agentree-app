import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FolderOpen, Import, Loader2, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react';
import { agentClient, SkillProgressEvent, SkillSummary } from '../lib/agentClient';
import { useToastHelpers } from './Toast';
import { Button } from '../../@/components/ui/button';
import { Input } from '../../@/components/ui/input';
import { Badge } from '../../@/components/ui/badge';
import { ScrollArea } from '../../@/components/ui/scroll-area';
import { Alert, AlertDescription } from '../../@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../@/components/ui/tabs';
import { cn } from '../lib/utils';

interface SkillRowProps {
    skill: SkillSummary;
    action?: React.ReactNode;
}

function SkillRow({ skill, action }: SkillRowProps) {
    return (
        <div className="rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <h3 className="truncate font-semibold">{skill.name}</h3>
                        {skill.installed && (
                            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                                Installed
                            </Badge>
                        )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <code className="rounded bg-muted px-2 py-1">{skill.id}</code>
                        <span>{skill.source}</span>
                        {skill.path && <span className="truncate">{skill.path}</span>}
                    </div>
                </div>
                {action && <div className="flex-shrink-0">{action}</div>}
            </div>
        </div>
    );
}

function isProgressVisible(progress: SkillProgressEvent) {
    return !progress.done;
}

export function SkillsPanel({ className }: { className?: string }) {
    const queryClient = useQueryClient();
    const toast = useToastHelpers();
    const [search, setSearch] = useState('');
    const [progressByOp, setProgressByOp] = useState<Record<string, SkillProgressEvent>>({});
    const deferredSearch = useDeferredValue(search);
    const searchTerm = deferredSearch.trim();
    const hasCatalogSearch = searchTerm.length >= 2;

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;

        void agentClient.onSkillProgress((event) => {
            if (disposed) return;
            setProgressByOp((current) => {
                if (event.done) {
                    const next = { ...current };
                    delete next[event.op_id];
                    return next;
                }
                return { ...current, [event.op_id]: event };
            });
        }).then((cleanup) => {
            unlisten = cleanup;
        });

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    const installedQuery = useQuery({
        queryKey: ['skills', 'installed'],
        queryFn: () => agentClient.listInstalledSkills('skills-installed'),
    });

    const catalogQuery = useQuery({
        queryKey: ['skills', 'catalog-search', searchTerm],
        queryFn: () => agentClient.searchCatalogSkills(searchTerm, `skills-search:${searchTerm}`),
        enabled: hasCatalogSearch,
    });

    const importableQuery = useQuery({
        queryKey: ['skills', 'importable'],
        queryFn: () => agentClient.listImportableSkills('skills-importable'),
    });

    const storePathQuery = useQuery({
        queryKey: ['skills', 'store-path'],
        queryFn: agentClient.getSkillStorePath,
    });

    const refreshAll = async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['skills', 'installed'] }),
            queryClient.invalidateQueries({ queryKey: ['skills', 'importable'] }),
            hasCatalogSearch
                ? queryClient.invalidateQueries({ queryKey: ['skills', 'catalog-search', searchTerm] })
                : Promise.resolve(),
            queryClient.invalidateQueries({ queryKey: ['skills', 'store-path'] }),
        ]);
    };

    const installMutation = useMutation({
        mutationFn: (skillId: string) => agentClient.installCatalogSkill(skillId, `install:${skillId}`),
        onSuccess: async (skill) => {
            toast.success('Skill installed', `${skill.name} is now available to Claude and Codex runs.`);
            await refreshAll();
        },
        onError: (error) => {
            toast.error('Install failed', error instanceof Error ? error.message : 'Could not install skill.');
        },
    });

    const importMutation = useMutation({
        mutationFn: (sourcePath: string) => agentClient.importLocalSkill(sourcePath, `import:${sourcePath}`),
        onSuccess: async (skill) => {
            toast.success('Skill imported', `${skill.name} is now available to Claude and Codex runs.`);
            await refreshAll();
        },
        onError: (error) => {
            toast.error('Import failed', error instanceof Error ? error.message : 'Could not import skill.');
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (skillId: string) => agentClient.deleteInstalledSkill(skillId, `delete:${skillId}`),
        onSuccess: async () => {
            toast.success('Skill deleted', 'The skill was removed from the Agentree store.');
            await refreshAll();
        },
        onError: (error) => {
            toast.error('Delete failed', error instanceof Error ? error.message : 'Could not delete skill.');
        },
    });

    const installedSkills = installedQuery.data ?? [];
    const catalogSkills = hasCatalogSearch ? catalogQuery.data ?? [] : [];
    const importableSkills = importableQuery.data ?? [];

    const filteredInstalled = useMemo(() => {
        const localSearch = searchTerm.toLowerCase();
        if (!localSearch) return installedSkills;
        return installedSkills.filter((skill) =>
            [skill.name, skill.id, skill.description].some((field) => field.toLowerCase().includes(localSearch))
        );
    }, [installedSkills, searchTerm]);

    const filteredImportable = useMemo(() => {
        const localSearch = searchTerm.toLowerCase();
        if (!localSearch) return importableSkills;
        return importableSkills.filter((skill) =>
            [skill.name, skill.id, skill.description, skill.source, skill.path ?? ''].some((field) =>
                field.toLowerCase().includes(localSearch)
            )
        );
    }, [importableSkills, searchTerm]);

    const activeMutationSkillId =
        installMutation.isPending
            ? installMutation.variables
            : importMutation.isPending
              ? importMutation.variables
              : deleteMutation.isPending
                ? deleteMutation.variables
                : null;
    const activeProgress = Object.values(progressByOp).filter(isProgressVisible);

    return (
        <div className={cn('flex h-full flex-col', className)}>
            <div className="border-b p-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-primary" />
                        <h2 className="text-lg font-semibold">Skills</h2>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void refreshAll()} className="gap-1">
                        <RefreshCw className="h-4 w-4" />
                        Refresh
                    </Button>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                    Installed skills live in the Agentree store and are auto-exposed to Claude and Codex on every run.
                </p>
                {storePathQuery.data && (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                        <FolderOpen className="h-3.5 w-3.5" />
                        <code>{storePathQuery.data}</code>
                    </div>
                )}
                <div className="relative mt-4">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search installed skills or the Vercel registry..."
                        className="pl-9"
                    />
                </div>
            </div>

            {activeProgress.length > 0 && (
                <div className="border-b bg-muted/30 px-4 py-3">
                    <div className="space-y-2">
                        {activeProgress.map((progress) => (
                            <div
                                key={progress.op_id}
                                className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm"
                            >
                                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                                <div className="min-w-0 flex-1">
                                    <div className="font-medium">{progress.message}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {progress.operation}
                                        {progress.skill_id ? ` • ${progress.skill_id}` : ''}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {(installedQuery.error || importableQuery.error || catalogQuery.error || storePathQuery.error) && (
                <div className="p-4">
                    <Alert variant="destructive">
                        <AlertDescription>
                            {String(
                                installedQuery.error ||
                                    importableQuery.error ||
                                    catalogQuery.error ||
                                    storePathQuery.error ||
                                    'Skills could not be loaded.'
                            )}
                        </AlertDescription>
                    </Alert>
                </div>
            )}

            <Tabs defaultValue="installed" className="flex min-h-0 flex-1 flex-col">
                <div className="border-b px-4 py-3">
                    <TabsList>
                        <TabsTrigger value="installed">Installed ({installedSkills.length})</TabsTrigger>
                        <TabsTrigger value="local">Local Sources ({importableSkills.length})</TabsTrigger>
                        <TabsTrigger value="catalog">Registry Search ({catalogSkills.length})</TabsTrigger>
                    </TabsList>
                </div>

                <TabsContent value="installed" className="mt-0 min-h-0 flex-1">
                    <ScrollArea className="h-full">
                        <div className="space-y-3 p-4">
                            {installedQuery.isLoading ? (
                                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                                    Loading installed skills...
                                </div>
                            ) : filteredInstalled.length === 0 ? (
                                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                                    {searchTerm ? 'No installed skills match your search.' : 'No skills installed yet.'}
                                </div>
                            ) : (
                                filteredInstalled.map((skill) => (
                                    <SkillRow
                                        key={skill.id}
                                        skill={skill}
                                        action={
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="gap-1"
                                                disabled={Boolean(activeMutationSkillId)}
                                                onClick={() => {
                                                    if (window.confirm(`Delete skill "${skill.name}"?`)) {
                                                        deleteMutation.mutate(skill.id);
                                                    }
                                                }}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                                {activeMutationSkillId === skill.id && deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                                            </Button>
                                        }
                                    />
                                ))
                            )}
                        </div>
                    </ScrollArea>
                </TabsContent>

                <TabsContent value="local" className="mt-0 min-h-0 flex-1">
                    <ScrollArea className="h-full">
                        <div className="space-y-3 p-4">
                            <div className="rounded-xl border bg-muted/25 p-4 text-sm text-muted-foreground">
                                Agentree scans your Claude Code and Codex skill folders, then imports selected skills into
                                the shared Agentree store.
                            </div>
                            {importableQuery.isLoading ? (
                                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                                    Scanning local skill folders...
                                </div>
                            ) : filteredImportable.length === 0 ? (
                                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                                    {searchTerm
                                        ? 'No local Claude Code or Codex skills match your search.'
                                        : 'No local Claude Code or Codex skills were found.'}
                                </div>
                            ) : (
                                filteredImportable.map((skill) => (
                                    <SkillRow
                                        key={`${skill.source}:${skill.path ?? skill.id}`}
                                        skill={skill}
                                        action={
                                            skill.installed ? (
                                                <Button variant="outline" size="sm" className="gap-1" disabled>
                                                    <CheckCircle2 className="h-4 w-4" />
                                                    Imported
                                                </Button>
                                            ) : (
                                                <Button
                                                    size="sm"
                                                    className="gap-1"
                                                    disabled={Boolean(activeMutationSkillId)}
                                                    onClick={() => skill.path && importMutation.mutate(skill.path)}
                                                >
                                                    <Import className="h-4 w-4" />
                                                    {activeMutationSkillId === skill.path && importMutation.isPending
                                                        ? 'Importing...'
                                                        : 'Import'}
                                                </Button>
                                            )
                                        }
                                    />
                                ))
                            )}
                        </div>
                    </ScrollArea>
                </TabsContent>

                <TabsContent value="catalog" className="mt-0 min-h-0 flex-1">
                    <ScrollArea className="h-full">
                        <div className="space-y-3 p-4">
                            {!hasCatalogSearch ? (
                                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                                    Type at least 2 characters to search the full Vercel skills registry.
                                </div>
                            ) : catalogQuery.isLoading ? (
                                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                                    Searching Vercel skills registry...
                                </div>
                            ) : catalogSkills.length === 0 ? (
                                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                                    No registry skills matched your search.
                                </div>
                            ) : (
                                catalogSkills.map((skill) => (
                                    <SkillRow
                                        key={skill.id}
                                        skill={skill}
                                        action={
                                            skill.installed ? (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="gap-1"
                                                    disabled={Boolean(activeMutationSkillId)}
                                                    onClick={() => {
                                                        if (window.confirm(`Delete skill "${skill.name}"?`)) {
                                                            deleteMutation.mutate(skill.id);
                                                        }
                                                    }}
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                    {activeMutationSkillId === skill.id && deleteMutation.isPending
                                                        ? 'Deleting...'
                                                        : 'Delete'}
                                                </Button>
                                            ) : (
                                                <Button
                                                    size="sm"
                                                    className="gap-1"
                                                    disabled={Boolean(activeMutationSkillId)}
                                                    onClick={() => installMutation.mutate(skill.id)}
                                                >
                                                    <Download className="h-4 w-4" />
                                                    {activeMutationSkillId === skill.id && installMutation.isPending
                                                        ? 'Installing...'
                                                        : 'Install'}
                                                </Button>
                                            )
                                        }
                                    />
                                ))
                            )}
                        </div>
                    </ScrollArea>
                </TabsContent>
            </Tabs>
        </div>
    );
}
