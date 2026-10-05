export const messages: Record<string, string> = {
  HEALTH_RECEPTION: "請先確認接客形式，再核對資料記法；既有報告會保留原口徑。",
  HEALTH_MIXED_KIND: "兩種接客形式需分開計算。請在明細新增「接客形式」欄，每列填「包棟」或「散客」，再更新資料。",
  HEALTH_VILLA_SPLIT: "包棟按房間拆列時，需要共同的「訂單編號」和「房號」欄，才能合併為同一組住宿。",
  HEALTH_DIMENSIONS: "這份大型報告目前保留日期總覽，無法再按通路或房間切分。請縮小來源範圍後重新匯入。",
  HEALTH_SOURCE_BOUND:
    "這份試算表已綁定其他工作區，請提供本工作區的來源或聯絡管理者。",
  HEALTH_SHARE_TIMEOUT: "自動檢查已暫停。分享完成後，點「重新檢查」即可繼續。",
  HEALTH_QUEUE_FULL: "目前等待中的分析較多，請稍後再試。",
  HEALTH_RETRIES: "資料處理中斷多次，請重新匯入。上次成功報告仍保留。",
  HEALTH_SIZE:
    "資料超過上限：檔案 3 MB、12 張工作表、合計 10,000 列、每表 64 欄。請拆分後再試。",
  HEALTH_FORMAT: "無法讀取檔案，請使用未加密的 Excel（xlsx／xls）或 CSV。",
  HEALTH_HEADERS:
    "尚未找到可辨識的訂單明細。請提供包含入住日期、退房日期或晚數的明細表。",
  HEALTH_UNIT:
    "每列代表的單位尚未確認，無法計算可信房晚。請修改答案或更換來源。",
  HEALTH_DATES: "沒有可辨識的入住日期欄，請更換來源。",
  HEALTH_STATUS: "無法確認哪些是有效訂單。請先移除取消資料或提供訂單狀態欄。",
  HEALTH_EMPTY:
    "目前沒有可納入的有效明細。請檢查日期、館別、取消狀態、重複編號與包棟資料。",
  HEALTH_EXPIRED:
    "這份資料已到保存期限。請重新匯入；最近完成的報告可保留 30 天。",
  HEALTH_UNAVAILABLE: "訂單健檢尚未完成伺服器設定。",
  SHEET_READER_UNAVAILABLE: "Google 試算表接收帳號尚未設定，請先上傳檔案。",
  SHEET_NOT_SHARED: "尚未取得讀取權限。請確認連結正確，並將指定帳號加入檢視者。",
  SHEET_READ_FAILED: "Google 試算表暫時讀取失敗，請稍後再試。",
  UNAUTHORIZED: "請先登入再繼續。",
  FORBIDDEN: "此帳號沒有這個旅宿的分析或匯入權限。",
  RATE_LIMITED: "操作較頻繁，請稍後再試。",
  VERSION_CONFLICT: "資料狀態已更新，請重新整理後再試。",
  HEALTH_TABLE_LOCKED: "更換工作表需要重新讀取來源，以保留已確認問題的意義。",
  INVALID_INPUT: "輸入格式不正確，請檢查後再試。",
  INVALID_SHEET_URL: "請貼上有效的 Google 試算表連結。",
  IDEMPOTENCY_CONFLICT: "同一次上傳的內容已改變，請重新選擇資料再試。",
};
export const messageFor = (code: string) =>
  messages[code] ?? "暫時無法完成，請稍後重試；上次成功報告仍保留。";
