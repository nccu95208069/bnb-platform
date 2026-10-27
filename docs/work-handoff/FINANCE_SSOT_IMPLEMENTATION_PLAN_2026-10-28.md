# Iron Gate 財務單一事實來源：實作交接規格

**文件日期：**2026-10-28（台北）
**性質：**設計與後續開發交接；本文件不代表程式、資料或正式服務已切換。
**第一個切換對象：**Sweetfun。其他民宿逐館啟用，不能直接套用 Sweetfun 的刷卡週期或權限。
**給實作者的起點：**先完成第 10 節 W0 的現況核對，再依 W1–W8 順序施工。遇到與本文件不同的正式環境或程式行為，停在該工作包，留下證據並更新本文件；不要猜測資料、擴張寫入範圍或跳過對帳。

## 接手模型的執行順序

1. 讀本文件、目標 repo 的 `AGENTS.md` 與第 11 節列出的現有實作；先做 W0，記下**當前正式部署與資料**，不要沿用 2026-10-28 的數字當最新狀態。
2. 一次只交付一個工作包的程式與驗收；在 W1–W6 期間保持正式財務 writer 不變。任何新增正式資料寫入都等 W7 的逐館對帳與切換。
3. 修改一個既有路徑時，同時查它的來源 ID、booking link、授權、重試與讀模型；若其中任何一項沒有證據，先放待核對，不能用「看起來相同」補值。
4. 每次回報都按第 12 節列出基線、變更、測試、對帳、旗標、部署和未解問題，讓下一位開發者可以續接。

## 1. 已確定的產品決策

1. **Iron Gate 是訂單關聯的財務與成本資料唯一接受端。**LINE OA、OS、Sean Dashboard 是操作入口。接受成功後，所有財務讀取以 Iron Gate 的正式帳本及其投影為準。
2. **LINE OA 與 OS 是日常登錄入口。**保留各自容易操作的預覽、確認及權限；切換後不能繼續把 Firestore 或 Redis 當另一份可改的正式財務帳本。
3. **Sean Dashboard 刷卡流程只屬於 Sweetfun。**保留現有人工標記 Done/Fail、預覽、確認及同步路徑。日後其他民宿可選不同的卡片服務與週期，不能因為共用帳本就自動取得 Sweetfun 的刷卡功能。
4. **Google Sheet 是每館可直接編輯的批次補登與操作表，不是每日交易的主儲存。**在輸入表中編輯，經「預覽／提交」同步至 Iron Gate；成功的原始版本留存不可改，後續改動形成新版本。Iron Gate 回寫狀態與查詢投影。不能靠單一 `onEdit` 觸發器保證同步，也不能把 Sheet 投影再次匯入成新收入。
5. **訂單連結必須精確。**正式接受時要有 Iron Gate preview 驗證、綁定訂單版本的 booking UUID；來源表可先用可稽核的 OTA ID／舊訂單鍵由 IG **精確解析**，不要求人手填 UUID。不能用房客姓名、入住日、金額近似比對。不明確的列進待核對，不進帳。
6. **「記錄收款」只表示有人登錄收款事實或證據，不代表系統真的刷卡、匯款或銀行已入帳。**卡片 Done 是人工確認；銀行／處理商結算、手續費與付款日期必須有各自的證據。不得推算或捏造。
7. **修正與作廢用新版本及反向事件。**正式事件和稽核不可直接覆寫或刪除；「作廢登錄」不等於「已退款」。真正退款另記一筆有原收款參照的事件。
8. **每館資料、憑證、Sheet、權限、切換旗標與核對報表分開。**不讓使用者傳入任意 property ID 就取得跨館權限。

### 明確不在第一期的事

- 不替銀行執行收付、自動銀行對帳或申報；若取得外部處理商／銀行證據，只保存其核對結果，不自動計算正式會計損益或稅額。
- 不將 OTA 顯示的房客付款，同時當成民宿實際入帳與 OTA 撥款收入。
- 不把 Sweetfun 舊 Calendar Sheet 解凍成財務主帳，也不把 LINE 現有 Sheet 投影當成可重複匯入的輸入表。
- 不在這次遷移中開啟 Offland 尚未通過核對的 OS 收款寫入。每館須獨立驗證、獨立切換。
- SaaS 客戶工作區 `/w/[slug]/finance` 有另一套 workspace 資料模型；第一期只處理 Sean OS 與上述入口。它須依 W8 建立獨立接入包，不可偷偷共用 Sweetfun 權限。

## 2. 現況基線與不能破壞的地方

以下是 2026-10-28 的程式及只讀正式環境盤點。W0 要重新確認部署版本與實際儲存；不要把當日盤點當成永久真相。

| 入口／現存資料 | 現況 | 遷移要求 |
| --- | --- | --- |
| Iron Gate 訂單 | `iron_gate.property_state.state_json` 裝訂單、房晚、訂單內 `paymentEvents`、`cardChargeResults`；沒有完整成本帳 | 在 `iron_gate` 私有 schema 新增正規化財務帳本；保留既有訂單與舊 API 相容讀取，不直接批量改訂單 JSON |
| OS 原生直訂收款／退款 | 已能寫 Iron Gate 訂單 `paymentEvents`；Sweetfun 正式功能旗標已開 | 既有事件應按**原 event ID**只映射一次；切新帳本時與相容投影在同一個可恢復交易中完成 |
| OS 手動收入／支出、週期費用等 | `sweetfun-os:finance:v1:{property}:{year}` 私有 Redis | 辨別現金已付、預定週期、跨月分攤；切換後 Redis 歷史只讀，OS 讀 Iron Gate 投影 |
| OS 舊訂單收款 | `sweetfun-os:payments:v1:{property}:{sha256(orderId)}` 私有 Redis；`status_only` 可表示零現金狀態 | `status_only` 不能變成收入；舊收款須映射到確切 booking UUID 或待核對 |
| LINE OA 財務 | Firestore `line_finance_v1_books/{property}` 有 entry 版本、稽核、操作與 outbox；目前投影到受保護 Sheet 的「財務異動紀錄」「訂單收款摘要」 | 沿用原授權員工／管理員各自的預覽／確認權；該館切換後先寫 Iron Gate 才回覆「已登錄」，Firestore 舊紀錄只讀；舊 Sheet 投影不得重匯 |
| Sean Dashboard 卡片 | Sweetfun Done/Fail → 人工預覽確認 → cc-sync → OS bridge → Iron Gate card-sync；Done 產生房價全額的既有 payment event，Fail 只留稽核 | 現有 Done 事件只認一次；不能當成銀行結算，不可把卡號／效期帶入新帳本或 Google Sheet |
| 每館 Google Sheet | 尚未有本設計的批次操作表 | 新增獨立工作簿；可編輯輸入列、明確預覽提交、版本與回寫狀態；不寫舊 Calendar Sheet |

**已觀測的正式資料快照：**Sweetfun Iron Gate 在盤點時有 10 筆 booking `paymentEvents`（皆信用卡）、12 個卡片結果（10 Done、2 Fail）；這只作遷移核對基線，不能據此推論全部現金收款。正式版本可能繼續變動。保存聚合數與來源版本即可，盤點紀錄不要複製房客或卡片資料到程式庫。

**重要相容限制：**目前 Iron Gate 的 `recordPaymentEvent` 只接受單筆訂單的 `received/refunded`，不支援成本、多訂單分攤或一般編輯／作廢。有 OS 舊訂單讀取路徑假設 `booking.version === 1 + paymentEvents...`；所以不可把 LINE／Redis 歷史資料直接塞進 `booking.paymentEvents`，否則會破壞訂單判讀。新帳本的歷史事件留在正規化資料表，訂單財務畫面用新投影讀取。

## 3. 共同語意：每筆金額到底代表什麼

**幣別與時間：**第一期只接受 TWD，傳輸與 DB 一律用整數 `amount_cents`，不可用浮點數金額。交易時間存 UTC，民宿營業日期與月份依 `Asia/Taipei`。`effective_on` 是來源事件日期，只用於穩定排序；`cash_on` 是**來源登錄的收／付日期**（LINE 支出的原 `paid_on` 映射此欄，並保留其證據級別）；`service_on` 是住宿／服務日；`attribution_month` 是管理報表攤提月。這些欄位分開儲存，不能從 `effective_on` 反推現金月或服務月。沒有收付的觀察事件可沒有 `cash_on`，有現金效果的事件必填。缺日期或不合理月份進待核對，不推斷。

