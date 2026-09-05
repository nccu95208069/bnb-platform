# 接手檢查與付款隔離測試範圍

本次接手從 `main` 的 `8bdf6bdb0a5b2662962320f31581b59c05971a75` 開始。GitHub 確認 PR #11 已合併且對應此 commit。使用者明確選擇在目前任務實作，並在正式 Sheet 結構尚未確認時先完成隔離測試。

## A. 已確認產品決策

產品主線是 3–30 房旅宿的 Agent-First 訂單與收款營運。Agent 負責理解、規劃與核對；Tools 負責權威查詢、匹配、驗證、計算、寫入；Mission 保存進度與依賴。重要寫入遵守先查、再寫、再查。Google Sheet 仍是正式營運主資料；LINE Reply Copilot 是保留的子系統。

## B. 原有程式與部署證據

main 包含日／週／月曆、連住、訂單詳情／編輯、角色與旅宿範圍介面，以及三份 workspace access migration。交接文件記載 PR #8、#10 的 CI／Vercel 部署已成功。本次確認其程式與 commit 已在 main，並讀取 PR #11 的 Backend／Frontend 檢查，兩項均為 SUCCESS；不將此視為重新驗證正式環境資料庫或真實客資流程。

本次不改月曆、連住或權限管理 UI。新增付款程式的驗證範圍是本機合成資料、實際 PostgreSQL 交易、HTTP API 與 CI；正式服務不因本次測試而啟用付款。

## C. Demo 與正式能力邊界

現有公開頁面是匿名 Demo；畫面付款或編輯不能證明正式資料持久化。新增後端確實將付款、Mission 與 audit 存入測試資料庫，但只允許明確開啟的 sandbox。正式 Sheet adapter、正式資料匯入及 UI 寫入切換都不在這次隔離驗收內。

## D. 規格與程式差距

- 舊 `Booking` 以 Sheet row／夜間片段為主，沒有 tenant/property、付款明細或版本控制。
- 舊 `sheets_sync.py` 使用唯讀 Sheets 權限；沒有受控付款寫回與外部冪等性。
- Seed 雖有 `DB_Payments`，不能假設其中的付款旗標或推導紀錄就是正式銀行入帳。
- 舊 calendar API 的完整隔離、其他 legacy table RLS、SMS／邀請端到端驗證仍待完成。
- 完整 Scheduler、優先排程、Agent 自然語言入口、Mission UI、Owlnest、退款與對帳都仍有後續工作。

交接 Prompt 曾把付款列為預設下一步，但較高優先文件要求先核對資料字典與寫入方向。PR #11 的 review 也指出同一風險。本次以最新使用者指示解決此衝突：先完成隔離付款測試，正式寫入持續受 Milestone 0／1 前置條件約束。

## E. 單一 Milestone

完成付款 Golden Workflow 的隔離後端驗收：持久化 Mission、付款 ledger、受控 Tool、同 key 防重複、expected version、當前伺服器權限、append-only audit、blocking child Mission，以及寫入後獨立驗證與恢復。這可以驗證核心可靠性，又不需要猜測正式 Sheet 寫入契約。

## F. 修改範圍與驗收

- `services/api/alembic/versions/008_payment_workflow.py`：獨立 schema 與五份表、scoped FK／唯一鍵／索引、RLS、grants、不可覆寫的付款／Tool history。
- `app/schemas/payment_workflow.py`：限定 `check_order`／付款／確認／調查輸入。
- `app/services/payment_workflow.py`：確定性查核、付款與 Mission 狀態／恢復。
- `app/api/endpoints/payment_workflow.py`：tenant/property scoped API，預設關閉功能、身分與當前資料庫權限檢查。
- `tests/test_payment_workflow.py`：用真實 PostgreSQL 驗證正常／零／多筆／重疊、付款重送與並發、版本衝突、角色與旅宿範圍、金額／日期、確認、回滾、恢復、驗證不符。
- `.github/workflows/ci.yml`：在 backend CI 提供 disposable PostgreSQL，防止付款驗收被無聲跳過。

詳細契約、Playbook、操作方式與 rollout 條件見 [PAYMENT_WORKFLOW.md](PAYMENT_WORKFLOW.md)；資料字典現況見 [PAYMENT_SOURCE_MAPPING.md](PAYMENT_SOURCE_MAPPING.md)。正式寫回需要下一輪核對與實作，不以本次測試結果宣稱 production-ready。
