# Sweetfun 手動訂單實作狀態（2026-10-24）

## 2026-10-25 新訂單信件的身分認領候選（尚未部署）

正式 Gmail checker 已把水芳 OwlNest 新訂單送往 Iron Gate，但目前 Iron Gate
對沒有既有來源連結的 OwlNest 訂單一律回 `SOURCE_IDENTITY_UNVERIFIED`。
因此日曆只出現「房晚待核」封鎖格，沒有可核對的正式訂單。10 月 25 日唯讀檢查
三筆待核通知，均在業主 OwlNest 訂單頁與原始 Gmail 信找到相同訂單、房間、日期、
平台單號及總額；原信顯示 Gmail 驗證的 OwlTing 網域 DKIM／DMARC 通過。

候選變更只讓**綁定的 Gmail 來源主體**憑 Gmail 第一筆可信驗證結果、完整的新單
`OBE...`、平台單號及總額建立來源訂單。若欠缺其中一項，仍停在待核；既有訂單
的平台單號及原始 Sheet N 欄別名碰撞也停在待核。這把 OwlNest 簽名的新單通知
當作來源身分證據，不把庫存關房當作訂單身分。既有三筆不會因部署程式而自動
解除，必須另以經核對的原始 receipt、即時 OwlNest 訂單及精確房晚檢查進行修復。
修復腳本 `iron-gate/scripts/reconcile-sweetfun-unverified-notices.mjs` 只吃未入版控的
私人 manifest，預設可產生回滾交易；任何版本、別名、房晚或來源證據改變均中止。

本節是待批准的修正契約，不代表正式環境已接受新單，亦不改變下方 10 月 24 日
發布時的限制與事實。發布及三筆真實資料修復均需要另外授權與完成後讀回。

**2026-10-25 更新：** [新直訂收退款與財務首頁已正式整合並回讀](SWEETFUN_DIRECT_FINANCE_2026-10-25.md)。下文 10 月 24 日的財務未啟用狀態為歷史紀錄；目前兩項正式開關已啟用，僅歷史來源財務遷移與舊 Sheet M1 摘要仍未納入。

水芳直訂的手動新增、修改與取消介面，以及私有 OS→Iron Gate 閘道已完成。新增分成「建立並讀回 Iron Gate 訂單」與使用者按「同步房況」後才開始的 OwlNest 關房。取消保留訂單與稽核，不刪除資料，也不自動退款或寄送旅客通知。

## 10 月 24 日正式發布

### 正式房況驗收（台灣時間 18:44–18:46）

- PR #72 已合併；Iron Gate 正式站 `iron-gate-green.vercel.app` 已切到部署 `dpl_9D8rWdSRf9krK29JX96te64eYKnE`。Sweetfun OS 的獨立「同步房況」入口維持在正式站。
- 以使用者指定的 **2027-03-20 水芳 101 房**進行一次合成訂單驗收。OwlNest 原始房況為可售 1、未鎖；OS 建立合成直訂後仍未寫房況。按一次「同步房況」產生作業 `752a511a-4e3a-47fc-b65b-219da6e0bd0e`，Iron Gate 記錄原本開放、寫入關房並讀回驗證；重新載入 OwlNest 後，該房晚為可售 0、已鎖。
- 隨後在 OS 取消該合成訂單，產生復原作業 `b73bc7ef-539a-45d0-8ed5-588398178c37`，OwlNest 讀回可售 1、未鎖，與原始狀態一致；OS 顯示當日 101 空房，Iron Gate 訂單保留 `cancelled` 稽核記錄，房晚 fence 與待派送作業均已清空。未修改其他正式訂單。這完成本次單房晚的真實關房、回讀、取消與復原驗收。
- `stockObservedFrom` 仍為空。PR #72 只容許**本單初次手動同步有完整「原本開放→本系統關房→讀回已關」證據**時，在取消中重新開放其原房晚；跨房／跨日期修改仍要求完整庫存觀測窗口，未知或衝突結果仍停在待核。這次單房晚驗收不代表全館庫存已觀測，也不開啟 OTA 認領或財務帳本整合。

