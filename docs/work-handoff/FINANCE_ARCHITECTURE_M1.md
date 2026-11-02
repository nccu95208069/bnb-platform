# 財務拆分與唯讀摘要：實作計畫及驗收

2026-09-08。使用者批准先拆分付款／請款／入帳，再做跨來源紀錄及版本檢查，最後啟用 Sheet 寫回。本文優先於 OS_PAYMENTS 中較早的純 OS 限制，但不代表現在已啟用寫回。

## 責任與資料流

工作表1 是訂房營運來源；OS 是新增財務事件的權威來源。保留 A:R 欄位名稱、位置、格式和訂房寫入流程。財務摘要是衍生資料，不是第二套可自由改寫的帳本。第一階段僅提供 OS `/finance/summary` 與受保護的 GET `/api/v1/finance-summary`；不新增正式 Sheet 工作表、不更改 H、不自動產生任何收款。

現有 H 的 done 是歷史標記，定義曾混用。Sweetfun Agoda 依業主本次確認作為舊請款標記，不能當作客人付款或銀行入帳證明。其他平台不從 H 推定實收。Offland 不套用 Sweetfun 的請款遷移規則。新的 Agoda 抓單已取消預設 done；這不會補齊歷史入帳。

## 狀態及金額契約

1. 客人付款：客人是否已付給旅宿或 OTA。平台匯款不能反推客人付款。
2. 平台請款：未請款／部分請款／已請款；直訂不適用。請款不等於入帳。
3. 旅宿入帳：實際收到現金、匯款或已確認的款項。OTA 代收排除。
4. 房費來源金額、已確認客人總價、已確認旅宿應收總額分開。G 的各通路口徑尚未統一，第一階段只展示「來源房費」，確認總額及餘額為 null，畫面顯示待確認。
5. 無紀錄不等於零收款。正數已記錄款項可展示，但不能宣稱歷史完整、已全付或用未知總額計算餘額。
6. 房晚列是營運粒度，收款及摘要是訂單粒度；不累加重複 P 欄刷卡總額。每張訂單的 source row ids 明列在結構化輸出。

## OS 儲存與相容性

沿用私人 Redis 的既有 payments:v1 與 finance:v1，不搬移、不重新編號、不清除 receipts。新 `sweetfun-os:finance-summary:v1:{property}` 是無 TTL 的訂單對應登錄，schema=1，保留既有 OS order_id、來源列 IDs、帶平台的 OTA aliases、OwlNest aliases、首次與最後觀測時間。

點「保存訂單對應」才以 POST 寫入登錄。GET 不寫資料。保存須符合預期登錄版本和來源摘要指紋；Redis compare-and-set 後讀回核對 audit。操作 actor 取登入身分；記錄版本、時間、來源指紋。無法確認時顯示重新整理，不假裝成功。重送舊版本回 409，不新增付款。

訂單改期但 ID 不變：沿用舊帳，追加 alias。新 ID 與另一張已保存訂單共用 alias／來源列：標 identity_conflict，兩筆不自動合併，不移轉既有收款。缺外部編號仍可沿用 OS ID；缺失不以姓名補配。來源刪除／取消後保留既有對應；只標未出現在目前來源，不能假定它一定取消。第一階段不做自動退款。

登錄不保存姓名、聯絡方式、憑證；外部訂單號和財務記錄僅限私人伺服器及授權回應。API 僅 owner/God/admin 且可看價格、旅宿 scope 符合者可讀寫；隱藏價格帳號不可讀。回應 no-store。

## 後續資料实体（M2 開始）

- 訂單金額確認：customer_total、property_receivable、currency、amount_basis、evidence、actor、version。金額以整數分保存。
- 客人付款事件：event_id、order_id、collector、amount、method、occurred_at、recorded_at、source、source_event_id、actor、reversal_of。訂金／尾款是類型，不是付款狀態本身。
- 平台請款批次：claim_id、platform、orders/allocations、claim_amount、claimed_at、evidence、version。可含多張訂單，不能重複當收入。
- 旅宿入帳事件：receipt_id、actual_amount、received_at、bank/reference、claim_id（可選）、allocations、fees/adjustments。分配合計須等於本筆可分配金額，退款、調整另列。
- audit 及 outbox：每次修改的前後值、source/actor、version、事件 ID、同步狀態和錯誤。更正追加沖銷／修訂，不刪歷史。

## 跨來源與 Sheet 寫回（M3/M4）

M3 先將 OS、信用卡同步、抓單修改導入相同受控服務。事件 ID 冪等；同一金融事實被其他來源改過時要求 review，合法的新訂金／尾款不因來源不同就互相覆蓋。UI 和 Agent 共用 check -> update -> check。衝突建立 blocking child Mission，重試先重新核對。

人工改 Sheet 只能以來源快照發現差異，未取得身分證據時 actor=unknown；不能假稱輪詢能找回所有中間變動或編輯者。需要攔截所有覆蓋時，保護財務摘要並改由受控入口操作。

M4 新增同一份 Sheet 的「訂單財務摘要」，一張訂單一列：OS/OTA/OwlNest ID、三種狀態、確認應收／已收／餘額、最後來源／操作者／時間、版本及同步狀態。先 preview diff、比對目標版本，再最小範圍寫入、讀回。不得改工作表1的姓名、房間、日期、G 或現有 H。正式主表如果需要摘要欄，另經抓單固定欄位相容性驗證後追加受保護欄。

先保存 OS 事件，再建立待同步工作。Sheet失敗顯示「OS 已保存／Sheet 待同步」，保留原 event_id 重試；跨系統不是原子交易，絕不假設一次都成功。回讀確認才標同步完成。現階段不實作或啟用此 outbox。

## 上線及回滾門檻

M1：獨立唯讀頁＋可選保存對應，隔離測試不寫真實收款。M2：金額證據確認和三類事件、財務備份／匯出／還原測試。M3：所有 writer 修訂及衝突介面。M4：正式摘要寫回小範圍試行。

未完成 M2 備份與還原前不擴大歷史財務資料遷移。不得聲稱 Redis 無 TTL 等於已完成供應商備份。回滾 M1 只撤頁面/API，保留新 registry 和既有付款鍵；schema 不變，無破壞性 migration。

## 驗收

入口：財務 → 訂單財務摘要。可選旅宿，搜尋 OTA 編號／房間／入住日；手機卡片和桌面三欄均顯示付款、請款、入帳。四種帳號語言沿用設定。

- Agoda done 顯示舊請款標記，但沒有憑空新增旅宿入帳。
- 連住多晚的同一收款只出現一次；OTA 代收只影響客人付款證據。
- 未確認應收總額及餘額顯示待確認。
- 保存對應後重新整理版本存在；另頁先保存後舊頁提交收到衝突。
- 改期、改 alias 後保留既有 ID；另一個 ID 共用 alias 時警示，不自動轉帳。
- 消失的來源訂單仍保留歷史對應；沒有自動退款。
- 未登入 401、無財務權限 403，錯旅宿不可讀。
- 正式工作表1未被本功能修改。

## Review 與限制

M1 不替換既有財務首頁的舊估算、不啟用新財務寫入、不創建 Sheet 摘要。新頁一律清楚呈現未知金額。所有過往付款資料原樣保留。code review、測試、部署及 PR 狀態另記 M1_VERIFICATION.md；不得把未合併說成已合併。
