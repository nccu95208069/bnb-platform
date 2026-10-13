# Iron Gate

Iron Gate 是獨立的訂單與房晚權威服務。此目錄目前提供可執行的合成 API、PostgreSQL 儲存、館別隔離、憑證與唯讀 OS 影子比對。**尚未部署，也尚未接管任何真實訂單。** 產品和 API 契約分別見 [Iron Gate v1](IRON_GATE_V1.md)、[API v1](API_V1.md) 與 [OpenAPI](openapi.yaml)。

## 本機驗證

需要 Node.js 22.15 以上：

```sh
npm ci
npm test
npm run check
```

`npm run test:server` 會在本機 `127.0.0.1` 啟動短暫的合成 HTTP 測試。`npm run test:pg` 只接受明確指定的本機 `iron_gate_test` 資料庫；先以管理角色套用 [schema](sql/001_property_store.sql)，再配置單獨的 `iron_gate_runtime` 登入角色。測試資料不可指向正式資料庫。

`npm run start:private` 只綁定 `127.0.0.1`。它要求 `IRON_GATE_DATABASE_URL`、`IRON_GATE_OS_PROOF_SECRET`，並在啟動時驗證資料庫角色、RLS 與遠端 TLS。資料庫管理憑證與發證功能不在服務程序中。正式部署還需要專用資料庫、備份還原演練、身分配置、監控，以及逐館 writer 封寫與遷移核對。

影子盤點工具 `npm run shadow:report -- report /absolute/private/os-workspace.json` 只輸出去個資報告；輸入檔仍含客資，必須保存在受控私密位置。它不會讀取或修改 OS，也不會啟用切換。現有 OS [只讀橋接](../docs/work-handoff/IRON_GATE_OS_PROOF_2026-10-13.md)預設關閉。
