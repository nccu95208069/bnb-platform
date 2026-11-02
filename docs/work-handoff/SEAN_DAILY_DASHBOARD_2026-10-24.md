# Sean 每日營運儀表板：資料來源修復與發布交接

日期：2026-10-24。

最新狀態：業主已明確選定「新單通知日」，後端、前端與 14 筆既有通知日補登均已發布並完成正式對帳。2026-10-24 12:17 台北時間，inventory version 59 的缺少每日統計日期筆數為 0；原始 OTA 下訂日未知的 14 筆仍保持未知，不影響其依已驗證通知日計入每日訂單。以下先記最新結果，再保留首輪來源修復的歷史證據。本次正式驗證為登入、HTTP、API 與首頁 SSR，未取得實際瀏覽器視覺／互動驗收。

## 最新發布：首次新單通知日

業主在本對話明確選擇：**新單通知日：看每天收到幾筆新單**。這是獨立的統計日期決策，沒有把收信、匯入或程式處理時間改寫成原始 OTA `bookedAt`。

新來源在受權 Gmail writer 首次成功建立 canonical booking 時，保留 `SourceLink.firstNewOrderNotification`。日期取自該封原始來源訊息的 Gmail `internalDate`，按 `Asia/Taipei` 分日；修改、取消、重送、金額補充與通路核對不會搬動首次通知時間。原始下訂日仍專供下訂提前天數使用。詳細契約與操作程序見 [新單通知日報表及受控補登](../../iron-gate/NOTIFICATION_REPORTING.md)。

每筆目前有效的確認訂單只計一次，多房、多晚與重送通知不重複計單；已取消／暫留仍不納入。歷史及其他來源沿用原下訂日並逐筆標示，沒有改名為通知日。

### 目前正式版本

