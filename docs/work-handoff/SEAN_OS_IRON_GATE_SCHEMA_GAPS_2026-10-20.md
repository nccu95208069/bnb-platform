# Sean Sweetfun OS 與 Iron Gate：訂單資料結構缺口與遷移前決策

日期：2026-10-20（Asia/Taipei）  
範圍：水芳 Sean 自用版工作台的訂單、房晚、收款與財務呈現；不是 BnB SaaS 客戶工作區。  
狀態：依目前程式與[水芳遷移計畫](../../iron-gate/SWEETFUN_SHEET_MIGRATION_PLAN_2026-10-20.md)核對。唯讀盤點及備份準備可繼續；**真實資料寫入 Iron Gate 或切換正本之前，須先決定下列無損資料契約並做往返驗證。**

## 先釐清「結構」是什麼

Iron Gate 目前的 PostgreSQL 並不是一張可讓 Sheet 每列直接寫入的訂單表。[SQL schema](../../iron-gate/sql/001_property_store.sql)以 `iron_gate.property_state.state_json` 保存館別狀態，包含 `bookings[]`、`sourceLinks[]`、`fences[]` 和 `manualBlocks[]`；`occupied_room_nights` 是逐房逐晚的占用索引，另有 outbox 與稽核。這個設計能保護房晚與交易一致性，但不能據此推論所有 Sweetfun 來源欄位都已有正式語意。

[Iron Gate Booking 型別](../../iron-gate/src/types.ts)已保存 UUID、版本、`held/confirmed/cancelled`、多段 `stays[]`、姓名／聯絡／備註、`totalCents`、`bookedAt`、來源、可選 `paymentEvents[]`；`sourceLinks[]` 保存外部單號、來源版本及取消 tombstone。這些是**內部狀態**。[一般訂單查詢](../../iron-gate/src/service.ts)只輸出其中受權的一部分：房間與日期、狀態、版本、可選姓名／備註、訂單總額與收退款總計；它沒有輸出 `bookedAt`、外部來源別名或逐房晚價格。另有受權的 [`finance/ledger` 逐筆事件查詢](../../iron-gate/src/service.ts)，可讀收／退款事件 ID、金額、時間及憑據參照；它目前沒有 Sean OS 的款項種類、付款方式、帳戶、房費／其他費用配置及期初款語意。**因此問題同時有「未保存的欄位」和「已保存但尚未提供給 Sean 工作台的欄位」，不是資料庫故障。**

Sean 版現在的[日曆來源](../../frontend/src/app/api/v1/bookings/calendar/route.ts)是 `Sweetfun caledar 2025` 的快照及即時 Sheet 補充；[Sheet adapter](../../frontend/src/lib/booking-sources/sweetfun-sheet.ts)將 J 房晚 ID 與 L 父訂單編號分別轉成舊畫面 ID，逐房晚保留 G 房費。[收款 API](../../frontend/src/app/api/v1/order-payments/route.ts)用 `SF-...` 訂單 ID 核對來源並可能回寫 H 欄；[財務摘要](../../frontend/src/app/api/v1/finance-summary/route.ts)也直接讀 Sheet。現有 Iron Gate 只讀影子橋接是 BnB SaaS 工作區的單筆 UUID 查詢，不是 Sean 版日曆接線。

## 具體缺口與需要定下的決策