**攤提政策版本：**LINE 舊費用以**整元**計算且餘數放最後一個月，例如 800 元分 3 月為 266／266／268；回填時必須逐月保留原結果並標 `allocation_policy=line_v1_last_month_whole_twd`。OS 歷史若已有明確 `expense_spread`，逐月照原值匯入，不重算。新輸入採整數分平均、餘數依月份由早至晚各加 1 分，標 `allocation_policy=ig_v1_earliest_cent`。不得用新規重算 LINE／OS 歷史；若未來要統一歷史算法，需另做明示修正及逐月對帳。

| 事件類型（API 值） | 何時成立 | 訂單關聯 | 收支呈現 |
| --- | --- | --- | --- |
| `property_receipt` | 民宿登錄確實收到房費、訂金或其他款，含人工確認的卡片 Done | 房費／訂金必須精確連訂單；其他收入可無訂單 | 記錄為民宿收款；保留 `evidence_level`，不可宣稱銀行已結算 |
| `property_refund` | 實際退還先前收款；必須指向原 receipt，可分次退且總額不超過原額 | 同原收款的訂單 | 降低淨收款；不等於「作廢登錄」 |
| `ota_guest_payment_observed` | 只知道房客已向 OTA 付款 | 精確連訂單 | **非民宿現金收款**；單獨顯示，不加到民宿收款或 OTA 撥款 |
| `ota_payout` | 有 OTA 撥入民宿的證據 | 可分攤多訂單；手續費不可猜 | 記民宿收到的款；同一 OTA 訂單須標示支付路徑，報表不得再把房客付款加一次 |
| `expense_paid` | 民宿確實付出成本 | 可選訂單；必須連 property、成本類別及付款日 | 現金支出依 `paid_on`，管理成本依攤提月份 |
| `processor_fee_paid` | 有處理商／OTA 費用實際扣款或帳單證據 | 可選關聯 payout／訂單 | 支出；不得由總額和淨額自行捏造 |
| `informational_status` | 例如 OS `status_only` 或未付款的週期預告 | 可選 | 零現金，不能產生財務 event；保留非金錢狀態／計畫紀錄 |

**來源證據級別：**`operator_attested`（人工宣告，含卡片 Done）、`provider_notice`（來源通知）、`processor_confirmed`（處理商交易證據）、`bank_reconciled`（銀行核對）。只能依實際證據提升；不能因寫入 Iron Gate 自動變成已結算。UI 必須顯示級別，尤其是卡片及 OTA 款。下表的 `cash_effect_cents` 表示**營運帳上記錄的收付效果**，並非銀行驗證結果；銀行已核對金額必須另以 evidence level 篩選。

**訂單財務摘要分開顯示：**房價、民宿已登錄收款、已登錄退款、房客付 OTA 的觀察值、OTA 實收撥款、成本、未結款與證據狀態。`未結款`只在應收方與訂單總額明確時計算；OTA 代收、混合付款或資料缺漏時顯示「待核對」，不能假定 `房價－所有收款`。成本不直接沖減已收房費；月報可另外列淨額。

## 4. Iron Gate 資料模型與交易規則

### 4.1 新增的私有資料表

在 `iron_gate` schema 新增 migration；表名可沿用下列名稱，若現有框架命名衝突，需全套同步改名並更新契約測試。財務讀寫不可依靠直接改 `property_state.state_json` 的陣列。

| 表 | 最少欄位與索引 | 用途／不變條件 |
| --- | --- | --- |
| `finance_connector` | `source_instance_id uuid PK`, `property_id`, `source_system`, `source_account_ref nullable`, `credential_ref`, `enabled`, `cutover_at`, `scan_cadence`, `confirm_policy`, `watermark`, `version`, `updated_at`; unique `(property_id,source_instance_id)` | 每館每個核可來源帳號／工作簿／adapter 一個穩定實例；`source_account_ref` 是安全的商戶帳號代碼／雜湊，不是密鑰。掃描頻率與允許入帳分開。Sweetfun 卡片實例保持 weekly/manual，其他館預設 disabled |
| `finance_document` | `id uuid PK`, `property_id uuid`, `kind`, `source_system`, `source_instance_id`, `source_record_id`, `current_version int`, `status`, `created_at`, `updated_at`; unique `(property_id,source_instance_id,source_record_id)` | 來源的一個邏輯收入／成本／撥款紀錄；只增版本，不能換 property／source ID；同一館兩個商戶帳號或工作簿也不會碰撞 |
| `finance_revision` | `document_id FK`, `version int`, `action`, `request_hash`, `source_version`, `created_at`, `actor_ref`, `reason_code`; PK `(document_id,version)` | 每次新增、修正、作廢的不可變版本。`source_version` 在同 document 必須唯一；一個 revision 可以包含「抵銷舊版＋生效新版」兩個以上 event |
| `finance_event` | `id uuid PK`, `property_id`, `document_id FK`, `revision_version int`, `event_kind`, `amount_cents bigint`, `cash_effect_cents bigint`, `currency`, `effective_on date`, `cash_on date nullable`, `service_on date nullable`, `recorded_at timestamptz`, `category_code`, `receipt_purpose nullable`, `payment_method_code nullable`, `payment_account_ref nullable`, `advanced_by_ref nullable`, `safe_description nullable`, `evidence_level`, `evidence_ref`, `reverses_event_id nullable`, `related_receipt_document_id nullable`, `related_receipt_event_id nullable`, `actor_ref`, `created_at`; indexes `(property_id,effective_on,id)`, `(property_id,cash_on,id)`, `(property_id,document_id,revision_version)` | 只追加；`amount_cents>0`，`currency='TWD'`；有現金效果必有 `cash_on`，非現金觀察 `cash_effect_cents=0`；反向事件恰好抵銷所指事件，原事件仍在。`category_code` 用每館受控分類，不從自由文字推算 |
| `finance_allocation` | `event_id FK`, `booking_id uuid`, `property_id`, `amount_cents bigint`, `allocation_kind`, PK `(event_id,booking_id,allocation_kind)`；index `(property_id,booking_id,event_id)` | 一筆收款／撥款可連多訂單；總分攤不得大於事件金額，要求全額歸屬的類型必須相等；booking 必須存在同館 Iron Gate 狀態 |
| `finance_expense_attribution` | `event_id FK`, `property_id`, `month date`, `amount_cents bigint`, `allocation_policy`, PK `(event_id,month)` | 支出管理月份。`month` 固定當月 1 日；同事件分攤合計必須等於費用額，和實際付款日分開；歷史 LINE 要保留原分月與政策版本 |
| `finance_source_link` | `property_id`, `source_instance_id`, `source_order_key`, `booking_id`, `verified_booking_version`, `source_snapshot_hash`, `evidence_ref`, `verified_at`; unique `(property_id,source_instance_id,source_order_key)` | 舊訂單鍵對照；保存建立對照時的 booking 版本，提交仍須重驗當前版本；只能由有證據的確切 ID 建立，不做姓名／日期模糊搜尋 |
| `finance_source_alias` | `property_id`, `source_instance_id`, `source_record_id`, `canonical_document_id`, `evidence_ref`, `verified_at`; unique `(property_id,source_instance_id,source_record_id)` | 同一筆**經濟事件**同時出現在 OS、LINE、卡片等來源時，經人工或共同交易 ID 核實後只指向一個正式 document；不能只因同金額／日期／訂單就自動合併 |
| `finance_payment_ownership` | `property_id`, `provider_code`, `source_account_ref nullable`, `provider_transaction_ref nullable`, `booking_id`, `existing_payment_event_id nullable`, `canonical_document_id`, `verified_at`; unique on non-null `(provider_code,source_account_ref,provider_transaction_ref)` **跨館**，另 unique existing event ID | 同一實際付款的歸屬。保留現有 Card/OS ownership 防線；有處理商交易 ID 可自動擋重，無可靠 ID 時依既有 booking/payment 狀態提出疑似重複 review，不能自動合併；跨館重複只回衝突碼，不洩露他館資料 |
| `finance_account` | `id`, `property_id`, `code`, `display_name`, `kind`, `status`, `version`; unique `(property_id,code)` | 每館付款帳戶的安全代碼與顯示名稱；不存完整銀行帳號或憑證。event 的 `payment_account_ref` 必須屬於同館 |
| `finance_category` | `property_id`, `kind`, `code`, `label`, `status`, `version`; PK `(property_id,kind,code)` | 每館受控收入／成本分類；Sweetfun 初始匯入 OS 現有分類及核可的 `custom_*`，歷史未知保持 `unclassified` 待分類，不猜 |
| `finance_recurring_rule` | `id`, `property_id`, `source_instance_id`, `source_record_id`, `version`, `cadence`, `start_on`, `end_on`, `next_due_on`, `status`, `category_code`; unique on source key | OS 週期支出規則及到期計畫；**不代表已支付**，不能直接產生 `expense_paid` |
| `finance_payout_rule` | `property_id`, `platform`, `mode`, `day`, `offset`, `version`, `status`; PK `(property_id,platform)` | OS 原有 OTA 預計撥款規則；只預估到期，不證明 OTA 已撥款，也不產生金錢事件 |
| `finance_operational_status` | `id`, `property_id`, `booking_id nullable`, `source_instance_id`, `source_record_id`, `version`, `status_code`, `settles_room boolean`, `recorded_at`; unique on source key/version | OS `status_only`、未付款計畫等零金額狀態；`settles_room=true` 保留「房費已確認」的業務意義，但不產生現金；可查詢不進金錢總和 |
| `finance_evidence_assertion` | `id`, `property_id`, `event_id`, `evidence_level`, `evidence_ref`, `processor_transaction_ref nullable`, `settlement_batch_ref nullable`, `bank_on nullable`, `recorded_at`, `actor_ref`; unique on `(property_id,event_id,evidence_level,evidence_ref)` | append-only 的後續處理商／銀行核對證據；提升可證明的狀態，不改原 event，也不新增房費收入 |
| `finance_settlement` | `id`, `property_id`, `source_instance_id`, `settlement_batch_ref`, `processor_transaction_ref nullable`, `gross_cents`, `refund_cents`, `fee_cents`, `net_cents`, `bank_on nullable`, `evidence_ref`, `created_at`; unique `(property_id,source_instance_id,settlement_batch_ref)` | 有處理商／銀行證據時才建立的清算核對。`gross-refund-fee=net`，連到原收款／退款／費用事件；清算本身不是第二筆房費收入 |
| `finance_settlement_link` | `settlement_id`, `property_id`, `event_id`, `role`, `amount_cents`; PK `(settlement_id,event_id,role)` | 明確連結清算 batch 的 gross 收款、refund 與 fee 事件；按 role 的合計須和有證據的 settlement 金額相符，不能靠同日期猜 |
| `finance_request_receipt` | `property_id`, `source_instance_id`, `request_key`, `request_hash`, `status`, `response_json`, `created_at`; PK `(property_id,source_instance_id,request_key)` | 重試與未知回應恢復。同 key/同 hash 回同一結果；同 key/不同 hash 回 409；不能重複入帳 |
| `finance_outbox` | `id`, `property_id`, `source_kind`, `source_id`, `destination`, `status`, `attempts`, `next_attempt_at`, `last_error_code`; unique `(property_id,source_kind,source_id,destination)` | Google Sheet／報表投影的可重試派送；`source_kind` 可為 event、operational_status、recurring_rule、payout_rule、evidence_assertion、settlement，零現金變動也會刷新訂單摘要；投影不參與財務接受結果 |
| `finance_import_issue` | `id`, `property_id`, `source_instance_id`, `source_record_id`, `source_version`, `canonical_document_id nullable`, `reason_code`, `severity`, `status`, `created_at`; unique on source revision/reason | 不明訂單、重複、欄位缺失等 `blocking` 列不能進正式金額；歷史分類缺失可為 `classification_only`，金額與日期已核實時以 `unclassified` 接受並待分類，連到已接受 document |

