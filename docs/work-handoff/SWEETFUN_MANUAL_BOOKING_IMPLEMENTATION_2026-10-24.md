# Sweetfun 手動訂單實作狀態（2026-10-24）

本分支加入水芳直訂的手動新增、修改與取消介面和私有 OS→Iron Gate 閘道。此功能預設關閉，沒有替水芳正式資料或 OwlNest 寫入。取消保留訂單與稽核，不刪除資料，也不自動退款或寄送旅客通知。

## 已實作

- OS 只在 Iron Gate 權威日曆的單次快照讀取正常、`CALENDAR_SOURCE=sheet_snapshot`、`IRON_GATE_SWEETFUN_MANUAL_ENABLED=true`，且手動 grant、房間對照和 proof secret 都有效時顯示水芳入口。Owner／Admin／God、具水芳權限及價格權限的當前登入者才能呼叫私有路徑；瀏覽器不接觸 Iron Gate credential。
- 新增與改房前，伺服器讀同版本 Iron Gate 房晚並檢查本地衝突；提交時簽 5 秒 proof，綁定操作者、方法、路徑、body hash 與防重鍵。Iron Gate 在交易內再次檢查權限、版本及衝突。提交後 OS 讀回訂單；伺服器或瀏覽器連線遺失、讀回不明時保留原鍵查詢 request receipt，不產生第二筆提交。
- `GET /api/v1/bookings/manual/[bookingId]` 提供已授權父單資料；`POST /manual/preview`、`POST /manual/[bookingId]/preview`、`POST /manual`、`PATCH /manual/[bookingId]`、`POST /manual/[bookingId]/cancel`、`GET /manual/requests/[requestKey]` 處理操作。改單與取消原因進入私有稽核紀錄。UI 目前支援單段住宿改動，可同時選多間房；多段住宿仍可取消，但不顯示不完整的修改表單。
- Iron Gate OS 建立 OwlNest 館訂單時要求 readback 能力、grant 及覆蓋房晚的庫存觀測窗口。改房／改期要求前次同步已驗證，並 fence 新舊房晚。工作器先關閉且回讀新房晚，再開放舊房晚；任一步未知則保留 fence 供人工核對。
- 日曆和詳情顯示來源、訂單版本、房況同步及來源待核狀態。水芳仍沿用既有唯讀來源標示；只有獨立手動入口可寫。新 Iron Gate 直訂不套用既有 OS 收款覆蓋，也不提供舊 OS 收款面板；獨立的 Iron Gate 收付款入口預設關閉。既有進口訂單的付款顯示和通知流程維持原版本。
- 無價格權限的日曆投影會在 Iron Gate、OS 轉換及最終權限投影遮蔽 OTA／OwlNest 訂單別名。來源事件若使用不同事件鍵但帶同平台同 OTA 單號，會保留房晚 fence 並停在來源待核，不再建立第二張確認單。瀏覽器會在提交前持久保存原請求鍵，重載後仍提示查詢；伺服器 5xx 不視為確定失敗。確認成功或明確拒絕後才清除鍵。
- 新直訂收付款有另一個預設關閉的入口：需 `IRON_GATE_SWEETFUN_MANUAL_PAYMENTS_ENABLED=true` 與獨立的 `IRON_GATE_SWEETFUN_MANUAL_PAYMENT_GRANT`（同館別／工作區，僅 `booking:read`、`payment:write`、`money` 範圍）。Owner／Admin／God 可在訂單詳情登記收款或退款，唯一憑證編號與時間寫入 Iron Gate append-only 事件；後端防重、同單同類憑證重複、版本及退款上限檢查後，OS 讀回核對。瀏覽器保存請求鍵供斷線後查詢。此流程不寫舊 OS 付款帳本，也不自動移轉真實銀行款項。
- 現有財務首頁和訂單收款摘要仍讀 Sheet／OS 舊帳本；Iron Gate 日曆啟用時，水芳頁面明確提示新直訂及其收付款未計入合計。不能把這些合計當完整財務數字或重複在舊帳本登記同一款項。

## 尚未開啟的正式流程

- **OTA 補登和人工更正／取消外部來源訂單未開放。** 目前 OS 會拒絕改動外部來源單，避免來信更新靜默覆蓋人工修改。需要先取得 OwlNest 單號的可信查詢與唯一性證據，建立來源身分／版本認領及核對流程。
- 目前沒有可用的 OwlNest 訂單編號、房晚及取消狀態查詢入口或匯出資料，因此同平台單號的碰撞保護只是防止已知重複，不能證明兩封來源事件必為同一 OwlNest 訂單，也不能當作 OTA 認領或正式啟用依據。Iron Gate 即使已能回讀 OwlNest 庫存，也會把沒有既有來源連結的新 OTA 事件停在待核並保留 fence；庫存回讀不被當成訂單身分證明。
- 水芳正式影子仍唯讀。切換前須完成 Sheet J/L/N 與 OwlNest 單號對照、舊訂單和財務逐筆對帳、所有舊 writer 的封寫或改接、OwlNest 庫存觀測與工作器告警／復原演練；否則不能設定手動開關或寫入 grant。
- 手動表單的預覽只證明 Iron Gate 當下本地房晚無衝突，`externalStockVerified=false`。真正的 OwlNest 關房以提交後工作器回讀為準。不得把預覽當作外部庫存或已完成同步的證據。
- 收付款功能需另外完成舊財務帳本逐筆對帳與報表整合，才可考慮正式啟用；目前只在 Iron Gate 訂單詳情呈現其事件，財務首頁不合併這些金額。

## 驗證

合成館別已測直訂預覽、建立、改期、取消、稽核原因、權限拒絕、版本衝突、遺失回應後用原鍵找收據、5xx 不明結果、來源別名碰撞、未核身分 OTA 事件待核、重載後請求鍵保存、收款／退款防重與退款上限、收付款不明結果查詢，以及新房晚未回讀前不開放舊房晚。與 2026-10-24 最新日曆、付款及通知分支整合後，Iron Gate 完整測試 203 通過、9 略過；前端 CI 相關測試 27 通過、型別與 lint 通過（7 個既有警告）；Next.js webpack 正式建置通過。CI 已加入 Iron Gate 完整測試及手動訂單／收付款測試。這些測試沒有對水芳正式資料或 OwlNest 做寫入驗收。
