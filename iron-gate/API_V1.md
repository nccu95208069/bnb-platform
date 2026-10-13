# Iron Gate API v1：介面與程式落地規劃

日期：2026-10-13（Asia/Taipei）
狀態：**可執行的合成驗證版本；未部署、未接真實訂單或 OwlNest**。產品權威與遷移決策仍以 [Iron Gate v1](IRON_GATE_V1.md) 為準；機器可讀路徑及請求格式見 [OpenAPI](openapi.yaml)。

## 1. 第一個可執行切片

| API | 現有程式 | 正式接線前仍需 |
| --- | --- | --- |
| `POST /v1/properties/{propertyId}/bookings` | OS 來源的 confirmed 訂單、房晚撞房、版本、防重、PostgreSQL 交易與持久 outbox、無通路／OwlNest 待同步狀態 | 正式 OS 機器憑證與逐館 writer 切換；LINE 須另走預覽／提交，官網加 OwlNest 須過共同開賣閘門 |
| `GET /v1/properties/{propertyId}/bookings/{bookingId}` | 館別與訂單範圍、欄位投影；OS 合成會員證明及預設關閉的只讀影子路由 | 正式會員／機器憑證配置、旅客訂單憑據；LINE 完整 `inspect` 快照 |
| `GET /v1/properties/{propertyId}/availability` | 本地 sold／held／blocked／unsold 與版本；OwlNest 館的 `saleReady` 固定為 false | 真實來源涵蓋、逐晚通路觀測與網站開賣核准 |
| `GET /v1/properties/{propertyId}/occupancy-summary` | 逐日 confirmed／held／blocked／unsold 數量與 fence 數；不含訂單或旅客資料，`saleReady=false` | 分析／定價服務專用的館別 grant 與正式資料涵蓋驗證 |
| `GET /v1/properties/{propertyId}/housekeeping-turnovers` | 已確認訂單的退房日、房間與訂單 ID；不含旅客姓名／聯絡方式 | 清掃服務專用 grant、派工與清掃完成回報接線 |
| `GET /v1/properties/{propertyId}/finance/ledger` | 財務 grant 分頁讀取 Iron Gate 收退款事實與憑據參照，不含旅客客資 | 舊 OS 期初款／匯入財務欄位無損對齊及真實憑據核實 |
| `POST /v1/properties/{propertyId}/bookings/{bookingId}/cancel` | 保留訂單、版本檢查；有 OwlNest 時維持 fence 直到開房讀回 | 實際付款／退款審核、外部取消責任分界 |
| `GET /v1/properties/{propertyId}/requests/{requestKey}` | 同服務／grant 查持久原收據及目前訂單版本，撤銷憑證即時拒絕 | 正式保留期與營運清理流程 |
| `POST /v1/source-events` | 來源帳號、前一來源版本、上次套用訂單版本、取消 tombstone、衝突停售 | 真實 provider 證據與排序規則、正式來源 grant 配置 |
| `GET /v1/inventory-operations/{operationKey}`、`POST .../readback` | 精確房晚集合、短時間讀回、逐晚庫存數與鎖房狀態、部分成功保留 fence、持久操作 journal；provider-neutral 的單次執行器已能模擬未知寫入結果 | OwlNest 正式寫入 API、登入、房型映射、逐晚真實讀回、持久單館 lease 與修復工作 |

這些路徑已在 `src/http.ts` 由可注入的驗證函式接到 `src/service.ts`；`src/node-server.mjs` 提供 Node HTTP 與 PostgreSQL 組裝入口，已用 127.0.0.1 合成請求驗證，**沒有啟動公開伺服器**。`npm run start:private` 的入口只綁 loopback，要求受限 PostgreSQL 執行角色、已套用 schema 與 OS 證明密鑰；共用 PostgreSQL handler 也在服務請求前核對資料庫角色與 RLS。建立共用 handler 必須提供連線 URL，遠端資料庫須設 `sslmode=verify-full`，不接受可覆蓋主機或停用驗證的參數。本機隔離資料庫已驗證正常執行角色可啟動、管理角色會被拒絕。現在另有 SQLite 單機持久儲存、PostgreSQL 可序列化館別交易、同交易 outbox 與僅能追加的稽核紀錄、可撤銷的不透明憑證。已實作 5 秒 OS 會員請求證明的簽發／驗證函式，OS 獨立分支有預設關閉的只讀影子路由；沒有正式部署或真實發證。