- 整合版經 PR #70 合併到 Iron Gate／OS 正式分支，Iron Gate 已部署至 `iron-gate-green.vercel.app`，Sweetfun OS 已部署至 `sweetfun-os.vercel.app`。正式環境使用原有 `sheet_snapshot` 月曆來源，只有具水芳權限與價格權限的 Owner／Admin／God 看得到手動入口；手機和桌面均提供「新增水芳訂單」。
- OS 的獨立手動 credential 只授權水芳的訂單讀取、新增、修改、取消及必要欄位，伺服器環境保存，期限至 2026-11-22 18:12（台灣時間）。屆期前須輪替；瀏覽器不接觸 token。財務寫入的獨立開關與 credential 沒有啟用。
- 正式環境已驗證部署就緒、未登入頁面／私有路徑的回應，以及登入後水芳月曆讀取。上述合成房晚已完成真實 OwlNest 寫入與復原；尚未替真實旅客建立水芳直訂。表單預覽與本地建單本身仍不算 OwlNest 關房證據。
- Iron Gate 的 OwlNest 設定與工作器已就緒，但舊館別狀態 `stockObservedFrom` 仍為空。初次建單、首次同步及本單已驗證關房後的取消已完成受控驗收；已同步訂單跨房晚修改仍受完整庫存觀測窗口限制。OTA 身分認領及舊財務帳本整合沒有隨本次發布開放。

## 已實作

