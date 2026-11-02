# Iron Gate 部署清單（2026-10-16）

## 已完成

- 使用者指定現有 Vercel 團隊的新專案及指定 Supabase 組織的專用 PostgreSQL。
- 已在 Vercel 團隊 `sweetfuns-projects` 建立 `iron-gate` 專案；未連接 Git、自訂網域或正式環境變數。`IRON_GATE_DATABASE_URL`、`IRON_GATE_OS_PROOF_SECRET`、`IRON_GATE_PREVIEW_ENABLED=true` 已設為**僅 Preview** 的加密變數。入口只在 Vercel 明確標記 `VERCEL_ENV=preview` 且 Preview 啟用旗標為真時才初始化資料庫；其他情況固定回 `503`。
- 使用者在 Supabase 現有 Pro 組織建立 `iron-gate` 專用專案 `brcszrkwkgiwatrxevkf`，東京區 `ap-northeast-1`，Micro，狀態已健康。已套用 `create_iron_gate_property_store` migration（版本 `20261015165045`），並建立只具 `iron_gate_runtime` 權限的登入角色 `iron_gate_app`。
- 已使用交易模式共用連線池 `aws-0-ap-northeast-1.pooler.supabase.com:6543`、受限帳號及 `sslmode=verify-full` 成功連線；服務的實際角色、RLS 與危險權限檢查通過。管理密碼沒有交給服務，也未存入程式碼。
- `anon`、`authenticated`、`service_role` 均無 `iron_gate` schema 使用權或訂單表讀取權；Supabase 控制台顯示 Data API 已停用，沒有可查詢的 schema。
- 已套用 [`sql/002_policy_plan_and_credential_index.sql`](sql/002_policy_plan_and_credential_index.sql)：調整四個 RLS policy 的查詢計畫，補上憑證館別索引。Supabase 安全顧問無警示；效能顧問只剩新建表尚未使用的索引，以及未使用的 Auth 服務連線配置提示。
- 從 Supabase 專案 SSL 設定取得公開 CA 憑證並納入函式產物。遠端連線時程式會綁定此 CA，且拒絕外部提供的憑證覆寫；本機建置已確認憑證存在於函式套件中。
- 使用同一入口對專用資料庫做了一次無憑證、唯讀的 HTTP 層測試：在通過連線與角色檢查後回覆固定 `401 UNAUTHORIZED`，沒有建立訂單或憑證。
- Vercel 本機建置通過，產物含 Node.js 22 函式、編譯後的服務及 PostgreSQL 驅動。路由僅將 `/v1/` 送入服務，沒有自動新增會破壞 OS 簽章的查詢參數。
- Vercel 的首次 Preview 判定問題使先前兩次 smoke 部署意外標成 Production，當時已刪除。使用者於 2026-10-16 明確同意暫時的 Production 固定 503 空殼；建立 [Production 部署](https://vercel.com/sweetfuns-projects/iron-gate/533sCKvAkcLDt41xFqaLGPVY7G52) 後檢查目標確為 production，公開別名 `https://iron-gate-green.vercel.app/v1/bookings` 實測 `503 SERVICE_UNAVAILABLE`、`private, no-store`。Production 沒有資料庫或簽章密鑰。
- 接著建立 [Preview 部署](https://vercel.com/sweetfuns-projects/iron-gate/CB1q8cjMq5JoMX8csAUYfkKrFXKp)，檢查目標確為 preview，且 Vercel Authentication 仍保護預覽網址。使用登入的 `vercel curl` 經保護層測試 `/v1/properties/00000000-0000-4000-8000-000000000001/bookings`，Iron Gate 回 `401 UNAUTHORIZED`、`private, no-store`；Production 在 Preview 建立後再次回 `503`。測試沒有送出建立或修改訂單的請求，也沒有匯入真實客資。
- 在專用資料庫短暫建立兩個全新合成館別及可撤銷短效測試憑證，經受保護 Preview 驗證同館事件讀取 `200`、跨館 `403`、憑證撤銷後 `401`。測試沒有建立訂單或接觸真實館別；兩個合成館別及兩筆測試憑證已刪除，逐表核對其占房、outbox、稽核均為零。
- 另以 OS 只讀簽章程式及全新合成會員／館別測試 `GET /v1/properties/{propertyId}/bookings?limit=1`：經受保護 Preview 回 `200`，證明原始查詢字串在實際路由可通過短效證明驗證。這是合成會員，尚未接正式 OS 登入。短效憑證已撤銷並刪除；使用者批准後透過控制台刪除唯一合成館別列，重新查詢確認館別、憑證、占房、outbox、稽核均為零。
- 合成 API、PostgreSQL 隔離、憑證撤銷、唯讀 OS proof 和本機備份還原演練已驗證。此結果不代表真實館別已切換。
- 新增逐館唯讀完整性檢查，會以受限角色在一致快照核對訂單房晚與占房索引，並檢查待同步通路操作是否仍被 fence 保護；本機 PostgreSQL 交易及備份還原前後的合成資料均已通過。沒有用真實館別執行。
- 2026-10-21 將含水芳遷移輔助工具的本地候選部署至新的受保護 Preview，控制面讀回 `Ready`／`preview`。正常未登入訪客請求被保護層轉向登入；登入的無憑證唯讀 API 請求回 `401 UNAUTHORIZED`、`private, no-store`。正式公開別名再次回 `503 SERVICE_UNAVAILABLE`，沒有啟用正式接單。Supabase 專用庫目前保存一個水芳**唯讀影子**館別，版本 2、1,607 筆訂單、1,758 個占房鍵、4 個隔離組；館別 authority epoch 仍為 0、通路和網站銷售均關閉，憑證／outbox／audit 均為 0。詳細來源和例外見[遷移執行紀錄](SWEETFUN_MIGRATION_EXECUTION_2026-10-20.md)。

## 專用資料庫初始化

1. Supabase 官方建立畫面顯示額外費用 `US$10/月`，另可能有用量費；使用者已明確同意。連接器 `get_cost` 無法回應，故使用者在網頁表單自行產生管理密碼並完成建立，沒有把密碼交給本服務。
2. 已核對專案健康狀態、Micro 規格、東京區及 Data API 停用狀態。資料庫 schema 僅用私有 `iron_gate`，不可將它加入 Data API。
3. 已套用 [`sql/001_property_store.sql`](sql/001_property_store.sql) 和 [`sql/002_policy_plan_and_credential_index.sql`](sql/002_policy_plan_and_credential_index.sql)，並以受限角色通過服務啟動安全檢查。憑證撤銷的 Preview 往返已用短效合成資料驗證；最後一間房的併發交易仍只在隔離本機資料庫驗證。管理連線不得放入 Vercel。
4. 配置獨立備份及還原位置；在非正式資料庫先演練跨環境還原和回滾，留存館別快照與核對結果。逐館切換前執行 `npm run check:property -- <property-uuid>`，任何不一致均阻擋切換；這項檢查不能取代來源／OS 影子比對。

## Vercel 預覽與正式啟用前

1. 僅在服務端設定受限 PostgreSQL pooler URL（`sslmode=verify-full`）、32 bytes 以上的 `IRON_GATE_OS_PROOF_SECRET` 及 Preview 專用的 `IRON_GATE_PREVIEW_ENABLED=true`；OS 端使用同一 secret 的獨立安全設定。函式從 [`certs/prod-ca-2021.crt`](certs/prod-ca-2021.crt) 載入 Supabase 公開 CA。避免在命令輸出、程式碼、日誌或瀏覽器洩漏私人連線憑證。
2. 合成 OS 會員的短時 proof 已在 Preview 對帶 `?limit=1` 的真實路由返回 `200`，可核對 `/v1/` 原始 path/query；未授權請求及合成機器憑證的同館、跨館、撤銷也已核對。**OS 真實會員、已部署 OS 影子路由及真實館別**仍待端到端核對，回應不得快取。
3. 設定限流、錯誤率及資料庫連線監控；驗證資料庫停機時固定回 `503`，不洩漏內部資訊。
4. 維持 OS 影子橋接預設關閉；網站報價、LINE owner action、OwlNest 登入後台的房量寫入請求與財務證據尚未完成，不得將 Iron Gate 指為真實訂單的唯一 writer。每館切換須先備份、影子比對、關閉舊 writer、核對並準備回滾。

目前有固定 503 的 Production 空殼與受 Vercel Authentication 保護的 Preview；Supabase 專用私有 schema 已存入真實來源的**唯讀影子**，但尚未作為訂單權威、尚未啟用真實接單或財務付款事件。

2026-10-21 候選程式加入與 Preview 完全分離的 Production 閘門：`IRON_GATE_PRODUCTION_ENABLED=true` 才讀取獨立的 `IRON_GATE_PRODUCTION_DATABASE_URL` 和 `IRON_GATE_PRODUCTION_OS_PROOF_SECRET`；目前正式環境**沒有**啟用這些設定，公開入口仍須維持 503。這是程式準備，不等於正式部署或切換。另已把訂單列表回覆加上 inventory version、authority epoch 和唯讀狀態，讓 OS 日曆能在逐頁及逐房晚讀取時拒絕版本漂移。現存水芳來源影子已更新至版本 5、1,606 張唯讀訂單／1,758 個占房房晚、epoch 0；正式來源 grant／link 仍為 0。啟用前還須完成[OS 日曆切換候選](OS_CALENDAR_HANDOFF_2026-10-21.md)、Gmail writer、舊入口停寫與最終來源核對。

17:29 台北時間從乾淨的草稿 PR #37 分支部署受保護 Preview `dpl_9DuEEdiibqQs1XufZtHQUPX44neS`，控制面讀回 target `preview`／Ready，Node API 建置成功。未登入訪客收到預覽登入導向 302；使用 Vercel 登入繞過預覽保護後，無 Iron Gate 憑證的訂單 GET 回 401、`private, no-store`。公開 Production 別名再讀仍為 503。未傳送有憑證的寫入、沒有改動正式來源、資料庫 grant 或 Production 設定。
