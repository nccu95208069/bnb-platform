"use client";

import { useState, useRef, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { apiClient } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import type { ConversationDetail, Message } from "@/lib/types";
import { CHANNEL_LABELS } from "@/lib/types";
import {
  ArrowLeft,
  Bot,
  User,
  Send,
  HandMetal,
  RotateCcw,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function ConversationDetailPage() {
  const params = useParams<{ id: string }>();
  const [messageText, setMessageText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    data: conversation,
    error,
    isLoading,
    refetch,
  } = usePolling<ConversationDetail>({
    fetcher: () => apiClient.get(`/conversations/${params.id}`),
    interval: 5000,
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation?.messages]);

  async function handleTakeover() {
    setIsToggling(true);
    try {
      await apiClient.post(`/conversations/${params.id}/takeover`);
      toast.success("已接手對話");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "接手失敗");
    } finally {
      setIsToggling(false);
    }
  }

  async function handleRelease() {
    setIsToggling(true);
    try {
      await apiClient.post(`/conversations/${params.id}/release`);
      toast.success("已交回 AI 管理");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "交回失敗");
    } finally {
      setIsToggling(false);
    }
  }

  async function handleSend() {
    const content = messageText.trim();
    if (!content) return;

    setIsSending(true);
    try {
      await apiClient.post(`/conversations/${params.id}/messages`, { content });
      setMessageText("");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "發送失敗");
    } finally {
      setIsSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-3rem)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          href="/conversations"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          返回對話列表
        </Link>
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          載入失敗：{error}
        </div>
      </div>
    );
  }

  if (!conversation) return null;

  const isHumanMode = conversation.status === "human";
  const channelLabel = CHANNEL_LABELS[conversation.channel] ?? conversation.channel;

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-4">
        <div className="flex items-center gap-3">
          <Link
            href="/conversations"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold">
              {conversation.display_name || conversation.channel_user_id}
            </h1>
            <p className="text-xs text-muted-foreground">
              {channelLabel}: {conversation.channel_user_id}
            </p>
          </div>
          <Badge variant="outline" className="text-xs">
            {channelLabel}
          </Badge>
          <Badge variant={isHumanMode ? "default" : "secondary"}>
            {isHumanMode ? (
              <>
                <User className="mr-1 h-3 w-3" />
                人工模式
              </>
            ) : (
              <>
                <Bot className="mr-1 h-3 w-3" />
                AI 模式
              </>
            )}
          </Badge>
        </div>
        <div>
          {isHumanMode ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRelease}
              disabled={isToggling}
            >
              {isToggling ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              交回 AI
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={handleTakeover}
              disabled={isToggling}
            >
              {isToggling ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <HandMetal className="mr-2 h-4 w-4" />
              )}
              接手對話
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 py-4" ref={scrollRef}>
        {conversation.messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-2 h-8 w-8" />
              <p>尚無訊息</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-2">
            {conversation.messages.map((msg) => (
              <ChatBubble key={msg.id} message={msg} />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <div className="border-t pt-4">
        {isHumanMode ? (
          <div className="flex gap-2">
            <Textarea
              placeholder="輸入訊息... (Enter 發送，Shift+Enter 換行)"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              onKeyDown={handleKeyDown}
              className="min-h-[2.5rem] resize-none"
              rows={1}
              disabled={isSending}
            />
            <Button
              onClick={handleSend}
              disabled={!messageText.trim() || isSending}
              size="icon"
              className="shrink-0"
            >
              {isSending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : (
          <div className="rounded-md bg-muted p-3 text-center text-sm text-muted-foreground">
            目前由 AI 管理對話，點擊「接手對話」可切換為人工模式
          </div>
        )}
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isOutgoing = message.role === "assistant" || message.role === "owner";
  const time = new Date(message.created_at).toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const roleLabel: Record<string, string> = {
    user: "客人",
    assistant: "AI",
    owner: "人工",
    system: "系統",
  };

  return (
    <div
      className={cn("flex gap-2", isUser ? "justify-start" : "justify-end")}
    >
      {isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
          <User className="h-4 w-4 text-muted-foreground" />
        </div>
      )}
      <div
        className={cn("max-w-[70%] space-y-1", isUser ? "" : "text-right")}
      >
        <div
          className={cn(
            "inline-block rounded-2xl px-4 py-2 text-sm",
            isUser
              ? "rounded-tl-sm bg-muted text-foreground"
              : message.role === "assistant"
                ? "rounded-tr-sm bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100"
                : message.role === "owner"
                  ? "rounded-tr-sm bg-primary text-primary-foreground"
                  : "rounded-tr-sm bg-yellow-100 text-yellow-900 dark:bg-yellow-900 dark:text-yellow-100",
          )}
        >
          {message.content}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {!isUser && (
            <span className="mr-1">{roleLabel[message.role]}</span>
          )}
          <span>{time}</span>
        </div>
      </div>
      {isOutgoing && (
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            message.role === "assistant" ? "bg-blue-100 dark:bg-blue-900" : "bg-primary",
          )}
        >
          {message.role === "assistant" ? (
            <Bot className="h-4 w-4 text-blue-700 dark:text-blue-300" />
          ) : (
            <User className="h-4 w-4 text-primary-foreground" />
          )}
        </div>
      )}
    </div>
  );
}