`source_system` 初始固定允許 `iron_gate_native`、`os_manual`、`os_legacy_payment`、`line_finance`、`sweetfun_card`、`sheet_bulk`、`ota_evidence`；不接受任意自由字串。`source_instance_id` 由館別綁定的 connector 產生且不得由 body 任選；同一系統可有多個商戶帳號。`source_record_id` 對原生 IG 用不可變 event ID，對 Redis 舊收款用 receipt ID，對 Sheet 用穩定 `row_id`；這三者的初版 `source_version=1`。Firestore entry 以原 entry ID 及原版本表示。Sweetfun Card 的來源 document ID 固定為該館 booking UUID，**不是**週分頁／列號；每次原 IG card result 的不可變 fingerprint 對應一個新 revision（依已確認順序遞增 version），Fail 是非金錢 revision，Done 的事件 ID 沿用原 deterministic `cardPaymentId`。未來分次刷卡須另有處理商 capture ID，不能濫用「一單一 card ID」。`evidence_ref` 只能是安全的來源參照或雜湊，不能含卡號、完整付款憑證、房客個資或原始對話。`finance_source_alias` 先於導入判斷；兩個來源可能描述同一筆款但沒有可靠共同 ID 時，標為疑似重複待核對，不自動接受第二筆，也不自動合併。

`cash_effect_cents` 的固定規則：`property_receipt`、`ota_payout` 為 `+amount_cents`；`property_refund`、`expense_paid`、`processor_fee_paid` 為 `-amount_cents`；`ota_guest_payment_observed` 為 0；reversal 為被抵銷事件效果的相反數。這是營運收支視角，並非複式會計分錄。退款還須有穩定的 `related_receipt_document_id`，並保留最初對應的 `related_receipt_event_id` 作稽核；receipt 修正後，退款仍屬同一邏輯 document，不能只看已反向的單一 event 算退款上限。作廢／修正的 reversal 則用 `reverses_event_id`。同一 event 不可被重複抵銷超過其效果。費用攤提與 booking allocation 必須隨原事件的 reversal 產生對應反向效果，不能只改總額而留下舊月份或舊訂單分攤；成本月報對原 `expense_paid` 分攤加正成本，對其 reversal 的同月份分攤減成本。**reversal 沿用原事件的 `effective_on`、`cash_on`、`service_on` 及分攤月份，讓歷史月份被正確重述；真正退款使用實際退款當日 `cash_on`。**`recorded_at` 永遠是追加該事件的當下 UTC，不可回填假時間。

**Sweetfun 初始分類對照：**成本沿用 OS `laundry, water, electricity, gas, utilities, cable, internet, cleaning, supplies, repairs, rent, small_items, other`，核可的自訂項目維持 `custom_*` 與原名稱；收入沿用 `lodging, breakfast, overtime, extra_guest, partner, other`。LINE 的 `room/deposit/extra` 是 `receipt_purpose`，不是新成本分類；既有 `room/deposit` 的收入分類用 `lodging`，`extra` 在無細類證據時用 `other` 並保留 purpose=extra，不把它誤算成房費。LINE 舊支出若金額／日期已核實、只有分類不明，以 `unclassified` **納入成本總額**並開 `classification_only` 待分類；新登錄則必須選分類。每館可有自己的分類字典，但代碼一經使用不能改寫舊事件意義。

**約束放在資料庫與交易內，而非只放 UI：**各表以 property 範圍建立 FK／複合唯一鍵和查詢索引；服務角色只開必要權限，RLS／授權查詢禁止跨館。`finance_revision`、event、allocation、attribution、receipt、outbox 要在**同一 DB 交易**提交。交易中鎖定該 document／來源版本，驗證原版本、booking property、退款上限、分攤合計與來源唯一鍵；接受後才發出 receipt。不要先回成功、再非同步寫錢。各子表的 `property_id` 須由父表帶入並以複合 FK 或交易檢查驗證，不能讓表面相同的 UUID 跨館引用。

### 4.2 新增、修正、退款、作廢的確切行為

