import { useEffect, useState } from 'react';
import { useKnowledgeStore } from '../../stores/knowledgeStore';
import { Button } from '../../../@/components/ui/button';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../@/components/ui/tabs';
import { FileText, Download, Trash2, Calendar, Database, File, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDistanceToNow } from 'date-fns';
import { Link } from 'react-router-dom';

import { useFileContent, useDeleteFile } from '../../hooks/useKnowledge';
import { SkeletonText } from '../../../@/components/ui/skeleton';

export function FilePreview() {
    const { activeFile, setActiveFile } = useKnowledgeStore();
    const [activeTab, setActiveTab] = useState('preview');

    const { data: fileContent, isLoading: isLoadingContent } = useFileContent(activeFile?.id || '');
    const deleteFileMutation = useDeleteFile();

    useEffect(() => {
        if (activeFile) {
            setActiveTab('preview');
        }
    }, [activeFile]);

    if (!activeFile) {
        return (
            <div className="h-full flex flex-col items-center justify-center text-gray-500 p-8 text-center">
                <FileText className="h-16 w-16 mb-4 opacity-20" />
                <h3 className="text-lg font-medium mb-2">No File Selected</h3>
                <p className="text-sm max-w-xs">Select a file from the sidebar to view its content, details, and usage history.</p>
            </div>
        );
    }

    const handleDelete = async () => {
        if (confirm('Are you sure you want to delete this file?')) {
            await deleteFileMutation.mutateAsync(activeFile.id);
            setActiveFile(null);
        }
    };

    const isLoading = isLoadingContent || (fileContent && fileContent.file.id !== activeFile.id);

    const formatDateSafe = (dateString: string) => {
        try {
            return formatDistanceToNow(new Date(dateString), { addSuffix: true });
        } catch {
            return 'recently';
        }
    };

    return (
        <div className="h-full flex flex-col bg-background">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b">
                <div className="flex items-center gap-3 overflow-hidden">
                    <div className="h-10 w-10 rounded bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="font-semibold truncate" title={activeFile.name}>{activeFile.name}</h2>
                        <p className="text-xs text-muted-foreground capitalize">{activeFile.status}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {fileContent?.signedUrl && (
                        <Button variant="outline" size="icon" asChild>
                            <a href={fileContent.signedUrl} download target="_blank" rel="noopener noreferrer">
                                <Download className="h-4 w-4" />
                            </a>
                        </Button>
                    )}
                    <Button variant="ghost" size="icon" onClick={handleDelete} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Info Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 bg-muted/30 text-xs border-b">
                <div className="flex flex-col gap-1">
                    <span className="text-muted-foreground flex items-center gap-1"><Database className="h-3 w-3" /> Tokens</span>
                    <span className="font-medium">{activeFile.metadata?.tokenCount?.toLocaleString() || '-'}</span>
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-muted-foreground flex items-center gap-1"><File className="h-3 w-3" /> Vectors</span>
                    <span className="font-medium">{activeFile.metadata?.vectorCount?.toLocaleString() || '-'}</span>
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-muted-foreground flex items-center gap-1"><Calendar className="h-3 w-3" /> Created</span>
                    <span className="font-medium">{formatDateSafe(activeFile.updatedAt)}</span>
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-muted-foreground flex items-center gap-1"><FileText className="h-3 w-3" /> Type</span>
                    <span className="font-medium uppercase">{activeFile.name.split('.').pop()}</span>
                </div>
            </div>

            {/* Content Tabs */}
            <div className="flex-1 overflow-hidden flex flex-col">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
                    <div className="px-4 pt-2 border-b">
                        <TabsList className="w-full justify-start h-9 bg-transparent p-0">
                            <TabsTrigger value="preview" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none px-4 pb-2">Parsed Text</TabsTrigger>
                            <TabsTrigger value="original" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none px-4 pb-2">Original File</TabsTrigger>
                            <TabsTrigger value="usage" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none px-4 pb-2">Usage ({fileContent?.usage?.length || 0})</TabsTrigger>
                        </TabsList>
                    </div>

                    <div className="flex-1 overflow-hidden relative">
                        {isLoading ? (
                            <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10 p-8">
                                <SkeletonText lines={10} />
                            </div>
                        ) : (
                            <>
                                <TabsContent value="preview" className="h-full m-0 absolute inset-0 data-[state=inactive]:hidden">
                                    <ScrollArea className="h-full p-6">
                                        <div className="prose dark:prose-invert max-w-none text-sm">
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                {fileContent?.content || '*No content available*'}
                                            </ReactMarkdown>
                                        </div>
                                    </ScrollArea>
                                </TabsContent>

                                <TabsContent value="original" className="h-full m-0 absolute inset-0 data-[state=inactive]:hidden bg-muted/10 p-4 flex items-center justify-center">
                                    {fileContent?.signedUrl ? (
                                        activeFile.name.toLowerCase().endsWith('.pdf') ? (
                                            <iframe src={fileContent.signedUrl} className="w-full h-full rounded border bg-white" title="Original PDF" />
                                        ) : activeFile.name.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                                            <img src={fileContent.signedUrl} alt="Original" className="max-w-full max-h-full object-contain rounded shadow-sm" />
                                        ) : (
                                            <div className="text-center">
                                                <p className="mb-4 text-muted-foreground">Preview not available for this file type.</p>
                                                <Button asChild>
                                                    <a href={fileContent.signedUrl} download>Download to View</a>
                                                </Button>
                                            </div>
                                        )
                                    ) : (
                                        <p className="text-muted-foreground">Original file not available.</p>
                                    )}
                                </TabsContent>

                                <TabsContent value="usage" className="h-full m-0 absolute inset-0 data-[state=inactive]:hidden">
                                    <ScrollArea className="h-full">
                                        {fileContent?.usage && fileContent.usage.length > 0 ? (
                                            <div className="divide-y">
                                                {fileContent.usage.map((item: { messageId: string; workspaceId: string; workspaceName: string; date: string; snippet: string }) => (
                                                    <div key={item.messageId} className="p-4 hover:bg-muted/50 transition-colors">
                                                        <div className="flex items-center justify-between mb-1">
                                                            <Link to={`/workspaces/${item.workspaceId}?messageId=${item.messageId}`} className="font-medium text-sm hover:underline flex items-center gap-1 text-primary">
                                                                <MessageSquare className="h-3 w-3" />
                                                                {item.workspaceName}
                                                            </Link>
                                                            <span className="text-xs text-muted-foreground">{formatDateSafe(item.date)}</span>
                                                        </div>
                                                        <p className="text-xs text-muted-foreground line-clamp-2 pl-4 border-l-2 border-muted">
                                                            "{item.snippet}"
                                                        </p>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-8">
                                                <MessageSquare className="h-8 w-8 mb-2 opacity-20" />
                                                <p>This file hasn't been used in any workspaces yet.</p>
                                            </div>
                                        )}
                                    </ScrollArea>
                                </TabsContent>
                            </>
                        )}
                    </div>
                </Tabs>
            </div>
        </div>
    );
}
