# Finance SSOT：LINE 月報所需的 Iron Gate 讀模型補充

本分支接在 W5 Card connector 草稿之後，只擴充 Iron Gate 帳本唯讀回應。沒有啟用新財務 writer、回填或切換正式服務。

## 變更

- 帳本事件回傳原登記者與原登記時間、目前版本操作者與時間。LINE 明細可保持原員工所有權，管理員修正後也不會改掉原 `actor`。
- reversal 回傳原事件類型與收款用途；退款回傳原收款用途和服務日。LINE 月報能把跨來源、修正及退款放入正確的收付／服務月份。
- PostgreSQL `date` 依執行環境本地日曆日格式化，避免台北時區的服務日提前一天。
- 既有測試中的 connector 設定更新依 W5 的版本稽核契約遞增版本。

## 驗證

- `npm run check` 通過。
- 隔離 PostgreSQL `iron_gate_finance_test3` 的 `finance-commands.postgres.test.mjs` 在 `TZ=Asia/Taipei` 與 `TZ=UTC` 均通過；`finance-native.postgres.test.mjs` 單獨通過。測試資料全為合成資料，測試檔需依序執行，因各檔會清空同一隔離庫。
- 對應 LINE 讀模型與月報測試在 GCO 本機工作樹通過；該 repo 的分支尚未發布。

## 待接續

LINE 的私訊／LIFF 與舊版本回填、Sheet 批次補登、逐筆正式對帳和逐館切換仍需各自完成。讀模型擴欄不能視為月報或正式來源已切換。併入與部署都需依各 repo 發布規則另行驗證。
