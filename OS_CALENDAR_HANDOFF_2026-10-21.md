# 水芳 OS 日曆讀取切換候選

日期：2026-10-21（Asia/Taipei）。**只有候選程式，尚未在正式 OS 啟用。**

舊 OS 的 `/api/v1/bookings/calendar` 目前仍從 Google Sheet 取得水芳訂單。切換後若 Gmail 只寫 Iron Gate，舊日曆會落後；因此新增預設關閉的 `IRON_GATE_SWEETFUN_CALENDAR_ENABLED` 路徑。使用者的現行 OS 登入與館別權限先被核對，伺服器才簽發僅五秒有效、綁定單一 GET 路徑的 OS 會員證明；Iron Gate 另外核對專用機器 token、館別、epoch 和 `booking:read`／`guest_name` 範圍。瀏覽器不接觸 token、簽章密鑰或 Iron Gate 原始回覆。

Iron Gate 的訂單分頁現在帶 `inventoryVersion`、`authorityEpoch`、`readOnly`。OS 只接受與設定相符的**正式非唯讀 epoch**；全部分頁、逐 31 天的六房房晚狀態及最後再讀的版本都必須一致。每個 `sold` 房晚須有唯一 confirmed 訂單，已封鎖的房晚以唯讀待核項顯示。未知 hold、缺頁、版本變動、房晚差異、回覆過大、憑證錯誤都讓日曆回 503；不退回已可能過時的 Sheet 來假裝同步。Offland 若有啟用，仍走現行 Sheet 讀取路徑。

第一階段只承接水芳訂單／房晚及獲授權的旅客姓名。平台、逐晚房價、付款與服務需求尚未完整搬入新 API，因此新讀取路徑隱藏價格，付款標為未知，訂單保持 OS 畫面唯讀；原財務帳本仍保留。來源目前提供的 `saleReady=false` 也不能當成 OwlNest 已可售。這是刻意可見的功能限制，業主核對前不可啟用該旗標。

正式設定要單獨提供 Iron Gate HTTPS 來源、專用讀取 grant、OS 簽章密鑰、六房 UUID 對照及正整數 authority epoch；任一設定缺少或仍為影子 epoch 0 都拒絕。程式未提交任何值或 token。合成測試驗證簽章範圍、保留封鎖房晚、拒絕缺少售出房晚、跨讀取版本變動與唯讀影子；Iron Gate 完整測試、TypeScript、前端 lint 和 webpack 建置通過。正式來源 grant、服務部署、畫面驗收及真實逐房晚比對仍待完成。
