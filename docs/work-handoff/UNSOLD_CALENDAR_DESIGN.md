# 未售出日曆與 T-39 整合設計

2026-09-05。範圍：在既有日曆加入已售／未售切換、未售月／週／日檢視、
房晚詳情、連住查詢、調價預演與持久化交辦。第一版維持本機合成資料。

## 來源核對與決策

已讀 bnb-pricing 的 T39_DYNAMIC_PRICING_BRIEF_2026-09-05.md 與交接包欄位，
並核對 docs/specs/t39-dynamic-pricing.md 的 git blob 指紋：
`a3cb13a27c0aca3078290b41e94e98837e933879`。正式規格優先於背景文件。
只借用契約與控制語意，不複製私有營運快照、manifest、journal、機密或歷史數據。
不修改、重跑另一個 Agent 的定價引擎。

- 上方右側切換已售／未售；保留旅宿、月週日與日期脈絡。
- 主價先採目前選定通路售價；旁列尚未發布的建議價與差額。本階段採此可逆預設，業主已略過偏好問題。
- 第一版先做預演與交辦；正式發布沿用既有 T-39 TTY 核准、guard、journal、
  coverage、五通路讀回。本階段只儲存本機示範交辦，不接引擎或發布。
- 未售出涵蓋可售、暫留、封房、維修與未知；已售格在週檢視中保留位置。
  空白／缺快照不能當成可售，網頁「沒顯示房間」也不能當成已售。
- Availability 與定價資格分開：holdout、pm_skip、超出模型地平線仍可能可售，
  但不能進一般調價清單。春節待補價不自行猜牌價。
- 通路系統價、客人前台實付、原價／基準、下一輪建議價各自標示。
  T-39 不提供即時入住率驅動的預測，本 UI 不宣稱模型已驗證獲利。

業主最新指示：先使用假資料，不持續串接或接收真實房價。價格約每 3–5 天
更新一輪，涵蓋至少未來 90 天的未售房晚。UI 用兩輪示範資料呈現同一房晚
隨輪次變價；房價以 room/date/channel/price_version 查詢，連住逐晚重查。
`demo_cycle` 僅是本機 fixture 選擇，不是正式引擎控制參數。正式接入改用引擎
提供的版本與覆蓋範圍；目前 90 天建議範圍依核對的 spec，不能自行外推。

## 三種檢視

月：日格內顯示可售房數、房號／目前價、待處理標記；點房晚開詳情，
點日期進日檢視。手機保留摘要，不把六房完整表硬塞七欄。

週：房間為列、日期為欄；目前價、建議差額與可售狀態並列。
已售、暫留、維修等格保留，避免把不連續空房看成可連住。

日：房間卡片與完整三種價格、更新時間、最少晚數、定價保護原因。
查連住時由 Tool 核對每晚，任何未知／封房／缺價均不回成功報價。

## 人與 Agent 共用

`check_availability` 回傳權威 adapter 的完整房晚狀態、連續區間、限制、版本。
`get_price` 綁 room/date/channel/stay length，回完整逐晚價與總額或明確不足。
`preview_pricing` 重新檢查選取範圍及 snapshot_id，輸出可提案與排除清單、原因。
`create_pricing_mission` 使用同一份預演、穩定 idempotency key 與 persistent Mission。
交辦狀態是等待定價引擎，不是已發布，也不新增獨立 Mission 資料庫。
Agent 直接用 scoped API；人用日曆與任務中心接手，無需操作任意 DOM 或 cells。

本機展示使用明確的合成 inventory/price adapter 與既有測試訂單 ledger。
不是從沒有訂單便推論正式可售，也不是重寫 T-39 分數／劑量／日型函式。
合成示例涵蓋保留、維修、來源過期、holdout、人工豁免、遠期與缺價。

## 正式接入契約與前提

1. 確認 SaaS property/room ↔ T-39 room ↔ OwlNest room_id 的唯一 mapping。
2. 房況來源須區分 sold/held/blocked/maintenance/unknown，並提供觀測時間、
   範圍覆蓋、version；daily_snapshot 的缺列不具此權威。
3. 接收引擎 export：基準 version/hash、spec fingerprint、plan hash、coverage、
   原始/有效乘數、建議價、保護理由。plan 未列入的格不能補算成建議價。
4. 每通路讀回證據與 guest-facing quote 分列。confirmed journal 的既知語意缺口
   尚未解決前，不把它當成已發布真值。
5. 正式價格寫入仍走既有核准器；UI 核准不能替代 TTY/HMAC，也不繞 holdout。
6. 若基準／spec／inventory 過期、資料缺漏、跨旅宿或權限不足，拒絕預演／寫入。

## 驗收

- 月、週、日可切換；選定日期與旅宿維持，手機可操作。
- 已售退房日可重新可售；維修／暫留／未知不計入可售，重疊視為異常。
- 缺價顯示待補，不當作零元；連住每晚皆需可售且價格齊全。
- 查價通路與每晚條件一致，不從 UI 計算正式總額。
- holdout/pm_skip/遠期/待補價都不進一般調價提案。
- 價格隱藏角色在 API 回應中沒有金額；Viewer 不可交辦調價。
- 過期 snapshot 拒絕；重送相同交辦只建立一筆 Mission。
- 付款日曆與既有付款任務不回歸；來源為合成資料清楚可見。

