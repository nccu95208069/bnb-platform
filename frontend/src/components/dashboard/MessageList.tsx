"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { DbMessage, MessageStatus } from "@/lib/supabase/types";
import { MessageCard } from "./MessageCard";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { PenLine, Inbox, Search } from "lucide-react";
import Link from "next/link";

function MessageCardSkeleton() {
  return (
    <div className="rounded-xl border p-6 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
        <div className="flex-1 space-y-3">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <div className="h-5 w-48 animate-pulse rounded bg-muted" />
              <div className="h-4 w-64 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-6 w-16 animate-pulse rounded-full bg-muted" />
          </div>
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="flex gap-4">
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16">
      <Inbox className="h-12 w-12 text-muted-foreground" />
      <h3 className="mt-4 text-lg font-medium">尚無訊息</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        建立您的第一封訊息，傳達重要的心意。
      </p>
      <Button asChild className="mt-6">
        <Link href="/dashboard/create">
          <PenLine className="mr-2 h-4 w-4" />
          建立新訊息
        </Link>
      </Button>
    </div>
  );
}

export function MessageList() {
  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<MessageStatus | "all">(
    "all"
  );

  useEffect(() => {
    async function fetchMessages() {
      setIsLoading(true);
      try {
        let query = supabase
          .from("messages")
          .select("*")
          .order("created_at", { ascending: false });

        if (statusFilter !== "all") {
          query = query.eq("status", statusFilter);
        }

        if (searchQuery.trim()) {
          query = query.or(
            `title.ilike.%${searchQuery}%,recipient_name.ilike.%${searchQuery}%`
          );
        }

        const { data, error } = await query;
        if (error) throw error;
        setMessages((data as DbMessage[]) ?? []);
      } catch {
        setMessages([]);
      } finally {
        setIsLoading(false);
      }
    }

    fetchMessages();
  }, [statusFilter, searchQuery]);

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("messages").delete().eq("id", id);
    if (!error) {
      setMessages((prev) => prev.filter((m) => m.id !== id));
    }
  };

  const handleRecall = async (id: string) => {
    const { error } = await supabase
      .from("messages")
      .update({ status: "recalled" })
      .eq("id", id);
    if (!error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, status: "recalled" as const } : m
        )
      );
    }
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜尋訊息標題或收件人..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as MessageStatus | "all")}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="所有狀態" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">所有狀態</SelectItem>
            <SelectItem value="draft">草稿</SelectItem>
            <SelectItem value="confirmed">已確認</SelectItem>
            <SelectItem value="sent">已寄送</SelectItem>
            <SelectItem value="recalled">已撤回</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="space-y-4">
          <MessageCardSkeleton />
          <MessageCardSkeleton />
          <MessageCardSkeleton />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && messages.length === 0 && <EmptyState />}

      {/* Message cards */}
      {!isLoading && messages.length > 0 && (
        <div className="space-y-3">
          {messages.map((message) => (
            <MessageCard
              key={message.id}
              message={message}
              onDelete={handleDelete}
              onRecall={handleRecall}
            />
          ))}
        </div>
      )}
    </div>
  );
}
