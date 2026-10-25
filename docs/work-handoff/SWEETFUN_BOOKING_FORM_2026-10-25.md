# 水芳新增訂單表單 — 2026-10-25

## 業主要求與行為

1. 點入住日後，同一月曆立即轉為選退房日；退房不得等於或早於入住。
2. 每個選取房間可以有不同入住與退房日，逐房、逐晚顯示日期與房號並輸入房費。
   總額從各格房費相加，後端再次核對完整房晚、重複、金額與合計。
3. 提交結果不明時自動以原識別查核，至多三次；不自動重新建立訂單。
   重新開啟視窗會接續查核，介面不再顯示 UUID 或「查詢原請求」。
   仍無法查明時保留原識別、允許稍後再確認或關閉，不假裝成功。
4. 新增表單的預訂日預設為開啟當天的 Asia/Taipei 日期，可修改，與所選入住日分開。

上方住宿日期可套用所有房間；各房間卡片可再覆寫。房價以整數台幣輸入、以分保存。
單次新增表單最多 120 個房晚，保留既有 API 請求大小上限。既有多段住宿修改限制不在本次擴張範圍。
房況同步依現行產品流程，需在訂單詳情另按「同步房況」；本次不自動操作 OwlNest。

## 提交後誤報的原因

正式環境的原提交回執及訂單均存在，狀態 confirmed / awaiting_manual_sync。
舊 `sameStays` 直接比較 JSON 字串。Postgres JSONB 會重排物件欄位，
例如 `checkIn, roomIds, checkOut` 與送出時 `checkIn, checkOut, roomIds`，
導致相同住宿資料被誤判為回讀不符。記憶體 repository 沒有此重排，舊測試未涵蓋。

修正以型別化日期、房間與住宿集合比對；仍拒絕實際資料差異。
新增模擬 JSONB 遞迴欄位重排的整合回歸，保留不同金額、日期與版本的拒絕檢查。
恢復查核須先讀取原回執，再獨立讀取該訂單並檢查版本，才回 readbackVerified。
舊的待查紀錄可直接接續，無需清除瀏覽器資料或再次提交。

## 房費保存與權限

OS 新增 API 支援可選 roomNightPrices，轉換房號至已授權館別 UUID，
要求所有入住房晚一一對應、不含退房日或重複格、合計等於 totalCents。
Iron Gate 本身再次驗證，OS 仍須有 booking:create、guest_name 與 money 權限。
逐晚金額只回給有 money 權限的讀者；網站、無價格角色沒有新增權限。
多房多晚依各住宿段加總供日曆顯示，財務仍只計一次訂單總額。
舊修改表單送出未改動的日期／總額時保留已存逐晚價格，備註修改不會將其刪除。

## 驗證與發布

本次測試使用合成資料；正式僅讀取既有訂單，不新增測試訂單或款項。
2026-10-25 10:17（Asia/Taipei）已完成正式發布與回讀。

- API／財務／日曆整合測試：42 passed。
- 表單及既有付款、月曆 DOM 測試：19 passed。
- Iron Gate：281 passed、9 skipped（外部資料庫等測試前提未配置）。
- frontend lint：0 errors，7 個既有 warnings；production Webpack build 通過。
- 自動恢復僅 GET；未觀察到正式付款寫入，沒有宣稱銀行對帳或實機 iPhone 驗收。

### 正式發布證據

- 程式提交：`4947891345317ac020561aee613688c34db260d2`；[PR #80](https://github.com/nccu95208069/bnb-platform/pull/80) 為 draft，基於既有 finance release 分支，保留已發布的 Offland 與財務整合。
- [CI 40153508891](https://github.com/nccu95208069/bnb-platform/actions/runs/40153508891) 在此程式提交 completed / success。
- Iron Gate：`dpl_CQ1GzFiH69ZUMFbxP68CCD3Q6weJ`，`iron-gate-eevwh0f52-sweetfuns-projects.vercel.app`，production / READY。
- Sweetfun OS：`dpl_GFjf2oAfNFakJSq1kgqajvT9kb6H`，`sweetfun-q5nqa12m6-sweetfuns-projects.vercel.app`，production / READY。
- 先建立 production 候選版本，使用既有 Vercel 身分通過平台保護後，未附業主登入的應用程式查詢均回 401；再依序切換後端、前台。兩個正式網址 alias 已獨立確認指向上述版本。
- 既有業主登入查詢原提交，回 `readbackVerified: true`、currentStatus `confirmed`、version `1`、`awaiting_manual_sync`。原訂單未更動，無重複新增。
- 正式站表單驗證：選入住 10/28 後自動轉退房；101 房 10/28–10/30、201 房 10/29–10/31 可分別輸入四晚 3900、4200、4800、5300，合計 18,200；預訂日仍為當天 2026-10-25。
- 實際 DOM viewport 為 390 與 360 CSS pixels，日期、房費輸入均未超出視窗；dialog scrollWidth 等於 clientWidth。瀏覽器原有縮放已納入尺寸換算，驗收後解除暫時 viewport，未送出草稿已關閉。瀏覽器 error log 為空。
- 發布後資料庫：水芳 epoch 1 / inventory 80 / 1,625 bookings / 0 payment events；Offland epoch 0 / inventory 1 / 270 bookings / 0 payment events。沒有新增憑證、調整權限或環境變數。
- 未以正式訂單測試新建、逐晚價格寫入、退款或 OwlNest 同步；寫入流程及 JSONB 回讀使用隔離合成資料驗證。未修改原訂單未填寫的預訂日。

## 憑證輪替排程

業主另已授權把 11/19 09:00（Asia/Taipei）的提醒改為一次性自動輪替。
既有 automation-7 已更新並讀回 ACTIVE；僅兩張水芳 Production Sensitive 憑證，
各 28 天（不超過 30 天），先建立、部署與回讀，再停用被替換的兩張舊憑證。
當天保留最新正式程式及 Offland 更新，不新增正式測試款項；完成或受阻後回報。
這是排程設定完成，不表示 11/19 的輪替已執行。