### 後續目標 API 與本輪新增實作

下表前四列及事件游標已加入 OpenAPI 和 HTTP handler；LINE owner-action 與網站報價仍是目標，**目前不能呼叫**：

| 目標路徑 | 輸入與必要規則 | 開放前要完成 |
| --- | --- | --- |
| `GET /v1/properties/{propertyId}/bookings` | 已有最小欄位、游標分頁與日期／狀態篩選；每筆重新套用欄位權限 | 大量訂單索引與跨頁版本語意 |
| `PATCH /v1/properties/{propertyId}/bookings/{bookingId}` | 已有 body 中訂單版本、房晚版本、穩定請求鍵及白名單欄位；本地改房原子化 | OwlNest 關新開舊及付款／價額調整的正式流程 |
| `POST /v1/properties/{propertyId}/holds`、`POST .../extend`、`POST .../convert`、`POST .../release` | 已有伺服器設定的 24 小時保留、到期人工決定、延長、付款後同 ID 轉正及明確釋出；到期不自動釋放。釋出後收款保留事實並標記人工處理 | 正式財務憑據核實、業主操作權限與通知接線 |
| `POST /v1/properties/{propertyId}/bookings/{bookingId}/payment-events` | 已有追加式收退款事件、版本檢查及受限財務身分 | 財務來源核實、沖銷、更正與取消後退款審核 |
| `POST /v1/owner-actions/preview`、`POST .../commit`、`GET .../status` | LINE grant、原始請求鍵、不可變預覽雜湊、確認期限與版本 | 現行 LINE 完整 `inspect`、owner 確認、grant 限定訂單範圍及同鍵收據 |
| `POST /v1/quotes`、`POST /v1/quotes/{quoteId}/consume` | 網站 binding、房型映射、短效報價、一次性消費 | 官網與 OwlNest 共用開賣閘門及正式 last-room 交易 |
| `GET /v1/properties/{propertyId}/events?after=…` | 已有館別範圍、去個資事件與重播 cursor | outbox 消費者、傳送重試及正式監控 |

新增上述路徑時先更新 OpenAPI 和契約測試，再啟用 handler；不得只靠設計文件使呼叫端誤以為端點已存在。

## 2. 請求及回覆規則

- 每次寫入使用穩定的 `Idempotency-Key` UUID；同一驗證後服務、操作者與 grant 下，同鍵同內容回原收據，同鍵異內容 `409`。OS 成員共用機器憑證時，收據仍綁定原成員；付款寫入與讀回須有當前 `money` 權限。權威版本錯誤、房晚撞房、來源分歧各有固定錯誤碼。來源事件的 `sourceVersion` 必須由 provider 證據得出，不能用 Email 收到時間。
- `expectedInventoryVersion` 是館別房晚比較版本；取消另須 `expectedBookingVersion`。服務端從權威路由取得 `authorityEpoch`，儲存層拒絕舊代次。呼叫者不得在 body 自報工作區、館別權限或切換代次。
- OwlNest 館本地建單與 fence 在同一交易持久化後回 `202 sync_pending`。connector 需回報每個房晚實際觀測的 `count` 與 `isLock`：關房須庫存為零或鎖定，開房須庫存大於零且未鎖定。逐晚資料齊全並相符才變 `sync_verified`；未知、部分成功或相矛盾時回 `review_required` 並停售。內部 `confirmed` 不等於通路已關房，也不是旅客通知已送達。
- 取消只改訂單狀態並保留稽核；已有未沖銷收款的原生訂單和保留單會拒絕直接取消或釋出。OwlNest 館的房晚在開房逐晚讀回前仍受 fence 保護。若原關房操作尚未確認，取消進人工核對，避免舊操作晚到後重新關房。
- 原生保留的 24 小時期限由服務端設定；期限過後仍占房，只有業主明確延長或釋出才改變狀態。釋出後晚到款項只追加財務紀錄及人工處理標記，不重新占房。
- `GET availability` 的 `unsold` 只代表本地未占用。此切片刻意不讓官網在 OwlNest 館由此判定可售。OwlNest 官方公開資料目前只有產品／後台操作介紹，未找到可供實作的正式開關房寫入契約；真實 connector 仍關閉，詳見 [OwlNest API 查核](OWLNEST_API_STATUS.md)。
- 分析／定價使用 `occupancy:aggregate`，清掃使用 `housekeeping:read`，兩者分開發證。逐日摘要中的 `fenced` 是額外的風險計數，可與已占用房晚重疊；`confirmed + held + blocked + unsold` 才等於房間總數。清掃資料只提供確認訂單的最後連續住宿夜後退房日期，沒有客資。
- 財務使用 `finance:ledger` 加 `money` 欄位權限逐筆查詢收退款事實；回覆含訂單 ID、金額、時間與憑據參照，不含旅客姓名與聯絡方式。這個列表只代表已進 Iron Gate 的追加式事件，不代替舊 OS 的期初／匯入款項。
- 回應一律 `private, no-store`，錯誤只含固定代碼。旅客憑據只能讀綁定的單一訂單；PII 由驗證後的欄位 grant 決定是否出現在投影中。每次接受的寫入另記操作者、服務、grant、請求鍵、訂單與版本；一般事件訂閱不含這些稽核欄位。

