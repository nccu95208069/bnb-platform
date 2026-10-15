# Iron Gate 部署清單（2026-10-16）

## 已完成

- 使用者指定現有 Vercel 團隊的新專案及指定 Supabase 組織的專用 PostgreSQL。
- 已在 Vercel 團隊 `sweetfuns-projects` 建立空的 `iron-gate` 專案；未連接 Git、自訂網域或正式環境變數。
- 使用者在 Supabase 現有 Pro 組織建立 `iron-gate` 專用專案 `brcszrkwkgiwatrxevkf`，東京區 `ap-northeast-1`；讀取狀態時仍為 `COMING_UP`，尚未套用 schema。
- Vercel 本機建置通過，產物含 Node.js 22 函式、編譯後的服務及 PostgreSQL 驅動。路由僅將 `/v1/` 送入服務，沒有自動新增會破壞 OS 簽章的查詢參數。
- 曾嘗試兩次無資料庫設定的 smoke 部署；Vercel 即使明確指定 `--target=preview`，仍將首次部署判定為 production 並綁定正式別名。兩次均已刪除，已確認專案「No deployments found」且別名回 404。第一次的請求只回 `503 SERVICE_UNAVAILABLE`。這與 [Vercel 公開追蹤的首次部署問題](https://github.com/vercel/vercel/issues/17069)一致；預覽目標異常未排除前不再部署。
- 合成 API、PostgreSQL 隔離、憑證撤銷、唯讀 OS proof 和本機備份還原演練已驗證。此結果不代表真實館別已切換。

## 專用資料庫初始化

1. Supabase 官方建立畫面顯示額外費用 `US$10/月`，另可能有用量費；使用者已明確同意。連接器 `get_cost` 無法回應，故使用者在網頁表單自行產生管理密碼並完成建立，沒有把密碼交給本服務。
2. 等待專案健康狀態，核對 Micro 規格、東京區及 Data API 關閉。資料庫 schema 僅用私有 `iron_gate`，不把它加入 Data API 的公開 schema 清單。
3. 將已在隔離 PostgreSQL 測試的 [`sql/001_property_store.sql`](sql/001_property_store.sql) 套用到此新專案；另外建立獨立的 `LOGIN` 角色，只授予 `iron_gate_runtime`。以受限角色重跑 RLS、最後一間房與憑證撤銷整合測試。管理連線不得放入 Vercel。
4. 配置獨立備份及還原位置；在非正式資料庫先演練跨環境還原和回滾，留存館別快照與核對結果。

## Vercel 預覽與正式啟用前

1. 僅在服務端設定受限 PostgreSQL pooler URL（`sslmode=verify-full`）和 32 bytes 以上的 `IRON_GATE_OS_PROOF_SECRET`；OS 端使用同一 secret 的獨立安全設定。避免在命令輸出、程式碼、日誌或瀏覽器洩漏。
2. 預覽環境驗證 `/v1/` 的原始 path/query 沒有被 Vercel 重寫改動；用 OS 實際產生的短時 proof 做唯讀端到端測試。核對未授權及跨館請求拒絕，回應不快取。
3. 設定限流、錯誤率及資料庫連線監控；驗證資料庫停機時固定回 `503`，不洩漏內部資訊。
4. 維持 OS 影子橋接預設關閉；網站報價、LINE owner action、OwlNest 正式寫入 API 和財務證據尚未完成，不得將 Iron Gate 指為真實訂單的唯一 writer。每館切換須先備份、影子比對、關閉舊 writer、核對並準備回滾。

目前無運作中的部署；Supabase 專用專案已建立但未初始化 Iron Gate schema，也沒有遷移任何真實訂單。
