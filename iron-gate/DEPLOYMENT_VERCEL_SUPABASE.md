# Iron Gate 部署清單（2026-10-16）

## 已完成

- 使用者指定現有 Vercel 團隊的新專案及指定 Supabase 組織的專用 PostgreSQL。
- 已在 Vercel 團隊 `sweetfuns-projects` 建立空的 `iron-gate` 專案；未連接 Git、自訂網域或正式環境變數。
- Vercel 本機建置通過，產物含 Node.js 22 函式、編譯後的服務及 PostgreSQL 驅動。路由僅將 `/v1/` 送入服務，沒有自動新增會破壞 OS 簽章的查詢參數。
- 合成 API、PostgreSQL 隔離、憑證撤銷、唯讀 OS proof 和本機備份還原演練已驗證。此結果不代表真實館別已切換。

## 建立專用資料庫前

1. 取得指定 Supabase 組織建立專案的**實際費用**，向使用者逐字呈報並確認。Supabase `get_cost` 目前不可用；在費用確認工具恢復前不得建立專案。
2. 決定資料庫區域。現有同組織的 `bnb-reply-copilot` 位於 `ap-northeast-1`，可作為候選；建立前確認位置及資料保存要求。
3. 建立 `iron-gate` 專用專案，不共用 OS 或其他產品資料庫。資料庫 schema 僅用私有 `iron_gate`，不把它加入 Data API 的公開 schema 清單。
4. 使用管理連線套用 [`sql/001_property_store.sql`](sql/001_property_store.sql)；另外建立獨立的 `LOGIN` 角色，只授予 `iron_gate_runtime`。以受限角色重跑 RLS、最後一間房與憑證撤銷整合測試。管理連線不得放入 Vercel。
5. 配置獨立備份及還原位置；在非正式資料庫先演練跨環境還原和回滾，留存館別快照與核對結果。

## Vercel 預覽與正式啟用前

1. 僅在服務端設定受限 PostgreSQL pooler URL（`sslmode=verify-full`）和 32 bytes 以上的 `IRON_GATE_OS_PROOF_SECRET`；OS 端使用同一 secret 的獨立安全設定。避免在命令輸出、程式碼、日誌或瀏覽器洩漏。
2. 預覽環境驗證 `/v1/` 的原始 path/query 沒有被 Vercel 重寫改動；用 OS 實際產生的短時 proof 做唯讀端到端測試。核對未授權及跨館請求拒絕，回應不快取。
3. 設定限流、錯誤率及資料庫連線監控；驗證資料庫停機時固定回 `503`，不洩漏內部資訊。
4. 維持 OS 影子橋接預設關閉；網站報價、LINE owner action、OwlNest 正式寫入 API 和財務證據尚未完成，不得將 Iron Gate 指為真實訂單的唯一 writer。每館切換須先備份、影子比對、關閉舊 writer、核對並準備回滾。

目前無正式部署、無 Supabase 專用專案，也沒有遷移任何真實訂單。