建立原生訂單的請求例子（所有 ID 和資料均為合成）：

```http
POST /v1/properties/22222222-2222-4222-8222-222222222222/bookings
Authorization: Bearer <service-token>
Idempotency-Key: 88888888-8888-4888-8888-888888888888
Content-Type: application/json

{"expectedInventoryVersion":1,"stays":[{"checkIn":"2026-11-10","checkOut":"2026-11-12","roomIds":["33333333-3333-4333-8333-333333333333"]}],"guestName":"Synthetic Guest","contact":null,"notes":null,"totalCents":1200000,"bookedAt":"2026-10-13","source":"os"}
```

沒有 OwlNest 時回 `201 local_only`；有待關房的 OwlNest 館回 `202 sync_pending`，附 `bookingId`、訂單／房晚版本及 `operationKey`。回應遺失時查同一館、同一 request key。

## 3. 程式邊界

```text
已驗證的 OS／網站／connector 身分
        ↓
HTTP 路由與輸入上限（src/http.ts）
        ↓
館別、動作、欄位、來源 grant 與版本檢查（src/service.ts）
        ↓
每館原子交易 PropertyRepository（src/types.ts）
        ↓
SQLite 單機或 PostgreSQL 可序列化儲存 + 同交易 outbox 〔合成資料已驗證〕
        ↓
OwlNest／來源 connector 真實讀回 〔尚未實作〕
```

`MemoryPropertyRepository` 只用來驗證領域規則。`SqlitePropertyRepository` 已驗證單機重啟與交易回滾；`PostgresPropertyRepository` 已在隔離的本機 PostgreSQL 驗證最後一間、同交易 outbox 與 RLS 跨館隔離。正式部署仍需真實身分接線、備份、監控、容量與故障恢復驗證。至少需要下列唯一性與持久性條件：

`src/channel-runner.mjs` 是不含 OwlNest 憑證或網路呼叫的模擬執行器：呼叫端必須提供持久的逐館 lease、絕對且可重入的逐晚設定操作與完整的 provider 觀測。寫入回覆本身不算成功；若結果未知，執行器停止後續寫入，讀回現況並交給 Iron Gate 保留待核對狀態。沒有官方寫入 API 契約與測試授權前，不能把模擬 adapter 改作正式 OwlNest 控房。

