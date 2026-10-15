# OwlNest 登入後台接線調查

日期：2026-10-16（Asia/Taipei）

使用者確認：此專案不申請 OwlNest 對外開放的正式 API；沿用「登入網站後呼叫後台」的方式。以下是現有程式的實際能力與 Iron Gate 尚缺的房量寫入證據。這裡的「後台請求」是 OwlNest 網頁自己使用的 HTTP 介面，不代表公開或穩定的第三方 API 契約。

## 現有路徑

| 用途 | 現有實作 | 已知能力與限制 |
| --- | --- | --- |
| 登入與取得憑證 | `pricing-runtime-recovery/scripts/owlnest_prices.py` 的 `capture_token()` 使用 Playwright 登入，從登入後的 `/booking/v2/admin` 請求擷取 `Authorization`，拒絕 `Bearer undefined`，憑證保存在權限 0600 的本機檔案。`gmail-check-order/src/line_agent/owlnest/secrets.py` 使用同一份受限帳密來源。 | 憑證會過期；登入出現驗證碼或網站改版時須停止並轉人工。Iron Gate 不能把帳密或 Bearer 放入瀏覽器、程式庫或日誌。 |
| 日曆唯讀 | OS `frontend/src/lib/owlnest-refresh.ts` 以伺服器端 `OWLNEST_AUTHORIZATION` 呼叫 `GET /booking/v2/admin/hotels/{hotel}/calendars`，解析 `stocks[].count/is_lock`，對 401/403/30003 停止。定價工具也直接呼叫相同後台路徑。 | 可作逐晚觀測，但須驗房型映射、館別、日期完整性與觀測時間；讀到的庫存不能單獨證明直客訂單未漏關房。 |
| 價格寫入 | `pricing-runtime-recovery/scripts/owlnest_prices.py` 記錄登入後 `PUT /booking/v2/admin/hotels/{hotel}/calendars/price`，絕對價格、讀前與延遲讀回；該 recovery checkout 的真實寫入已被凍結。 | 這是價格，不能據此推定房量／販售狀態的寫入路徑或 payload；Iron Gate 不呼叫此寫入器。 |
| 開關房 | `gmail-check-order/src/line_agent/owlnest/automation.py` 的 PlaywrightDriver 登入後台，於日期面板同時設定庫存 0/1 與販售關／開，再從月曆格和重開面板兩段讀回；`executor.py` 有前置異常分類、有限重試、紀錄與告警。 | 目前查到的是**網頁 UI 操作**，不是直接呼叫房量後台請求的程式。UI 的實作與測試不能充當 Iron Gate 所需的逐晚後台寫入請求契約。 |

## Iron Gate 的接線方向

1. 在登入後的受控測試工作階段，從瀏覽器網路紀錄辨認「變更庫存」與「變更販售狀態」所發送的確切請求、館別／房型／日期欄位、回應與延遲生效方式。先只讀觀察；不要猜測路徑，也不要把價格 PUT 當作房量 PUT。不得儲存或輸出 Bearer、cookie、帳密或旅客資料。
2. 建立館別專用的後台操作 adapter。每筆 Iron Gate 操作先持久化房晚 fence 與操作鍵，再用絕對值逐晚設定；結果未知時不盲目重送。沿用既有前置分類、館別雙重核對、逾時、受控重試及告警經驗。
3. 操作後以已知日曆 GET 逐晚讀回 `count/is_lock`，再核對 Iron Gate 最新訂單／fence；觀測不完整、相矛盾或過期時維持停售與人工核對。開房尤其要確認沒有別的訂單或人工鎖。要用不影響真實銷售的隔離測試館／日期驗證登入、單筆關房、開房、部分失敗與還原。
4. 只有上述房量請求與讀回在受控環境被實測，且逐館 lease、房型映射、憑證保管與修復流程完成後，才將 adapter 接到 `src/channel-runner.mjs`。目前它仍是合成模擬，OwlNest 館 `saleReady=false`。

此調查讀取本機程式與文件，未對 OwlNest 發送請求或更改房況。
