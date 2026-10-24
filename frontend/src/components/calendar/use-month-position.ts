"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

// Keep a month-relative position as asynchronously loaded months change height.
// Layout changes must never become date-navigation events.
export function useMonthPosition(
  root: RefObject<HTMLDivElement | null>,
  target: string,
  revision: number,
  onMonth: (month: string) => void,
  firstRenderedMonth?: string,
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
    if (!forced && published.current === month && saved.current &&
      container.contains(saved.current.node)) return;
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
  }, [root, target, revision, firstRenderedMonth]);

  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    const nodes = [...container.querySelectorAll<HTMLElement>("[data-position-month]")];
    let frame = 0;
    let lastUserScroll = 0;
    const resize = new ResizeObserver(() => {
      const position = saved.current;
      if (!position) return;
      // A panel finishing layout during a touch gesture must not cancel the
      // browser's native momentum. Its fixed-height shell already holds space.
      if (performance.now() - lastUserScroll < 150) return;
      const top = Math.max(0, position.node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop + position.offset);
      if (Math.abs(top - container.scrollTop) > 1) {
        container.scrollTo({ top, behavior: "instant" });
        expectedScroll.current = container.scrollTop;
      }
    });
    nodes.forEach(node => resize.observe(node));
    resize.observe(container);
    const publishVisibleMonth = () => {
      frame = 0;
      const bounds = container.getBoundingClientRect();
      // Month shells are ordered and each is at least one viewport tall.
      // Binary search avoids reading every month's layout on each scroll.
      let low = 0, high = nodes.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (nodes[mid].getBoundingClientRect().bottom <= bounds.top) low = mid + 1;
        else high = mid;
      }
      const visible = [nodes[low], nodes[low + 1]].filter((node): node is HTMLElement => !!node)
        .map(node => {
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
    const scroll = () => {
      if (expectedScroll.current !== null && Math.abs(container.scrollTop - expectedScroll.current) < 1) return;
      expectedScroll.current = null;
      lastUserScroll = performance.now();
      if (!frame) frame = requestAnimationFrame(publishVisibleMonth);
    };
    container.addEventListener("scroll", scroll, { passive: true });
    return () => { resize.disconnect(); container.removeEventListener("scroll", scroll); cancelAnimationFrame(frame); };
  }, [root, firstRenderedMonth]);
}
