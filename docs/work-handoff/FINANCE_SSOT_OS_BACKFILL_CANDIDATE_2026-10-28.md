# OS Redis 財務唯讀回填候選（2026-10-28）

此工作包提供**離線**的來源快照檢查、逐筆轉換候選及回讀對帳。沒有讀取正式 Redis、送出 Iron Gate 匯入命令、啟用財務旗標或發布。`matched` 僅表示所提供的私有快照和完整、固定水位的回讀檔在這個轉換契約下逐筆相同；報告固定為 `cutover_ready:false`，不能當 W7 切換核准。

## 私有輸入與使用方式

`iron-gate/src/os-finance-backfill.mjs` 的 `captureOsFinanceSnapshot` 接受注入的唯讀 `scan(cursor,pattern)` / `mget(keys)`。它對指定館別的 `sweetfun-os:finance:v1:<property>:20xx` 和 `sweetfun-os:payments:v1:<property>:<64 hex>` 各掃兩次、讀兩次，結果或鍵集合不一致就拒絕。`:mission:` 輔助鍵不是收款帳本，會排除。執行環境必須另外取得已授權的唯讀 Redis 連線與同一館別的原始付款訂單身分；本程式不包含正式連線設定。

私有 bundle JSON 的主要欄位：

```json
{
  "snapshot": {
    "schema_version": 1,
    "property_id": "sweetfun",
    "captured_at": "2026-10-28T00:00:00Z",
    "scan_complete": true,
    "records": [{"key": "sweetfun-os:finance:v1:sweetfun:2025", "value": "<原始 Redis JSON 字串>"}],
    "payment_orders": [{"property_id": "sweetfun", "order_id": "<原始訂單 ID>", "payment_order_id": "<實際付款訂單 ID>", "status": "current"}]
  },
  "source_instances": {"os_manual": "<connector UUID>", "os_legacy_payment": "<connector UUID>"},
  "links": [{"source_system": "os_legacy_payment", "source_instance_id": "<同來源 connector UUID>", "property_id": "sweetfun", "source_order_key": "<確切付款訂單 ID>", "booking_id": "<IG booking UUID>", "booking_version": 1, "snapshot_hash": "<64 hex>", "reviewed": true}],
  "catalog": {"categories": [], "accounts": []},
  "account_map": [],
  "known_aliases": [],
  "reference_events": [],
  "reference_complete": false
}
```

`payment_orders` 必須來自同一來源範圍的已核對身分。付款 Redis key 是 `sha256(JSON.stringify(payment_order_id ?? order_id))`；不能由雜湊反推訂單，不能靠客名、房號、日期猜測。`links` 必須是已審核、同館、同 connector 的 `finance_source_link` 對照；候選命令攜帶 booking UUID、版本與來源快照 hash。取消訂單、別館或歧義連結列入 review。`account_map` 也要帶相同的 `source_instance_id`，並與已讀回的 Iron Gate `catalog` 帳戶／分類及人工確認一致；缺少或不一致的帳戶／分類不會悄悄丟棄。外部提供的 `payment_orders` 並非這個 Redis 雙讀的一部分，仍須另外證明它在同一來源水位完整，否則不能用本報告核准切換。

含金流和原始 Redis 值的 bundle、plan、回讀與報告必須存於私有位置。CLI 只接受儲存庫外的絕對路徑、使用不覆寫模式和 `0600` 輸出權限；終端只印聚合數量：

```sh
node iron-gate/scripts/os-finance-backfill-offline.mjs plan /private/bundle.json /private/plan.json
node iron-gate/scripts/os-finance-backfill-offline.mjs reconcile /private/plan.json /private/readback.json /private/report.json
```

## 轉換邊界

