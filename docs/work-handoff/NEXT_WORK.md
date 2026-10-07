# Next Work — Ordered Milestones and Acceptance Criteria

## P1 — 訂單與房晚查詢前台（2026-10-04 owner request）

- [ ] **ORDER-FINDER-P1：重要待辦。** 後端、Sheet 欄位與分頁可依資料正確性設計；使用者必須能透過清楚的前台找到一筆訂單或某間房的某一晚，不必閱讀原始帳本。
- **目前狀態：已依業者要求發佈正式網站，供親自走流程。** 詳見 [發布與驗證紀錄](ORDER_FINDER_2026-10-05.md#owner-authorized-production-release)。版本 `9dc8978` 保留當時正式站的分析功能，共 194 項本機測試與雲端建置通過。瀏覽器已恢復，可確認登入後的月曆、訂單查詢、空結果與清除條件；窄版實測為 400 CSS px，完整訂單／收款寫入、精確 360px 與實機驗收仍待完成。

### 第一版資訊與操作設計

1. **房況月曆：** 預設開啟當月，保留上／下月與日期跳轉。桌面以連續住宿呈現平台、旅客、房間；手機以每日房晚數搭配下方清單，避免姓名擠在窄格內。跨週／跨月仍指向同一訂單，完整連住資訊在明細保留。點日期展開當天房晚清單，點住宿開完整訂單。館別與房間篩選沿用使用者授權範圍；空白只表示未顯示紀錄，來源未核對不得宣稱可售。
2. **訂單查詢：** 姓名／訂單編號搜尋，加上日期類型、起迄日期、預訂平台；日期類型明確區分「住宿期間」「入住日期」「退房日期」「訂房日期」。住宿期間採房晚區間交集，退房日不算佔房。姓名支援去除前後空白與大小寫正規化；舊姓名欄內的需求註記保留在備註，不當作正式姓名，也可被搜尋。
3. **結果清單：** 每張訂單只顯示一次，列出旅客、平台、入住／退房、房間、總晚數與房晚數、訂單總額、已付／待確認，以及需注意事項。多房、多段與換房可展開，不重複累計整筆訂單金額。手機改成摘要卡，桌面用緊湊清單。
4. **共用訂單明細：** 上層顯示旅客、來源訂單編號、平台、訂房日期與住宿摘要；依序呈現全部住宿／每房每晚、款項、特殊需求與備註。從房晚進入時標出選中的房間／日期，並保留同單其他房晚。預設顯示業者語言，原始來源、對照欄位與系統 ID 放在可展開的來源資訊。
5. **款項語意：** 訂單總額與單晚金額分開；原始逐晚價格、平均分攤與未知必須有標記。來源累計已付不假裝成銀行入帳或有日期的收款交易；未知顯示「待確認」，不填 0、不算出假的尾款。具日期的實際收款另列明細；付款狀態、訂單狀態與資料異常各自呈現。
6. **待核對資料：** 提供清楚可找到的待核對入口；重複房晚、分組待確認、姓名缺漏須顯示不同原因。未完成轉換的來源紀錄不能因為不在正式訂單中而消失；可查看已知資訊及原因，不任意合併或選擇其一。
7. **返回與手機：** 切換月曆／清單、開啟明細、返回後保留查詢條件與日期。正式版用網址保存可分享的查詢狀態與深層連結，仍須登入及館別授權；桌面與手機都使用獨立單筆明細，鍵盤可操作，焦點返回原入口。

**2026-10-05 owner feedback：** 明細左側列出整月訂單，排序沒有說明且讓畫面雜亂。修正版移除明細旁的訂單清單與查詢控制，只保留目前選中的完整訂單、簡短來源導覽與返回入口；回到月曆／搜尋結果後再選其他訂單。訂單查詢清單按入住日期由早到晚，明示排序；同一日房晚仍按房號排序。這取代初版桌面清單＋側欄的設計。

**2026-10-05 owner follow-up — 明細的日期、收款、備註與標籤：**

- 日期區塊命名為「入住、退房日期」，每個房間／住宿段顯示實際入住與退房，不以逐晚拆分作為主要呈現。逐晚金額保留在可展開的明細。
- 訂單款項直接提供「已收款」操作，開啟金額、訂金／尾款／付清剩餘房費／其他收款、匯款／現金／信用卡、收款時間、收款帳戶／帳號與收款備註。允許分次登記，新增後更新收款紀錄與尾款；按鈕本身不直接把整單標成付清。現金不要求帳號；收款帳戶是旅宿的入帳帳戶，與客人的付款帳號分開。帳號在摘要遮罩顯示。
- 復用既有 `frontend/src/components/payments/os-payment-panel.tsx` 的分類、方式、時間及核對流程，以及客戶 `order-finance.tsx` / `use-command` 的版本、去重、重試與回讀規則。`finance/finance-workspace.tsx` 已有日曆收款自動列入財務、房費對應訂單／扣抵應收，以及帳戶名稱／末碼的 `payment_accounts` 模型；目前帳戶選擇主要在支出介面。正式版將既有帳戶能力整合進訂單收款，補齊收款端欄位與權限，不另建立無法與財務同步的收款帳。來源累計與平台已收不能重複登記；其他費用不抵房費；歷史金額未知時，新增明細不把未知歷史當成 0。
- 備註區有明確「新增備註／編輯備註」入口；保留既有文字，支援儲存與取消。款項備註與訂單備註分開。正式版需版本衝突處理、操作權限及變更紀錄，來源刷新不可默默覆寫人工備註。
- 「快速標籤」可直接勾選／移除，預設收據（收）、國旅（旅）、寵物（寵），另有嬰兒用品與晚到示例。業者可新增、編輯完整名稱、月曆顯示的一個字與顏色；同一旅宿共用標籤定義，以固定 tag ID 綁定訂單。改名／改色更新全部使用此標籤的訂單；不同標籤不可共用同一縮寫以免混淆。
- 桌面月曆在住宿條上顯示單字色標，空間不足顯示 `+N`；手機日期格顯示該日標籤摘要，點日期後依房間／訂單看完整標籤。顏色與文字並用，點進明細可見全名。標籤不取代已結構化的寵物數量、加床數量等實際需求。
- 互動稿提供本頁收款、備註、標籤的真實互動示範，但僅使用虛構資料，重新載入重設；正式持久化、API 與財務串接尚未完成。使用者輸入的帳號、付款及備註內容不送往外部服務或對話狀態。

### 資料與實作順序

- **A：統一唯讀查詢。** 接到客戶工作區既有訂單、住宿段、房晚、來源款項與實際收款；先做分頁／篩選／排序 API 與共用明細，再接月曆和清單。復用既有房況顯示與財務計算，不從標準 Sheet 六個分頁各自拼出一套前台狀態。
- **欄位缺口：訂房日期。** 目前 `Booking` 沒有獨立的來源訂房日期欄位；新增 nullable 的 `bookedAt`（保留來源與時區），匯入／手動表單需明確映射。`createdAt` 是系統建檔時間，不可冒充訂房日期；缺值可被「訂房日期未填」條件查到。
- **欄位缺口：預訂平台。** 現行客戶 `Booking` 也沒有獨立的平台欄位；應補齊可保留原值的標準平台與來源訂單編號映射。`entry=sheet/calendar/os` 是資料輸入方式，不能當成 Booking、Agoda、LINE 等預訂平台。未提供平台應顯示未填，不猜測。
- **B：查詢介面。** 先完成姓名／日期／平台篩選、訂單列表與共用明細，再完成月份房況、點日房晚與待核對入口。輸入搜尋做節流／取消過期請求；清單分頁，月曆按視窗查詢但明細取完整訂單，搜尋可跨月找出完整結果。
- **C：整合驗收。** 連結已授權的私有資料，測試館別權限、隱藏價格角色、手機與回上一頁。首次正式接資料須顯示來源更新時間、查詢失敗／空結果／載入狀態；查詢失敗不得顯示為無訂單。
- **示意界線：** 互動稿使用虛構旅客、日期與金額，查詢與明細已可操作，並示範本頁收款、備註與標籤編輯；不寫入正式帳本。正式款項寫入、訂單修改及部署仍沿用既有受控流程，不因 mockup 按鈕而宣稱完成。
- **互動稿檢查：** 已於桌面及 360px 手機檢查月曆、姓名＋平台＋訂房日期複合搜尋、兩房兩晚明細、來源累計已付、未知款項、訂房日期未填、返回條件與待核對紀錄。互動稿沒有資料 API；正式版尚須完成下列驗收。逐晚分攤需以最小貨幣單位分配餘額，確保房晚合計等於訂單總額。

### 驗收條件

以下勾選代表程式與資料／元件測試通過；不代表已完成瀏覽器或正式環境驗收。

- [x] 用旅客姓名或平台訂單編號找到跨月訂單，再限定訂房日期／平台；日期未填可單獨找到，且與建立時間不混淆。
- [x] 點月曆某天 → 某間房的房晚 → 完整訂單，在兩次點擊內看見旅客、所有房間／夜晚、訂單金額及備註。
- [x] 同單兩房兩晚顯示一張訂單、兩個住宿晚、四個房晚；金額僅計一次，退房當晚不列為該單佔房。
- [x] 跨週／跨月連住與換房能回到同一訂單；從夜晚進入明細可辨識原選取日期，不截掉其他住宿。
- [x] 金額／已付款未知不變成 0；來源已付摘要與有日期的實際收款可區分，逐晚分攤有標記。
- [x] 重複房晚、尚待分組與姓名缺漏均可查到；待核對紀錄保留，不以不可靠金額加入確認合計。
- [ ] 桌面與 360px 手機都能搜尋、篩選、開明細及返回；空結果可清除條件，載入失敗可重試，鍵盤可完成流程。
- [x] 跨工作區／館別請求被伺服器拒絕，無價格角色的回應不含款項；公開示意與版本庫沒有真實旅客資料。
- [x] 「已收款」可登記多次款項與方式／時間／收款帳戶；財務、訂單、月曆狀態來自同一筆已核對資料；重試不重複收款，現金不強制帳號，未知歷史不誤算尾款。
- [x] 備註可新增、編輯、取消及重新查回；收款備註與訂單備註不互相覆蓋。標籤可新增／編輯／選色／套用／移除，月曆單字色標與完整名稱同步，跨日期與多房顯示一致。

Latest order-report decision: [booking momentum and interactive charts](ORDER_MOMENTUM_2026-10-05.md) supersedes report chat. The payment release preflight observed production `dpl_6XJrBWS65ueS5byANoK5QUxTUfVk` serving commit `695f0b7`, including order-count clarification and chart month navigation. This already-live source is preserved in the payment branch.

## Calendar onboarding implementation and acceptance

[Live acceptance](CALENDAR_LIVE_ACCEPTANCE_2026-10-04.md) now verifies real Google consent, preview/save, refresh, revocation/reconnect, ICS/ZIP, email-link return and two manually invoked production worker executions in the approved synthetic scope. The [configuration guide](CALENDAR_GOOGLE_SETUP_2026-10-04.md) remains the runbook. The later [owner pilot release](CALENDAR_LIVE_ACCEPTANCE_2026-10-04.md#primary-domain-owner-pilot) promotes the primary domain, enables explicitly opted-in synchronization and verifies two actual platform cron deliveries. Real-device and broader live-data acceptance remain open.

Latest owner decision: [preview first and passwordless saving](CALENDAR_PREVIEW_FIRST_2026-10-04.md) is implemented. Google login/consent precedes preview; ICS/ZIP previews anonymously and asks for an email link only when saving. The former calendar contact/activation/password prerequisite is superseded.

Owner request: implement Google Calendar, iOS and Android onboarding and backend, then review and repair critical issues. See [actual implementation and review](CALENDAR_ONBOARDING_2026-10-04.md); the [original plan](GOOGLE_CALENDAR_FAST_ONBOARD_2026-10-03.md) records the earlier design.

- [x] **CAL-G0** — Source-aware intake/activation; calendar customers need no Sheet URL; isolated scopes, source references, blocks and bounded coverage.
- [x] **CAL-G1** — ICS/ZIP import, room/date mapping, per-event corrections, grouped preview, atomic commit/readback, exact retry, revised-source review, guarded undo and standard-workbook v2 output.
- [x] **CAL-G2-CODE** — Read-only Google OAuth, selected calendars, pagination, preview revalidation, reconnect and property-scoped credential removal. Tested with synthetic provider responses.
- [x] **CAL-G3-CODE** — Durable jobs, leases, retries, field ownership, source changes/cancellations and freshness checks. Continuous mode is gated by explicit configuration.
- [x] **CAL-IOS / CAL-ANDROID-WEB** — Separate intake options, account identification instructions, Google-backed connection and ICS/ZIP file paths, with explicit local-device limitations.
- [x] **CAL-REVIEW** — Review and regression coverage for authorization, money, source completeness, stale availability, retry and dependency critical vulnerabilities. See the repair record.
- [x] **CAL-GOOGLE-PROVIDER-LIVE** — Real consent, preview/save, refresh, revoke/reconnect, email/ICS/ZIP and persisted synthetic records verified in the protected candidate.
- [x] **CAL-GOOGLE-SCHEDULE-LIVE** — Vercel automatically invoked the promoted production worker at 06:45:25 and 06:50:25 UTC on October 4, both HTTP 200 with `vercel-cron/1.0`. No manual run was issued. The production registry was empty; real Google source-change processing was separately verified in the protected acceptance run.
- [x] **CAL-OWNER-PILOT-READY** — Primary domain, persistent customer configuration, approved owner Google account, real email login, three saved/reloaded synthetic bookings and guarded undo are verified. The owner can now import their own data; this is not a completed real-sample pilot.
- [ ] **CAL-MOBILE-LIVE** — Real-device file selection and OAuth return, including multiple accounts and cancellation recovery. Mac iCloud export is documented; iPhone-only/iCloud direct and Android device-local readers require a separate native/provider adapter.
- [ ] **CAL-PILOT** — Scoped real samples for per-room calendars, titles that identify rooms and check-in reminders; measure corrections and verify overlaps, recurrence exceptions and unknown money.

The intake chooses one primary source; additional calendar bindings can be reviewed within the property. Coverage requires explicit confirmation that all booking sources for the selected period are included. Color-based rules, multi-source declarations at intake, a pre-import month-grid preview and native device APIs remain design extensions, not claims of shipped behavior.

Latest customer-import implementation: see [standard workbook and conversion rules](STANDARD_SHEET_2026-10-03.md). The original sources remain read-only, owner/editor identity matching is removed, and grouped orders/nightly rows/calendar grids now normalize into a standard ledger. Remaining standard-workbook work is deployment acceptance and optional shared-drive provisioning for automatic copies, plus a separately specified continuous-source-sync contract. Do not reintroduce the superseded single-row-only or source-owner-email restrictions.

The historical backend work order below remains applicable. The later owner-requested ORDER-FINDER-P1 above adds a concrete operator-facing retrieval priority alongside that work.

## Milestone 0 — Verify the current truth

### Goal

Create a verified inventory of the real operating systems and data semantics before adding production writes.

### Work

- map every current Google Sheet column, formula, validation, and derived report
- document which system creates each field and which direction it syncs
- document Owlnest booking/inventory behavior and manual recovery steps
- distinguish production/private data from anonymized seed data
- identify one stable internal `property_id`, `room_id`, `order_id`, and row/version strategy
- confirm payment methods and how deposits, balances, additions, refunds, and OTA payouts are currently recorded
- record known bad-data patterns and actual operator recovery behavior

### Acceptance criteria

- one approved data dictionary
- one approved source-of-truth/sync diagram
- no unidentified write direction for the first payment workflow
- no production credential or PII committed to the public repository
- open questions are explicit, not hidden behind assumptions

## Milestone 1 — Freeze `check_order`

### Goal

Provide one authoritative order-resolution Tool that the Agent can trust.

### Contract requirements

Input may use:

- formal `order_id`, or
- bounded query criteria such as stay date, room, guest, external order number

Output statuses:

- `unique_match`
- `not_found`
- `needs_more_criteria`
- `data_integrity_conflict`
- `source_unavailable`

A unique order snapshot should include at least:

- internal/external IDs
- property/room
- guest display identity
- check-in/check-out
- source and order state
- total/expected deposit
- payment transaction summary
- received/balance/payment state
- version
- source freshness and synchronization warnings

### Acceptance criteria

- Agent cannot bypass unique matching
- overlapping active orders return an integrity conflict
- canceled/invalid records are handled deterministically
- same input produces a stable structured result
- tenant/property authorization is enforced server-side
- tests cover zero, one, many, overlap, canceled, stale source, and unauthorized access

## Milestone 2 — Payment ledger and controlled `update_order(record_payment)`

### Goal

Replace the prototype payment-state patch with a formal transaction model.

### Data work

Create a first-class Payment entity with:

- `payment_id`
- `tenant_id`
- `property_id`
- `order_id`
- amount/currency
- payment type
- method
- actual receipt timestamp/date
- reconciliation state
- source/operator/Mission/Step
- idempotency key
- timestamps
- reversal/refund relationship where needed

### Tool input

- official order ID
- expected version
- idempotency key
- amount/currency
- payment type/method
- received time
- optional note/source evidence

### Tool behavior

- validate role and property scope
- validate order state and amount
- detect duplicate operation
- enforce expected version
- write Payment transaction atomically
- recalculate received/balance/payment state
- append audit
- return new version and summary

### Acceptance criteria

- retry with the same idempotency key never creates a second payment
- stale expected version returns `version_conflict`
- unauthorized roles receive no mutation
- no-price role receives no monetary output
- payment/order summaries remain transactionally consistent
- audit links the owner instruction, Mission, Step, Tool, and final state

## Milestone 3 — Payment Golden Workflow and persistent Mission

### Goal

Complete one end-to-end Agent workflow: “the guest paid a deposit.”

### Work

- persist Mission and Step state
- load payment Playbook
- call `check_order`
- handle clarification/integrity statuses
- apply AI direct-modification/risk confirmation rule
- call controlled payment update
- call `check_order(order_id)` again
- compare final state with original instruction
- complete only after verification
- expose concise progress and outcome in UI

### Acceptance criteria

Test at least:

- normal unique order
- missing criteria
- not found
- unexpected amount
- duplicate payment retry
- concurrent version change
- permission denial
- Mission interruption at a Tool boundary
- overlap incident creates a blocking child Mission
- resumed Mission re-queries rather than using a stale snapshot
- final verification mismatch prevents completion

## Milestone 4 — Availability and recommended-direct pricing

### Goal

Answer authoritative availability/price questions without model calculation.

### Work

- define sellable inventory semantics
- account for orders, holds, manual blocks, maintenance, and external freshness
- implement `check_availability`
- define base/channel/recommended-direct rates
- implement `get_price`
- map conditions such as occupancy, minimum stay, and plan
- return continuous available periods and warnings

### Acceptance criteria

- checkout day is handled correctly
- model never calculates official availability from raw bookings
- price is bound to the correct room/date/conditions
- stale or uncertain external state is explicitly labeled
- no-price role cannot retrieve monetary values
- tests cover continuous periods, split availability, hold/block, maintenance, stale sync, and channel variation

## Milestone 5 — Direct booking plus Owlnest inventory closure

### Goal

Create a non-OTA booking safely and close external inventory.

### Work

- re-check availability at create time
- implement `create_order`
- optionally record supplied deposit
- implement Owlnest connector or approved browser-automation fallback
- implement `update_inventory`
- verify external state
- implement partial-success and repair Mission

### Acceptance criteria

- overlapping active order is rejected transactionally
- internal order and payment are idempotent
- external closure result is persisted
- internal success/external failure is `partial_success`, never full success
- repair retries do not duplicate the order/payment
- oversell risk is visible to the owner
- final verification includes both internal order and external inventory state

## Milestone 6 — Minimum Mission Manager and Scheduler

### Goal

Support real interruption, blocking, waiting, and scheduled work.

### Required state

- queued
- running
- paused
- blocked
- waiting_user
- waiting_external
- completed
- failed
- canceled

### Required behavior

- one Tool execution stream per property
- three priority classes
- switch only at Tool boundary
- dependency/blocking relationship
- revalidation flag on resume
- owner answer resolves only the related waiting Mission
- 09:00 morning-report Mission is enqueued as a soft schedule

### Acceptance criteria

- process restart does not lose Mission state
- waiting_user does not block unrelated work
- safety Mission preempts at the next Tool boundary
- scheduled report waits behind owner real-time work
- resumed report re-fetches stale inputs
- audit explains why every Mission changed state

## Milestone 7 — Morning report

### Goal

Produce a concise, actionable daily report based on verified Tools.

### Candidate content to validate with the owner

- today’s arrivals/departures/staying guests
- unpaid or partially paid near-term arrivals
- room/service preparation requirements
- payment receipts needing reconciliation
- external inventory sync failures
- active data-integrity incidents
- only the top actionable exceptions, not a dense dashboard export

### Acceptance criteria

- report data has an explicit cutoff/freshness time
- unresolved incidents are isolated from confirmed totals
- structured extra guest/bed/pet/baby-supply fields drive preparation items
- report can pause/resume under scheduler rules
- final report is stored and auditable

## Production-readiness gate before real guest data

Do not switch the public application from anonymized demo mode until all items below pass:

- every read is tenant/property scoped server-side
- every mutation has server-side role enforcement
- booking/payment/mission/audit tables have reviewed RLS/grants
- no-price responses are redacted before leaving the server
- production secrets are stored only in approved secret managers
- logs and errors are PII-safe
- invitation/auth flows are end-to-end tested
- SMS provider is configured only if phone login is actually launched
- backups and rollback paths are documented
- private spreadsheets/screenshots are excluded from public commits and fixtures

## Avoid during the next phase

- rebuilding the calendar from scratch
- adding more dashboard metrics before the payment workflow is real
- letting the Agent manipulate arbitrary fields
- combining search and update into one opaque Tool
- treating UI success toasts as authoritative completion
- implementing broad parallel Mission execution
- migrating SSOT before the first workflows are validated
- reviving the superseded PR #9 branch
# Calendar change intake — 2026-10-07 owner request

See [calendar change intake and deferred producer coordination](CALENDAR_CHANGE_ENDPOINT_2026-10-07.md). Implement the OS receiver first and coordinate bnb-pricing now. **LINE / Gmail / OwlNest room-toggle callbacks with `訂房小助手` remain a required TODO, deferred until the receiver is ready and its current deployment is complete, per the owner's explicit instruction.** Do not mark those producer hooks connected based only on receiver completion.
