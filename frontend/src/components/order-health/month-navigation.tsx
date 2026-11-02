"use client";
import { shiftMonth } from "@/lib/order-health/momentum";
import styles from "./health.module.css";

export function MonthNavigation({ month, currentMonth, onChange, label }: {
  month: string;
  currentMonth: string;
  onChange: (month: string) => void;
  label: string;
}) {
  return <div className={styles.monthNavigation} role="group" aria-label={label}>
    <button type="button" className={styles.secondary} disabled={month === "2000-01"} onClick={() => onChange(shiftMonth(month, -1))} aria-label="查看上一個月">← 上個月</button>
    <label>月份<input type="month" value={month} min="2000-01" max="2099-12" onChange={(e) => {
      const value = e.target.value;
      if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= "2000-01" && value <= "2099-12") onChange(value);
    }} /></label>
    <button type="button" className={styles.secondary} disabled={month === "2099-12"} onClick={() => onChange(shiftMonth(month, 1))} aria-label="查看下一個月">下個月 →</button>
    {month !== currentMonth && <button type="button" className={styles.link} onClick={() => onChange(currentMonth)}>回到本月</button>}
  </div>;
}
