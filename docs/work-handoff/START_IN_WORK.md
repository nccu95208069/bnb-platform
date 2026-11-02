# Start This Project in ChatGPT Work

Use the prompt below in a new Work thread after connecting/opening `nccu95208069/bnb-platform` and adding the private handoff bundle or the original Agent-First decision document as a Project source.

## Copy/paste prompt

```text
你現在接手 bnb-saas / Sweetfun OS 專案，repository 是 nccu95208069/bnb-platform。

先不要立刻改程式。先依序讀取：
1. AGENTS.md
2. WORK_CONTEXT.md
3. docs/work-handoff/README.md
4. docs/work-handoff/PRODUCT_DECISIONS_V0_2.md
5. docs/work-handoff/IMPLEMENTATION_STATUS_2026-09-05.md
6. docs/work-handoff/NEXT_WORK.md
7. 與當前任務直接相關的程式碼、migration、tests 與 merged PR #8、#10

若 Project 裡有《Agent-First 旅宿訂單與財務系統｜產品設計決策紀錄 v0.2》，它是完整產品討論與決策原始來源。不得把 AI_CONTEXT.md 或 docs/ai-context/ 的舊 LINE Reply Copilot 方向誤認為目前整體產品主線；它們只保留為平行／後續訊息子系統參考。

請先輸出一份「接手檢查」：
A. 你理解的目前產品定位與核心架構
B. 已完成且真正部署的功能
C. Demo／prototype 與 production-ready 的明確邊界
D. 規格與程式碼之間的差距或衝突
E. 下一個最合理的單一 Milestone，以及為何不是先做其他項目
F. 你準備修改的檔案、資料表、migration、API、tests 與驗收案例

先核對 NEXT_WORK.md 的 Milestone 0／1 前置條件。正式付款寫入必須等資料字典、穩定 ID、寫入方向與 Tool 契約完成確認。
目前已有付款隔離測試實作，請先讀 PAYMENT_WORKFLOW.md 與 PAYMENT_SOURCE_MAPPING.md。
正式來源尚未確認時，只能以隔離合成資料驗證「登記訂金／付款」Golden Workflow，不得猜測正式 Sheet 欄位或宣稱正式登記完成：
check_order → controlled update_order(record_payment) → check_order，並包含 persistent Mission、idempotency、expected version、audit、permission、blocking child Mission、final verification。

執行規則：
- Agent 負責意圖、Mission、Tool 規劃／順序、輸入輸出核對與重新規劃。
- Tool 負責權威查詢、唯一匹配、完整性判斷、業務驗證、正式計算、寫入、同步與結構化錯誤。
- 不得由模型自行挑選多筆候選訂單。
- 同房重疊有效訂單是 data_integrity_conflict，必須建立 blocking investigation Mission。
- 重要寫入必須 check → update → check；update success 不是 Mission 完成條件。
- 一間旅宿第一版同時間只執行一個 Tool flow，只能在 Tool 邊界切換 Mission。
- 優先序：安全／阻擋 > 老闆即時 > 例行排程。
- 等待老闆只阻擋相關 Mission。
- 公開 Vercel 必須維持匿名 demo，直到所有 production tenant/property authorization、RLS、server-side writes 與 PII-safe logging 完整驗證。
- 不要把真實客資、訂單匯出、對話、門鎖密碼、銀行資訊或 credentials 放進 public repo。
- 可逆且低風險的工作請自主完成；只有不可逆／高風險決策、付費服務或憑證需求、缺少無法替代的關鍵資產、或會改變既定產品策略的重大分歧才停下來詢問。
- 使用 branch + PR；跑完 frontend lint/build、backend lint/format/tests 後才能建議 merge。

接手檢查完成後，若沒有真正阻擋因素，就直接開始完成下一個 Milestone，不要停在純規劃。
```

## Suggested Work setup

- Use a regular Project so chats, files, and instructions stay together.
- Add the private transition ZIP and/or original decision DOCX as Project sources.
- Connect GitHub and open the repository.
- Start a Work thread from the Project when that option is available.
- Keep production credentials out of chat; enter them only through approved secret/configuration interfaces.

## First verification command for the new agent

Before coding, it should verify that current `main` contains:

- `AGENTS.md`
- `WORK_CONTEXT.md`
- `docs/work-handoff/`
- Supabase workspace migrations `202609050001` through `202609050003`
- merged behavior from PR #8 and PR #10

It should explicitly ignore the closed/superseded PR #9 branch.
