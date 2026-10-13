# Iron Gate OS 會員證明：只讀準備元件

日期：2026-10-13（Asia/Taipei）

狀態：合成驗證；**沒有新增路由、導流訂單、發證或部署**。

`frontend/src/lib/customer-workspaces/iron-gate-proof.server.ts` 供未來的私有 OS 閘道使用。閘道須先驗證登入 session，再用 `loadWorkspace` 每次重新讀取正式 `Workspace.members`；只有 active 會員且有該館權限時，才可簽發最多五秒的請求證明。證明綁定 Iron Gate 機器憑證 ID、OS 帳號 ID、工作區／館別、動作／欄位、HTTP 方法、路徑及查詢、原始 body 摘要與 `Idempotency-Key`。使用者不能從瀏覽器指定會員角色或館別。

這版只簽 `booking:read` 與 `event:read`。現有 `viewer_no_price` 只獲得 `guest_name` 欄位；其他角色的可讀欄位依現行 OS 訂單 view 為姓名、聯絡方式、備註及金額。OS 的機器憑證由 Iron Gate 再取交集；證明與機器 token 不得送到瀏覽器或記錄在日誌。任何寫入動作須先完成 OS／Iron Gate 訂單、付款與保留語意對齊及館別權威切換，不能靠新增本證明自行開放。

程式碼審查發現：若儲存資料出現未知角色、非布林的全館授權或同一帳號的重複會員紀錄，預設放行會使權限擴大。簽發前現已逐項拒絕這些狀態，並加入合成拒絕測試。

合成測試驗證簽章、期限、body 綁定、跨館拒絕及撤銷會員拒絕；另與 Iron Gate 的驗證元件做本機互通測試。前端型別檢查與 lint 通過；Webpack 正式建置通過。尚待：正式 OS 私有閘道、逐請求登入與授權接線、機器憑證配置、私有網路與 TLS、服務間失敗處理、舊 writer 封寫及逐館資料遷移。