- **新增：**先查該來源實例的 alias、payment ownership 及同訂單既付狀態；若已映射到正式 document，回原 receipt／提出已存在的精確連結，不能另建。對房費／訂金，以**所有入口**的同訂單有效淨收款加本次金額檢查房價上限；現有 OTA 已付／Card ownership 狀態與收款方不明時先進 review，不能仿照舊 LINE 或只看 OS 單一路徑。`extra` 另列用途，不擠進房價上限。無可靠共同交易 ID、但同訂單出現疑似同款時先 review。通過後對 `(property,source_instance_id,source_record_id)` 建 document v1，事件及分攤同交易寫入；回 `document_id`、`version=1`、`event_ids`、`request_key`、最終狀態。
- **修正：**請求需帶 `expected_version`。先追加抵銷前一版經濟效果的 reversal event，再追加新版本事件與分攤；document `current_version+1`。如果是補描述等不影響金額的欄位，也記 revision/audit，不產生假的金錢變動。版本不符回 409，附當前版本，不自動覆蓋。修正 receipt 金額時，交易內重新計算所有**有效** linked refunds；新有效收款低於已退款總額就 409 拒絕，不能留下指向已失效金額的退款鏈。若退款本身登錄錯誤，先經授權修正／作廢該退款，再改原收款。
- **作廢錯誤登錄：**用 reversal 抵銷該 document 目前生效事件並標記 `void`，保留歷史；此動作**不代表已把錢退給客人**，UI 要用「作廢登錄」而不是「退款」。原收款已有有效退款時不可直接作廢，先處理該退款鏈並在同館交易內重驗。
- **退款：**新增 `property_refund` document/event，指向原 `property_receipt`；交易中檢查同館、已接受且未作廢的**淨有效收款**、歷次有效退款總額和此次金額。可部分退款；不得因卡片 Fail 或單純訂單取消自動生成退款。舊 Iron Gate API 曾允許沒有 `refundOfEventId` 的退款；歷史回填須找確切原款證據，找不到就進 review。新 API 與切換後的新入口一律要求原收款 event ID。
- **來源重試：**所有入口提供穩定 `request_key`，payload 正規化後計算 hash。遇到逾時／未知結果，先查 receipt，再用**同 key／同 payload**重試；不能生成另一個 ID。receipt 與財務事件同交易，避免「已入帳但回應遺失」造成重複。
- **舊事件相容：**既有 IG 原生 paymentEvent 與卡片 Done 依 `(property,原 event id)` 映射一次進新讀模型／帳本；歷史導入不可讓 booking version 增加。W2 必須擴充現有 IG repository 的同一個 DB transaction，讓新 `finance_event`、request receipt、必要的舊 `property_state` booking `paymentEvents`／`cardChargeResults`／booking version **原子提交**；Card 的 `recordCardSync` 與 OS 的 `recordPaymentEvent` 都走同一規則，舊 API 立即讀到一致狀態。做不到原子提交時，保持新 writer 旗標關閉，讓既有路徑繼續服務，不能只用非同步 outbox 後補舊 booking JSON 卻先回「已入帳」。讀取只算一份，不能把相容 paymentEvents 與新事件相加。**對 IG 原生／Card 兩條路徑**，切換前的唯一寫入端是舊 IG booking JSON；切換後對新操作是新帳本交易加相容 JSON，舊獨立寫入路徑須封閉。

### 4.3 API 契約

所有 route 置於現有 Iron Gate 受保護 API 下；W2 用下列路徑作固定契約並寫測試。`source_instance_id`、`source_system`、property、service principal 從已核可 connector 憑證推導；body 中相同欄位若提供，必須一致才接受。LINE 操作人由 GCO 驗證 LINE ID token/webhook 及館別權限後，放入經服務端簽署的 `source_actor_ref` 與操作 ID；Iron Gate 稽核同時記服務 principal 與已驗證員工。不得接受瀏覽器或 LINE 訊息自行填的 actor。**所有連訂單的新增／修改／退款先取得 IG 的精確 preview**；LINE/OS/Sheet 呼叫新 `POST /finance/commands/preview`，Card 保留現有 IG Card preview 但必須滿足同一版本綁定。preview 用 IG source link 或 booking UUID 解析並回 `{booking_id,booking_version,source_snapshot_hash,preview_token}`；token 綁 property、connector、正規化 payload、各 allocation 與版本，15 分鐘有效。commit 的每筆 allocation 帶 `booking_id`、`expected_booking_version`、`amount_cents`；IG 在同一寫入交易重新查當前 booking 版本，變動則 `VERSION_CONFLICT` 並要求重預覽。無訂單的一般支出不需要 booking preview。以下為 body 範例：

```json
{
  "request_key": "stable-source-action-id",
  "source_record_id": "original-entry-id",
  "source_version": 2,
  "expected_version": 1,
  "action": "amend",
  "event_kind": "expense_paid",
  "amount_cents": 120000,
  "currency": "TWD",
  "effective_on": "2026-10-28",
  "cash_on": "2026-10-28",
  "service_on": null,
  "category_code": "supplies",
  "payment_method_code": "bank_transfer",
  "payment_account_ref": "owner_operating",
  "evidence_level": "operator_attested",
  "booking_allocations": [],
  "expense_attributions": [{"month":"2026-10-01","amount_cents":120000,"allocation_policy":"ig_v1_earliest_cent"}]
}
```

費用分類、付款方法／帳戶代碼、來源證據安全參照依事件類型驗證；LINE 舊自由文字 `method` 只留原安全值供稽核，不猜成新帳戶。收款可按多張訂單分攤；每個 allocation 給 UUID 與金額，最多 100 筆，超過拆成有共同 batch ID 的多筆 document。支出可不連訂單，但必須連館別與成本類別。所有文字長度、金額上限、幣別、日期、來源版本須服務端驗證。

**固定路由：**以下每一條都在 `/v1/properties/{propertyId}` 下：

| 方法與後綴 | 必要用途 |
| --- | --- |
| `POST /finance/commands/preview` | booking-linked LINE/OS/Sheet 操作的精確訂單解析、金額與來源版本預覽；Card 可沿用現有 IG preview；都不寫帳 |
| `POST /finance/commands`、`GET /finance/receipts/{requestKey}` | 接受一筆經濟事件／修正／作廢／退款；同 key 回讀最終 receipt |
| `GET /finance/ledger?from&to&cursor`、`GET /bookings/{bookingId}/finance`、`GET /finance/expenses?month&cursor` | 總帳、單筆訂單財務、成本月份讀模型 |
| `POST /finance/status-commands`、`GET /finance/status?bookingId` | `settles_room` 等零現金狀態，使用同一套 request receipt 和版本衝突規則 |
| `POST /finance/recurring-rules`、`GET /finance/recurring-rules?cursor` | 到期計畫新增／修改／停用，不自動認列已付款 |
| `POST /finance/payout-rules`、`GET /finance/payout-rules` | 記錄本館 OTA **預計**撥款日規則，不當實際撥款證據 |
| `GET /finance/accounts` | 只讀本館帳戶代碼，帳戶管理另需受 owner scope 保護的 `POST /finance/accounts` |
| `POST /finance/evidence-assertions`、`POST /finance/settlements`、`GET /finance/settlements?cursor` | 追加處理商／銀行證據，建立及查詢有來源批次的清算；清算不再增加房費收入 |
| `POST /finance/imports/preview`、`POST /finance/imports/commit`、`GET /finance/imports/{batchId}` | 綁來源水位與列 hash 的批次預覽／提交／狀態回讀 |
| `GET /finance/issues?status&cursor`、`POST /finance/issues/{issueId}/resolve` | 列出來源不明與疑似重複；解決時附精確 mapping/evidence，重新走 preview/command，不允許直接改帳 |

成功的 money command 回 200/201 `{receipt_status:"accepted",document_id,document_version,event_ids,request_key,as_of_event_id}`；同 key 重送回相同 receipt。`GET /finance/receipts/{requestKey}` 找不到回 404（呼叫方用原 key 重送），不能從逾時推定失敗。讀模型回 `as_of_event_id`／版本與 evidence level，游標按 `(effective_on,id)` 穩定排序；現金報表按 `cash_on`，服務報表按 `service_on`，成本按 attribution 月。帳本讀、寫收款、寫支出、狀態、計畫、批次匯入、Sheet 投影各有獨立 scope。

**錯誤碼固定：**`PROPERTY_FORBIDDEN` 403、`SOURCE_FORBIDDEN` 403、`UNKNOWN_BOOKING` 422、`SOURCE_MAPPING_REVIEW_REQUIRED` 409、`VERSION_CONFLICT` 409、`REQUEST_KEY_REUSED` 409、`ALLOCATION_MISMATCH` 422、`REFUND_LIMIT` 422、`UNSUPPORTED_CURRENCY` 422、`IMPORT_ROW_REVIEW_REQUIRED` 409。對使用者顯示可處理的說明；log 不輸出原始財務 payload 或個資。

## 5. 四個入口如何接上新帳本

### 5.1 LINE OA：日常收入與支出

