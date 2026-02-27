"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  MoreHorizontal,
  Pencil,
  Copy,
  Eye,
  Trash2,
  Undo2,
} from "lucide-react";
import type { DbMessage } from "@/lib/supabase/types";

interface MessageActionsProps {
  message: DbMessage;
  onDelete?: (id: string) => void;
  onRecall?: (id: string) => void;
}

export function MessageActions({
  message,
  onDelete,
  onRecall,
}: MessageActionsProps) {
  const router = useRouter();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleCopyToken = async () => {
    if (message.access_token_hash) {
      await navigator.clipboard.writeText(message.access_token_hash);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      onDelete?.(message.id);
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const canEdit = message.status === "draft";
  const canRecall = message.status === "confirmed";
  const canCopyToken = message.status !== "draft" && message.status !== "recalled";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs">
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">操作選單</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() =>
              router.push(`/dashboard/messages/${message.id}`)
            }
          >
            <Eye />
            查看詳情
          </DropdownMenuItem>
          {canEdit && (
            <DropdownMenuItem
              onClick={() =>
                router.push(`/dashboard/create?edit=${message.id}`)
              }
            >
              <Pencil />
              編輯
            </DropdownMenuItem>
          )}
          {canCopyToken && (
            <DropdownMenuItem onClick={handleCopyToken}>
              <Copy />
              複製存取金鑰
            </DropdownMenuItem>
          )}
          {canRecall && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onRecall?.(message.id)}>
                <Undo2 />
                撤回訊息
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setShowDeleteDialog(true)}
          >
            <Trash2 />
            刪除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>確認刪除</DialogTitle>
            <DialogDescription>
              確定要刪除「{message.title}」嗎？此操作無法復原。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "刪除中..." : "確認刪除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
