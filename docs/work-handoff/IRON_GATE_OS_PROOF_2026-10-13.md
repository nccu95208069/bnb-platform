# Iron Gate OS 會員證明與只讀影子入口

日期：2026-10-13（Asia/Taipei）

狀態：合成驗證；已新增**預設不通的只讀影子路由**，沒有導流訂單寫入、配置正式憑證或部署。

`frontend/src/lib/customer-workspaces/iron-gate-proof.server.ts` 供未來的私有 OS 閘道使用。閘道須先驗證登入 session，再用 `loadWorkspace` 每次重新讀取正式 `Workspace.members`；只有 active 會員且有該館權限時，才可簽發最多五秒的請求證明。證明綁定 Iron Gate 機器憑證 ID、OS 帳號 ID、工作區／館別、動作／欄位、HTTP 方法、路徑及查詢、原始 body 摘要與 `Idempotency-Key`。使用者不能從瀏覽器指定會員角色或館別。

這版只簽 `booking:read` 與 `event:read`。現有 `viewer_no_price` 只獲得 `guest_name` 欄位；其他角色的可讀欄位依現行 OS 訂單 view 為姓名、聯絡方式、備註及金額。OS 的機器憑證由 Iron Gate 再取交集；證明與機器 token 不得送到瀏覽器或記錄在日誌。任何寫入動作須先完成 OS／Iron Gate 訂單、付款與保留語意對齊及館別權威切換，不能靠新增本證明自行開放。

程式碼審查發現：若儲存資料出現未知角色、非布林的全館授權或同一帳號的重複會員紀錄，預設放行會使權限擴大。簽發前現已逐項拒絕這些狀態，並加入合成拒絕測試。

`GET /api/customer-workspaces/{slug}/iron-gate-shadow/{propertyId}/bookings/{bookingId}` 先驗 OS cookie，再從伺服器端設定選定館別機器憑證，重新讀取會員、簽發單次證明，對 Iron Gate 發出三秒上限的 GET。它僅顯示 Iron Gate 已有的那筆影子資料，不改 OS 的訂單或庫存；預設關閉，未配置時回 503。回覆會核對工作區／館別／訂單 ID、欄位白名單與會員欄位授權，通路錯誤不洩露 token 或原始錯誤內容。啟用需由伺服器端設定 `IRON_GATE_SHADOW_ENABLED=true`、`IRON_GATE_BASE_URL`（HTTPS，或本機 127.0.0.1 HTTP）、`IRON_GATE_OS_PROOF_SECRET`（至少 32 bytes）及 `IRON_GATE_OS_READ_GRANTS` JSON 陣列；每個元素是 `credentialId`、`clientId`、`workspaceId`、`propertyId`、`origin:"os"`、`token`。同館只允許一個 grant，這些值不可暴露到瀏覽器或日誌。

合成測試驗證簽章、期限、body 綁定、跨館拒絕、撤銷會員拒絕、只讀轉發與回覆欄位限制；另與 Iron Gate 的驗證元件做本機互通測試。前端型別檢查與 lint 通過。尚待：正式機器憑證配置、OS 與 Iron Gate 的私有網路及 TLS、正式資料唯讀比對、舊 writer 封寫及逐館資料遷移。未通過這些條件前，影子路由不得被當作正式訂單來源。