保持現有群組／私訊的**館別授權員工**驗權、自然語句／LIFF、預覽及**明確確認**；管理員另有整館稽核、整館月報與期初／刷卡核對權，不能在遷移時把一般授權員工縮成只准 admin，也不能放寬管理員權限。未確認不寫帳。收到確認後保留原 `entry_id`、`version`、操作 ID 當穩定 key，呼叫 Iron Gate。Iron Gate receipt 確認後才回 LINE「已登錄」；逾時先查 receipt，顯示「處理中／待核對」，不回錯誤的成功或另建一筆。Firestore 可保留狀態、對話、舊稽核，但新財務經濟事實不能在 Firestore 先行成功。不要在 Firestore transaction 中呼叫 HTTP；要持久化待送操作並以 outbox worker 送出、按 receipt 收斂。

LINE 舊 `room/deposit/extra` 映射 `property_receipt` 的用途，`expense` 映射 `expense_paid`。**現有 LINE 收入（含 `extra`）都先取 order snapshot 並帶原 order ID；回填不可鬆開原關聯。**若未來要新增無訂單「其他收入」，那是另改 LINE UI/模型與權限的功能，不能在遷移時假設舊 `extra` 無訂單。LINE expense 目前有 description、amount、`paid_on`、`attribution_month`、`months`、`start_month`，可選的 method 仍是自由文字；沒有結構化成本類別、供應商、發票、付款帳戶。歷史資料分類不明但金額／日期可靠者標 `unclassified` 並開非阻擋分類 issue（不猜帳戶），保留原 method 的安全值；新 UI/LIFF 必須新增必要的分類及實付日，其他欄位未知時明確留空。LINE 的 `amend/void` 要映射帳本版本及 reversal；不能把 void 當 refund。保留原 21 欄版本日誌和 11 欄摘要供歷史稽核，但切換後它們只是舊投影，不再回灌 Iron Gate。

**特殊情況：**既有 LINE `cc_sync` 的 outbox operation ID 不全是 UUID；讀取與去重不得假設 UUID。LINE 開帳／訂金 registry 不一定有 outbox；W0 要單獨盤點並決定是否有實際金流，不能因缺 outbox 就把其紀錄當作已入帳。Sweetfun 與 Offland 目前由同一 LINE runtime 建立，但 W4/W7 **先只切 Sweetfun**：使用逐館路由旗標；Offland 維持原 Firestore writer 直到其獨立驗收。LIFF 單筆查單路由目前須帶已驗證 actor 給 Sweetfun IG HybridOrderSource；改接財務時要修正並用真 route 合成測試覆蓋。

### 5.2 OS：日常收入、收款、成本

OS `/finance`、`/finance/bookkeeping` 保留手動新增收入／支出、分攤至多 100 張訂單、付款方式／帳戶、支出攤提與週期規則。提交後由 OS server 呼叫 Iron Gate，使用 OS 既有登入與館別授權，再換取館別限定的 finance scope；前端不得持有 Iron Gate 寫入 token。OS 儲存待送 request key，重新整理後仍能查 receipt，避免二次點擊重複收款。收到正式 receipt 後才顯示完成。

OS 原生直訂收款／退款已在 Iron Gate：做一次來源 ID 對照／讀模型遷移，不當成第二筆新的現金。OS 舊 Redis receipt 與手動財務 entry 逐筆匯入；`status_only` 的 `settles_room=true` 必須保留「房費狀態已確認」的業務意義，但不產生收入。週期規則只是到期提醒；每次實際付費由使用者確認後才寫 `expense_paid`。現有 OS 手動 `method='ota'` **不足以證明 OTA 已撥款**；歷史若無來源證據，留待核對，不自行映射為 `ota_payout` 或 `ota_guest_payment_observed`。現有財務報表混合 Redis、Sheet、IG；切換後統一從 Iron Gate 讀模型取數，舊 Redis 保留只讀稽核與回復證據。Sweetfun IG 訂單目前已關閉舊 Sheet 收款寫回；不得重新打開。Offland 的 OS 收款 POST 目前在 review gate，W7 不能順便放行。

保留 OS 現有 finance owner/god/admin 權限與 `viewPrices` 館別限制，日曆收款若允許 housekeeper，也只給原有範圍；新後端每筆再驗證 scope。其他館的帳戶、成本分類、Sheet 工作簿設定，必須各館獨立，不能複製 Sweetfun 祕密與權限。

### 5.3 Sean Dashboard：Sweetfun 人工刷卡

維持現在的 Done/Fail 與人工確認流程。來源 Sheet 可以用 OTA 訂單號進 IG preview，但 commit 前必須由 IG 精確解析唯一 booking UUID、驗證住宿日／總額／confirmed/source link，並綁 booking 版本。**Done** 保留原 deterministic `cardPaymentId` 和 fingerprint，依原 IG event ID 在新帳本呈現一次 `property_receipt`，`evidence_level=operator_attested`；重按 Done、換週次或重新投影都不能新增金額。**Fail** 只有非金錢 revision、稽核與狀態，絕不生收款。部分收款、退款、手續費或結算日期不能由「全額 Done」推算；需要實際來源與新操作才增加。卡號 PAN、效期及其他敏感來源欄位不得出現在新 DB、Sheet、URL、log、錯誤或測試夾具。

Card 的切換也遵守第 4.2 節原子交易：W7 之前唯一 writer 是現有 IG `recordCardSync` 的 booking JSON；W7 之後由同一 IG transaction 接受新帳本事件與舊 booking `paymentEvents`／`cardChargeResults` 相容投影，兩者讀回一致才回 Dashboard 成功。若這條路徑尚未完成，卡片寫入旗標不得切換，也不得回「已入帳」。現有 OS 卡片 ownership key、既有收款檢查與 IG 既付檢查須繼續攔截重複；新帳本不能繞過。對同 booking、同金額、相近時間而無共同交易 ID 的 OS/LINE/Sheet 新收款，標疑似重複待核對，不自動合併也不接受第二個未審核的卡片收款。

Dashboard 的登入目前不是多館租戶權限，第一期明確只綁 Sweetfun property。未來其他館要接卡片服務時，使用 **Iron Gate/OS 的每館 connector registry**，至少含 `source_instance_id`、adapter、來源帳號／Sheet、credential ref、cutover、enabled、掃描頻率、manual/auto 確認政策、水位、版本與稽核；來源 connector、掃描頻率和入帳授權是三件不同事。需改造 Dashboard 固定館別、cc-sync 固定來源、OS bridge 固定 property、IG card-sync 固定 property 四層，建立每館憑證、權限、鎖、回讀與隔離測試後再開。Sweetfun 保留 weekly/manual；其他館預設 disabled。不能給單密碼 Dashboard 一個任意 property ID 參數作為多館接入。

處理商清算／入銀行是**後續證據**：有來源批次與交易 ID 時，向 `finance_settlement`/`finance_evidence_assertion` 追加 gross、refund、fee、net、bank date 與證據；清算淨額只是核對／資金轉移，**不再新增訂單房費收入**。真正有證據的費用另建一次 `processor_fee_paid`，與 settlement 連結並按來源 ID 去重。目前 Sweetfun Card 來源只有房價、人工 Done/Fail 與日期，沒有處理商交易、手續費或銀行入帳資訊；這些欄位先保持未知。

### 5.4 Google Sheet：可編輯的批次補登與操作

**每館獨立工作簿。**即使同一營運團隊也不共用可編輯工作簿；跨館中央彙總只能由權限過濾的唯讀報表另產生。Sheet 的 property 由**已登記 spreadsheet ID + connector credential** 唯一綁定；貼上的列不能自行指定館別。建議 tab：

| Tab | 可否編輯 | 用途 |
| --- | --- | --- |
| `批次輸入` | 授權營運者可編輯**業務欄** | 粘貼、補登及修改列；每列持久 `row_id`、來源、base_version、日期、類型、金額、訂單 ID、成本資料、安全備註、sync_status、error_code；`row_id/base_version/sync_status/error_code` 是系統保護欄，不由營運者編輯；館別只由工作簿綁定，顯示欄若有不符必拒絕 |
| `匯入預覽與待核對` | 系統寫、營運者只讀 | 顯示新增、修正、重複、未知訂單、分攤錯誤；提交前逐列核對 |
| `訂單財務摘要` | 系統寫、受保護 | Iron Gate 的訂單關聯讀模型，註明資料時間與證據級別 |
| `收支事件` | 系統寫、受保護 | Iron Gate 接受事件的投影；保留 event ID、來源、版本、反向／退款關聯 |
| `各館成本` | 系統寫、受保護 | 本館支出、實付日、攤提月份與成本分類；不混別館 |
| `同步紀錄` | 系統寫、受保護 | batch ID、來源版本、雜湊、提交者、時間、結果、下次重試；不含敏感支付資訊 |

