# Iron Gate

Iron Gate 是獨立的訂單與房晚權威服務。此目錄目前提供可執行的合成 API、PostgreSQL 儲存、館別隔離、憑證與唯讀 OS 影子比對。**尚未部署，也尚未接管任何真實訂單。** 產品和 API 契約分別見 [Iron Gate v1](IRON_GATE_V1.md)、[API v1](API_V1.md) 與 [OpenAPI](openapi.yaml)。

`src/channel-runner.mjs` 提供注入式通路操作模擬，不含正式 OwlNest 寫入連線；只有取得官方寫入 API 契約、測試授權及持久逐館 lease 後，才可接到真實控房程序。

## 本機驗證

需要 Node.js 22.15 以上：

```sh
npm ci
npm test
npm run check
npm run build
```

`npm run build` 產生可直接由 Node.js 執行的 `dist/`，不需在正式執行時開啟實驗性 TypeScript 解析。`dist/` 是建置產物，不進 Git；`npm run start:built` 在缺少正式環境設定時會拒絕啟動。

`npm run test:server` 會在本機 `127.0.0.1` 啟動短暫的合成 HTTP 測試。`npm run test:pg` 只接受明確指定的本機 `iron_gate_test` 資料庫；先以管理角色套用 [schema](sql/001_property_store.sql)，再配置單獨的 `iron_gate_runtime` 登入角色。測試資料不可指向正式資料庫。

`npm run test:restore` 要求 `IRON_GATE_PG_ADMIN_URL` 指向本機 `iron_gate_test`，以及可選的 `IRON_GATE_PG_BIN`（`pg_dump`／`pg_restore` 所在目錄）。它建立兩個一次性資料庫，產生合成訂單、房晚、事件、稽核與憑證，備份後還原並核對資料及受限執行角色，最後刪除一次性資料庫。這只驗證本機還原鏈路；正式館別仍需另做有紀錄的備份、還原與回滾演練。

`npm run start:private` 只綁定 `127.0.0.1`。它要求 `IRON_GATE_DATABASE_URL`、`IRON_GATE_OS_PROOF_SECRET`，並在啟動時驗證資料庫角色、RLS 與遠端 TLS。資料庫管理憑證與發證功能不在服務程序中。正式部署還需要專用資料庫、備份還原演練、身分配置、監控，以及逐館 writer 封寫與遷移核對。

## Vercel 專案

`api/index.mjs` 是獨立 Vercel 專案的 Node.js 入口；`vercel.json` 只把 `/v1/` 路徑導向它。建置先產生 `dist/`，公開靜態目錄 `public/` 保持空白。入口需要伺服器端的 `IRON_GATE_DATABASE_URL` 與 `IRON_GATE_OS_PROOF_SECRET`，少任一項就只回 `503 SERVICE_UNAVAILABLE`。資料庫 URL 必須使用驗證主機名稱的 TLS，連線角色必須是受限的 `iron_gate_runtime` 成員；正式連線字串及 proof secret 不可提交到 Git 或放在瀏覽器環境變數。資料庫建立、管理帳號、遷移和發證都不由 Vercel 函式執行。

新 Vercel `sweetfuns-projects/iron-gate` 專案目前只有空殼，尚未配置資料庫或正式部署。連線到 Supabase 專用 PostgreSQL 時，短生命週期函式應使用 transaction pooler；程式每次讀寫都以明確 transaction 設定逐館 RLS。正式啟用前要在部署預覽中核對重寫後的原始路徑與查詢字串，因為 OS proof 會對完整請求路徑簽章。部署及資料庫準備狀態詳見 [部署清單](DEPLOYMENT_VERCEL_SUPABASE.md)。

影子盤點工具 `npm run shadow:report -- report /absolute/private/os-workspace.json` 只輸出去個資報告；輸入檔仍含客資，必須保存在受控私密位置。它不會讀取或修改 OS，也不會啟用切換。現有 OS [只讀橋接](../docs/work-handoff/IRON_GATE_OS_PROOF_2026-10-13.md)預設關閉。
