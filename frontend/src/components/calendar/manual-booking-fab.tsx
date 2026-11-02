"use client";

import { Plus } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const STORAGE_KEY = "sweetfun-manual-booking-fab-position-v1";
const SIZE = 56;
const EDGE = 12;
const BOTTOM_EDGE = 48;
const DRAG_THRESHOLD = 6;

type Position = { x: number; y: number };
type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  left: number;
  top: number;
  moved: boolean;
};

function clamp(position: Position): Position {
  const maxX = Math.max(0, window.innerWidth - SIZE);
  const maxY = Math.max(0, window.innerHeight - SIZE);
  const minX = Math.min(EDGE, maxX);
  const minY = Math.min(EDGE, maxY);
  return {
    x: Math.min(Math.max(position.x, minX), Math.max(minX, maxX - EDGE)),
    y: Math.min(Math.max(position.y, minY), Math.max(minY, maxY - BOTTOM_EDGE)),
  };
}

function readPosition(): Position | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as
      { x?: unknown; y?: unknown } | null;
    if (!saved || typeof saved.x !== "number" || typeof saved.y !== "number" ||
      !Number.isFinite(saved.x) || !Number.isFinite(saved.y) ||
      saved.x < 0 || saved.x > 1 || saved.y < 0 || saved.y > 1) return null;
    return clamp({
      x: saved.x * window.innerWidth - SIZE / 2,
      y: saved.y * window.innerHeight - SIZE / 2,
    });
  } catch {
    return null;
  }
}

function savePosition(position: Position) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      x: (position.x + SIZE / 2) / window.innerWidth,
      y: (position.y + SIZE / 2) / window.innerHeight,
    }));
  } catch {
    // Private browsing or a full storage quota must not prevent the button working.
  }
}

export function ManualBookingFab({ onActivate }: { onActivate: () => void }) {
  const [position, setPosition] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const restore = () => setPosition(readPosition());
    restore();
    window.addEventListener("resize", restore);
    return () => window.removeEventListener("resize", restore);
  }, []);

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    suppressClick.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    active.moved = true;
    setDragging(true);
    setPosition(clamp({ x: active.left + dx, y: active.top + dy }));
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.moved) {
      const next = clamp({
        x: active.left + event.clientX - active.startX,
        y: active.top + event.clientY - active.startY,
      });
      setPosition(next);
      savePosition(next);
      suppressClick.current = true;
    }
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") suppressClick.current = false;
    if (!event.altKey || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const next = clamp({
      x: rect.left + (event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0),
      y: rect.top + (event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0),
    });
    setPosition(next);
    savePosition(next);
  }

  return (
    <button
      type="button"
      aria-label="新增水芳訂單"
      aria-describedby="manual-booking-fab-help"
      title="新增水芳訂單（可拖曳）"
      className={`fixed z-40 flex size-14 touch-none select-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl ring-1 ring-primary/30 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring ${dragging ? "cursor-grabbing scale-105" : "cursor-grab active:scale-95"}`}
      style={position ? { left: position.x, top: position.y } : {
        right: "1rem", bottom: "calc(env(safe-area-inset-bottom) + 1.25rem)",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          return;
        }
        onActivate();
      }}
    >
      <Plus aria-hidden="true" className="size-7" strokeWidth={2.5} />
      <span id="manual-booking-fab-help" className="sr-only">
        拖曳可移動位置；按 Alt 加方向鍵也能移動。點按以新增訂單。
      </span>
    </button>
  );
}
