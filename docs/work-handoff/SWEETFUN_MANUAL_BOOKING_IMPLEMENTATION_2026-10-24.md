# Sweetfun 手動訂單實作狀態（2026-10-24）

本分支加入水芳直訂的手動新增、修改與取消介面和私有 OS→Iron Gate 閘道。此功能預設關閉，沒有替水芳正式資料或 OwlNest 寫入。取消保留訂單與稽核，不刪除資料，也不自動退款或寄送旅客通知。

## 已實作

- OS 只在 Iron Gate 權威日曆的單次快照讀取正常、`CALENDAR_SOURCE=sheet_snapshot`、`IRON_GATE_SWEETFUN_MANUAL_ENABLED=true`，且手動 grant、房間對照和 proof secret 都有效時顯示水芳入口。Owner／Admin／God、具水芳權限及價格權限的當前登入者才能呼叫私有路徑；瀏覽器不接觸 Iron Gate credential。
- 新增與改房前，伺服器讀同版本 Iron Gate 房晚並檢查本地衝突；提交時簽 5 秒 proof，綁定操作者、方法、路徑、body hash 與防重鍵。Iron Gate 在交易內再次檢查權限、版本及衝突。提交後 OS 讀回訂單；伺服器或瀏覽器連線遺失、讀回不明時保留原鍵查詢 request receipt，不產生第二筆提交。
- `GET /api/v1/bookings/manual/[bookingId]` 提供已授權父單資料；`POST /manual/preview`、`POST /manual/[bookingId]/preview`、`POST /manual`、`PATCH /manual/[bookingId]`、`POST /manual/[bookingId]/cancel`、`GET /manual/requests/[requestKey]` 處理操作。改單與取消原因進入私有稽核紀錄。UI 目前支援單段住宿改動，可同時選多間房；多段住宿仍可取消，但不顯示不完整的修改表單。
- Iron Gate OS 建立 OwlNest 館訂單時要求 readback 能力、grant 及覆蓋房晚的庫存觀測窗口。改房／改期要求前次同步已驗證，並 fence 新舊房晚。工作器先關閉且回讀新房晚，再開放舊房晚；任一步未知則保留 fence 供人工核對。
- 日曆和詳情顯示來源、訂單版本、房況同步及來源待核狀態。水芳仍沿用既有唯讀來源標示；只有獨立手動入口可寫。新 Iron Gate 直訂不套用既有 OS 收款覆蓋，也不提供舊 OS 收款面板，避免把付款寫進另一套帳本。既有進口訂單的付款顯示和通知流程維持原版本。

## 尚未開啟的正式流程

- **OTA 補登和人工更正／取消外部來源訂單未開放。** 目前 OS 會拒絕改動外部來源單，避免來信更新靜默覆蓋人工修改。需要先取得 OwlNest 單號的可信查詢與唯一性證據，建立來源身分／版本認領及核對流程。
- 水芳正式影子仍唯讀。切換前須完成 Sheet J/L/N 與 OwlNest 單號對照、舊訂單和財務逐筆對帳、所有舊 writer 的封寫或改接、OwlNest 庫存觀測與工作器告警／復原演練；否則不能設定手動開關或寫入 grant。
- 手動表單的預覽只證明 Iron Gate 當下本地房晚無衝突，`externalStockVerified=false`。真正的 OwlNest 關房以提交後工作器回讀為準。不得把預覽當作外部庫存或已完成同步的證據。

## 驗證

合成館別已測直訂預覽、建立、改期、取消、稽核原因、權限拒絕、版本衝突、遺失回應後用原鍵找收據，以及新房晚未回讀前不開放舊房晚。與 2026-10-24 最新日曆、付款及通知分支整合後，Iron Gate 完整測試 200 通過、9 略過；前端 Iron Gate 日曆、路由及手動訂單測試 21 通過、型別與 lint 通過；Next.js webpack 正式建置通過。CI 已加入 Iron Gate 完整測試及手動訂單測試。這些測試沒有對水芳正式資料或 OwlNest 做寫入驗收。
