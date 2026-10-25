# 水芳新直訂收退款與財務首頁 — 2026-10-25

## 狀態與範圍

工程、隔離驗證與業主授權的正式發布已完成；2026-10-25 08:42（Asia/Taipei）正式回讀通過。
本次只把 Iron Gate `source=os` 新直訂的收退款事實接入 Sean OS 財務首頁。
不把歷史主表 `done`、LINE Firestore 訂金、匯入來源付款欄或遷移證據轉成新收款。
已登記款項不代表銀行或刷卡結算已核實；此功能不執行銀行轉帳。

## 寫入前正式核對

2026-10-25 約 02:35（Asia/Taipei），以既有登入者唯讀查詢及 Supabase 聚合核對：

- 水芳 Iron Gate authority epoch 1、inventory version 79；1,624 張訂單。
- `source=os` 僅一張已取消的既有驗收訂單，付款事件 0；全館付款事件也是 0。
- OS 2026 帳本 version 14；12 筆分錄：9 筆手動收入、2 筆手動支出、1 筆日曆收入。
- 分錄 ID 重複 0；有效住宿收入缺訂單連結 0。
- 新直訂 UUID／`IG-` 訂單鍵／舊收款鍵／分攤連結的交集 0。
- 正式財務頁當時仍回 `iron_gate_direct_excluded=true`。

此核對只涵蓋已讀取的 OS 帳本與 Iron Gate 狀態，並非外部銀行對帳或所有歷史來源的完整性保證。
本次沒有修改正式訂單、房晚、收退款事件或舊帳本。

## 寫入、去重與回讀

Iron Gate 新增 `GET /v1/properties/:id/finance/direct-snapshot`，以一次權威狀態讀取回傳
所有原生 OS 訂單（包含暫留與取消）、房晚、整單金額、版本及追加式收退款。
獨立財務 grant 只需 `finance:ledger` 和 `money`；OS proof 使用當前登入者，並核對館別、
工作區與 epoch。不回傳姓名、聯絡方式、備註或來源原文。

快照 revision 包含付款事件與訂單版本；付款不改 inventory version 時也能識別財務變更。
超過 5,000 張或 2 MB、未知金額、房晚錯誤、事件重複或加總不符時停止顯示，不能截斷合計。

每筆事件只投影成 `iron-gate:<property-id>:<event-id>` 一筆收入或退款，不複製至 Redis。
如果舊帳本已有同一新直訂的明確身分連結，整合讀取與新登記皆阻擋。
舊付款入口與通用住宿收入配置也拒絕原生 Iron Gate 訂單。

日曆與財務首頁共用同一收退款表單與 API。登記流程為：完整來源核對 → 同館付款鎖 →
Iron Gate 版本／憑證／金額／防重檢查 → 原訂單回讀 → 財務投影獨立回讀。
只有確認同一事件的訂單、類型、金額、方式、時間、憑證與退款連結，才回 `financeVerified=true`。
收款不得超過剩餘應收；取消訂單不能新增一般直訂收款。
退款必須選同單原收款，不可早於原款或超過其未退額／整單淨收款。
既有 website hold 的遲到款處理維持原契約。

瀏覽器在送出前保存原請求鍵與原內容；結果不明時保持待查。
重開頁面後先查原請求，只有權威端回 `REQUEST_NOT_FOUND` 才提供同鍵同內容重試。
已寫入但財務讀取失敗仍是「結果尚未確認」，不能另建付款。

## 首頁計算與操作

- 已收與應收使用整單金額，房晚不重複乘算；已收為收款扣退款後淨額。
- 暫留／取消訂單不算入住月份營收或應收；其實際收退款仍依台灣收付日列現金紀錄。
- 退款獨立顯示並扣現金淨額，不算營運費用。
- 直訂可從應收清單、直訂區塊或原分錄進入收退款。取消後仍有淨收款者保留退款入口。
- 只有完整取得整合快照，首頁才移除「新直訂尚未併入」提示。
- 舊 `/api/v1/finance-summary` 的保守 Sheet M1 摘要仍明示新直訂排除，不宣稱其他報表已遷移。

## 驗證

- 前端 API／投影／防重／既有帳本回歸：116 passed。
- 表單 DOM：3 passed，含缺少財務確認時保留請求、取消後退款模式、重開頁面同鍵重試。
- Iron Gate 全套：268 passed、9 skipped（需另配外部／本機資料庫的測試）。
- TypeScript 通過；frontend lint 0 errors、7 個既有 warnings；production Webpack build 通過。
- Python API：166 passed、45 skipped；專案虛擬環境 Ruff lint 與 format 通過。
- 隔離環境使用真正 OS API、簽章 Iron Gate HTTP handler 與記憶體 repository／Redis；
  覆蓋收款、部分退款、取消、跨台灣月份、整單總額、同請求重送、版本衝突、超額、錯誤退款連結、
  舊帳本衝突、錯誤權限／epoch、讀回失敗與恢復；未對正式帳本製造驗收款項。

## 正式啟用計畫與回退

發行前重新確認實際正式部署及其他進行中的更新。本次期間 Offland PR #78 的未合併程式
已部署到 OS 與 Iron Gate；不能從較舊的水芳分支直接部署而覆蓋它。
發行候選須包含當下正式來源，對重疊檔案重新檢查、測試及建置。

僅在 Sweetfun OS **Production** 配置下列四個設定，沒有 Preview 憑證傳送需求：

