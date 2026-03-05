"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, Circle, CheckCircle2 } from "lucide-react";

// --- Types ---

interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

type FilterType = "all" | "active" | "done";

const STORAGE_KEY = "bnb-todos";

const DEFAULT_TODOS: Todo[] = [
  {
    id: "default-1",
    text: "Railway 設定 GOOGLE_SERVICE_ACCOUNT_JSON 和 GOOGLE_SHEET_ID 環境變數",
    done: false,
    createdAt: "2026-03-05T00:00:00.000Z",
  },
  {
    id: "default-2",
    text: "環境變數設好後呼叫 POST /api/v1/bookings/sync 同步訂房資料",
    done: false,
    createdAt: "2026-03-05T00:00:00.000Z",
  },
  {
    id: "default-3",
    text: "設定 LINE Bot webhook 連接",
    done: false,
    createdAt: "2026-03-05T00:00:00.000Z",
  },
  {
    id: "default-4",
    text: "Railway 設定 ANTHROPIC_API_KEY、LINE_CHANNEL_SECRET 等 production 環境變數",
    done: false,
    createdAt: "2026-03-05T00:00:00.000Z",
  },
];

// --- Helpers ---

function loadTodos(): Todo[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    // 首次使用：載入預設待辦事項
    saveTodos(DEFAULT_TODOS);
    return DEFAULT_TODOS;
  } catch {
    return [];
  }
}

function saveTodos(todos: Todo[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}

// --- Component ---

export default function TodosPage() {
  const [todos, setTodos] = useState<Todo[]>(() => loadTodos());
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const persist = useCallback((next: Todo[]) => {
    setTodos(next);
    saveTodos(next);
  }, []);

  const handleAdd = () => {
    const text = input.trim();
    if (!text) return;
    const todo: Todo = {
      id: crypto.randomUUID(),
      text,
      done: false,
      createdAt: new Date().toISOString(),
    };
    persist([todo, ...todos]);
    setInput("");
  };

  const handleToggle = (id: string) => {
    persist(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };

  const handleDelete = (id: string) => {
    persist(todos.filter((t) => t.id !== id));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleAdd();
  };

  const filtered = todos.filter((t) => {
    if (filter === "active") return !t.done;
    if (filter === "done") return t.done;
    return true;
  });

  const activeCount = todos.filter((t) => !t.done).length;

  const filterButtons: { label: string; value: FilterType }[] = [
    { label: `全部 (${todos.length})`, value: "all" },
    { label: `待辦 (${activeCount})`, value: "active" },
    { label: `已完成 (${todos.length - activeCount})`, value: "done" },
  ];

  if (!mounted) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="待辦事項"
        description="追蹤後台管理的待辦工作"
      />

      {/* Add todo */}
      <div className="flex gap-2">
        <Input
          placeholder="新增待辦事項..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1"
        />
        <Button onClick={handleAdd} disabled={!input.trim()}>
          <Plus className="mr-2 h-4 w-4" />
          新增
        </Button>
      </div>

      {/* Filters */}
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

      {/* Todo list */}
      {filtered.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          {filter === "all" ? "尚無待辦事項" : filter === "active" ? "沒有待辦項目" : "沒有已完成項目"}
        </div>
      ) : (
        <div className="divide-y rounded-md border">
          {filtered.map((todo) => (
            <div
              key={todo.id}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
            >
              <button
                onClick={() => handleToggle(todo.id)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {todo.done ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : (
                  <Circle className="h-5 w-5" />
                )}
              </button>
              <span
                className={`flex-1 text-sm ${
                  todo.done ? "text-muted-foreground line-through" : ""
                }`}
              >
                {todo.text}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(todo.createdAt).toLocaleDateString("zh-TW")}
              </span>
              <button
                onClick={() => handleDelete(todo.id)}
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
