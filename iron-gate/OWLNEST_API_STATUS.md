# OwlNest 登入後台接線調查

## 2026-10-24 正式單房晚驗收（更新現況）

水芳直訂已透過 Sweetfun OS 的獨立「同步房況」按鈕完成一次真實 OwlNest 寫入。指定 2027-03-20 的 101 房，OwlNest 原為 `count=1,is_lock=false`；合成直訂初次同步後，Iron Gate 作業 `752a511a-4e3a-47fc-b65b-219da6e0bd0e` 記錄原本開放並讀回 `count=0,is_lock=true`，重新載入 OwlNest 後畫面一致。OS 取消同一合成訂單後，作業 `b73bc7ef-539a-45d0-8ed5-588398178c37` 讀回 `count=1,is_lock=false`，OwlNest 畫面恢復原狀；房晚 fence、待派送作業均清空。PR #72 已合併並發布至 Iron Gate 正式站。下文較早日期的「未發出 PUT／尚未驗證」陳述是當時的調查紀錄，現況以上述結果為準。

此驗收只覆蓋一個經核對的房晚與本系統自己的手動關房證據。舊館別 `stockObservedFrom` 仍空，跨房晚改期與無完整本單關房證據的取消仍受庫存窗口限制；不能由這次庫存讀回推定 OwlNest 訂單身分、全館房況或 OTA 來源唯一性。

日期：2026-10-16（Asia/Taipei）

使用者確認：此專案不申請 OwlNest 對外開放的正式 API；沿用「登入網站後呼叫後台」的方式。以下是現有程式的實際能力與 Iron Gate 尚缺的房量寫入證據。這裡的「後台請求」是 OwlNest 網頁自己使用的 HTTP 介面，不代表公開或穩定的第三方 API 契約。

## 現有路徑

| 用途 | 現有實作 | 已知能力與限制 |
| --- | --- | --- |
| 登入與取得憑證 | `pricing-runtime-recovery/scripts/owlnest_prices.py` 的 `capture_token()` 使用 Playwright 登入，從登入後的 `/booking/v2/admin` 請求擷取 `Authorization`，拒絕 `Bearer undefined`，憑證保存在權限 0600 的本機檔案。`gmail-check-order/src/line_agent/owlnest/secrets.py` 使用同一份受限帳密來源。 | 憑證會過期；登入出現驗證碼或網站改版時須停止並轉人工。Iron Gate 不能把帳密或 Bearer 放入瀏覽器、程式庫或日誌。 |
| 日曆唯讀 | OS `frontend/src/lib/owlnest-refresh.ts` 以伺服器端 `OWLNEST_AUTHORIZATION` 呼叫 `GET /booking/v2/admin/hotels/{hotel}/calendars`，解析 `stocks[].count/is_lock`，對 401/403/30003 停止。定價工具也直接呼叫相同後台路徑。 | 可作逐晚觀測，但須驗房型映射、館別、日期完整性與觀測時間；讀到的庫存不能單獨證明直客訂單未漏關房。 |
| 價格寫入 | `pricing-runtime-recovery/scripts/owlnest_prices.py` 記錄登入後 `PUT /booking/v2/admin/hotels/{hotel}/calendars/price`，絕對價格、讀前與延遲讀回；該 recovery checkout 的真實寫入已被凍結。 | 這是價格，不能據此推定房量／販售狀態的寫入路徑或 payload；Iron Gate 不呼叫此寫入器。 |
| 開關房 | `gmail-check-order/src/line_agent/owlnest/automation.py` 的 PlaywrightDriver 登入後台，於日期面板同時設定庫存 0/1 與販售關／開，再從月曆格和重開面板兩段讀回；`executor.py` 有前置異常分類、有限重試、紀錄與告警。 | 既有服務是**網頁 UI 操作**，不是直接呼叫房量後台請求的程式。UI 的實作與測試不能充當 Iron Gate 的實際 HTTP 往返證據。 |