- OS 只在 Iron Gate 權威日曆的單次快照讀取正常、`CALENDAR_SOURCE=sheet_snapshot`、`IRON_GATE_SWEETFUN_MANUAL_ENABLED=true`，且手動 grant、房間對照和 proof secret 都有效時顯示水芳入口。Owner／Admin／God、具水芳權限及價格權限的當前登入者才能呼叫私有路徑；瀏覽器不接觸 Iron Gate credential。
- 新增與改房前，伺服器讀同版本 Iron Gate 房晚並檢查本地衝突；提交時簽 5 秒 proof，綁定操作者、方法、路徑、body hash 與防重鍵。Iron Gate 在交易內再次檢查權限、版本及衝突。提交後 OS 讀回訂單；伺服器或瀏覽器連線遺失、讀回不明時保留原鍵查詢 request receipt，不產生第二筆提交。
- 新增直訂須填館別（水芳固定館別）、入住與退房日、房間、旅客姓名及房費；聯絡方式、備註與預訂日可留白。讀回逐項核對訂單版本、來源、房晚、旅客、聯絡資料、備註、總額與預訂日；任何不一致都回報結果待核，不能顯示已完成。成功畫面保留明確訊息：Iron Gate 已建單，OwlNest 尚未開關房。
- `GET /api/v1/bookings/manual/[bookingId]` 提供已授權父單資料；`POST /manual/preview`、`POST /manual/[bookingId]/preview`、`POST /manual`、`POST /manual/[bookingId]/sync-room-status`、`PATCH /manual/[bookingId]`、`POST /manual/[bookingId]/cancel`、`GET /manual/requests/[requestKey]` 處理操作。改單與取消原因進入私有稽核紀錄。UI 目前支援單段住宿改動，可同時選多間房；多段住宿仍可取消，但不顯示不完整的修改表單。
- OS 建立 OwlNest 館直訂只檢查 Iron Gate 本地日期、房晚、封房及版本，不要求 OwlNest readback、grant 或既有庫存觀測窗口。建立後狀態是 `awaiting_manual_sync`，沒有通路作業或工作器寫入。只有使用者按「同步房況」且當時的 OwlNest 通路設定就緒，才以防重鍵建立 `sync_pending` 作業與房晚 fence。工作器在任何 PUT 前讀取並持久記錄所有目標房晚原本開放；若原本已關閉，直接停在 `review_required`，不能把既有關房誤認作本單完成。中斷後的人工復原也不能只憑最終關房狀態自動驗證這類作業。
- 手動關房若停在 `review_required`，全館通路 claim 先保持鎖定。操作員核對原作業與 OwlNest 房況後，可使用既有私有 `recover-channel-claim.mjs` manifest 明確加入 `releaseReviewedManualClaim: true`、`acknowledgeQuarantine: true` 及至少八字元的 `reviewReason`，並提供當前 `expectedClaimId`、`expectedInventoryVersion`。此獨立處置會重新完整讀取目標房晚，且只在所有房晚目前都關閉時，檢查 claim、訂單、作業、房晚 fence 與版本，留下觀測及稽核紀錄後清除全館 claim；原訂單仍待核，原房晚 fence 不釋放，其他不重疊作業才可續跑。任何房晚仍開放、證據不完整、版本改變或有重疊待處理作業時拒絕；操作員須先處理仍開放的 OwlNest 房晚。此步驟不會再送 OwlNest PUT，也不把未知關房判成成功。
- 在初次同步前，OS 可更正新直訂的房晚或取消，仍只改 Iron Gate，不排 OwlNest 作業。已驗證過的訂單若改房／改期，仍要求完整庫存觀測窗口，並 fence 新舊房晚；工作器先關閉且回讀新房晚，再開放舊房晚。取消本系統已驗證初次手動關房的原房晚可用該次完整證據安全開房；其他已同步訂單仍要求已觀測房晚窗口，未知結果保留 fence 待核對。
- 日曆和詳情顯示來源、訂單版本、房況同步及來源待核狀態。水芳仍沿用既有唯讀來源標示；只有獨立手動入口可寫。新 Iron Gate 直訂不套用既有 OS 收款覆蓋，也不提供舊 OS 收款面板；獨立的 Iron Gate 收付款入口預設關閉。既有進口訂單的付款顯示和通知流程維持原版本。
- 無價格權限的日曆投影會在 Iron Gate、OS 轉換及最終權限投影遮蔽 OTA／OwlNest 訂單別名。來源事件若使用不同事件鍵但帶同平台同 OTA 單號，會保留房晚 fence 並停在來源待核，不再建立第二張確認單。瀏覽器會在提交前持久保存並讀回確認原請求鍵，重載後仍提示查詢；伺服器 5xx 不視為確定失敗。確認成功或明確拒絕後才清除鍵。
- 業主從日曆點選一張已連結、無待核且通路狀態穩定的外部來源單，可只更正 Sweetfun OS 的旅客姓名並填原因。此操作以訂單 UUID 和版本鎖定單筆紀錄，不改房型、日期、金額、聯絡方式或 OwlNest 訂單；原來源連結保留但標示差異，後續來源事件不能默默覆蓋更正。姓名以外的 OTA 人工修改及取消仍不開放。
- 新直訂收付款有另一個預設關閉的入口：需 `IRON_GATE_SWEETFUN_MANUAL_PAYMENTS_ENABLED=true` 與獨立的 `IRON_GATE_SWEETFUN_MANUAL_PAYMENT_GRANT`（同館別／工作區，僅 `booking:read`、`payment:write`、`money` 範圍）。Owner／Admin／God 可在訂單詳情登記收款或退款，唯一憑證編號與時間寫入 Iron Gate append-only 事件；後端防重、同單同類憑證重複、版本及退款上限檢查後，OS 讀回核對。瀏覽器保存請求鍵供斷線後查詢。此流程不寫舊 OS 付款帳本，也不自動移轉真實銀行款項。
- 現有財務首頁和訂單收款摘要仍讀 Sheet／OS 舊帳本；Iron Gate 日曆啟用時，水芳頁面明確提示新直訂及其收付款未計入合計。不能把這些合計當完整財務數字或重複在舊帳本登記同一款項。

## 尚未開啟的正式流程

