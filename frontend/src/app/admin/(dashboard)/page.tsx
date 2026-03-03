"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { DocumentStatusBadge } from "@/components/admin/document-status-badge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { signOut } from "@/lib/supabase/auth";
import type { Document, DocumentChunk } from "@/lib/types";
import {
  FileText,
  Trash2,
  Loader2,
  RefreshCw,
  FileUp,
  LogOut,
  ChevronDown,
  ChevronRight,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";

const ACCEPTED_TYPES = [".pdf", ".txt", ".md"];

export default function AdminPage() {
  const router = useRouter();
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Document | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Text input state
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [isSubmittingText, setIsSubmittingText] = useState(false);

  // Chunks expanded state: doc id → chunks or null (loading)
  const [expandedChunks, setExpandedChunks] = useState<
    Record<string, DocumentChunk[] | null>
  >({});

  const {
    data: documents,
    error,
    isLoading,
    refetch,
  } = usePolling<Document[]>({
    fetcher: () => apiClient.get("/documents"),
    interval: 5000,
  });

  const handleUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;

      setIsUploading(true);
      let successCount = 0;
      let failCount = 0;

      for (const file of Array.from(files)) {
        const ext = "." + file.name.split(".").pop()?.toLowerCase();
        if (!ACCEPTED_TYPES.includes(ext)) {
          toast.error(`不支援的檔案格式：${file.name}`);
          failCount++;
          continue;
        }
        try {
          const formData = new FormData();
          formData.append("file", file);
          await apiClient.upload("/documents/upload", formData);
          successCount++;
        } catch (err) {
          toast.error(
            `上傳失敗：${file.name} - ${err instanceof Error ? err.message : "未知錯誤"}`,
          );
          failCount++;
        }
      }

      if (successCount > 0) {
        toast.success(`成功上傳 ${successCount} 個檔案`);
        await refetch();
      }
      if (failCount > 0 && successCount > 0) {
        toast.warning(`${failCount} 個檔案上傳失敗`);
      }

      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [refetch],
  );

  async function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!textTitle.trim() || !textContent.trim()) return;

    setIsSubmittingText(true);
    try {
      await apiClient.post("/documents/text", {
        title: textTitle.trim(),
        content: textContent.trim(),
      });
      toast.success("文件已建立，正在處理中...");
      setTextTitle("");
      setTextContent("");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "建立失敗");
    } finally {
      setIsSubmittingText(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await apiClient.delete(`/documents/${deleteTarget.id}`);
      toast.success(`已刪除 ${deleteTarget.filename}`);
      setDeleteTarget(null);
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    router.replace("/admin/login");
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    handleUpload(e.dataTransfer.files);
  }

  async function toggleChunks(doc: Document) {
    if (doc.status !== "completed") return;

    if (expandedChunks[doc.id] !== undefined) {
      // collapse
      setExpandedChunks((prev) => {
        const next = { ...prev };
        delete next[doc.id];
        return next;
      });
      return;
    }

    // expand & load
    setExpandedChunks((prev) => ({ ...prev, [doc.id]: null }));
    try {
      const chunks = await apiClient.get<DocumentChunk[]>(
        `/documents/${doc.id}/chunks`,
      );
      setExpandedChunks((prev) => ({ ...prev, [doc.id]: chunks }));
    } catch {
      toast.error("無法載入 chunks");
      setExpandedChunks((prev) => {
        const next = { ...prev };
        delete next[doc.id];
        return next;
      });
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="文件管理（管理員）"
        description="上傳、處理與管理 RAG 知識庫文件"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              重新整理
            </Button>
            <Button variant="outline" size="sm" onClick={handleSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              登出
            </Button>
          </div>
        }
      />

      {/* File upload area */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
          isDragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-primary/50"
        }`}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          multiple
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
        {isUploading ? (
          <>
            <Loader2 className="mb-2 h-10 w-10 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">上傳中...</p>
          </>
        ) : (
          <>
            <FileUp className="mb-2 h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium">拖拽檔案至此或點擊上傳</p>
            <p className="mt-1 text-xs text-muted-foreground">
              支援 PDF、TXT、MD 格式
            </p>
          </>
        )}
      </div>

      {/* Text input area */}
      <div className="rounded-lg border p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <PenLine className="h-4 w-4 text-muted-foreground" />
          直接輸入文字內容
        </div>
        <form onSubmit={handleTextSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="text-title">標題</Label>
            <Input
              id="text-title"
              placeholder="例：民宿介紹、房型說明..."
              value={textTitle}
              onChange={(e) => setTextTitle(e.target.value)}
              disabled={isSubmittingText}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="text-content">內容</Label>
            <Textarea
              id="text-content"
              placeholder="在此輸入要提供給 AI 參考的文件內容..."
              rows={6}
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              disabled={isSubmittingText}
              className="resize-y"
            />
          </div>
          <Button
            type="submit"
            disabled={
              isSubmittingText || !textTitle.trim() || !textContent.trim()
            }
            size="sm"
          >
            {isSubmittingText && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            建立文件
          </Button>
        </form>
      </div>

      {/* Document list */}
      {isLoading && (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          載入中...
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          載入失敗：{error}
        </div>
      )}

      {!isLoading && !error && documents && documents.length === 0 && (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          <FileText className="mx-auto mb-2 h-8 w-8" />
          <p>尚未上傳任何文件</p>
        </div>
      )}

      {!isLoading && !error && documents && documents.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>檔名</TableHead>
                <TableHead>類型</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead>Chunk 數</TableHead>
                <TableHead>上傳時間</TableHead>
                <TableHead className="w-[70px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <>
                  <TableRow key={doc.id}>
                    <TableCell>
                      {doc.status === "completed" && (
                        <button
                          onClick={() => toggleChunks(doc)}
                          className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                        >
                          {expandedChunks[doc.id] !== undefined ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        {doc.filename}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{doc.content_type}</Badge>
                    </TableCell>
                    <TableCell>
                      <DocumentStatusBadge status={doc.status} />
                    </TableCell>
                    <TableCell>{doc.chunk_count}</TableCell>
                    <TableCell>
                      {new Date(doc.created_at).toLocaleDateString("zh-TW")}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(doc)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expandedChunks[doc.id] !== undefined && (
                    <TableRow key={`${doc.id}-chunks`}>
                      <TableCell colSpan={7} className="bg-muted/30 px-4 pb-4">
                        {expandedChunks[doc.id] === null ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            載入中...
                          </div>
                        ) : (
                          <div className="space-y-2 pt-2">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                              擷取的重點段落（共 {expandedChunks[doc.id]!.length} 個）
                            </p>
                            <div className="space-y-2 max-h-80 overflow-y-auto pr-2">
                              {expandedChunks[doc.id]!.map((chunk) => (
                                <div
                                  key={chunk.id}
                                  className="rounded-md bg-background border p-3 text-sm"
                                >
                                  <span className="text-xs text-muted-foreground mr-2">
                                    #{chunk.chunk_index + 1}
                                  </span>
                                  {chunk.content}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>確認刪除</DialogTitle>
            <DialogDescription>
              確定要刪除「{deleteTarget?.filename}」嗎？此操作無法復原。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
