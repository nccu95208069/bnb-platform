# 水芳財務證據與候選對照契約

日期：2026-10-20（Asia/Taipei）

這份契約只用於受限環境的遷移核對。`sweetfun-finance-candidate.mjs` 接受已轉成 TWD 整數分的私有來源快照，輸出來源主張、衍生投影、零收入狀態及待核例外；始終回傳 `canStage=false`、`canCutover=false`，不建立 Iron Gate 收款事件。原始鍵、訂單鍵和快照不能寫入 Git、一般日誌或對外 API。

正規化輸入含 `osEntries`、`osReceipts`、`lineEntries`、`lineDetailProjections`、`sheetMarkers`。OS 財務原值 `amount_cents` 直接映為 `amountCents`；OS 私有收據的 TWD 元值須先以精確十進制轉為分，`received_at` 轉台北日期。LINE Firestore 整數元 `amount` 乘 100，`paid_on` 映為 `date`；同一張 Sheet 明細投影只作核對，不產生來源主張。原始 H 值映為 marker 而不換算金額。來源的 void 與狀態紀錄也保留於私有輸出，只有 active 主張進有效金額小計。正規化映射本身仍須以真實來源逐筆反向驗證，不能只通過合成測試就匯入。

| 來源 | 來源主張 | 不能另算一筆的資料 |
| --- | --- | --- |
| Sean OS `finance` 手動分錄 | 以分錄 ID 和原金額保留一筆收入或支出；逐單 `allocations` 僅是這筆分錄的分攤。 | 71 個配置不能拆成 71 筆實收；`source_paid`、主表 H `done` 和 O:Q 卡欄只是來源線索。 |
| Sean OS 私有收據 | 非 `status_only` 收據以收據 ID 保留一筆收款主張，對應 `payment:<receipt-id>` 日曆財務投影。 | 日曆投影不能再加總；零金額 `status_only` 收據與 H 附註不產生收入。 |
| LINE Firestore `entries` | 以 entry ID、版本、狀態、整數元轉分記錄目前有效的收入或支出，同時保存不可變版本與操作鏈作核對。 | `財務異動紀錄` 是明細投影，`訂單收款摘要` 是彙總；同一 entry 不可加算三次。作廢版本不是退款。 |

核對器要求每份來源內 ID 唯一、`status_only` 金額為零、日曆投影與私有收據 ID／金額相符、LINE 明細投影與 entry 版本／金額／類型／狀態相符，並檢查手動住宿收入的分攤總額。相同訂單、日期與金額出現在兩個來源時只標記可能重複，保留兩份來源主張，待原始收據及銀行／刷卡憑據釐清，不自動合併或刪除。來源快照與候選會以雜湊及雙向重算核對，核對器不能替代帳本備份。

正式導入前還需逐筆補齊：OS 完整私有收據和逐年帳本、LINE Firestore 不可變版本／操作／稽核／outbox／投影回執、每筆收退款的有效狀態與實際收付日期、來源訂單→正式 UUID、幣別／付款方式／帳戶／退款關聯、外部憑據，以及跨來源重複判定。銀行或刷卡實際入帳尚未驗證的項目只能標為帳本紀錄，不能標為已對帳現金。費用分攤、期初已收和卡累計須保存其原有語意；未知值不可補零。

目前受限唯讀核對：2026 OS 已讀命名空間有九筆手動收入、兩筆手動支出、一筆日曆收入；日曆收入已對到原始非狀態收據。十筆原始收據各對到一筆完成的任務，主表九個不同 H 請求對到九筆零金額狀態收據。LINE 只有一筆有效訂金 Firestore entry，已與不可變版本、操作、事件、audit、outbox、投影回執及 Sheet 明細逐層核對；其 OS 訂單無收據或財務配置。`audit-sweetfun-finance-sources.mjs` 只接受受限私有檔案，輸出匯總與雜湊；不輸出原始鍵，也不建立收款事件。此次候選來源內部例外碼為空，只代表所讀範圍一致，沒有證明外部銀行／刷卡結算、其他未發現來源或歷史完整性。詳細數量見[執行紀錄](SWEETFUN_MIGRATION_EXECUTION_2026-10-20.md)。
