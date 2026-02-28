"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import type { Conversation, ConversationStatus } from "@/lib/types";
import { CHANNEL_LABELS } from "@/lib/types";
import { MessageSquare, Search, Bot, User, RefreshCw } from "lucide-react";

type FilterType = "all" | ConversationStatus;

export default function ConversationsPage() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");

  const {
    data: conversations,
    error,
    isLoading,
    refetch,
  } = usePolling<Conversation[]>({
    fetcher: () => apiClient.get("/conversations"),
    interval: 10000,
  });

  const filtered = useMemo(() => {
    if (!conversations) return [];
    return conversations.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false;
      if (search) {
        const q = search.toLowerCase();
        const displayName = c.display_name?.toLowerCase() ?? "";
        const userId = c.channel_user_id.toLowerCase();
        return displayName.includes(q) || userId.includes(q);
      }
      return true;
    });
  }, [conversations, filter, search]);

  const filterButtons: { label: string; value: FilterType }[] = [
    { label: "全部", value: "all" },
    { label: "AI 處理中", value: "ai" },
    { label: "人工接手中", value: "human" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="對話管理"
        description="查看客人的對話列表，接手或交回 AI 管理"
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            重新整理
          </Button>
        }
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜尋客人名稱..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          {filterButtons.map((btn) => (
            <Button
              key={btn.value}
              variant={filter === btn.value ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(btn.value)}
            >
              {btn.label}
            </Button>
          ))}
        </div>
      </div>

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

      {!isLoading && !error && filtered.length === 0 && (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          <MessageSquare className="mx-auto mb-2 h-8 w-8" />
          <p>{search || filter !== "all" ? "沒有符合條件的對話" : "尚無對話"}</p>
        </div>
      )}

      {!isLoading && !error && filtered.length > 0 && (
        <div className="divide-y rounded-md border">
          {filtered.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationRow({ conversation }: { conversation: Conversation }) {
  const timeAgo = conversation.last_message_at
    ? formatTimeAgo(conversation.last_message_at)
    : "";
  const isAi = conversation.status === "ai";
  const channelLabel = CHANNEL_LABELS[conversation.channel] ?? conversation.channel;

  return (
    <Link
      href={`/conversations/${conversation.id}`}
      className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">
            {conversation.display_name || conversation.channel_user_id}
          </span>
          <Badge variant="outline" className="text-xs">
            {channelLabel}
          </Badge>
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {conversation.channel_user_id}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        {timeAgo && (
          <span className="text-xs text-muted-foreground">{timeAgo}</span>
        )}
        <Badge variant={isAi ? "secondary" : "default"}>
          {isAi ? (
            <>
              <Bot className="mr-1 h-3 w-3" />
              AI
            </>
          ) : (
            <>
              <User className="mr-1 h-3 w-3" />
              人工
            </>
          )}
        </Badge>
      </div>
    </Link>
  );
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "剛剛";
  if (diffMin < 60) return `${diffMin} 分鐘前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小時前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return date.toLocaleDateString("zh-TW");
}
