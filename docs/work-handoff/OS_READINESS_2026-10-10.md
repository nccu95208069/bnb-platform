# OS 入口、onboarding 與入住備註 — 2026-10-10

## 交付狀態

本次程式與隔離驗證完成，尚未發布到正式主網域。變更基於 PR #31 的目前分支；既有正式日曆保持原版本。LINE 真實發送、外部新客戶與實體手機驗收仍分開列出，不將合成測試當成正式啟用。

## OS-02：一致的使用入口

兩套日曆位於同一個 Sweetfun OS 部署，資料與登入範圍不同：

| 入口 | 資料權威來源 | 權限 |
|---|---|---|
| `/calendar` | Sweetfun／OFFLAND 現有 Google Sheet；OwlNest 觀測獨立 | 既有 workspace 登入及館別授權 |
| `/w/{slug}/calendar` | 外部客戶工作區；已確認匯入／原生訂單 | customer 帳號、有效 membership、館別範圍 |
| `/workspaces` | 逐一重新核對上述兩種登入 | 只列出當下有權限的旅宿 |

首頁與「我的旅宿」統一指向 `/workspaces`。保留資料隔離，不把兩套權限或訂單權威來源直接合併。登入回程支援特定訂單、館別與入住備註；外部網址與不允許的參數被拒絕。Email 與 Google 回程綁定原始登入請求，避免重試時更換目的地。

## OS-01：onboarding 卡點修正

- 空白工作區原本直接進入 Sheet 匯入，現在先提供 Sheet／Google／iPhone／Android 來源選擇。
- 未匯入時不再顯示「已核對 undefined 至 undefined」。
- 實際瀏覽器驗收發現 ICS DESCRIPTION 被捨棄，已保存為訂單備註；多活動備註去重合併。
- 來源備註變更納入匯入差異指紋。只有現有備註仍等於上次來源內容時才更新；使用者後來手動修改的備註受到保護。

隔離環境使用合成帳號、獨立 Redis 與兩間合成房間。實測登入、新建工作區、選擇來源、ICS 上傳、房間對應、預覽、確認、持久化、日曆與訂單讀回。瀏覽器實際發現備註遺失後，修正版本以同一匯入服務重新預覽及確認更新，再由瀏覽器檢查提醒及訂單。沒有寫入真實客戶訂單。這不等於真實新客戶、實體手機或 LINE 內建瀏覽器完成驗收。

## OS-07：已核實每日觀測

10/10 以正式 Redis 的每日執行紀錄唯讀查核。兩館三天的結果均 `verified=true`，權威觀測時間與完成紀錄相符；不是只看排程設定。

| 台北日期 | Sweetfun 成功時間 | OFFLAND 成功時間 |
|---|---|---|
| 2026-10-08 | 08:44 | 08:32 |
| 2026-10-09 | 08:27 | 08:52 |
| 2026-10-10 | 08:27 | 08:08 |

首跑及後續三日紀錄驗收完成。本次查核不新增 OwlNest 讀取，也不修改價格、房態或排程。

## OS-04：OS 端提醒與串接契約

管理者頁面：既有館 `/arrivals`，新客戶 `/w/{slug}/arrivals?property=...`。

- 台北今日／明日入住、正式確認、含備註的訂單；先合併母訂單所有房晚，再判定入住日，避免續住被當成新入住。
- 完整備註、館別、房間、入住退房、原訂單連結、核對時間與「已處理」狀態。
- 已處理採指紋與原子寫入後讀回；備註或住宿內容改變會重新顯示待處理。訊息送達不等於人員已處理。
- 既有館讀完整權威 Sheet，不使用快取當成新鮮核對。缺少／重複備註欄、訂單身份或來源衝突會顯示無法確認，不當成沒有需求。
- 新館重新核對會員、館別、匯入完成狀態、今日／明日涵蓋範圍及連線日曆的新鮮度。舊或未核對資料不發提醒。
- UI/API 僅 owner／admin（既有館含 god）可用；POST 驗證同來源，回覆 no-store；失敗回覆不包含原始備註。

