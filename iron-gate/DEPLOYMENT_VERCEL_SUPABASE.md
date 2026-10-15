# Iron Gate 部署清單（2026-10-16）

## 已完成

- 使用者指定現有 Vercel 團隊的新專案及指定 Supabase 組織的專用 PostgreSQL。
- 已在 Vercel 團隊 `sweetfuns-projects` 建立 `iron-gate` 專案；未連接 Git、自訂網域或正式環境變數。`IRON_GATE_DATABASE_URL`、`IRON_GATE_OS_PROOF_SECRET`、`IRON_GATE_PREVIEW_ENABLED=true` 已設為**僅 Preview** 的加密變數，尚未部署。入口只在 Vercel 明確標記 `VERCEL_ENV=preview` 且 Preview 啟用旗標為真時才初始化資料庫；其他情況固定回 `503`。
- 使用者在 Supabase 現有 Pro 組織建立 `iron-gate` 專用專案 `brcszrkwkgiwatrxevkf`，東京區 `ap-northeast-1`，Micro，狀態已健康。已套用 `create_iron_gate_property_store` migration（版本 `20261015165045`），並建立只具 `iron_gate_runtime` 權限的登入角色 `iron_gate_app`。
- 已使用交易模式共用連線池 `aws-0-ap-northeast-1.pooler.supabase.com:6543`、受限帳號及 `sslmode=verify-full` 成功連線；服務的實際角色、RLS 與危險權限檢查通過。管理密碼沒有交給服務，也未存入程式碼。
- `anon`、`authenticated`、`service_role` 均無 `iron_gate` schema 使用權或訂單表讀取權；Supabase 控制台顯示 Data API 已停用，沒有可查詢的 schema。
- 已套用 [`sql/002_policy_plan_and_credential_index.sql`](sql/002_policy_plan_and_credential_index.sql)：調整四個 RLS policy 的查詢計畫，補上憑證館別索引。Supabase 安全顧問無警示；效能顧問只剩新建表尚未使用的索引，以及未使用的 Auth 服務連線配置提示。
- 從 Supabase 專案 SSL 設定取得公開 CA 憑證並納入函式產物。遠端連線時程式會綁定此 CA，且拒絕外部提供的憑證覆寫；本機建置已確認憑證存在於函式套件中。
- 使用同一入口對專用資料庫做了一次無憑證、唯讀的 HTTP 層測試：在通過連線與角色檢查後回覆固定 `401 UNAUTHORIZED`，沒有建立訂單或憑證。
- Vercel 本機建置通過，產物含 Node.js 22 函式、編譯後的服務及 PostgreSQL 驅動。路由僅將 `/v1/` 送入服務，沒有自動新增會破壞 OS 簽章的查詢參數。
- 曾嘗試兩次無資料庫設定的 smoke 部署；Vercel 即使明確指定 `--target=preview`，仍將首次部署判定為 production 並綁定正式別名。兩次均已刪除，已確認專案「No deployments found」且別名回 404。第一次的請求只回 `503 SERVICE_UNAVAILABLE`。這與 [Vercel 公開追蹤的首次部署問題](https://github.com/vercel/vercel/issues/17069)一致；預覽目標異常未排除前不再部署。
- 曾嘗試兩次無資料庫設定的 smoke 部署；Vercel 即使明確指定 `--target=preview`，仍將首次部署判定為 production 並綁定正式別名。兩次均已刪除，已確認專案「No deployments found」且別名回 404。第一次的請求只回 `503 SERVICE_UNAVAILABLE`。這與 [Vercel 公開追蹤的首次部署問題](https://github.com/vercel/vercel/issues/17069)一致；取得使用者對暫時 Production 空殼部署的明確決定前不再部署。
- 合成 API、PostgreSQL 隔離、憑證撤銷、唯讀 OS proof 和本機備份還原演練已驗證。此結果不代表真實館別已切換。

## 專用資料庫初始化

1. Supabase 官方建立畫面顯示額外費用 `US$10/月`，另可能有用量費；使用者已明確同意。連接器 `get_cost` 無法回應，故使用者在網頁表單自行產生管理密碼並完成建立，沒有把密碼交給本服務。
2. 已核對專案健康狀態、Micro 規格、東京區及 Data API 停用狀態。資料庫 schema 僅用私有 `iron_gate`，不可將它加入 Data API。
3. 已套用 [`sql/001_property_store.sql`](sql/001_property_store.sql) 和 [`sql/002_policy_plan_and_credential_index.sql`](sql/002_policy_plan_and_credential_index.sql)，並以受限角色通過服務啟動安全檢查。下一步以專用資料庫驗證合成資料的最後一間房及憑證撤銷流程；管理連線不得放入 Vercel。
4. 配置獨立備份及還原位置；在非正式資料庫先演練跨環境還原和回滾，留存館別快照與核對結果。

## Vercel 預覽與正式啟用前

1. 僅在服務端設定受限 PostgreSQL pooler URL（`sslmode=verify-full`）、32 bytes 以上的 `IRON_GATE_OS_PROOF_SECRET` 及 Preview 專用的 `IRON_GATE_PREVIEW_ENABLED=true`；OS 端使用同一 secret 的獨立安全設定。函式從 [`certs/prod-ca-2021.crt`](certs/prod-ca-2021.crt) 載入 Supabase 公開 CA。避免在命令輸出、程式碼、日誌或瀏覽器洩漏私人連線憑證。
2. 預覽環境驗證 `/v1/` 的原始 path/query 沒有被 Vercel 重寫改動；用 OS 實際產生的短時 proof 做唯讀端到端測試。核對未授權及跨館請求拒絕，回應不快取。
3. 設定限流、錯誤率及資料庫連線監控；驗證資料庫停機時固定回 `503`，不洩漏內部資訊。
4. 維持 OS 影子橋接預設關閉；網站報價、LINE owner action、OwlNest 正式寫入 API 和財務證據尚未完成，不得將 Iron Gate 指為真實訂單的唯一 writer。每館切換須先備份、影子比對、關閉舊 writer、核對並準備回滾。

目前無運作中的部署；Supabase 專用專案及私有 schema 已建立，沒有遷移任何真實訂單。
