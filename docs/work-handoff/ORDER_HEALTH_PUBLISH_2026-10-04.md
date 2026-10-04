# 訂單健檢：真實 Sheet 分享偵測與發布

## 最新使用者決定

發布可直接使用的 HTTPS 網站；移除範例體驗入口。貼上 Sheet 後應由背景工作偵測分享狀態，取得讀取權限後自動接續。

## 流程

1. 登入既有 Sweetfun OS 帳號，進入 `/order-health`（登入後返回 `/revenue`）。
2. 貼上完整 Google Sheet 連結，停止輸入 800 毫秒後自動提交。
3. 後端以 Sheets 唯讀 scope 查詢試算表 metadata，確認實際可讀性。
4. 403/404 進入 `awaiting_share`，顯示當前部署的接收帳號、複製按鈕、開啟原試算表及三步分享教學。Google API 未啟用、配額或系統錯誤不會誤報為缺少分享。
5. 頁面開啟時每 2.5 秒更新狀態，真正 Google 檢查至少間隔 10 秒；關閉頁面後，由每分鐘 cron 接續。15 分鐘未完成分享就暫停，使用者可手動重新檢查。
6. 權限可讀後，自動進入資料辨識，再依既有最多五題流程確認及分析。

讀取成功只證明有讀取能力，不能證明 Drive 分享的精確角色是 Viewer。因此介面顯示「已取得讀取權限」，並教使用者分享成「檢視者」。不要求將文件公開、不修改來源內容。

## 持久化與授權

- `health:pending` 加密保存工作索引，與建立工作或重啟工作以 CAS 原子提交。
- 每個工作仍有 90 秒 lease，避免畫面輪詢與 cron 重複處理。
- cron 使用 `CRON_SECRET` 驗證，執行前重新檢查保存的 actor、角色、工作區與旅宿。
- 每個旅宿只有最新工作繼續；分享等待不耗用資料處理的三次重試額度。
- 重新分享或重新啟動以 queue version 保護，不會被較舊 worker 的清理刪除。
- 解析明細加密保存 24 小時，報告 30 天。客戶與旅宿權限仍由後端檢查。

## 讀取帳號

`ORDER_HEALTH_SHEET_READER_CREDENTIALS` 可指定本功能的獨立帳號；未設定時使用原有 `CUSTOMER_SHEET_READER_CREDENTIALS`。前端永遠使用 API 回傳的實際帳號，沒有寫死範例帳號。

目前已存在的雲端接收帳號是 `bnb-sheet-reader@bnb-sheet-reader.iam.gserviceaccount.com`。
使用者前次本機操作使用 `grouptravel-sheet-writer@grouptravel-collector.iam.gserviceaccount.com`。將其私鑰上傳 Vercel 的操作被自動審查拒絕，需使用者明確授權後才能執行。沒有改用其他途徑上傳該私鑰。

## 驗證

- 26 項 focused Node tests 通過，包含分享等待、限頻、cron 自動接續、逾時再啟動、actor 授權撤銷及 API 設定错误分類。
- TypeScript 與本功能 ESLint 通過。
- 第一個雲端候選版本建置成功（17 秒），隔離的短期驗收帳號確認登入、空白工作區、真實 Google API 回應及 `checking_access → awaiting_share`。
- 目前正式來源 commit `fcbb05c` 是本分支祖先；發布包含其既有日曆授權修復。
- 候選部署分享連結的建立也被自動審查拒絕；沒有建立公開 bypass 連結或關閉部署保護。
- 正式入口：`https://sweetfun-os.vercel.app/order-health`，發布程式 commit `b3f8517`，最終部署 `dpl_EKFeYme7Hyd6LgMQXQRtWZAkrGHF`（`sweetfun-6bbs6lrrc-sweetfuns-projects.vercel.app`），Production / READY，Next.js 16.3.8，最後建置 8 秒。
- `/order-health` 未登入會導到保留返回位置的登入頁；實際擁有者登入狀態已在瀏覽器確認，可直接看到空白真實資料入口，CTA 為「檢查試算表連線」。
- 瀏覽器驗證貼上連結後自動提交，真實 Google API 拒絕讀取時進入分享指引；沒有點擊範例或手動啟動按鈕。
- 發布後回讀 Vercel 排程定義，已綁定最終部署。23:32:30、23:33:30 的 `/api/cron/order-health` 均為 200；離開分析頁 201 秒後，伺服器仍記錄新的分享檢查。這確認背景排程獨立於頁面輪詢。
- 分析 API 與 cron 的匿名請求均為 401。最終部署錯誤記錄掃描沒有發現錯誤。
- 短期驗收帳號、工作區和來源已清除。擁有者工作區保持空白，不植入範例報告或試算表。
- 舊本機入口 8793 已改成轉向 HTTPS 正式入口；正式站不依賴本機服務。

注意：CLI `--skip-domain` 候選部署會更新專案別名，但並未更新 cron 的 deploymentId。後續使用正常 `vercel deploy --prod --yes` 完成正式發布並回讀排程；不能以手動 alias 成功推論 cron 已更新。

## 回復方式

若新頁面出現問題，可將 `sweetfun-os.vercel.app` 重新指向既有部署 `sweetfun-byrqds9oh-sweetfuns-projects.vercel.app`。既有訂單、日曆與登入資料不受新健康分析 key 影響；本次沒有資料庫結構遷移。

## 2026-10-05 選項理解改善

使用者反映「每一列代表什麼」太抽象。住宿記錄與金額問題改成白話標題、完整選項及具體填表例子；不確定的選項說明略過後不能計算哪些指標。來源預覽改為欄名與數值分開呈現，這兩題預設展開實際讀取的前三列。

文案在 API 回傳時依問題 ID 套用，已存在的匯入工作重新整理也會更新；不改原始問題值、已存答案、計算規則或試算表。TypeScript、變更檔案 ESLint、diff whitespace 檢查通過。瀏覽器因無法驗證管理員安全政策拒絕存取，未繞過限制；本次不能聲稱完成實際畫面驗收。