- **OTA 補登、房晚／金額等人工更正及外部來源單取消仍未開放。** 只允許上述已選定訂單的本地姓名更正；若要新增、移房或取消 OTA 訂單，還需要 OwlNest 單號的可信查詢與唯一性證據，以及來源身分／版本認領流程。
- 目前沒有可用的 OwlNest 訂單編號、房晚及取消狀態查詢入口或匯出資料，因此同平台單號的碰撞保護只是防止已知重複，不能證明兩封來源事件必為同一 OwlNest 訂單，也不能當作 OTA 認領或正式啟用依據。Iron Gate 即使已能回讀 OwlNest 庫存，也會把沒有既有來源連結的新 OTA 事件停在待核並保留 fence；庫存回讀不被當成訂單身分證明。
- 水芳 Iron Gate 已有其他正式 writer；唯讀狀態查詢顯示 `readOnly=false`、OwlNest 通路已就緒，但舊狀態缺少 `stockObservedFrom`。正式 OS 手動入口及 grant 已開啟。初次 Iron Gate 建單不依賴舊庫存窗口；指定安全房晚的按鈕關房、回讀、取消與復原已完成上述真實驗收。跨房晚改期與其他缺少本單關房證據的取消仍受舊窗口限制；同館其他 writer 的營運觀測須持續。
- 手動表單預覽只證明 Iron Gate 當下本地房晚無衝突，`externalStockVerified=false`。按「同步房況」後也要等 OwlNest 完整回讀，才能顯示同步成功；預覽或已建單都不是外部關房證據。
- 舊財務帳本逐筆對帳與報表整合另案處理，不阻擋本次 Iron Gate 建單與按鈕同步流程。獨立收付款功能仍預設關閉；目前財務首頁不合併 Iron Gate 收付款事件。

## 10 月 24 日唯讀訂單核對

以 Gmail 最近十封水芳訂單處理通知為樣本，先讀原始訂單主旨／處理附件，再讀 Iron Gate 的來源連結、訂單狀態、佔房晚與通路同步狀態。樣本原信是 **七封新訂、三封取消，沒有改單**；其中一封新訂及兩封取消曾被送入人工待核。Gmail 的通用警報名稱 `ModifyEmailNeedsReview` 不能用來判斷原信是修改。這三筆是新訂／取消，原本不建立「修改信防重 claim」，因此其警報附件中的 Firestore `set_state` 找不到 claim，不代表既有 claim 遭刪除。

截至台灣時間 2026-10-24 12:43 的唯讀資料庫快照，十個來源編號都有 Iron Gate 連結；七筆新訂目前為 confirmed，共佔十一個房晚，三筆取消目前為 cancelled、佔房晚為零。兩封因舊格式預訂日被拒的取消，已由獨立的受控修復核對來源、原請求鍵、訂單與通路回讀後完成；參見 gmail-check-order 的草稿 PR #95。另一封新訂原請求回執是 `review_required/ROOM_CONFLICT`，之後有**不同請求鍵**的 `applied` 回執；目前該來源連到一筆 confirmed、通路已驗證的單。原警報與目前資料須分開呈現，不能把較晚的套用說成原請求成功。

這次核對證明 Iron Gate 的目前狀態，不證明 OwlNest 平台訂單身分唯一，也不完成舊 Sheet／財務逐筆對帳。OTA 補登及外部來源人工更正仍維持關閉；未核對 OwlNest 訂單身分前，不用這十筆樣本解除來源待核防線。

## 驗證

合成館別已測直訂預覽、必填欄位、本地建單與讀回、按鈕前工作器閒置、按鈕後才排關房、原本已關房零寫入待核、同步中斷待核、人工隔離後保留待核房晚而讓不重疊作業續跑、遺失按鈕回應後原鍵查詢、初次同步前改期／取消、已驗證後改期／取消及庫存窗口限制。工作器若在按鈕請求讀回前已把房況轉為待核，OS 現在回報實際待核狀態，而非誤稱結果不明。既有的權限、版本衝突、來源待核、付款與通知測試仍保留；同一合成館別串起 OS 建單、按鈕同步、OwlNest 模擬回讀、改期、收款與全額退款、取消和最終回讀。PR #72 後 Iron Gate 完整測試 268 通過、9 略過，型別檢查通過；前端 Iron Gate 相關測試 36 通過，型別與 lint 通過（7 個既有警告），Next.js webpack 正式建置通過。正式水芳單房晚的寫入驗收結果見本文件上方；合成測試本身仍不證明真實寫入。
