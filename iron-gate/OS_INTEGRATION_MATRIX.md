# 現有 OS 與 Iron Gate 接線差異

日期：2026-10-13（Asia/Taipei）
狀態：唯讀盤點；**沒有切換任何 OS 寫入路徑**。依據目前 [OS Booking 型別](../frontend/src/lib/customer-workspaces/types.ts)、[原生建單](../frontend/src/lib/customer-workspaces/service.ts)、[保留操作](../frontend/src/lib/customer-workspaces/holds.ts) 與 [操作路由](../frontend/src/app/api/customer-workspaces/%5Bslug%5D/operations/route.ts)。

## 身分與權限

OS 的客戶登入 cookie 對應 `Account`；當前 `Workspace.members` 決定角色、active、全部館別或指定館別。Iron Gate 的 OS 機器憑證只能表示「呼叫服務」，每次仍須由 OS 私有端即時驗證會員，回傳 `subjectId`、`workspaceId`、授權 `propertyIds/actions/fields`，再與機器憑證取交集。現有服務在未注入此 verifier 時拒絕 OS token。`src/os-member-proof.mjs` 提供綁定單次請求的 5 秒證明協定；[OS 只讀影子路由](../docs/work-handoff/IRON_GATE_OS_PROOF_2026-10-13.md)每次重讀會員，預設關閉且未部署。不能把瀏覽器自報角色或完整 cookie 原文直接存入 Iron Gate。

## 資料語意差異

| 項目 | 現有 OS | Iron Gate 目前 | 接線要求 |
| --- | --- | --- | --- |
| 身分 | `Booking.id`、`Workspace.id`、`Property.id`、`Room.id` 是 UUID | 相同 UUID 型別 | 舊 ID 原樣保留；不得用新建單路徑重編號。 |
| 住宿 | `stays` 可選；舊單可用 `checkIn/checkOut/roomIds` | `stays` 必填 | 唯讀轉換需還原每段房晚並逐房逐日比對；不可用全區間填中間空檔。 |
| 版本 | `Workspace.version` 控制 OS 整份 workspace CAS；訂單另有 `Booking.version` | 每館 `inventoryVersion` 與訂單版本 | 切換水位和館別版本需建立可驗證映射，不能把 workspace 版本直接當館別版本。 |
| 金額 | TWD 元，可有兩位小數 | TWD 分整數 | 用精確乘 100，保留 `null`；不得四捨五入來源未核實值。 |
| 財務 | `payments[]` 有種類、房費／其他費用配置、收款時間、方式、帳戶；另有 `openingReceived`、`importedFinance`、`expectedDeposit` | 收／退款事件與總額摘要，尚無全部 OS 欄位 | 遷移需保留事件 ID、配置、期初與來源金額口徑，不能把所有收款合成單一已收。 |
| 保留 | `active/awaiting_owner/converted/released`、延長、晚到付款；延長可到 366 天 | 服務端初始 24 小時、到期時投影 `awaiting_owner`，明確延長或釋出；釋出後收款標記 `latePaymentReview`，不重新占房 | 操作員確認、原有通知與付款憑據仍須接線；逾期轉正須先由業主延長。 |
| 外部與網站欄位 | `platform`、`calendar`、`imported`、`website`、`lineOwner`、`channelClose` 等 | 只有最小來源欄位 | 須可追溯且無損保留；資料未知時用待核對，不能在轉換時丟棄。 |
| 封房 | `Workspace.blocks`、`integrationFences` 與 `calendarSources` | `manualBlocks`、`fences` | 逐房晚核對；來源仍掌權的館不得在 Iron Gate 另開賣。 |

## 網站預訂與 LINE 業主操作

現有網站流程在 `frontend/src/lib/website-booking/booking.ts` 依序核對 owner binding、來源涵蓋與開賣開關，先發 120 秒房況觀測 token，再依 OS 定價發 5 分鐘報價。預訂以同一工作區 CAS 一次寫入保留單、消費報價、保存同鍵收據並建立通知；重試先查原收據，報價時與提交時各自重查實體房間、封房、價格與設定版本。Iron Gate 目前只實作本地占房與保留，沒有上述 binding、房型、價格、報價及通知的完整契約，所以網站直接建立訂單固定拒絕 `WEBSITE_QUOTE_REQUIRED`。接線不可把現有報價 ID 當成無需驗證的寫入授權，亦不可讓 OS 和 Iron Gate 同時寫同一筆正式訂單。

現有 `frontend/src/lib/website-booking/owner-actions.ts` 要求 LINE webhook 已驗證的一對一發話者與目前 pairing 相符，再查 owner、binding、原網站訂單及工作區版本；每次操作帶業主確認、請求鍵與訂單／工作區版本，未知提交結果以原收據讀回。Iron Gate 尚無 binding 專屬的完整 inspect 快照及業主確認證據，LINE 一般建單／讀單／取消固定拒絕。後續應把現行協定映射到同一權威訂單，而非另開一條可略過 owner 確認的寫入端點。

## 必須封住或導流的寫入入口

至少包含原生建單與操作、保留與付款、網站訂房／改期、LINE owner-action、來源連結訂單與庫存 guard、Sheet／日曆匯入、封房及遷移腳本。`customer-workspaces/[slug]/route.ts` 的原生 `createBooking` 仍直接修改 Workspace；`operations/route.ts` 另有保留、付款、取消。只改畫面或路由而留住儲存層旁路，不足以宣布 Iron Gate 為正本。

建議先做唯讀快照轉換與差異報告，覆蓋所有上表欄位、付款總額與每一實體房晚。完成即時會員證明、狀態／金額相容、所有 writer 盤點、備份和還原演練後，才可逐館建立不可繞過的寫入閘門；切換不得雙寫兩份正本。Sweetfun／OFFLAND 仍各自需要實際備份與回滾驗證。

`src/os-shadow.mjs` 已提供**只讀**的 workspace 盤點：計數有效房晚、檢出跨訂單撞房、列出 Iron Gate 尚不能無損保存的欄位，公開報告只輸出 ID 與快照雜湊。對沒有付款、保留、外部來源、封房、欄位差異或撞房的原生訂單，可在記憶體中產生單館唯讀候選；候選保留原始訂單快照與 OS 原 ID，故須當作含個資的私密資料。`compareOsPropertyCandidate` 可將當前 OS 快照與已保存的只讀候選逐單核對，輸出缺漏／差異訂單 ID 而不輸出客資；任何差異、來源變更或影子狀態可寫都不算吻合。`canCutover` 仍固定為 `false`，沒有 OS 讀取、資料庫匯入或啟用寫入功能。真實資料核對仍須在受控環境執行，且此候選不能代替完整備份或回滾演練。

本機可用 `npm run shadow:report -- report /absolute/private/os-workspace.json` 印出去個資盤點；已保存唯讀狀態可用 `npm run shadow:report -- compare /absolute/private/os-workspace.json <property-uuid> /absolute/private/iron-gate-state.json <authorityEpoch> <inventoryVersion>` 比對。輸入檔含客資，僅能放在受控私密位置；CLI 不寫來源，也不輸出客資。解析失敗一律只輸出固定錯誤碼，避免錯誤訊息帶出原始資料。這兩種模式都不啟用切換。