| 紀錄 | 必須持久的鍵或限制 |
| --- | --- |
| 館別權威 | `propertyId` 唯一；`authorityEpoch` 與房晚版本同交易檢查 |
| 訂單 | `bookingId` UUID 唯一；取消保留原訂單與完整版本歷史 |
| 有效房晚／fence | `propertyId + roomId + date` 的占用／阻擋在同一交易內檢查，最後一間只能一筆成功 |
| 來源連結 | `propertyId + sourceSystem + sourceAccount + externalOrderId` 唯一；保存 `sourceVersion`、`lastAppliedBookingVersion` 和 tombstone |
| 請求收據 | `propertyId + clientId + subjectId + grantId + requestKey` 唯一；保存請求摘要與不可改的結果 |
| 通路操作 | `operationKey` 唯一；每筆期望房晚、讀回證據、狀態與重試紀錄不可因程序重啟消失 |
| 稽核紀錄 | `auditId` 唯一；與訂單和 outbox 同交易，正式執行角色只能 INSERT，不能讀取、修改或刪除 |

正式 `Authenticate` adapter 每次請求須重新核對服務憑證、OS 成員角色、館別、來源 grant 的 active／version／帳號、網站 binding、旅客訂單憑據及欄位權限；`Principal` 只能由這個 adapter 建立，不能直接反序列化外部 JSON。LINE 的一般 create／inspect／cancel 在此切片回固定拒絕，直到既有 owner-action 的預覽、確認雜湊、完整快照及同鍵讀回接上。

OS 可由私有閘道在**每次請求**重新讀取正式 `Workspace.members`，核對 active、角色與館別後，簽發最多 5 秒的 `X-Iron-Gate-OS-Proof`。證明綁定機器憑證 ID、會員 ID、館別、允許動作／欄位、HTTP 方法、路徑與查詢、原始 body 摘要及 `Idempotency-Key`；Iron Gate 先核對機器憑證，再以 `src/os-member-proof.mjs` 驗證並取交集。OS 獨立分支已增加[只讀影子訂單路由](../docs/work-handoff/IRON_GATE_OS_PROOF_2026-10-13.md)，每次從 OS 儲存重讀會員並簽發證明；合成測試、型別檢查、lint 與正式建置通過。影子路由預設關閉、未部署，沒有導流寫入。證明與機器 token 只能在私有服務連線傳送，不能回給瀏覽器或寫入日誌。

## 4. 下一段實作順序

1. 對齊 OpenAPI 與 OS `Booking`／`Workspace` 欄位；held、改期／改房、追加式收退款、列表和事件 cursor 的本地邏輯已具備，仍需既有 UUID、付款與房晚版本的轉換測試。
2. 將現有可撤銷憑證與 PostgreSQL 持久儲存接到正式 OS 即時會員驗證和私有部署；合成租戶的跨館拒絕、併發最後一間、重試及故障恢復已通過，正式環境仍須重驗。
3. 逐條導流或封住 OS 原生、網站、保留、匯入、LINE、來源與付款 writer；同一館的 `authorityEpoch` 切換前不得有旁路。`os-shadow` 可對狹窄的原生訂單子集產生含原 ID／原始快照的**唯讀候選狀態**；它不接觸 OS 或資料庫，也沒有啟用寫入的步驟。欄位差異見 [OS 接線矩陣](OS_INTEGRATION_MATRIX.md)。舊館 `calendar/changes` 是通知入口，需檢查上游 Sheet writer。
4. 接真實 OwlNest connector、來源事件證據與 LINE owner-action；完成未知結果停售、逐晚讀回、改期／取消及網站／來源共同開賣閘門。未驗證前保持關閉。
5. Sweetfun／OFFLAND 各自完成備份、實際還原演練、影子比對、封寫、切換與回滾驗證；兩館分別決定開關。

## 5. 合成驗證

`npm test` 執行競爭、同鍵重試、跨館與旅客範圍、保留、改房、取消、OwlNest 部分／過早讀回、來源分歧、亂序取消、SQLite 重啟與 HTTP 錯誤邊界。`npm run check` 做嚴格型別檢查。`npm run test:pg` 在隔離 localhost 的 `iron_gate_test` 資料庫驗證 PostgreSQL 交易、RLS、憑證不可列舉和即時撤銷；`npm run test:server` 驗證本機 HTTP listener。`npm run test:restore` 在兩個一次性本機資料庫之間演練合成訂單、占房、事件、稽核、憑證與序列的備份／還原，並重查受限執行角色。這些結果不證明真實 provider、OS 會員、正式儲存或生產租戶已可用。