| 主題 | Iron Gate 已有 | Sean 版／Sweetfun 來源所需；目前缺口 | 遷移前須定下 |
| --- | --- | --- | --- |
| **來源與正式 ID** | 內部訂單、房間、館別為 UUID；`sourceLinks` 能綁一個外部單號及版本。 | Sheet 的 J 是房晚唯一 ID、L 是父單編號、N 是 OTA 單號；Sean 畫面及收款另使用衍生 `sheet-...`／`SF-...` ID。三者不可混作單一外部 ID，也不能因列移動重建訂單。 | 單一、持久的 J→房晚、L→父單、N→通路及舊 OS ID→UUID 對照；空 L、重複號、改號的處理；正式讀 API 如何回傳受權別名，並讓舊連結定位原單。 |
| **住宿與房況** | `stays[]` 支援多房、多段；占用索引可逐房晚防撞，另有 `held`、`fences`、`manualBlocks`。 | Sean 日曆要展示每個實體房晚、保留／封房與來源待核，退房日不占房。目前一般訂單列表不包含封房／待核房晚，也沒有 Sean 日曆直接可用的投影；現有日曆型別只有 `confirmed/cancelled`，無保留狀態。 | 定義一份含訂單、保留、人工封房、來源 fence、版本與新鮮度的受權房晚讀取契約；OS 畫面對未知／待核的呈現及停售規則。 |
| **房晚與訂單價格** | `Booking.totalCents` 可存整單 TWD 分；一般讀 API 有金額權限時回總額。 | Sheet G 是逐房晚房費；Sean 日曆、訂單明細及財務摘要需要逐晚／逐房配置。Iron Gate `Booking` 及現有來源事件沒有該配置，不能把整單總額除以房晚數來補。 | 決定逐房晚價格、其他費用、折讓及整單總額的無損模型與讀取欄位；來源不明時用 `null/待核`，畫面隱藏未核定價格，不顯示假 0 元。 |
| **收付款與退款** | `paymentEvents[]` 可存 received/refunded 金額與時間；`finance/ledger` 可逐筆查，普通訂單查詢只給總計。 | Sean OS 私有收款含款項用途、付款方式、收款帳戶、房費／其他費用配置、狀態同步及可能的期初／沖銷；主表 H 的 `done` 只是來源標記。現有 Iron Gate 事件契約不能無損承接這些語意，也不能從總計反推每筆實收。 | 逐筆事件及期初款的正式欄位、證據與退款關聯；哪些仍留在授權財務帳本、如何關聯 Iron Gate 訂單；避免 H 註記與 OS 帳本重複匯入。 |
| **來源資訊與訂房時間** | 內部有 `bookedAt`、`source`、`sourceKey`，`sourceLinks` 有外部版本。 | 一般訂單讀 API 不回 `bookedAt`、平台、J/L/N 別名或原始來源證據；`source` 只有 os/line/website/external，不能代替 Booking.com 等平台。Sean 畫面不能拿 Iron Gate `createdAt` 冒充客人訂房日。 | 分清訂房日、系統建檔日、通路、來源版本及可見備註；定義受權投影，敏感原文仍受限保存。 |
| **分頁一致性與權限** | 訂單列表可按日期／狀態分頁；OS 欄位授權可控制姓名、備註、金額。 | Sean 日曆一次顯示整月及跨月連住；列表每頁最多 100 筆，跨頁時若持續改單，可能拼出不同版本的月份。既有 Sean 登入／`sweetfun` 館別 ID 也不是目前 Iron Gate UUID grant。 | 定義同一館、同一版本的完整月視圖或可驗證分頁水位；Sean 專用伺服器端會員證明及館別 ID 映射，無權者不得取得客資／價格，瀏覽器不得持有服務憑證。 |
| **切換與寫入** | Iron Gate 有 authority epoch、版本檢查及請求防重。 | Sean 日曆、收款、財務摘要仍讀 Sheet；收款會寫私有帳本及 H 欄。Gmail、LINE、人工路徑也可能寫原表。只改日曆會出現兩套正本。 | 對 Gmail、Sean OS、LINE、H 回寫及其他 writer 建立同一館別開關；停窗排空與影子核對後一起切換，所有查詢與操作讀回同一權威版本。 |

## 建議的決定順序與驗收

1. **先定無損來源模型，再做真實匯入。** Iron Gate 與 Sean OS 共同定稿 J/L/N/舊 OS ID 對照、房晚價格及財務事件模型，並決定哪些資訊存在 Iron Gate、哪些保留於有權限的財務領域。不得把真實資料先壓成目前的 `totalCents + stays[]` 再期待日後還原。
2. **定稿版本化讀取契約。** 一般訂單、房晚與財務讀取各自有清楚欄位、權限、版本／水位與未知值；Sean OS 做伺服器端轉換，並保持原畫面的住宿、價格、收款及異常標示。即使內部已存 `bookedAt` 或逐筆付款，也須證明前台可受權讀回。
3. **合成資料先測，再逐筆雙向核對。** 測多房多夜、中間空檔、空 L、J 重跑、平台改單／取消、保留、封房、H `done` 但無實收、部分付款、退款及讀取中斷。真實來源每一列、每張父單、每個房晚和財務事件須在受限環境做來源→Iron Gate→Sean 畫面的雙向核對；差異逐項關閉。
4. **影子期與切換分開。** 唯讀盤點、私密備份與隔離影子試轉可繼續；未完成欄位契約、備份還原、三入口拒寫／改接與正式讀回前，`canCutover=false`，Iron Gate 不接管水芳真單。正式窗口仍按[遷移計畫](../../iron-gate/SWEETFUN_SHEET_MIGRATION_PLAN_2026-10-20.md)另行判定。

本文件記錄的是需要共同決定的介面與資料語意，不指定一定要新增哪一張實體 SQL 表；以版本化 JSON、獨立事件或受權財務帳本實作皆可，但須通過上述無損往返和操作驗收。沒有真實客資或來源單號寫入本文。