## Agent 呼叫契約（本機示範）

與付款相同的 scoped root：
`/api/v1/tenants/{tenant_id}/properties/{property_id}/payment-workflow`。
一般 API 保留身分驗證與資料庫 property membership；fixture adapter 預設關閉。
啟動沿用 `AGENT_PAYMENT_PLAYBOOK.md` 的本機服務，sandbox 專用入口為 8765，
人類 UI 為 3000 的 `/calendar?mode=unsold`。本機代理在 production 一律拒絕。

共同 query：`start`、`end`（退房日，不含末日）、`rooms`（空陣列代表全部）、
`channel`（direct/airbnb/booking/agoda/owljourney）、`demo_cycle`（1 或 2）。
每次查詢限制 1–93 晚；這是 API 請求大小，與 90 天模型建議範圍不同。

1. POST `/tools/check_availability`：共同 query，取得 `snapshot_id`、完整房晚、
   各狀態數量與連續可售區間。連續區間本身不保證符合最低晚數或價格完整。
2. POST `/tools/get_price`：共同 query 加 `room`，逐晚重新查核；成功為
   `quote_ready`、`total` 與逐晚價格。未知、缺價、不可售或最低晚數不足時
   為 `not_quotable` 且 `total=null`。試算不是可直接下訂的保證。
3. POST `/tools/preview_pricing`：共同 query 加 `expected_snapshot`，輸出
   proposed/excluded 與原因。版本不符回 409，必須重新查核而不是重送舊版本。
4. POST `/pricing-missions`：再加 `goal`、`idempotency_key`；Owner/Admin 可保存
   `kind=review_pricing` 的 persistent Mission 與 audit，重送相同內容只保存一筆。
   `waiting_external` 在此表示示範交接停點，沒有背景 worker 或引擎連線。
   GET `/missions/{id}` 可由人或 Agent 讀回原 query、版本、提案與排除原因。
   既有付款的 advance 不會執行調價，這版沒有價格發布 Tool。

viewer_no_price 的 availability 回應不含 pricing；get_price/preview/交辦均拒絕。
Viewer 可讀取價格與預演，但不能保存交辦；Housekeeper 不能交辦調價。

## 本機驗證紀錄

- 後端 211 項測試通過，含 9 項新增房況／價格／交辦測試。
- 覆蓋退房不佔房、重疊、暫留／維修／封房／未知、缺價、最低晚數、逐晚總額、
  通路／輪次版本、holdout／pm_skip／遠期、409 重新核對、冪等與權限隔離。
- 前端建置與 TypeScript 通過；lint 無錯誤，保留原 week-carousel 一項未使用 import 警告。
- 瀏覽器已驗證兩輪變價、最低兩晚限制、保存交辦、任務中心重新整理仍保存。
- 實際調價引擎、預測售出機率、正式房況和通路讀回均未連接；所有價格為虛構。

## 2026-09-05 操作一致性修正

- 未售月曆「另幾房」沿用已售的原地整週展開，提供整列收合；點日期才進日檢視。
  已售原有的展開後收合按鈕判斷也已修正。
- mode/view/date/room/channel/cycle/expanded/stay/order 由網址與瀏覽歷程共同管理。
  同一次點擊造成的日期及檢視變更只記一筆，Back/Forward 還原畫面、房晚詳情、
  展開列與篩選，不只是改地址。調價預演暫存在 history.state，不寫入分享網址。
- 手機跨網路預覽透過帳密保護的 HTTPS gateway 轉送本機假資料服務；未登入 401，
  已登入房況讀取 200，異常 Origin 403。帳密、暫時網址與 tunnel 設定不加入 repo。
  3000/8765/資料庫仍只綁 loopback，production proxy 仍拒絕，未發布正式網站。
- `PAYMENT_SANDBOX_PREVIEW_ORIGIN` 僅額外允許指定 HTTPS 預覽 Origin；搭配 gateway
  的驗證與 Host 轉送，不能單獨作為公開部署的授權機制。Next dev origin 同步限制。
- 此預覽需電腦與背景服務持續運行；不是常駐正式部署。
- 瀏覽器測試腳本見 `frontend/tests/browser/calendar-navigation.js`。

本次驗證：前端 lint 無錯誤、TypeScript／build 通過；桌機 16 個導航斷言通過，
外部 HTTPS 手機尺寸的 9 個查房／報價／保存交辦／Back 還原斷言通過，瀏覽器無錯誤。
返回任務中心前的已保存提案會保留交辦內容與保存結果；打字與伺服器確認回應更新
同一筆瀏覽紀錄，不額外增加頁面。所有網路測試資料仍為 synthetic preview。

## 2026-09-06 精簡顯示（業主最新決策）

暫時隱藏示範價格輪次、連住查價、調價預演與交辦。以
`frontend/src/lib/availability-features.ts` 的三個顯示開關控制，均預設 false；
未來業主要求時可個別恢復。舊網址的 cycle 與舊 history 提案不會重啟隱藏功能。
目前顯示第一組合成價格，保留每房／每晚／每通路的版本資料模型。
任務中心暫不列出調價交辦，舊連結顯示已暫停；既有資料與後端 Tools 保留。
已售付款流程不受影響。前述完整調價瀏覽器驗收須重新開啟對應開關後才能執行。