### LINE worker API

`POST /api/integration/arrival-reminders/v1`，預設 `ARRIVAL_REMINDERS_ENABLED=false`。只有另行設定 `ARRIVAL_REMINDER_WORKERS` 的獨立 Bearer capability 能讀取備註；原價格／異動／網站 token 不會繼承此權限。

Worker 設定為陣列：每筆 `id`、`token_sha256`、`targets`。Target 可為 `kind=legacy`（propertyId、recipientId、verifiedAt、verifiedBy）或 `kind=workspace`（既有且本人已驗證的 website bindingId）。所有名稱／ID 都由伺服器設定，不能由請求任意指定收件人。新館在每次 claim 重新檢查 binding、配對、目前 owner 身分與館別。

1. `action=targets` 取得允許的 target ID、day、台北排程時點 09:00。
2. `action=claim,targetId,attemptId`：只於台北 09:00–09:59 提供工作，一次最多一筆。每次新 claim 使用持久的 UUID；不確定回覆時沿用原 UUID 查回。
3. 工作包含 job id、attemptId、bookingId、recipient、text、claimExpiresAt；文字含原訂單連結，超長備註限制訊息長度但 OS 保留全文。
4. 發送端須先持久保存發送意圖，以同一工作恢復；在發送前再次沿用原 attempt 查核有效工作。不可在程序重啟或 LINE 回覆不明時直接重發。
5. `action=ack,targetId,day,attemptId,jobId,outcome,providerReceipt`：sent 必須附 LINE receipt；failed／unknown 不自動重試發送。ACK 可於時窗外補回。
6. 下一筆用新的 attemptId，直到沒有工作。每日每館每筆訂單只有一個原子保留，即使兩個 binding 指向同一旅宿也不會重複領取。5 分鐘過期的未明發送維持 unknown，不重新派送。

OS 只保存處理指紋與送達回條，備註仍留在來源。已處理保存 30 天；發送防重及回條保存 7 天。LINE 執行者須獨立保存 provider 結果與待補 ACK，避免到期後重送。

尚未設定正式 reminder worker、連接小助手排程或發送真實 LINE；這是可串接的 OS 端交付，不能把 OS-04 整張 ticket 關閉。既有 Sheet reader 有合成資料整合測試；本機缺正式 Google 憑證，新增提醒頁尚未完成正式 Sheet→UI 驗證。

## Code review 與驗證

人工 code review 已檢查權限邊界、資料來源可信度、備註保留、CAS 競爭、重試與失敗狀態。修正了實際匯入備註遺失、原登入回程漏掉訂單，以及多 binding 同一訂單可能重複派送等問題；新增缺備註欄／未完成匯入／涵蓋範圍不足時的拒絕條件。審查後本次範圍沒有已知未修復 P0/P1；正式發送與實體客戶驗收是尚未完成的外部驗收，並未宣稱通過。

- 相關服務、權限、匯入、Google／Email 登入、日曆異動、真實隔離 Redis 競爭與重啟讀回測試通過（53 項）。
- 兩項 DOM 流程通過：匯入精靈；提醒全文／處理後讀回／來源失敗的明確呈現。
- 實際瀏覽器：登入→工作區→匯入→日曆→入住備註→完整訂單→修改備註→再次待處理；已處理跨重載保留；390px 沒有水平溢出。
- TypeScript、production build、lint 通過；lint 為 0 errors、5 個既有 warnings。
- 未執行真實通知、收退款、價格或庫存寫入；未改正式主網域或啟用發送。

## 其餘依賴

OS-05／ING-01 的來源成功後通知、INT-03 舊表／OwlNest 占房釋出、OS-10 實體裝置與第二房換房、OS-11／INT-04 定價端全欄位讀回，仍依既有主責線與驗收條件執行；本批交付不替這些項目結案。