2026-10-16 另從 OwlNest 自己的[公開 PlanView 程式](https://www.owlting.com/booking/admin/js/PlanView.4d7b8c.min.js)定位到日曆畫面的候選寫入：`PUT /booking/v2/admin/hotels/{hotel}/calendars/stock`，畫面建構 `stock_items`，單格包含 `room_ids`、`week_days`、同一天起訖、`exclude_holiday`，勾選庫存時含 `count`／`safe_stock_check`，勾選販售狀態時含 `is_lock`。目前 UI 可同時勾選兩項；關房候選值為 `count=0,is_lock=1`，開房為 `count=1,is_lock=0`。[公開請求 wrapper](https://www.owlting.com/booking/admin/js/utility.min.js?v=ow_2610070502)會補 `lang` 並交給 jQuery；stock 路徑未設 `isJson`，因此與價格寫入的 JSON 路徑不同。實際傳輸編碼仍須看登入後的網路紀錄。`src/owlnest-stock-command.mjs` 僅依這份靜態程式建構送進頁面 wrapper 的單房晚資料，**不持有憑證、沒有序列化器或 HTTP 寫入功能**。真實權限、回應與非同步效果仍未經登入帳號實測，不可把靜態程式碼當成功寫入證據。

### 登入後唯讀驗證（2026-10-16）

依使用者指定的唯讀範圍，沿用既有登入命令與本機受限帳密取得短效憑證，再對已知館別的一個房型、一個日期送出 `GET /booking/v2/admin/hotels/{hotel}/calendars?during_start_date=2026-10-17&during_end_date=2026-10-17`。HTTP 回 `200`，回應頂層為 `status: 0` 與 `data`；指定房型的 `stocks[]` 有 `date`、數字 `count`、布林 `is_lock`，另有 `day_of_week`、`is_allow_update`、`max_stock_count`。Iron Gate 的 `createOwlNestWebReadback()` 使用同一憑證與這個 GET，成功解析一個房晚；檢查只輸出欄位型別，沒有保存或顯示真實房量、價格、旅客資料或憑證。這驗證了**目前的唯讀日曆路徑**，並不驗證 stock PUT 的編碼或寫入效果。沒有送出任何 PUT，也沒有變更房況或價格。

## Iron Gate 的接線方向

1. 在登入後的受控測試工作階段，從瀏覽器網路紀錄核對上述候選請求的實際 URL、編碼、館別／房型／日期欄位、回應與延遲生效方式。先只讀觀察；不要把價格 PUT 當作房量 PUT，也不能只因 UI 顯示成功就認定房晚已同步。不得儲存或輸出 Bearer、cookie、帳密或旅客資料。
2. 建立館別專用的後台操作 adapter。每筆 Iron Gate 操作先持久化房晚 fence 與操作鍵，再用絕對值逐晚設定；結果未知時不盲目重送。沿用既有前置分類、館別雙重核對、逾時、受控重試及告警經驗。
3. 操作後以已知日曆 GET 逐晚讀回 `count/is_lock`，再核對 Iron Gate 最新訂單／fence；觀測不完整、相矛盾或過期時維持停售與人工核對。`src/owlnest-web-readback.mjs` 已把這個唯讀路徑做成注入憑證的 adapter，含固定主機、館別／房型映射、回應大小限制、登入失效與缺格拒絕的合成測試；目前只用真實帳號驗證過一個房晚的**讀取**。開房尤其要確認沒有別的訂單或人工鎖。要用不影響真實銷售的隔離測試館／日期驗證單筆關房、開房、部分失敗與還原；使用者目前只授權唯讀觀測。
4. 只有上述房量請求與讀回在受控環境被實測，且逐館 lease、房型映射、憑證保管與修復流程完成後，才將寫入 adapter 接到 `src/channel-runner.mjs`。目前它仍是合成模擬，OwlNest 館 `saleReady=false`。

此調查已登入 OwlNest，並唯讀驗證一個房晚的日曆回應結構；未更改房況或價格。

### 2026-10-21 候選傳輸補齊

再次唯讀檢查 OwlNest 當前公開的 PlanView 與 utility 程式：單房晚更新仍走 `PUT .../calendars/stock`。頁面先把 `lang` 與 `stock_items` 合併，再交給 jQuery 預設的表單序列化；utility 也把語言加到 URL 查詢。`src/owlnest-web-provider.mjs` 現在依此建立單房晚的 `application/x-www-form-urlencoded` 請求，包含房型、日期、庫存 0/1、停售狀態和防超賣欄位。它由注入的短效授權和 HTTP client 呼叫，固定 OwlNest 主機、拒絕登入重導與異常回應，不自動重送結果不明的 PUT；`src/channel-runner.mjs` 必須再執行新的日曆 GET 並記錄每格讀回，才可能解除房晚 fence。

這仍是**未接入正式 dispatch 的候選**。合成測試覆蓋表單欄位、GET→PUT→GET 與結果不明時不重送；公開網頁程式和模擬回應不能證明登入後 stock PUT 被接受，也不能證明線上房量會按預期變更。須由業主指定不影響接單的測試房晚，明確同意受控的關房、讀回、復原、再讀回，並核對實際傳輸與效果後，才可接上正式通路 runner。此前沒有發出 OwlNest PUT，`saleReady=false`。

受控真機測試須先固定**唯一館別、房型、日期**及原始房量，查原 Sheet 沒有該房晚訂單或衝突，確認不是房價實驗的保護日期，且擁有者可即時處理異常。短效登入憑證只在受限本機讀取；連續兩次日曆 GET 必須均為 `count=1,is_lock=false`。只送一次單格絕對關房 PUT，之後輪詢 GET 到 `count=0,is_lock=true`；再送一次單格絕對開房 PUT，輪詢 GET 到原始 `count=1,is_lock=false`。每次記錄請求時間、HTTP 狀態、回應狀態與精確房晚讀回，不記錄 token、cookie 或旅客資料。PUT 回應成功但房量未變、結果不明、讀回逾時或出現其他訂單時，都不得盲目重送或宣稱恢復；立刻以唯讀 GET 確認實際狀態，暫停該房晚接單並通知擁有者處理，直到讀回原狀或明確記錄未復原。這個受控測試只驗證一格與當時網站版本，正式接線仍需逐館 lease、憑證管理及事件消費驗收。

`src/owlnest-stock-probe.mjs` 將上述兩次基線讀回、關房與復原各一次寫入、結果不明時的唯讀確認實作為獨立流程。它需要呼叫者提供當下原表無訂單與非實驗保護日期的檢查函式；缺少這項檢查時不會執行。尚未對真實 OwlNest 呼叫，也未接上正式排程。
