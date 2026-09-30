# LINE 待辦近期改動 Code Review — 2026-09-30

## 範圍與結論

檢查原生 LINE 待辦、按鈕回饋（b4402af）、同名主題合併（e7f8595），
以及本次每組 5 張卡片的變更。重點涵蓋 `manager-inbox.mjs`、
`manager.mjs`、`daili.mjs`、客服經理 API route，並對照後端 review/send
的版本、快照、權限與最多 5 筆讀取契約。

下列問題是程式碼檢查發現的可達情境，不代表已發生正式環境事故。
已一併修正；複查後未發現本次範圍仍需阻擋上線的確定問題。

## Findings 與修正

### P1：處理中的舊 LINE 事件可能跨越重新綁定邊界

- 位置：`frontend/src/lib/host-agents/manager.mjs` 的 webhook 與
  `frontend/src/lib/host-agents/daili.mjs` 的 `decide`。
- 情境：事件先驗證舊 LINE 業主，之後帳號解除並重新綁定；較晚執行的
  單筆或批次操作若只讀取當下綁定狀態，可能被蓋上新的綁定版本。
- 修正：所有 LINE 決定都攜帶驗證寄件人當時的 binding revision，Daili
  寫入前要求一致。若重新綁定發生在該次讀取之後，操作仍保存舊 revision，
  由原有 worker 比對阻擋傳送。業主網頁另由登入 session 驗證。

### P1：舊批次按鈕可能讀到後來重繪頁面的版本

- 位置：`frontend/src/lib/host-agents/manager.mjs`，`showPage`、`batchPreview`。
- 原因：批次按鈕只攜帶 view/page；同一頁再次顯示會覆寫保存的草稿版本。
  舊按鈕因此可能引用新版本，即使新卡片還未送達。確認畫面只列姓名，
  不能補足該版本草稿的顯示依據。
- 修正：每次顯示加入獨立 `renderToken`，按鈕必須與保存紀錄一致；
  批次保存精確 draft/version，最終操作仍逐筆核對。舊協定的批次確認
  需重新開啟分類取得新卡片。

### P2：5 張長卡片可能超過 LINE carousel 上限

- 位置：`frontend/src/lib/host-agents/manager-inbox.mjs`，`pageMessages`。
- 原因：固定將整頁卡片放進一個 carousel，未計算 UTF-8 JSON 位元組。
- 修正：邏輯分頁固定最多 5 位，依實際 JSON bytes 將長卡片分成多排，
  每排預留至 48,000 bytes。單張上限保守採 30,000 bytes；不截斷待核准
  的回覆全文。極端 5 排時將導航獨立 bubble 放在最後一排，整次仍不超過
  5 個 LINE message objects。
- 依據：[LINE Messaging API](https://developers.line.biz/en/reference/messaging-api/nojs/)
  的 bubble 30 KB、carousel 50 KB 與 reply 最多 5 個 message objects。

### P2：直接修改全域頁數會使舊的「下一組」跳過客人

- 位置：`frontend/src/lib/host-agents/manager.mjs`，`openInbox`、`showPage`。
- 情境：舊頁已顯示第 1～3 位，改版後原按鈕的 page=1 若改用 5 計算，
  將從第 6 位開始，跳過第 4、5 位。
- 修正：新 view 保存 `pageSize=5`；舊 view 缺值時沿用 3，保留連續索引。
  重新點任何分類即建立新的 5 張分頁。翻頁也重新過濾分類，已延後或
  分類改變的項目不會繼續混入舊分類；「稍後處理」不提供不適用的批次操作。

### P2：草稿版本改變可能吞掉完成回報

- 位置：`frontend/src/lib/host-agents/daili.mjs`，`notice` 與通知送出迴圈。
- 情境：送出/確認訂單已完成並排入通知，業主隨即進行另一操作使版本變更，
  原通知被當成過期卡片而刪除。
- 修正：完成通知保存該次結果的快照，重試沿用同一份內容；目前草稿
  升版不再抹掉已發生的結果。草稿型通知仍核對目前版本，舊通知無快照時
  保留原本保守判定。所有快照仍在原有加密儲存範圍內。

### P2：剛處理完的舊待辦可能立即被清除，進度按鈕失效

- 位置：`frontend/src/lib/host-agents/daili.mjs`，`decide` 與 cache 保留條件。
- 情境：待辦建立已超過 7 天，業主今天才結案；清理原本只看建立時間，
  因而可能在通知送出前刪掉剛完成的草稿，讓「查看進度」找不到該項目。
- 修正：新操作保存 `last_action_at`，保留期從最近操作/傳送/訂單處理時間
  計算；既有批准與傳送時間也納入相容判斷。尚未處理及未知結果仍保留。

## 複查項目

- 所有分類共用新頁數 5；最後一頁及已處理的舊分頁可能少於 5 位。
- LINE payload 分排保留順序、全部 guest cards、回覆全文與分頁控制。
- 批次的 render token、draft version、owner binding revision 與後端完整
  inbox snapshot 各自核對，更新內容不能沿用舊核准。
- 單筆重複點擊只回傳既有結果，不建立新傳送 claim。
- 主題合併只處理相同顯示字串，保留全部 obligation IDs 與明確結案目標。
- 讀取證據只在 LINE 接受卡片後建立，依完全相同版本與完整可見訊息保留。
- 背景 action worker 使用同一 property lease；發送和訂單確認分開；
  暫停時送出仍受阻，未知傳送結果不盲目重送。

## 檢查與限制

JavaScript 語法、scoped ESLint、TypeScript、diff whitespace 檢查與雲端
production build 的結果於部署時記錄。此次要求為 code review，未新增或
執行自動化測試，亦未核准真實客人訊息或訂單作為測試。

已知保守行為：快速核准可能早於非同步讀取證據回寫；此時保留未知覆蓋，
不把未證明已讀/已回答的歷史問題自動結案。單張超過 LINE 上限的異常資料
會明確拒絕顯示，避免以被截短的回覆取得核准。實際手機卡片與傳送流程
未在本次操作。