- 手動 entry 保留原始 `id` 和所在的**原年度 Redis key**。`history[].before`、目前版本及 void 依原 operations 鏈建立 `create → amend → void`，修改有前版反向事件，作廢淨效果為零。原始 operation ID/hash、`redis:<年度>:<原 state 版本>`、原 actor 的館別雜湊及來源時間保存在私有 plan；money 命令的 `source_version` 使用這個原 Redis 版本，並攜帶原版本快照 hash、actor 與時間。目標逐筆修訂序號另由 `expected_version` 和回讀的 `revision_version` 核對。跨年度改付款日不會把 entry 移到另一年度 key。
- 支出付款日只建一筆現金事件；`expense_spread` 原整數分、原月份、連續順序均逐筆保留為 `os_source_exact` attribution。來源零分月份無法由現行 IG 正分 attribution 表達，列入 review，不自行改攤。
- 週期規則、預計 OTA payout 規則、帳戶和成本分類是非現金候選。已實付 occurrence 是另外一筆手動支出；現行 IG 金流命令無法同時保留原 entry ID 與 `(recurrence_id,occurrence)`，此筆明確列入 `RECURRENCE_LINK_UNREPRESENTABLE` review，原 due date 保存在私有 plan。不能把規則當支出，或把作廢的 occurrence 當已付。
- 舊收款使用原 receipt ID，收款時間轉台北現金日。`status_only` 只建立 `room_confirmed`、`settles_room=true` 的零現金候選；非零收款若另有 `settles_room=true`，會分為一筆現金和一筆零現金狀態。`origin_source_version=redis:ledger:<原 append 版本>` 由 receipt audit 證明；無 audit 時，只有 `ledger.version===receipts.length` 的純追加帳本才可由位置推定。`receipt.source_version` 是訂單來源指紋，不是帳本版本。Sheet pending／失敗的狀態不得當已核實。
- `method='ota'`、取消訂單、缺精確來源連結、錯館、無可驗證付款帳戶、無原始收款的退款、重複 receipt ID，以及與 IG/Card/其他來源同訂單、同額、相近日期但無共同交易 ID 的紀錄都留 review；不自動合併，也不把 OTA 代收推定為民宿已收。
- 原始描述與收款備註不送進 money 匯入命令。來源 actor 以 `os_actor:<sha256(property:original_actor_id)>` 供 IG 私有稽核；缺原 actor、來源時間或可核對原版本的候選列入 review，不以匯入者取代。分類由原 entry／rule 及歷次 `history.before` 盤點；它沒有獨立的 Redis catalog。內建分類只有程式常數，若 IG 尚未設定，就列 `BUILTIN_CATEGORY_CONFIGURATION_REQUIRED`，不可借用第一筆付款的 actor／時間假裝分類建立來源。自訂分類只有名稱、代碼和首筆使用操作可完整核對時才列非現金匯入候選。衝突名稱與無法定位首筆來源操作的自訂分類保留 review。預計 payout 規則若同平台有多個歷史版本而不能重建每版內容，也保留 review。

分類與帳戶可能需要兩階段：先用已核對來源匯入非現金 catalog，再從 IG 讀回，重跑 plan 取得使用該分類／帳戶的 money 候選。這份離線工具**不會提交**任何階段；現有 IG 影子 money API 仍須逐筆 preview、取得含版本的精確命令與短效 token、commit、按原 request key 回讀 receipt。未知回應不能換 key 重送。

## 對帳輸入及限制

`readback` 需含 `complete:true`、同一個 `as_of_change_seq`、`unsequenced_event_count:0` 及**完整** `events[]`，其中每筆保留 `id/document_id/source_instance_id/source_system/source_record_id/revision_version/source_version/revision_action`、現金效果、分類、付款方式／帳戶、來源 actor／時間、evidence ref、bookings allocation、expense attribution、evidence level 與 document status/version。另須含 `receipts` 物件，以每個 money `request_key` 為鍵，值為固定原 key 回讀的 IG accepted receipt，保留 document ID/version 與 `origin_request_hash`。非現金資料另附 `catalog:{complete:true,next_cursor:null,as_of_change_seq,entries:[...]}`，其 `entries` 為 IG `imports/catalog` 固定水位的全部分頁合併結果，帶 `source_version`（原 Redis 版本）、`target_version`（IG 修訂版）、來源 provenance、`imported_payload` 及 `target_current`。既有而非本次匯入的分類／帳戶另附相同水位的 `existing_catalog`。分頁缺頁、水位不一致、任何一筆來源缺失或多出、金額／版本／分攤／證據級別不一致，都會產生具 source ID 的差異，不會只比較總額。

`operational_status` 是逐版新增獨立目標列，對帳會檢查每版的 `target_ref`、目標 ID、來源 connector、版本、狀態、booking 及原始時間；舊版目標缺失或被改動也會報差異。週期與 payout 規則是更新同一目標列，只用最後一版核對目前狀態，歷次輸入仍逐版核對 catalog provenance。

仍需完成 W0 真實來源快照、既有 IG/Card/LINE/Sheet 的精確 alias 和 ownership、來源 high-water mark、正式館別私有備份、已審核來源連結、非現金匯入 API 的實際回讀、所有 review 人工處理、W7 最後 delta 和營運入口排空。尤其歷史 occurrence 身分模型尚未解決。合成測試通過不代表正式來源差異為零。

本地驗證：`node --test iron-gate/tests/os-finance-backfill.test.mjs`，涵蓋跨年度修改、修正／作廢、奇數分攤、台北跨日、零現金狀態、精確付款別名、未知來源、重複 ID、卡片疑似重複與變動快照拒絕。
