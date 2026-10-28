# W7 歷史已付、現金明細未知處置候選（2026-10-28）

**狀態：設計候選，未合併、未部署、未寫入正式帳。** 此方案處理 Sweetfun 四筆舊 OS 零金額 `status_only` 與目前主表 `not_yet` 的衝突。業主逐筆確認三筆水芳實收、金額等於各訂單總額，另一筆未付；業主選擇不提供實際收款日期和方式。原始訂單、收據、決議與來源雜湊只存私有逐筆清單，本文不含訂單 ID、旅客資料或金額。

## 必須保留的區別

- `property_receipt` 是民宿實收的**現金事件**，現行 Iron Gate 契約需要真實 `cash_on`；沒有日期就不能把 OS 確認日、入住日或切換日填進去。未知方式也不能猜成現金、轉帳或刷卡。
- `operational_status` 的 `room_confirmed` 是**零現金狀態**。匯入它不會增加 `room_received_cents`，現行 `bookingFinance.remaining_due_cents` 與 OS 日曆付款狀態仍會從 money events 算出待收；不能宣稱單靠此狀態就完成「不再催收」。
- 訂房總價可作為業主所說「實收等於訂單金額」的**報告基準**，不是原始收據。每筆若有修改、折抵或退款，需重新核對，不能按訂房價建立金流。

## 建議的受限期初處置

新增與 money events 分離、逐館逐訂單的 `legacy_settlement_disposition`，只在正式切換前建立，狀態限 `settled_before_cutover_cash_details_unknown` 或 `unpaid_at_cutover`。它保留來源系統／實例、原 OS 零金額收據 ID 與版本、Redis 快照及 owner 決議 hash、已核對的 Iron Gate 訂單 UUID／版本／快照 hash、審核者／時間、訂單總額基準，以及獨立 request key。`cash_effect_cents` 固定 0，不含或推定 `cash_on`、付款方式及收單交易編號。原 OS 與 Sheet 值不改寫；衝突維持可見的稽核紀錄。

三筆業主確認已收：在應收讀模型顯示「切換前已結清（收款明細未核實）」並阻止重複催收，但**不增加已收現金與月份營收**。日曆付款狀態需獨立顯示此標籤，不能偽裝成有可回讀 `property_receipt` 的一般 `paid`。任一筆未來退款、改訂單金額、訂單版本變動或找到新的同筆收款來源時，先停在人工審核，禁止自動按未知原收據退款或二次入帳。

一筆業主確認未付：保留 `unpaid_at_cutover`，正常計算應收與催收；原 OS 的 `settles_room=true` 明列為已否決的歷史狀態，不匯入有效 `room_confirmed`，也不從來源刪掉。

## 寫入與回讀邊界

1. 僅接受固定私有 manifest 中精確的四筆來源身分；核對館別、source instance、收據 ID／版本／hash、完整 OS 快照 hash、業主決議 hash、IG 訂房版本／快照 hash、目前 Sheet 標記及同訂單 money aliases。來源或訂單有變動即重做 preview。
2. 使用專用 property-scoped preview → commit → 原 request key 回讀，且要求當時未啟用新財務 writer。資料庫以唯一鍵防重，同一來源與訂單的不同決議須人工衝突處理；不沿用 money command 來繞過日期驗證。
3. 讀模型分開呈現 `received_cents`（只含已接受現金事件）、`remaining_due_cents`（營運應收）、`historical_cash_detail_missing` 與 `collection_hold`。所有報表在涵蓋這些訂單的歷史期間標示現金明細不完整；不得把缺口當 0 或納入零差異現金總額。
4. 回讀需在固定 finance change sequence 逐筆比對四筆決議、原始來源 hash、訂單版本、現金效果 0、相關 cash event 缺席及保留的原 OS 衝突。最終切換還要獨立核對所有其他來源金流、未知請求、最後增量與 Offland 館別隔離。

## 驗收與限制

測試至少涵蓋錯館、錯版本／來源 hash、重複或翻轉決議、非零 OS 收據、待處理或失敗的 Sheet 同步、缺來源連結、既有競爭 money event、無授權帳號、過期 preview、未知 commit 回應，以及三筆已結清但 `received_cents` 不增加、未付的一筆仍可催收。正式帳目前沒有 finance 005–017 表，更沒有本處置資料表；此方案須先在隔離環境完成 schema/API/OS/LINE 讀模型及真回讀驗證。它不能證明原始銀行入帳日、付款方式或歷史現金報表完整，也不能取代正式切換時段的授權。
