export type CalendarReadState = "loading" | "refreshing" | "failed" | "ready";

const NOTICES = {
  loading: {
    label: "讀取中",
    detail: "正在讀取最新訂單，現有資料尚未確認。",
  },
  refreshing: {
    label: "更新中",
    detail: "正在確認最新訂單，目前顯示上次讀取的資料。",
  },
  failed: {
    label: "更新失敗・顯示舊資料",
    detail: "最新訂單暫時無法確認，目前顯示上次讀取的資料，僅供查看。",
  },
} as const;

// The current request takes precedence over health copied from a saved response.
// Only a settled, successful read may use that response's source status.
export function calendarReadNotice(state: CalendarReadState) {
  return state === "ready" ? null : NOTICES[state];
}
