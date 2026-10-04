# 訂單健檢：實際匯入整合版

本次由 `codex/customer-onboarding` 的 `940d88d` 分出 `codex/order-health-page`。依 2026-10-04 已確認的頁面規劃，將獨立原型接入 OS。這是可執行的實際匯入版本，尚未部署到正式站。

## 已接通

- 舊 OS `/revenue?property=…` 與客戶工作區 `/w/[slug]/revenue?property=…`，導覽提供入口。
- CSV（UTF-8／Big5）、xlsx、xls 解析；3 MB、12 工作表、合計 10,000 列、64 欄限制；ZIP 展開限制 16 MB、拒絕巨集與加密 ZIP。
- Google Sheet 使用既有 `CUSTOMER_SHEET_READER_CREDENTIALS`，只申請 Sheets 唯讀 scope；成功讀取的來源綁定工作區。
- 遮蔽已辨識的個資欄名，丟棄未映射的欄值。Gemini 只接收遮蔽後欄名與允許的候選映射；不能刪掉固定規則辨識出的安全欄位。模型失敗時保留規則結果，頁面顯示實際辨識方式。
- 後端累計最多五題；選工作表、選館別、日期格式、資料單位、無狀態確認、房費口徑、下訂日按影響排序。名額不足時停用較低優先指標或隔離資料，不增加第六題。
- 多工作表可選一張；只有欄位與映射完全一致時，才提供使用者明確選擇合併，保留原工作表與列號。
- 固定規則計算房晚、已知房費、正金額房晚平均價格、月度、通路、星期分布及以房晚加權的提前預訂中位數。
- 取消／未知狀態、重複訂單 ID、無 ID 的完全相同明細、實體房號重疊、錯誤日期、多房矛盾與未釐清包棟均隔離。零元仍算房晚，但不進 ADR 分母。退房日不計住宿晚。
- 不宣稱完整期間、實收、淨利或精確住房率；未知每日庫存時停用住房率與未來空檔；跨晚總價均分明示估算。
- 小芳以 Gemini 選取報告內 Fact，再由固定模板輸出數字與來源；模型不能自由生成數字。模型未配置或失敗時，只回答可明確對應的指標問題。
- 加密持久化工作與 lease；Next `after` 執行、刷新可恢復逾時工作；request ID 防重送、CAS 防止並行覆寫。
- 明細 24 小時、報告與按使用者隔離的問答 30 天；支援提前清除明細。設定修改建立新工作與新快照，舊報告不改寫。新匯入失敗不覆蓋上次成功報告。
- 每次 API 都重查登入、工作區成員、旅宿和金額權限；owner/admin 可匯入與問答，viewer 可讀報告；housekeeper／viewer_no_price 不可讀客戶分析。舊 OS 按既有 `viewPrices` 與管理角色規則。POST 要求同來源。

## 設定

沿用既有 Redis REST 與帳號登入環境；可另外設定 32 字元以上 `ORDER_HEALTH_ENCRYPTION_KEY`。未設定時依序使用 `CUSTOMER_SESSION_SECRET`、`CALENDAR_OWNER_SESSION_SECRET`。輪替有效密鑰會讓舊報告無法解密，部署時須保持穩定。

`GEMINI_API_KEY` 和 `GEMINI_MODEL` 都有值才啟用 AI；模型名稱沿用環境設定，不在程式硬編新模型。

Google 接收帳號未配置時，頁面明示不可用並保留檔案入口。Google 憑證不回傳前端。

## 驗證紀錄

- 23 項 Node 測試通過：三種檔案格式、個資欄排除、跨月、零元、缺值、混合幣別、多房、重複與實體重疊、日期、五題、合併工作表、保存／恢復、revision 不可變、問答隔離及真實 session 權限判斷。
- Google adapter 以合成金鑰及模擬 transport 驗證唯讀 scope、三段讀取與撤權錯誤。**尚未以真實分享的 Google Sheet 驗證此新入口。**
- Gemini 實際 API：以合成欄名辨識成功，119 input tokens、62 output tokens；合成報告問答回覆「2 房晚」，模式為 Gemini 且快照一致。未傳送真實客人／訂單資料。
- 本機 Next + 獨立合成 store 跑完整瀏覽器流程：CSV 48 列 → 3 題 → 45 有效列／3 取消列 → 90 房晚、203,100 房費；刷新保留題目進度，修改已回答題目不增加計數，图表問答核對相同報告。
- HTTP：未登入 401、其他旅宿 403、跨來源 POST 403；授權讀取 private/no-store，報告數值一致。
- 桌面與 390 px 手機版已檢查。既有 CalendarAppearanceProvider 在開發模式的 abort log 仍可見，非此功能新增；不宣稱整站零 console log。
- TypeScript 與新功能 ESLint 通過；全站 lint 無 errors，保留既有 7 warnings。
- 正式 webpack build 通過。預設 Turbopack 在本機隔離環境建立 CSS worker port 時受限；以 `next build --webpack` 完成相同 production routes 建置，未更改正式 build script。

## 邊界與下一次正式驗收

這一版偏向可辨識欄名的訂單明細，不支援任意排房矩陣、複雜合併儲存格、無法辨識標題或混合包棟庫存。未知狀態先隔離，不自動猜成有效訂單。重複 ID 不自動拆解總價；需要先整理來源。

尚未提供可信每日庫存、同／環比、訂單增刪異動逐筆比較、自動定時讀 Sheet、自由文字經營建議及任意期間工具查詢。小芳目前引用已計算 Fact；不宣稱完整任意分析代理。

正式發布前應在候選部署中，以真實授權 Sheet 驗證分享／撤權、既有 Redis 方案的容量與 TTL、正式登入角色以及模型設定，再決定发布。此分支未變更正式訂單、帳本或現有公開服務。

## 重跑

```sh
cd frontend
node --experimental-strip-types --test tests/order-health/engine.test.ts
npm run lint
npx next build --webpack
```

測試使用 Node 24；單元測試不需要真實憑證或外部網路。瀏覽器證據與合成 store 放在工作区輸出／暫存位置，不提交任何測試登入入口或真實憑證。
