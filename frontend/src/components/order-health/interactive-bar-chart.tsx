"use client";
import { useRef, useState } from "react";
import { formatNumber as num } from "@/lib/order-health/analytics";
import styles from "./health.module.css";

export type BarPoint = { key: string; label: string; value: number | null; secondary?: number | null; detail: string };
export function InteractiveBarChart({ points, label, comparison }: { points: BarPoint[]; label: string; comparison?: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const active = hovered ?? selected;
  const maximum = Math.max(1, ...points.flatMap((p) => [p.value ?? 0, p.secondary ?? 0]));
  const picked = points.find((p) => p.key === active);
  const exportCsv = () => {
    const rows = [["日期／期間", label, ...(comparison ? [comparison] : []), "明細"], ...points.map((p) => [p.label, p.value ?? "", ...(comparison ? [p.secondary ?? ""] : []), p.detail])];
    const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a"); link.href = url; link.download = "訂單分析.csv"; link.click(); URL.revokeObjectURL(url);
  };
  return <div className={styles.interactiveChart}>
    <div className={styles.chartReadout} aria-live="polite" aria-atomic="true">
      {picked ? <><strong>{picked.label} · {num(picked.value)} {label}</strong><span>{picked.detail}{comparison ? ` · ${comparison} ${num(picked.secondary ?? null)}` : ""}</span></> : <><strong>移到長條上，查看當日數字</strong><span>手機可點選；鍵盤可用左右方向鍵切換。</span></>}
    </div>
    <div className={styles.barScroll}>
      <div className={styles.barPlot} role="group" aria-label={label} onPointerLeave={() => setHovered(null)} style={{ minWidth: `${points.length * 44}px` }}>
        {points.map((p, i) => <button key={p.key} ref={(el) => { buttons.current[i] = el; }} type="button"
          className={styles.barButton} data-active={p.key === active} aria-pressed={p.key === selected}
          aria-label={`${p.label}，${label} ${num(p.value)}。${p.detail}${comparison ? `；${comparison} ${num(p.secondary ?? null)}` : ""}`}
          onPointerEnter={(e) => { if (e.pointerType === "mouse") setHovered(p.key); }}
          onFocus={() => setHovered(p.key)} onBlur={() => setHovered(null)}
          onClick={() => setSelected(p.key === selected ? null : p.key)}
          onKeyDown={(e) => {
            const target = e.key === "ArrowRight" ? Math.min(i + 1, points.length - 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? points.length - 1 : null;
            if (target !== null) { e.preventDefault(); buttons.current[target]?.focus(); }
            if (e.key === "Escape") { setSelected(null); setHovered(null); }
          }}>
          <span className={styles.barTrack}>
            {comparison && p.secondary !== null && p.secondary !== undefined && <i className={styles.comparisonBar} style={{ height: `${Math.max(p.secondary > 0 ? 1 : 0, p.secondary / maximum * 100)}%` }} />}
            <i className={styles.primaryBar} data-missing={p.value === null} style={{ height: `${p.value === null ? 0 : Math.max(p.value > 0 ? 1 : 0, p.value / maximum * 100)}%` }}>
              <b className={styles.barValue}>{num(p.value)}</b>
            </i>
          </span><span className={styles.barLabel}>{p.label}</span>
        </button>)}
      </div>
    </div>
    {comparison && <p className={styles.small}>綠色：本期　灰色：{comparison}</p>}
    <details><summary>查看完整數據</summary><button type="button" className={styles.link} onClick={exportCsv}>下載 CSV</button><div className={styles.tableWrap}><table><thead><tr><th>日期／期間</th><th>{label}</th>{comparison && <th>{comparison}</th>}<th>明細</th></tr></thead><tbody>{points.map((p) => <tr key={p.key}><td>{p.label}</td><td>{num(p.value)}</td>{comparison && <td>{num(p.secondary ?? null)}</td>}<td>{p.detail}</td></tr>)}</tbody></table></div></details>
  </div>;
}