`批次輸入` 是**真正可編輯**的資料區。新列首次掃描由服務端派穩定 UUID `row_id`；它不依列號、排序或 Sheet 分頁。對已成功的列再編輯時，掃描器保留上一個已接受快照，將改動標為 `pending_revision`；預覽展示差異，提交使用同一 `row_id` 與下一版。若保護欄被貼上覆蓋、重複或刪掉，整列進 review，不能按目前列號重建身分。不得原地改掉正式事件。提交前的業務欄可自由修改；正式數字只在 commit 成功後改變。不能把 `收支事件` 或舊 LINE「財務異動紀錄」重新當輸入。所有投影 tab 由 Iron Gate outbox 回寫且唯讀；投影失敗只使 Sheet 顯示延遲，不回滾已接受的財務事件。輸入列採欄位白名單，備註限制長度且做卡號／效期／聯絡資料拒收或遮罩；preview token、audit、outbox、log 都不得保存未過濾原文。

同步採「**明確預覽 → 選擇安全列 → 提交 → 按 receipt 回讀**」，再加**每 5 分鐘掃描變更、每日全簿水位對帳**找漏改與投影漂移；明確提交時立即掃描所選列，不必等 5 分鐘。編輯觸發器只能作加速提示，不能作唯一保障：[Google Apps Script 官方觸發器說明](https://developers.google.com/apps-script/guides/triggers)指出程式/API 寫入不會觸發一般編輯 trigger，且編輯觸發佇列有限。每次 preview 固定來源 spreadsheet ID、tab、row ID、版本、內容 hash、Iron Gate ledger 版本，token 15 分鐘到期；commit 重新讀列與版本，不符即重新預覽。相同 batch／列版本重試必須無害，單列錯誤不阻擋安全列，但不能默默略過；營運者須選擇「只提交安全列」或先修正。匯入後狀態要回寫 accepted event ID／待核對原因。若 Google Sheets API 暫時不可用，Iron Gate 仍為準，outbox 重試投影。

## 6. 身分、安全與權限

- **館別隔離：**每次讀寫由驗證後 principal 的 property scope 決定；URL/body 的 property ID 只是與 scope 比對。SQL 查詢、唯一鍵、外鍵、Sheet connector、Redis/Firestore 遷移 key 都帶 property。用兩館測試確認跨館 403 且無資料洩漏。
- **操作權限：**`finance:read`、`finance:record_receipt`、`finance:record_expense`、`finance:correct`、`finance:refund`、`finance:import`、`finance:project` 分開。LINE bot 只能代表經 LINE 驗證且獲本館授權的員工，管理員另有目前才具備的整館能力；OS server 依角色授權。**Card connector 保持現有專用 `card:sync` grant，不能直接拿一般 `finance:record_receipt`**；IG 內部只允許綁定 Sweetfun property、該館 Card connector 的 UUID `source_instance_id`、固定 adapter 和既有 Card preview/commit 流程，拒絕錯館、錯來源及任意款種。擴館時逐館獨立 grant，舊 Sweetfun grant 不變。沒有某 scope 時不能靠寬廣 `source:write` 繞過。
- **來源最小化：**DB、Sheet、log、outbox 只保留金額、類型、日期、來源 ID、安全證據 ref；不保留 PAN、效期、完整卡片工作簿、客人聯絡資料或完整 LINE 對話。證據原件在原受限系統，以 opaque ref 查。
- **稽核：**每次接受、拒絕、修正、作廢、退款、匯入與投影，記 actor/service、property、request key、前後版本、時間、原因碼；稽核不含原始祕密。不可讓管理 UI 直接 UPDATE/DELETE 已接受事件。
- **效能：**按 `(property_id, effective_on, id)` 分頁；booking allocation 與來源 key 建索引；交易要短，不在 DB 鎖內呼叫 LINE、Sheets、Dashboard、支付商等外部服務。對高流量讀模型做版本化投影；不得為整頁日曆遍歷全館歷史事件。

## 7. 回填與對帳規格

### 7.1 各來源的正式匯入規則

1. **Iron Gate 既有 native/卡片：**先逐 booking 讀 Card 結果，建 `sweetfun_card` document（來源 ID 是 booking UUID），保留 Fail 非金錢 revision；Done 的帳本 event ID 精確對應原 `paymentEvent.id`，用 `finance_source_alias` 與 ownership key 將該 IG 原生 event ID 指向**同一**卡片 document。然後才匯入其餘未被 alias 的 IG native paymentEvents。Card Fail 不導入金額；所有 paymentEvent 只映射一次，不再向訂單加一筆。保留原事件證據級別。
2. **LINE Firestore：**先讀 `versions/{entry_id}:{version}` 和 `audit/{operation_id}` 重建版本鏈，以 `outbox.sequence` 對齊，最後與 `entries/{entry_id}` 核對；不可把 21 欄版本日誌每列相加。有完整歷史時依原 entry ID + version 重建「舊版反向＋新版生效」，最後淨額須等於目前有效版本；若歷史不完整，僅匯入可驗證的目前淨效果，標註歷史證據不完整，不捏造中間交易。已作廢淨額應為零。LINE 歷史攤提使用原整元尾數規則。缺 booking 對照的房費／訂金進 review；舊 `extra` 也保留原 order ID。Firestore 舊投影與新 Sheet 不互相回灌。
3. **OS Redis 財務：**手動 entries 的有效版本；週期規則本身為 `finance_recurring_rule` 計畫，已付款 occurrence 才是支出。分攤與付款帳戶保留；缺成本類別按確定規則映射，無法確定進 review。`method='ota'` 若無撥款證據進 review，不當 OTA 實收。
4. **OS Redis 舊收款：**按原 receipt ID + order key，`status_only` 金額零且 `settles_room` 意義保存在 `finance_operational_status`；先以 `finance_source_link` 找精確 booking。沒有確切連結先留待核對，不按人名／日期猜。舊退款如無原收款 ID，先核對確切來源；無法驗證就留 review。
5. **OTA：**若已有「房客向 OTA 付款」或「OTA 撥款」來源，兩者分開；來源無明確金額與銀行／OTA 證據時只保留觀察狀態，不補造撥款或費用。
6. **Sheet：**新 `批次輸入` 才是匯入來源；舊 Calendar、LINE 的結果投影、OS 報表均不得再次當現金事件輸入。

### 7.2 對帳輸出及門檻

每館、每來源、每月份各輸出：來源 active/void/待核對筆數；已接受 document、event、反向、refund 筆數；按 `event_kind` 與證據級別的整數分合計；訂單精確映射數；未映射與衝突清單；最早／最新來源版本；Sheet 投影落後量。另對 card Done 的原 event ID 做一對一清單核對，Fail 金額 0；對 OS `status_only` 金額 0；對 LINE 修改／作廢用**淨效果**核對。不得只比總數，因一筆重複與一筆遺漏可能互相抵銷。

切換前必須：**已接受來源逐筆差異 0、重複入帳 0、跨館連結 0、未知回應未決 0**；同款跨來源 alias 已有共同交易 ID 或人工證據；所有剩餘 `blocking` review 都有來源、原因與處理人，且不算進正式金額。`classification_only` 歷史成本以 `unclassified` 計入已核實總額，另外報未分類筆數，不得說分類已完成。LINE 另核對 `operations` 的 pending/recorded/cancelled、`_conversations/drafts` 的 confirming/editing、`control/projection.claim` 及 outbox；確認中或未知結果**不能因 15 分鐘 TTL 到期就當清空**，Sheet 投影 claim 也不能假定會自動到期。成本可保留不完整供應商／發票欄位，但不得把未知金額自動補成 0。對帳報告含來源 snapshot 雜湊與新帳本水位，放私有位置，不將交易明細提交到公開 repo。

## 8. 切換、回復與監控

**每館單獨操作，不做跨館總開關。**第一館 Sweetfun。使用正式環境來源讀權與寫權前，先確認部署來源、分支、資料庫 migration、各入口憑證及回復版本；備份 Firestore/Redis/IG/Sheet 的可用來源版本與 hash，保留還原演練證據。先在隔離測試館和預覽環境通過第 9 節，再做正式影子對帳。每館記錄 `backfill_watermark`（歷史匯入已接受）與 `cutover_epoch`（新入口開始正式寫入）；回復判斷看 **cutover 後** 是否有新 accepted event，不把回填事件誤當成新營運寫入。

正式切換順序：

1. **先**部署 additive 的 Iron Gate schema、API、相容讀模型與關閉的新寫入旗標；測試館驗證，再用正式來源做只讀 shadow 與對帳。此時舊入口照常運作。
2. 到切換窗口才將該館 LINE/OS finance、Sheet 批次提交、Sweetfun 卡片確認的**財務提交**短暫設為排隊／唯讀；訂房與行事曆讀取保持服務，避免非必要停機。Offland 的 LINE finance writer 保持原狀。
3. 等待舊 outbox 與在途請求收斂；LINE 的 pending/recorded/cancelled operations、confirming/editing drafts、projection claim 各自核對，不能只等 TTL。記錄來源 high-water mark，做最後差量匯入與逐筆核對，確認 review 清單及來源 alias/ownership。
4. 逐一切換 LINE、OS、Card connector、Sheet 匯入的**Sweetfun**寫入旗標；每個入口用 receipt 回讀。**同一來源同一時間只能有一個正式寫入端。**完成後才解除排隊，排隊請求沿原 key 送出。
5. OS、LINE、Sheet 改讀 Iron Gate 投影；核對事件數、金額、訂單摘要、成本月份、Google Sheet 投影水位。舊 Firestore/Redis/Sheet 歷史只讀。
6. 觀察至少一個完整營運週期，Sweetfun 包含一次卡片人工確認週期；記錄失敗佇列、重試、財務差額與待核對。沒有真實卡片操作時只能說系統測試通過，不能宣稱生產端到端已驗證。

**失敗時的分界：**若只有歷史回填事件、`cutover_epoch` 後尚無新 accepted event，經 final delta 核對可把入口恢復舊寫入，保留新帳本影子資料待重建。只要已有**cutover 後**的新 accepted event，就**不可直接切回舊雙主**；暫停新寫入，保留 Iron Gate 已接受事件，修復 connector 或用有來源 ID 的前向重播收斂。若需回舊系統，先建立逐筆反向同步及對帳計畫，由負責人確認。單純 Sheet 投影失敗不用回滾財務接受；重跑 outbox 即可。

監控指標：每來源成功／拒絕／未知結果，receipt 查詢恢復率，outbox backlog 與最老時間，LINE/OS/Sheet 投影落後版本，跨來源重複攔截，未映射訂單，退款上限拒絕，館別權限拒絕，Card Done 重放攔截，按日/月整數分差額。告警需帶安全的 property/source/request key，不帶金額細節以外的個資與卡片欄位。

## 9. 必須通過的驗收案例

| 情境 | 預期結果 |
| --- | --- |
| 同一來源、同 key/同 payload 重送 3 次，包含第一次寫入後斷線 | 只一組事件；receipt 三次相同；無重複金額 |
| 同 key 改金額；同來源舊版修改；兩個人同時修改 | 409，不改舊事件；顯示當前版本與待核對入口 |
| LINE 先預覽未確認；確認後 HTTP 結果未知 | 未確認 0 事件；未知時查 receipt／排隊，不能提前回「已登錄」或重建 ID |
| 授權 LINE 員工用 LIFF 單筆查 Sweetfun 訂單、預覽收入；管理員看整館月報 | 已驗證 actor 傳到 IG 訂單查詢；員工只見原權限內資料，管理員權限不變 |
| LINE 舊 entry 修改、作廢；把作廢誤當退款 | 修正有 reversal、淨額正確；作廢不產生退款；實際退款另有原收款參照 |
| OS 同筆收入分攤多訂單，分攤合計錯／其中一單屬他館 | 正確時各訂單顯示比例；錯誤時整筆拒絕且無部分入帳 |
| LINE/OS 訂單 preview 後 booking.version 改變才提交 | 409 `VERSION_CONFLICT`；不得照舊 preview 入帳，重新取 IG 版本並預覽 |
| 收款 100 元、退款 20 元後，將原收款改為 10 元或作廢 | 409 且事件不變；先處理錯誤退款後再修正原收款；有效退款不可超過有效收款 |
| `status_only`、未付款的週期支出 | 現金事件數 0；狀態／計畫仍可查看 |
| OTA 房客已付款與 OTA 撥款；處理商費用未知 | 不重複計入民宿收入；手續費不自動推算 |
| Card Done 重按、跨週重投、Fail、卡片來源含 PAN | Done 只一筆既有 event；Fail 0 金額；PAN/效期在 DB、Sheet、log、測試輸出皆不存在 |
| Card 專用憑證用來寫任意收款／錯館／錯來源；Card Done 後再送同款 OS receipt | 全部拒絕或轉待核對；現有 ownership key 與既付攔截保持生效 |
| 支出實付在 10 月，分攤 11–12 月；奇數分攤 | 現金 10 月一筆；管理報表 11–12 月整數分合計恰等於原支出 |
| Sheet 直接改尚未提交列、修改已提交列、API 寫列未觸發 onEdit、投影失敗 | 預覽/定時掃描發現變更；已提交列走新版本；Iron Gate 不重複；投影重試收斂 |
| 兩個 property 同名訂單鍵、跨館 token／Sheet 使用者 | 不混資料；跨館操作 403；各館報表與成本表只見本館 |
| 舊 Redis receipt、IG 原生 paymentEvent、Card Done 指同一收款 | 對照後只算一次；booking version 與舊讀取契約不變 |
| LINE、OS 對同訂單／同金額／同日期各登一筆但沒有共同交易 ID | 標疑似重複待核對；不能僅按相似值自動合併，也不能悄悄當兩筆確認收款 |
| LINE 訂金、OS 房費、Card Done 合計超過同訂單房價 | 房費／訂金跨入口上限檢查阻擋；`extra` 作獨立用途，不能假裝房費 |

測試順序：純函式語意 → DB migration/約束 → API 契約與權限 → 各 adapter 的故障恢復 → Sheet 批次與投影 → 隔離測試館全流程 → 正式影子對帳 → 逐館切換。測試用合成資料與隔離館，不能拿真卡或真房客資訊當夾具。對每個工作包只要有 API/DB 變更，補上真正能抓到雙記帳、跨館洩漏和斷線重試的測試，不能只鏡像實作。

## 10. 後續開發工作包：照順序交付

每包交付程式、測試、schema/API 文件、私有對帳證據與明確「未做事項」。不得把 W0–W6 的影子資料當成已切換正式帳本。每包先在相應 repo 的現行遠端基線建工作分支，按 repo `AGENTS.md` 與 release 流程開 PR；不要直接在本 ChatGPT 專案鏡像的其他工作樹覆寫進行中的工作。

### W0｜盤點與快照（只讀）

**做：**確認 Iron Gate、OS、GCO、Dashboard 當前正式部署 SHA/版本/旗標；盤點每館 Firestore/Redis/IG/Sheet 的來源數與 schema；列出精確訂單 ID 對照來源、Card Done event IDs、Card/OS 既有 payment ownership、LINE outbox 特例及 OS `status_only`。LINE 另盤點 `operations`、`_conversations/drafts`、`control/projection.claim` 的未結狀態。產生來源 hash、水位、只含聚合的基線報表與可還原備份。整理未對照清單。

**完成條件：**每個來源都有「誰現在能寫、存在哪裡、如何停／回復」；Sweetfun 的既有 10 個 paymentEvents、12 個 card results 依**當下**數字重新核對；不存在把卡片或房客明細寫進公開 repo。來源差異和歷史資料問題列成 review，不把 review 當成功。

### W1｜財務語意、DB migration 與契約

**做：**實作第 3–4 節的資料表、欄位約束、索引、RLS、權限；固定事件種類、成本分類、證據等級、版本及錯誤碼；寫 schema migration/rollback 及合成資料測試。先建 booking ID 交易內驗證：如果訂單仍在 JSON state，鎖該 property state 並查同館 booking；不要建立指向不存在 JSON 欄位的假 FK。後續可另建 booking index，但該 index 須和訂單交易同步。建 `source_instance_id`、跨來源 alias/ownership 與處理商交易 ID 唯一性；無可靠共同 ID 只能標疑似重複 review。

**完成條件：**同 key／版本／退款上限／分攤／跨館都由 DB 交易攔住；migration 在空 DB 與既有 IG schema 都可重跑驗證；沒有任何財務入口已切正式寫入。

### W2｜Iron Gate 財務 API 與讀模型

**做：**實作受 scope 保護的 commands、receipt、ledger、booking finance、expense、非金錢狀態／週期計畫、import preview/commit API；接短交易、反向事件、outbox、游標分頁；做既有 IG paymentEvent/Card Done 去重相容讀模型，保持訂單版本和舊 API。擴充 `iron-gate/src/postgres-repository.mjs` 的 `transact(propertyId, fn)`：現有 callback 先變更 `property_state` 草稿並排入 outbox/audit，新增受驗證的 finance pending writes，於**同一 PostgreSQL transaction、同一 property scope** 插入 finance revision/event/allocation/receipt，才 `COMMIT`；memory/sqlite repository 依相同語意提供測試實作。Card 的 `recordCardSync` 與 OS 原生 `recordPaymentEvent` 均走此路徑，舊 JSON 相容內容、版本、receipt 必須原子一致；沒有做到就不切正式 writer。新事件驗收在 DB commit 後才回成功。建立按 booking/property/month 的讀模型、evidence level、settlement 與待核對輸出。

**完成條件：**第 9 節 idempotency、訂單 preview/版本、退款後修正、零現金 outbox、隔離、舊事件不重算案例通過；舊訂單／行事曆讀取不變；新 API 仍處於測試館或關閉旗標。

### W3｜OS 日常入口

**做：**將 OS 新收入、收款、退款、支出、修正／作廢改走 Iron Gate；前端按 action 顯示預覽和狀態，server 保留 request key 與 receipt 恢復；現有 OS 人工財務報表改讀 IG 投影。建立 Redis 舊資料唯讀匯入器與逐筆核對。原生 IG 收款只映射一次；`status_only` 保留 `settles_room` 且不入現金；週期規則、預計 OTA payout 規則與付款帳戶另在非金錢模型呈現，到期提醒不自動扣錢；`method='ota'` 沒證據則待核。保持 Offland review gate。

**完成條件：**OS 同一筆多次點擊只一筆、跨館與角色權限不變；舊 Redis/IG 金額與新讀模型逐筆一致；正式寫入旗標仍關，待 W7。

### W4｜LINE OA 日常入口

**做：**新增缺少的成本分類等必要輸入，保留 LINE **授權員工／管理員各自既有權限**、預覽及確認。確認後持久化 pending operation → Iron Gate API → receipt 回讀 → 回覆結果。用逐館旗標先建 Sweetfun adapter，Offland writer 不變；直到 W7 切換成功，Firestore 仍是舊正式寫入端，不能提前改成只讀。切後改讀 IG 財務摘要、Firestore 版本／outbox 歷史只讀。匯入器按版本鏈、amend/void 做反向效果並保留 LINE 舊攤提規則；處理 `cc_sync` 非 UUID ID、registry 無 outbox、LIFF 單筆查單 actor 傳遞。

**完成條件：**未知 HTTP 結果、重試、修改、作廢都無雙記帳；只有 IG 接受後才回「已登錄」；舊 Sheet 投影未被回灌。

### W5｜Sweetfun Card 相容與各館 connector 設定

**做：**維持 Dashboard Sweetfun 專用流程及既有 fingerprint；Done/Fail 對新讀模型一對一核對，卡片正式 commit 必須走 W2 的帳本＋舊 booking JSON 原子路徑。於 IG/OS 定義 per-property connector 的 source instance、adapter、來源帳號/Sheet、憑證、安全授權、cutover、enabled、掃描 cadence、確認 policy、水位、版本與稽核，**不啟用其他館**；檢查 Dashboard、cc-sync、OS bridge、IG card-sync 四層固定館別並逐層準備配置改造；測試不同館憑證與存取隔離。新增「人工確認／結算已核」兩層顯示，以 append-only assertion 留證；不把 Done 升格為 bank reconciled 或再算一次收入。

**完成條件：**舊 Done 金額、數量、event ID 原樣；重試不增收；Fail 無收款；卡號/效期在新路徑全部排除；其他館維持未啟用。

### W6｜每館 Google Sheet 批次工作簿

**做：**建立第 5.4 節範本及權限，並建 scanner、preview、commit、receipt、投影 outbox、定時對帳。測試直接編輯與 API 編輯、已接受列 revision、Sheet API 中斷、批次安全子集、不同館隔離。Sheet 只有輸入候選列可編輯，接受歷史留 IG；不碰 Sweetfun 舊 Calendar Sheet。

**完成條件：**Google Sheet 直接修改可被 scanner 發現並同步；提交後可在 IG 查到精確 event ID 和版本；重試不重算；投影延遲有狀態與告警。

### W7｜逐館影子回填與正式切換

**做：**先 Sweetfun，依第 7–8 節完成來源快照、私有備份、逐筆 mapping、影子匯入、對帳；控制 LINE/OS/Card/Sheet 財務寫入暫停與排空，定版來源水位，啟用 IG，回讀與恢復入口。保留 release journal、部署版本、旗標、回復點和私有結果。每館重做，不複用 Sweetfun 開關。

**完成條件：**四個入口都只用同一 IG 財務事實來源，已接受差異 0、雙記帳 0、未知結果 0；舊來源只讀；成本表只見本館；完整營運週期監控無未處理差額。若未觀測真正生產刷卡／收款，明記未驗證範圍。

### W8｜擴館與 SaaS 客戶工作區

**做：**每新增民宿都先整理它的訂單 ID、金流服務商、成本類別、角色與 Sheet 權限，再重跑 W0/W7 的館別版。SaaS `/w/[slug]/finance` 另立 workspace 身分與遷移包，證明其 `workspace.bookings[].payments` 與 IG booking UUID 的授權映射，再接本帳本。

**完成條件：**第二館不依賴 Sweetfun Dashboard、卡片週期、憑證或 Sheet；tenant/owner 不跨館；各館能個別停用、修復和對帳。

## 11. 實作者應先閱讀的具體檔案

路徑相對於本 ChatGPT 專案根目錄；這些是**現況參考**，不是可任意修改的共同工作樹。開始各工作包時要以相應 repo 的最新遠端版本及 `AGENTS.md` 為準。

- Iron Gate 訂單／付款：`card-iron-gate-20261027/iron-gate/src/types.ts`、`src/service.ts`（`recordPaymentEvent`、`recordCardSync`、`directFinanceSnapshot`、booking version 判定）、`src/postgres-repository.mjs`、`src/http.ts`、`src/card-sync.ts`、`src/credential-grant.mjs`。
- OS 財務：`os-manual-ui-fixes-20261025/frontend/src/lib/finance-store.ts`、`src/lib/os-payments.ts`、`src/lib/finance-context.ts`、`src/app/api/v1/order-payments/route.ts`、`src/lib/booking-sources/iron-gate-calendar.server.ts`。
- LINE 財務：`gco-line-room-control-fix-20261025/src/line_agent/finance_domain.py`、`finance_repository.py`、`finance_runtime.py`、`finance_projection.py`、`iron_gate_unified.py`。
- 卡片實際路徑：`card-iron-gate-20261027/docs/work-handoff/CARD_IRONGATE_SYNC_2026-10-27.md`、`card-iron-gate-20261027/frontend/src/app/api/internal/card-sync/route.ts`、`frontend/src/lib/booking-sources/iron-gate-card-sync.server.ts`、`card-cc-sync-20261027/scripts/irongate_credit_card_sync.py`、`scripts/sync_credit_card_status.py`、`card-dashboard-20261027/src/proxy.ts`。
- 現有 OS/IG 財務說明：`os-ig-manual-release-20261024/docs/work-handoff/SWEETFUN_DIRECT_FINANCE_2026-10-25.md`、`os-manual-ui-fixes-20261025/docs/work-handoff/IRON_GATE_OWNER_PAYMENT_2026-10-23.md`（若檔案不在該工作樹，從目前 OS 遠端分支尋找同名文件）。

## 12. 交接時不可省略的完成報告格式

每個工作包的 PR/交接文字都要列：**改了哪些檔案與 migration、使用的正式基線 SHA、測試及結果、資料來源 snapshot/hash、逐筆對帳結果、旗標與實際部署狀態、尚待核對筆數、回復步驟**。寫「程式已合併」不等於「已在正式環境運作」；寫「UI 顯示收款」不等於「銀行已入帳」。若驗收失敗，停在原本的寫入端，不以手動補一個總額掩蓋差異。
