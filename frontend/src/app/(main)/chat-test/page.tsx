"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";
import { RotateCcw, Send } from "lucide-react";

// --- Types ---

interface DebugInfo {
  original_query: string;
  reformulated_query: string;
  is_ack: boolean;
  intent: string;
  extracted_dates: string[];
  extracted_room: string | null;
  extracted_guest_name: string | null;
  booking_context: string | null;
  rag_context: string | null;
  llm_model: string | null;
  llm_provider: string | null;
  response_time_ms: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  debug?: DebugInfo;
}

interface SimulateResponse {
  reply: string | null;
  conversation_id: string | null;
  debug: DebugInfo;
}

// --- Intent helpers ---

const INTENT_LABELS: Record<string, string> = {
  availability: "空房查詢",
  pricing: "報價",
  order_lookup: "訂單查詢",
  general: "一般問題",
  ack: "非提問",
};

const INTENT_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  availability: "default",
  pricing: "default",
  order_lookup: "default",
  general: "secondary",
  ack: "outline",
};

// --- Component ---

function generateSessionId() {
  return `test-${crypto.randomUUID().slice(0, 8)}`;
}

export default function ChatTestPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(generateSessionId);
  const [selectedDebug, setSelectedDebug] = useState<DebugInfo | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleReset = () => {
    setMessages([]);
    setSessionId(generateSessionId());
    setSelectedDebug(null);
    setInput("");
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await apiClient.post<SimulateResponse>("/chat/simulate", {
        text,
        session_id: sessionId,
      });

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: res.reply ?? "(無回覆)",
        timestamp: new Date(),
        debug: res.debug,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setSelectedDebug(res.debug);
    } catch (err) {
      const errorMsg: ChatMessage = {
        role: "assistant",
        content: `錯誤：${err instanceof Error ? err.message : "未知錯誤"}`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col">
      <PageHeader
        title="AI 對話測試"
        description={`Session: ${sessionId}`}
        actions={
          <Button variant="outline" size="sm" onClick={handleReset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            重置對話
          </Button>
        }
      />

      <div className="mt-4 flex min-h-0 flex-1 gap-4">
        {/* Left: Debug Panel */}
        <div className="w-[38%] shrink-0 overflow-y-auto rounded-md border bg-card p-4">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
            Pipeline Debug
          </h3>
          {selectedDebug ? (
            <DebugPanel debug={selectedDebug} />
          ) : (
            <p className="text-sm text-muted-foreground">
              點擊 AI 回覆查看 debug 資訊
            </p>
          )}
        </div>

        {/* Right: Chat Window */}
        <div className="flex min-w-0 flex-1 flex-col rounded-md border bg-card">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-lg space-y-3">
              {messages.map((msg, i) => (
                <ChatBubble
                  key={i}
                  message={msg}
                  isSelected={msg.debug === selectedDebug && !!msg.debug}
                  onSelect={() => msg.debug && setSelectedDebug(msg.debug)}
                />
              ))}
              {loading && <TypingIndicator />}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <div className="border-t p-3">
            <div className="mx-auto flex max-w-lg gap-2">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="輸入訊息... (Enter 發送, Shift+Enter 換行)"
                rows={1}
                className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                disabled={loading}
              />
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="self-end"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function ChatBubble({
  message,
  isSelected,
  onSelect,
}: {
  message: ChatMessage;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const isUser = message.role === "user";
  const time = message.timestamp.toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
          isUser
            ? "bg-green-500 text-white"
            : `bg-white text-foreground border shadow-sm cursor-pointer ${
                isSelected ? "ring-2 ring-primary" : ""
              }`
        }`}
        onClick={isUser ? undefined : onSelect}
      >
        <p>{message.content}</p>
        <p
          className={`mt-1 text-[10px] ${
            isUser ? "text-green-100" : "text-muted-foreground"
          }`}
        >
          {time}
        </p>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex gap-1 rounded-2xl border bg-white px-4 py-3 shadow-sm">
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:0ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:150ms]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function DebugPanel({ debug }: { debug: DebugInfo }) {
  return (
    <div className="space-y-4 text-sm">
      {/* Intent */}
      <div>
        <Label>意圖分類</Label>
        <Badge variant={INTENT_VARIANTS[debug.intent] ?? "secondary"}>
          {INTENT_LABELS[debug.intent] ?? debug.intent}
        </Badge>
        {debug.is_ack && (
          <Badge variant="outline" className="ml-2">
            ACK
          </Badge>
        )}
      </div>

      {/* Reformulated */}
      <div>
        <Label>Reformulated Query</Label>
        <Value>{debug.reformulated_query}</Value>
      </div>

      {/* Extracted params */}
      <div>
        <Label>提取參數</Label>
        <div className="space-y-1">
          <Row label="日期" value={debug.extracted_dates.length > 0 ? debug.extracted_dates.join(" ~ ") : "—"} />
          <Row label="房號" value={debug.extracted_room ?? "—"} />
          <Row label="姓名" value={debug.extracted_guest_name ?? "—"} />
        </div>
      </div>

      {/* Booking context */}
      <div>
        <Label>Booking Context</Label>
        <Value>{debug.booking_context ?? "(無)"}</Value>
      </div>

      {/* RAG context */}
      <div>
        <Label>RAG Context</Label>
        <Value truncate>{debug.rag_context ?? "(無)"}</Value>
      </div>

      {/* Model info */}
      <div>
        <Label>Model / Provider</Label>
        <Value>
          {debug.llm_model ?? "—"} / {debug.llm_provider ?? "—"}
        </Value>
      </div>

      {/* Response time */}
      <div>
        <Label>回應耗時</Label>
        <Value>{(debug.response_time_ms / 1000).toFixed(1)}s</Value>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 text-xs font-medium text-muted-foreground">{children}</p>
  );
}

function Value({
  children,
  truncate,
}: {
  children: React.ReactNode;
  truncate?: boolean;
}) {
  return (
    <div
      className={`rounded bg-muted px-2 py-1.5 text-xs whitespace-pre-wrap break-all ${
        truncate ? "max-h-32 overflow-y-auto" : ""
      }`}
    >
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
