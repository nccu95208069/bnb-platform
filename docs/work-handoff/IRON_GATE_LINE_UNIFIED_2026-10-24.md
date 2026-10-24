# 水芳 LINE OA 統一流程：Iron Gate 後端契約

狀態：執行程式 `9a11207eed72500cdfb5d12c6f62feee431d0fab` 已推送至草稿 PR #37，四項 CI 全數通過；Vercel 正式環境的**無網域候選** `dpl_5UHaDG1yuif1N3LLyKJwTgfdoDn6` 已 Ready，但尚未指派正式網域，也未合併。`iron-gate-green.vercel.app` 仍指向舊部署 `dpl_FGwTLAdcZ5ah8TStZDVQDJsmSm6f`。LINE OA 的啟用旗標在 Gmail 服務，正式環境目前未設定。

## 範圍

水芳 LINE OA 沿用 2026-10-21 既有的理解、候選、確認卡、財務帳本及房態互動。訂單正本改由 Iron Gate 的 LINE manage-all grant 讀取與變更；OFFLAND 保持原後端。原子批次取消與房態 batch API 支援舊 LINE OA 的日期「全部」取消及多房晚開關房，沒有提供未授權的通用批次入口。

## 寫入契約

- 每次新增、修改、取消、批次取消和房態 batch，先核對權限、authority epoch、庫存版本、booking 版本及全部房晚，再簽短效預覽。提交需帶原預覽 token 與 idempotency key；整個批次在單一 repository transaction 中完成，失敗不留下部分 booking 或 manual block 變動。
- LINE 新增的 booking ID 使用原 request key，讓既有財務預寫 claim 與最後正式 booking 指向同一 ID。逐房晚價格只接受完整、無重複、整元且與總額相符的 `roomNightPrices`；修改房晚或總額時清除失效的舊分配。
- 批次取消逐筆建立待核對通路操作與 fence。人工房態 batch 用一個通路操作涵蓋所有房晚；worker 必須逐格回讀後才釋放 fence。取消外部來源 booking 時保留 source-review 狀態，且不視為原 OTA 訂單同步完成。
- 原始 imported Sheet snapshot 只用作唯讀證據。LINE 只有在 grant 同時具備管理權與 money 欄位時，才看得到可驗證的逐房晚價格、來源付款旗標與舊訂單參照。無法確定的分配或收款狀態回傳 unknown，由 LINE OA 停在人工核對；不從整筆總價補造逐晚金額。

## 回讀與發布門檻

Gmail 服務提交後必須用原 request key 查 receipt，再查每筆 booking、版本、狀態、房晚與金額；房態 batch 另查每格 manual block 和房態。收據代表 Iron Gate 正本已變更，通路 `sync_pending` 仍需 worker 後續核對。

本地 `npm run check` 及 `npm test` 通過（200 pass、9 skip）。配對的 GCO 草稿 PR #96 執行程式 `8cb5546c18508f2a36ebc588a6dbf89cc1c9aba0` 與發布控制 `e8a9e7e105f6e3a5ffbf113030ac9309eeceb952` 已通過離線與 CI；其正式服務仍是 `gmail-order-handler-line-hold-400` 100%。正式發布前仍須核對當下 grant／來源／通路狀態、驗證受保護候選、取得本次發布授權，並用真實 LINE 操作核對正本與通路回讀。
