# 民宿 OS 服務頁：設計與驗證紀錄

## 目標與完成範圍

依 owner 要求，以 Awwwards、Webby Awards、FWA 得獎作品的製作水準作為設計目標，重新設計 `/join`，反覆自查與修正。這是內部品質目標，不代表取得獎項、外部評分或評審認證。

品牌命題：「把時間，留給款待。」以台灣小型旅宿的接待日常建立品牌敘事，避免虛構客戶、使用數量、得獎標章與未承諾的服務價格。首頁、問卷、諮詢與結果均屬同一視覺系統。

- 暖白底色、森林綠、陶土色；原創門廊標記，對應旅宿迎接客人的意象。
- 自託管 Noto Serif TC 子集搭配現有 Geist；中文版標題、標點、斷行、字距、層級分開校準。
- 原創庭院情境影像、響應式 WebP、明確 AI 情境標示，沒有冒用實際旅宿照片。
- 互動房況示意：切換包棟／單房／混合，點選不同訂房會顯示相應房間、金額與實收；資料全為虛構，互動不寫入 API。
- 分段進場、影像輕微縮放與按鈕反馈均為短暫效果，無強制捲動、循環動畫、滑鼠替代指標或音效。尊重 reduced-motion。
- 可直接跳至主內容、原生 FAQ、鍵盤焦點、具名按鈕、原生 dialog 與無 JavaScript 的 Email 替代入口。
- 保留既有申請保存、Sheet 分享、非 Sheet 專人協助、重試鎖定與固定收件者機制。以 route-scoped 樣式隔離，不改其他帳務與日曆頁。

參考評審原則：[Webby 官方網站評審項目](https://www.webbyawards.com/judging-criteria/)包含內容、架構與導覽、視覺設計、功能、互動、創新與整體體驗；[Awwwards Mobile Excellence 指南](https://www.awwwards.com/mobile-excellence-guidelines.pdf)作為手機可用性參考。FWA 為創作品質目標，未取得個案評審回饋。

## 自查與修改

1. **構圖與故事**：改為旅宿品牌敘事，重做 hero、品牌宣言、房況示意、加入步驟、FAQ、末段行動入口；移開遮住影像文字的浮動字卡。
2. **互動與內容**：示意日曆選取不同房間會更新訂房與收款，混合模式同時展示包棟與單房；未選 Google Sheet 的諮詢完成畫面不顯示待核對 Sheet 權限。
3. **手機與無障礙**：放大小字、提高灰綠文字對比、加大示意訂房觸控高度至 44px、修正手機標題孤字、修正問卷進度區與日曆群組語意；Sheet 的複製按鈕使用一致樣式。
4. **正式版本複驗**：通過 production build，重新走完表單至實際本機 API 的 201 保存結果，確認 `preview:true`、不寄信、結果與重試狀態仍然清楚。

## 驗證證據

- 六種 viewport：360、390、768、1024、1440、1920px；無頁面橫向溢出、無破圖、無瀏覽器執行錯誤。
- 實際瀏覽器操作：示意類型切換、選取不同房間、問卷焦點、房間輸入、Sheet 分流與分享聲明、改走非 Sheet 諮詢、聯絡表單、儲存成功、關閉視窗、FAQ。
- axe-core：正式版 Sheet 步驟（含首頁）與諮詢 dialog 零自動違規。背景為漸層的影像文字與日曆格線有需人工確認項目，已目視檢查；不宣稱完整 WCAG 認證。
- reduced-motion：影像 animation-name 為 `none`。無 JS 時標題、內容、原生 FAQ、Email 連結可用，另有明確替代入口說明。
- 本機正式版冷載入，Chrome desktop DPR 1：LCP 約 0.55s，CLS 0。模擬 mobile 390px、150ms latency、1.6Mbps、CPU 4x：LCP 約 2.31s，CLS 0。約 484KB 資源傳輸量，無持續動畫。這是一次本機模擬，非 Lighthouse 分數、真實用戶 Core Web Vitals 或正式主機測速。
- 34 個服務／API／授權回歸測試、5 個 DOM 測試通過；DOM 測試新增日曆示意選取驗證，既有問卷分流與不確定送出後重新載入同筆重試仍通過。
- ESLint 零錯誤，兩個原有日曆未使用變數警告；TypeScript 與 webpack production build 通過。Python backend 未變更。

開發機證據位於 `/tmp/bnb-onboarding-check/`：`design-browser-audit.json`、`design-performance.json`、`design-final-desktop.png`、`design-final-mobile.png`、`design-final-sheet.png`、`design-final-contact.png`、`design-final-result.png`、`design-service-tests.log`、`design-ui-tests.log`、`design-lint.log`、`design-build.log`。這些本機檔案不隨部署發布。

## 原創影像與字體

使用內建 image_gen 工具生成情境影像；原始檔留在生成目錄，網站使用版本已保存到 repository：

- `frontend/public/images/service/courtyard.webp`，1600 × 1067，277,016 bytes。
- `frontend/public/images/service/courtyard-800.webp`，800 × 533，88,408 bytes。
- `frontend/public/fonts/service-serif-0.woff2`，Noto Serif TC 400 本頁中文字子集，88,692 bytes。授權在同目錄 `OFL-NotoSerifTC.txt`。新增標題字符需更新子集或確認 fallback。

影像最後使用提示詞（內建工具，非 CLI）：

> Use case: photorealistic-natural. Asset type: original editorial hero photograph for a premium Taiwanese hospitality management brand website named 民宿 OS. Create a highly art-directed architectural photograph of an intimate Taiwan mountain guesthouse courtyard, pale warm limewash walls, deep timber framed open doorway on right, a single sculptural small tree casting delicate shadows, warm terracotta tiles and low concrete steps, glimpse of forest mountains through the far side, a quiet tea table with two cups low in frame. Tactile wabi-sabi, lived-in understated hospitality, editorial architecture magazine quality, entirely believable light and materials, warm late afternoon sunlight with beautiful geometric shadow composition, subtle analog grain. Landscape 3:2 composition, spacious, hero subject distributed across the frame suitable for cropping to portrait at center-right, quiet natural warm muted greens and cream. No people, no lettering, no signs, no text, no watermark, no logos, no computer screens, no gratuitous decoration. This is an illustrative imagined guesthouse, not a named property. Save the generated image for use in the website project.

## 上線狀態

更新於既有草稿 PR #26，尚未部署或切換正式網站。`CUSTOMER_INTAKE_ENABLED` 預設關閉；本機預覽使用 `CUSTOMER_INTAKE_PREVIEW=true`，禁止外寄。正式 Gmail 通知驗證、帳號／資料匯入的發布前條件維持原紀錄，詳見 `SERVICE_JOIN_2026-10-02.md` 與 `CUSTOMER_WORKSPACES_2026-10-02.md`。
