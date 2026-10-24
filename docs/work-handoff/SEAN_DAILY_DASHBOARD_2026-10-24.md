# Sean 每日營運儀表板：資料來源修復與發布交接

日期：2026-10-24。

狀態：Iron Gate 後端與 Sean Dashboard 前端均已發布到正式網址。後端已完成來源 SQL 對帳與權限驗證；前端正式登入、HTTP、API 與 SSR 回讀均已完成。**14 筆下訂日期缺漏的來源原因已確認，但尚未取得可驗證的原始下訂日期；切換後新單的每日統計仍不完整，資料品質警示保留。** 本次記錄的前端驗證範圍為 HTTP／API／SSR，未記錄瀏覽器視覺驗收。

## 本次修復範圍

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

**來源原因已查明；真實日期回填尚未驗證，沒有修改任何訂單。** 完整的每日新單統計仍待取得原始信箱或 OTA 訂單記錄中的可驗證日期，或由產品負責人明確選定並標示另一種日期定義（例如收到新單通知日）。在此之前維持日期未知與品質警示，不宣稱水芳每日新單統計已完全修復。

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
- [ ] 取得可驗證的原始 OTA 下訂日期，或明確決定另一種統計日期定義；目前原始郵件精確匹配 0／14，真實日期回填未驗證，每日新單完整性仍受阻。
- [ ] 操作負責人安排 2026-11-13 前的報表憑證輪替；目前沒有自動輪替工作。

後續取得原始日期證據或明確的日期定義決策時，再記錄修正範圍與驗證結果；不得無聲改用處理、收信、匯入或建立時間回填。後續若執行瀏覽器視覺／互動驗收，另記實際觀察結果。
