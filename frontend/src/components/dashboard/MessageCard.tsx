"use client";

import { Card, CardContent } from "@/components/ui/card";
import { MessageStatusBadge } from "./MessageStatusBadge";
import { MessageActions } from "./MessageActions";
import type { DbMessage } from "@/lib/supabase/types";
import { User, Paperclip, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

const relationships: Record<string, string> = {
  partner: "伴侶",
  spouse: "配偶",
  parent: "父母",
  child: "子女",
  sibling: "兄弟姊妹",
  friend: "朋友",
  colleague: "同事",
  other: "其他",
};

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const masked =
    local.length <= 2
      ? local[0] + "***"
      : local.slice(0, 2) + "***";
  return `${masked}@${domain}`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface MessageCardProps {
  message: DbMessage;
  onDelete?: (id: string) => void;
  onRecall?: (id: string) => void;
}

export function MessageCard({ message, onDelete, onRecall }: MessageCardProps) {
  const preview = stripHtml(message.body).slice(0, 100);

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="flex items-start gap-4">
        {/* Avatar */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
          <User className="h-5 w-5 text-muted-foreground" />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate font-medium">{message.title}</h3>
              <p className="text-sm text-muted-foreground">
                致 {message.recipient_name}
                <span className="mx-1">·</span>
                {relationships[message.recipient_relationship] ||
                  message.recipient_relationship}
                <span className="mx-1">·</span>
                {maskEmail(message.recipient_email)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <MessageStatusBadge status={message.status} />
              <MessageActions
                message={message}
                onDelete={onDelete}
                onRecall={onRecall}
              />
            </div>
          </div>

          {/* Preview */}
          {preview && (
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
              {preview}
              {stripHtml(message.body).length > 100 && "..."}
            </p>
          )}

          {/* Footer */}
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDate(message.created_at)}
            </span>
            {message.media_count > 0 && (
              <span className="flex items-center gap-1">
                <Paperclip className="h-3 w-3" />
                {message.media_count} 個附件
              </span>
            )}
            {message.viewed_at && (
              <span className={cn("text-green-600 dark:text-green-400")}>
                已讀取
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
