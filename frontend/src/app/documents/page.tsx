"use client";

import { useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import type { Document } from "@/lib/types";
import {
  FileText,
  Trash2,
  Loader2,
  RefreshCw,
  FileUp,
} from "lucide-react";
import { toast } from "sonner";

const ACCEPTED_TYPES = [".pdf", ".txt", ".docx"];

export default function DocumentsPage() {
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Document | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    data: documents,
    error,
    isLoading,
    refetch,
  } = usePolling<Document[]>({
    fetcher: () => apiClient.get("/documents"),
    interval: 15000,
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="文件管理"
        description="上傳與管理 RAG 訓練文件"
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            重新整理
          </Button>
        }
      />

      {/* Upload area */}
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
              支援 PDF、TXT、DOCX 格式
            </p>
          </>
        )}
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
                <TableHead>檔案名稱</TableHead>
                <TableHead>類型</TableHead>
                <TableHead>Chunk 數</TableHead>
                <TableHead>上傳時間</TableHead>
                <TableHead className="w-[70px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      {doc.filename}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{doc.content_type}</Badge>
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

