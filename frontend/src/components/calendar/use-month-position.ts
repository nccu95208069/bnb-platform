"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

// Keep a month-relative position as asynchronously loaded months change height.
// Layout changes must never become date-navigation events.
export function useMonthPosition(
  root: RefObject<HTMLDivElement | null>,
  target: string,
  revision: number,
  onMonth: (month: string) => void,
) {
  const callback = useRef(onMonth);
  useLayoutEffect(() => { callback.current = onMonth; }, [onMonth]);
  const saved = useRef<{ node: HTMLElement; offset: number } | null>(null);
  const expectedScroll = useRef<number | null>(null);
  const published = useRef<string | null>(null);
  const lastRevision = useRef(revision);

  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    const month = target.slice(0, 7) + "-01";
    const forced = lastRevision.current !== revision;
    lastRevision.current = revision;
    if (!forced && published.current === month && saved.current) return;
    const node = container.querySelector<HTMLElement>(`[data-position-month="${month}"]`);
    if (!node) return;
    const day = container.querySelector<HTMLElement>(`[data-position-month="${month}"] [data-position-date="${target}"]`);
    const offset = day && !target.endsWith("-01")
      ? day.getBoundingClientRect().top - node.getBoundingClientRect().top - 48
      : 0;
    saved.current = { node, offset };
    published.current = month;
    container.scrollTo({ top: Math.max(0, node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop + offset), behavior: "instant" });
    expectedScroll.current = container.scrollTop;
  }, [root, target, revision]);

  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    const nodes = [...container.querySelectorAll<HTMLElement>("[data-position-month]")];
    const resize = new ResizeObserver(() => {
      const position = saved.current;
      if (!position) return;
      const top = Math.max(0, position.node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop + position.offset);
      if (Math.abs(top - container.scrollTop) > 1) {
        container.scrollTo({ top, behavior: "instant" });
        expectedScroll.current = container.scrollTop;
      }
    });
    nodes.forEach(node => resize.observe(node));
    resize.observe(container);
    const scroll = () => {
      if (expectedScroll.current !== null && Math.abs(container.scrollTop - expectedScroll.current) < 1) return;
      expectedScroll.current = null;
      const bounds = container.getBoundingClientRect();
      const visible = nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { node, height: Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top)) };
      }).sort((a, b) => b.height - a.height)[0];
      if (!visible?.height) return;
      saved.current = { node: visible.node, offset: bounds.top - visible.node.getBoundingClientRect().top };
      const month = visible.node.dataset.positionMonth!;
      if (month !== published.current) {
        published.current = month;
        callback.current(month);
      }
    };
    container.addEventListener("scroll", scroll, { passive: true });
    return () => { resize.disconnect(); container.removeEventListener("scroll", scroll); };
  }, [root]);
}