| 設定 | 精確範圍 |
| --- | --- |
| `IRON_GATE_SWEETFUN_FINANCE_GRANT` | 獨立 OS credential；水芳目前 workspace/property/epoch；`finance:ledger`；`money` |
| `IRON_GATE_SWEETFUN_FINANCE_ENABLED` | `true`，先啟用完整唯讀投影並核對舊帳本未增加 |
| `IRON_GATE_SWEETFUN_MANUAL_PAYMENT_GRANT` | 另一張 OS credential；同水芳範圍；`booking:read`,`payment:write`；`money` |
| `IRON_GATE_SWEETFUN_MANUAL_PAYMENTS_ENABLED` | 財務讀回成功後才開 `true` |

兩張 credential 最長 30 天，token 僅存 Vercel Sensitive server settings；資料庫只存 hash。
既有 OS proof key 沿用，不擴增 guest fields、館別、外部來源或庫存寫入權。
新增 credential 的實際交易與非敏感範圍／效期讀回列於下方正式發布證據。

部署順序：保留現況的 Iron Gate → OS 完整財務讀取 → 既有 owner 正式網域 GET 回讀 →
開收退款 → 再核對財務與日曆能力開關。匿名及低權限拒絕、舊帳本版本／筆數不變、
新投影 revision 與直接訂單數一致皆須確認。沒有指定真實款項時，正式驗收只讀資料，
收退款寫入鏈路採隔離合成測試；不憑空登記真實營收。

如啟用後讀取異常，先關付款開關，再回退財務讀取；保留全部正式收退款與原請求鍵。
已有新事件時不得回退成允許舊入口重複收款的版本，也不得刪除／作廢事件來掩蓋失敗。
關財務讀取時 UI 必須恢復明確排除提示。保留其他館別的當前正式設定。

## 業主授權的正式發布與回讀 — 08:37–08:43

業主明確授權正式發布、建立兩張水芳專用且最長 30 天的憑證，僅放正式環境，
開啟收退款及財務整合，保留 Offland 更新，且不新增正式測試款項。

實際 runtime 為 `5f152401a52f83a816b611b76f68a44f4423557a`，
分支 `codex/sweetfun-ig-finance-release-20261025`，完整保留 Offland `0b17dff`。
只有付款錯誤訊息表需合併，水芳直訂入口限制與 Offland 待對帳限制均保留。
合併版通過 127 項前端測試、278 項 Iron Gate 測試（9 skipped）與 production build；
發證準備另有 2 項通過的範圍／秘密隔離測試。PR #79 原功能 commit 的五項 CI 全通過。

| 服務／階段 | 正式部署 |
| --- | --- |
| Iron Gate | `dpl_FDAPxPSFgXimCTXGnrPyDa23gcCA` / `iron-gate-22s4p8m2k-sweetfuns-projects.vercel.app` |
| OS 先開財務讀取 | `dpl_33GcFNLz3KLjFPsxMe9sDSNtDZpt` / `sweetfun-r9rfj587h-sweetfuns-projects.vercel.app` |
| OS 最終收退款啟用 | `dpl_5cV7Xuy9cQgeuFu5zmejCavBT9e8` / `sweetfun-348daok34-sweetfuns-projects.vercel.app` |

三者皆以 Production 建置、先 `skip-domain`，READY 後才 promote。
獨立 alias 回讀確認 `iron-gate-green.vercel.app` 和 `sweetfun-os.vercel.app` 指向上述最終版本。
未登入的後端財務與 OS 財務 API 都回 401。

`scripts/prepare-sweetfun-finance-grants.mjs` 只在私有暫存目錄準備秘密與 hash-only SQL。
實際 SQL 在同一短交易確認水芳 workspace／epoch 1／非唯讀狀態，新增兩張獨立 OS grant，
同 ID 同內容可重跑，既有其他 active 同用途 grant 或不符內容會停止。
獨立資料庫查詢再次確認 token hash、完整 scope、active 與 expiry 全部相符。

| 用途 | credential ID | actions／fields |
| --- | --- | --- |
| 財務讀取 | `e7965348-11df-4bf6-96e7-e937eb3043b9` | `finance:ledger` / `money` |
| 收退款 | `4aa22423-20bc-4e03-a064-957d2b68e824` | `booking:read`,`payment:write` / `money` |

兩張均於 **2026-11-22 08:37:27 Asia/Taipei** 到期（28 天），屆期前須輪替。
Vercel 獨立回讀確認兩項 grant 是 Sensitive 且只有 `production` target，兩項功能開關均為 true。
沒有 Preview／Development 副本；原 OS proof key 沿用。讀取驗證後已刪除整個私有發證暫存包。

正式 owner 瀏覽器讀回：

- 財務 `iron_gate_direct_excluded=false`；來源 revision 為
  `8d4979855c87a871155d022aebe3102641cb6e82181c16d711251c3cfe3a0681`。
- 舊帳本仍為 2026 version 14、12 筆；原分錄排序後 FNV-1a 內容指紋前後均為 `c363ad1b`。
- 財務訂單由 1,606 增至 1,607，新增投影是原已取消且零收款的 OS 訂單，應收與營收不增加。
- 日曆 `iron_gate_manual_payment_enabled=true`，來源 errors／warnings 皆空；
  水芳來源 version 79，Offland 仍顯示「OFFLAND 訂房表」。
- 原已取消訂單的 payments GET 回 version 4、events 0、淨額 0。
  財務頁的「查看收退款」能開啟同一明細；表單中登記收款停用，沒有送出任何款項。
- 最後資料庫聚合：水芳 epoch 1/version 79/1,624 訂單/0 付款事件；
  Offland epoch 0/version 1/唯讀/270 訂單/0 付款事件。

正式沒有建立測試訂單或測試款項，也未改舊帳本。實際收款、部分退款、重送與失敗恢復的
寫入循環以隔離測試驗證；正式驗收是登入讀取、入口權限、來源一致性與 UI 核對，未宣稱銀行結算對帳。