| 服務 | PR／合併 | 實際部署 |
|---|---|---|
| Iron Gate | [PR #67](https://github.com/nccu95208069/bnb-platform/pull/67)，merge `7da05f9df8a0ce97bd30652fe75af2e9ff639e66` | `dpl_Cdtfje2w1H7oZ4iNzae6wc8Rj7oX`；實際來源 `35a6f388480c7a15ec2f25b391c4304fe86f3da2` |
| Sean Dashboard | [PR #103](https://github.com/nccu95208069/sean-dashboard/pull/103)，merge `c27b19164ada38f5d198691d9583b6d6a8aa5f1e` | `dpl_2HARAjHYcDoJE1GW4XzaTMGdnaBa`；實際 Git 來源為同一 merge commit |

實際正式 alias 已分別回查為上述 deployment：<https://iron-gate-green.vercel.app> 與 <https://sean-dashboard-sepia.vercel.app>。發布前核對原正式版本及目前分支，保留同時已上線的 LINE／通路功能；沒有重部署 GCO。

### 14 筆通知日補登與資料不變驗證

先用每筆唯一的原始 `source.applied`（booking version 1）、同範圍 actor／grant、精確 durable receipt 與尚未被後續來源事件取代的 link 建立證據。14／14 通過；其中一筆原請求使用既有 API 接受的 UUID4，仍適用同樣的完整證據檢查，沒有推測其原因。

實際 PostgreSQL 交易先以 `ROLLBACK` 演練全部檢查與讀回，核對原 state hash、version 58、audit 41 列、outbox 40 列完全保留。正式提交於 `2026-10-24T04:15:24.942Z` 記錄，version **58 → 59**：

- 14 個精確 source link 增加首次通知證據。
- 新增同 authority epoch 1 的報表政策，以及 14 筆通知日／1 筆政策 audit 與 outbox。
- 完整訂單集合、原始日期、booking versions、價格、付款、房晚、來源版本、receipts、通路操作與 fences 的不變摘要相同。
- 占房索引仍為 **1,774 房晚**；原始下訂日未知仍為 **14 筆**。
- 無訂單重播、郵件 claim 重設或通知寄送；私人輸入及 SQL 未放入 Git 或部署。

| 已補登的新單通知日（台北） | 筆數 | 訂房金額 |
|---|---:|---:|
| 2026-10-22 | 4 | TWD 18,145 |
| 2026-10-23 | 8 | TWD 52,683 |
| 2026-10-24 | 2 | TWD 5,794 |

### 正式 SQL／API 對帳結果

驗證時間：**2026-10-24 12:17:30 台北時間**，inventory version **59**。當前確認訂單 **1,616 筆**：14 筆通知日、1,602 筆原下訂日；缺少可用每日統計日期 **0 筆**。以下不是之後每次讀取都必須保持的固定值。

| 指標 | SQL 與正式 API 一致 |
|---|---:|
| 水芳 10/23 昨日訂單 | 8 筆／TWD 52,683 |
| 水芳 10/24 今日訂單 | 2 筆／TWD 5,794 |
| 水芳 10/17–10/23 近 7 天 | 43 筆／TWD 188,066 |
| OFFLAND 10/17–10/23 近 7 天 | 3 筆／TWD 23,800 |

近 7 天的 43 筆包含 12 筆已核對的新通知日及 31 筆明確標示的歷史／其他來源原下訂日。取得並標示這些日期不等於證明切換前通知日已完整涵蓋。

`reportingPolicy.notificationCoverageFrom=2026-10-25` 是完成本次發布後的下一個完整台北日，並非從最早一筆訂單猜測。兩個完整 7 天區間都在這個日期之後、沒有缺日期／價格且日期口徑一致時，才允許週期比較；因此最早是 **11/8** 的報表，且仍須通過其他完整性條件。當前每日數字可讀，跨口徑／未涵蓋期間的增減百分比與判斷暫停。

### 驗證與維護

- 前端：**386 tests／32 files passed**、TypeScript、正式 build 通過；lint 仍為既有 3 errors／4 warnings，無新問題。
- 後端：**224 passed、0 failed、9 optional PostgreSQL tests skipped**；check／build 通過。正式 SQL 的演練、提交及讀回另已完成。
- 獨立審查通過首次通知不可變、零訂單區間涵蓋檢查、SQL NULL 防護與精確 link 變更範圍。
- PR 精確 commit 的 [CI verify](https://github.com/nccu95208069/sean-dashboard/actions/runs/40061291306/job/120775161217) 與正式 merge commit 的 [CI verify](https://github.com/nccu95208069/sean-dashboard/actions/runs/40061557724/job/120775974331) 均成功。
- 使用正常帳密登入成功；`/`、`/pulse`、`/offland`、兩館 API 均 HTTP 200。首頁 SSR 顯示新日期口徑；`/pulse` 為 client-rendered，不能把初始 HTML 當成完成畫面。
- `/api/morning` 為 `private, no-store`；未登入回 401，直接未授權 Iron Gate report 也回 401。報表不含 canonical UUID／郵件來源版本，住客標籤固定為「旅客」。
- 臨時測試瀏覽器下載失敗，因此未新增瀏覽器視覺驗收結論；介面元件／資料契約已有自動測試，正式結果以上述 HTTP、API、首頁 SSR 與來源對帳為準。
- 原報表憑證及權限不變：**2026-11-20 16:24 台北時間到期，建議 11/13 前輪替；未設定自動輪替。** 詳細操作見下方維護段落。

## 首輪來源修復的歷史紀錄（PR #64／#102）

以下各節保留選定新單通知日之前的 version 58 結果與調查背景；目前正式結果以本文件上方最新發布段落為準。

### 首輪修復範圍

水芳訂單正本移至 Iron Gate 後，Sean Dashboard 的每日訂單統計改由服務端呼叫專用的唯讀報表端點：

```text
GET /v1/properties/:propertyId/business-report
```

報表以完整館別快照中的 canonical booking 計單，僅將 `confirmed` 訂單納入接單統計，使用 `Asia/Taipei` 的來源下訂日期。近期接單即使安排在遠期住宿日，也會納入相應接單期間。OFFLAND 保留原有資料來源。

缺少可驗證下訂日期的訂單保留為未知，仍參與適用的訂單總數與房況計算，不以匯入時間或 `createdAt` 補造日期。金額為訂房金額，不代表實收款。已驗證的逐房晚價格優先使用；需按房晚分攤的訂單保留估算提示。

## 正式發布識別

| 服務 | 合併紀錄 | 正式部署 | 正式網址 |
|---|---|---|---|
| Iron Gate 後端 | bnb-platform PR #64；merge `dd5cb674b3324dc9367e742ab183b475a40ad045` | `dpl_7GjxL92kV7a1WFfDjGvtmnB32vsy` | <https://iron-gate-green.vercel.app> |
| Sean Dashboard 前端 | sean-dashboard PR #102；merge `08aeb96eb1c4931c16a26fec018d20e57019c941` | `dpl_HdbsVzaTJKxUkVU1CRB6xaCmeFi4` | <https://sean-dashboard-sepia.vercel.app> |

Iron Gate **實際部署來源 commit** 為 `6a616bc74d1b14a29bbdbd007481d4ae4dc84df0`。它與 PR merge commit 分別記錄，避免將合併紀錄誤當成實際部署來源。

這次報表發布保留原本已上線的 LINE 訂房、批次操作與通路功能；來源修復沒有要求改動訂單、付款或庫存資料。

## 正式來源對帳

以下為發布驗證時的快照：**inventory version 58**。直接來源 SQL 與 HTTP 報表的對應統計完全一致；期間依台北時間的下訂日期計算，起訖日均包含。

| 指標 | SQL 與 HTTP 一致結果 |
|---|---:|
| 全部確認訂單 | 1,616 筆 |
| 缺少可驗證下訂日期 | 14 筆 |
| 缺少訂房金額 | 0 筆 |
| 2026-10-17 至 2026-10-23 接單 | 31 筆 |
| 2026-10-17 至 2026-10-23 訂房金額 | TWD 117,238 |
| 2026-09-24 至 2026-10-23 接單 | 147 筆 |
| 2026-09-24 至 2026-10-23 訂房金額 | TWD 548,145 |

14 筆未知下訂日期未歸入每日接單日期桶，介面須持續顯示資料品質提示。這些數字是 version 58 的驗證證據，不是後續每次讀取都必須維持的固定值。

OFFLAND 正式 `/api/offland` 回讀的當日日期為 2026-10-24；2026-10-17 至 2026-10-23 接單為 **3 筆、TWD 23,800**。

## 已確認的來源日期缺口

version 58 中缺少 `bookedAt` 的 14 筆，全都是切換後建立的 `external` 來源訂單，具備 `sourceCalendar`，沒有舊表匯入快照。平台分布為 **Booking 9 筆、Agoda 2 筆、Ctrip 3 筆**。因此這個缺口直接影響切換後新單的每日接單統計，不能只視為舊歷史資料的警示；上述 SQL／HTTP 一致僅證明系統對目前已知日期的計算一致，不代表每日新單已完整納入。

固定 GCO 執行程式來源 `8cb5546c18508f2a36ebc588a6dbf89cc1c9aba0` 的 [Gmail writer](https://github.com/nccu95208069/gmail-check-order/blob/8cb5546c18508f2a36ebc588a6dbf89cc1c9aba0/src/gmail/iron_gate_booking.py#L297-L313) 刻意對新單送出 `bookedAt: null`。其 [parser](https://github.com/nccu95208069/gmail-check-order/blob/8cb5546c18508f2a36ebc588a6dbf89cc1c9aba0/src/gmail/parser.py#L429-L440) 的 `booking_date` 使用程式處理當天，不能當作 OTA 真實下訂日；此限制已記載於同一固定版本的 [Gmail 下訂日期政策與相容性修正文件](https://github.com/nccu95208069/gmail-check-order/blob/8cb5546c18508f2a36ebc588a6dbf89cc1c9aba0/docs/SWEETFUN_GMAIL_IMPORTED_BOOKED_AT_20261024.md)。本次沒有把處理日期、Gmail 收信日期或 Iron Gate `createdAt` 改寫為下訂日期。

來源郵件查證以這 14 筆各自的 `sourceVersion` 中原始 Gmail message ID 雜湊作精確比對。限定日期與平台的連接信箱搜尋得到 24 個候選 ID，與來源雜湊比對為 **0／14 相符**；目前連接的帳號並非 GCO 原始信箱。只讀取了兩個候選的郵件 metadata，沒有讀取候選正文，無法據此確認原始通知信是否包含明確標示的 OTA 訂單成立日期。這個結果表示原始來源存取尚未成立，不能推論原信一定沒有日期，也不能將通知或轉寄的時間當作原始下訂時間。

**首輪當時：來源原因已查明，真實 OTA 日期回填尚未驗證，沒有修改任何訂單。** 後續業主已選定並授權首次新單通知日；上方最新發布段落記錄此口徑及其驗證結果。原始 OTA 日期仍未知，通知日沒有覆寫原欄位。

## HTTP 與存取權限回讀

| 驗證 | 結果 |
|---|---|
| 專用報表憑證讀取正式 `business-report` | HTTP `200` |
| 成功回應快取標頭 | `Cache-Control: private, no-store` |
| 未帶 Iron Gate 憑證讀取報表 | HTTP `401` |
| 使用報表憑證讀取原始 `bookings` | HTTP `403` |

報表 credential 使用 `origin: service`、唯一 action `booking:aggregate`、`fields: []`，並限制於既定 workspace、property 與當前 authority epoch。它沒有原始訂單讀取或任何訂單／庫存／付款寫入權限。

回應不包含住客姓名、聯絡資料、備註、來源訂單識別碼或 canonical booking／room ID。相容欄位使用固定中性住客標籤；房況僅描述確認訂單占用，不構成可售庫存保證。

## 前端正式 HTTP／API／SSR 驗證

| 驗證 | 結果 |
|---|---|
| 正常登入 | HTTP `200` |
| 登入後 `/`、`/pulse`、`/offland` | 均為 HTTP `200` |
| 首頁 SSR 內容 | 包含來源標示、14 筆日期缺漏警示、`117,238`，以及有資料的 OFFLAND 卡片 |
| 登入後 `/api/morning` | HTTP `200`；`source=iron-gate`、inventory version 58，統計與上表一致 |
| `/api/morning` 快取標頭 | `Cache-Control: private, no-store` |
| 登入後 `/api/offland` | HTTP `200`；當日及近 7 天統計與上述 OFFLAND 回讀一致 |
| 未登入 `/api/morning` | HTTP `401` |
| 正式 HTML／API 回應中的 reporting token | 未發現洩漏 |

前端精確 merge commit `08aeb96eb1c4931c16a26fec018d20e57019c941` 的 [CI verify](https://github.com/nccu95208069/sean-dashboard/actions/runs/40056446639/job/120760372530) 成功；PR verify 也已成功。上述正式環境證據來自登入請求、路由狀態、API 與 SSR 內容回讀，沒有將它延伸為瀏覽器視覺或互動驗收。

## 憑證維護：需要排程給操作負責人

| 項目 | 值 |
|---|---|
| Reporting credential ID | `e87f492c-e8f9-41d0-bf87-5615de57b89d` |
| 到期時間（UTC） | `2026-11-20T08:24:05Z` |
| 到期時間（Asia/Taipei） | 2026-11-20 16:24:05 |
| 建議最遲完成輪替日期 | **2026-11-13** |
| 自動輪替 | **未設定；不會自動續期** |

憑證仍遵守既有最長 30 天效期限制。依[報表憑證發行與輪替操作說明](../../iron-gate/REPORTING_CREDENTIAL_ROTATION.md)，使用[受限操作程式](../../iron-gate/scripts/reporting-credential.mjs)發行新的報表專用憑證，更新 dashboard 的服務端 `IRON_GATE_REPORT_TOKEN` 與精確對應的 `IRON_GATE_REPORT_EXPIRES_AT`，完成驗證後再單獨撤銷舊憑證。

發行新憑證不會自動撤銷舊憑證，讓部署與回復驗證保有重疊時間。不可透過延長舊效期、加入 `booking:read`、放寬 authority epoch，或將管理連線放入應用 runtime 來處理到期問題。本文件僅保存非秘密識別與到期資訊，不保存 token、管理連線或住客資料。

## 最後驗收與待補紀錄

- [x] Iron Gate 正式報表 SQL／HTTP 對帳，inventory version 58。
- [x] 正式報表 HTTP `200` 與 `private, no-store`。
- [x] 未授權 `401`、報表憑證原始訂單讀取 `403`。
- [x] 後端與前端正式部署識別已記錄。
- [x] 前端正式登入、三個頁面路徑、兩館 API 與首頁 SSR 回讀。
- [x] 前端精確 merge commit 的 CI verify 成功，未登入保護與 token 不洩漏檢查通過。
- [x] 確認 14 筆下訂日期缺漏皆為切換後新單，並追到 GCO 刻意送出未知日期的來源政策。
- [x] 業主明確選定首次新單通知日；後續發布與 14 筆補登已核對，當前缺每日統計日期 0 筆。真實 OTA 原下訂日期仍未知，沒有回填。
- [ ] 操作負責人安排 2026-11-13 前的報表憑證輪替；目前沒有自動輪替工作。

日期定義決策與修正結果已記錄於本文件上方。未來取得真實 OTA 原始日期時，仍需獨立證據與受控程序；不得把通知、處理或匯入時間當成原始下訂日。後續若完成瀏覽器視覺／互動驗收，另記實際觀察結果。
