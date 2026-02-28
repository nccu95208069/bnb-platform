# BnB Platform Frontend

BnB 民宿管理後台前端應用程式，提供對話管理、知識庫文件管理、渠道設定等功能的管理介面。

## 技術棧

| 類別 | 技術 | 版本 |
|------|------|------|
| 框架 | Next.js（App Router） | 16.1.6 |
| UI 函式庫 | React | 19.2.3 |
| 語言 | TypeScript | 5.x |
| 樣式 | Tailwind CSS v4 + tw-animate-css | 4.x |
| UI 元件 | shadcn/ui（New York style, radix-ui） | radix-ui 1.4.3 |
| 狀態管理 | Zustand | 5.0.11 |
| 後端服務 | Supabase（@supabase/ssr, @supabase/supabase-js） | — |
| 富文字編輯 | Tiptap | 3.x |
| 圖示 | Lucide React | — |
| Toast 通知 | Sonner | 2.x |
| 字型 | Geist Sans / Geist Mono（Google Fonts） | — |

## 快速開始

```bash
# 1. 進入前端目錄
cd frontend

# 2. 安裝依賴
npm install

# 3. 設定環境變數
cp .env.local.example .env.local
# 編輯 .env.local，填入必要的環境變數（見下方說明）

# 4. 啟動開發伺服器
npm run dev
```

開發伺服器預設在 `http://localhost:3000` 啟動。

## 環境變數

在 `.env.local` 中設定以下變數：

```env
NEXT_PUBLIC_SUPABASE_URL=          # Supabase 專案 URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=     # Supabase anon key
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api/v1   # 後端 API base URL
```

> **注意**：API Client 使用的環境變數為 `NEXT_PUBLIC_API_BASE_URL`，預設值為 `http://localhost:8000/api/v1`。

## 可用指令

```bash
npm run dev     # 啟動開發伺服器（含 HMR）
npm run build   # 生產建置（含 TypeScript 型別檢查 + ESLint）
npm run lint    # 執行 ESLint 檢查
npm start       # 以生產模式啟動
```

## 目錄結構

```
frontend/
├── src/
│   ├── app/                        # Next.js App Router 頁面
│   │   ├── layout.tsx              # Root Layout（Sidebar + Toaster）
│   │   ├── page.tsx                # 首頁（重導向至 /conversations）
│   │   ├── globals.css             # 全域樣式（Tailwind CSS）
│   │   ├── robots.ts               # SEO robots 設定
│   │   ├── sitemap.ts              # SEO sitemap 設定
│   │   ├── conversations/
│   │   │   ├── page.tsx            # 對話列表頁
│   │   │   └── [id]/page.tsx       # 對話詳情頁
│   │   ├── dashboard/
│   │   │   ├── page.tsx            # 訊息管理儀表板
│   │   │   └── create/page.tsx     # 建立新訊息（Wizard）
│   │   ├── documents/
│   │   │   └── page.tsx            # 知識庫文件管理
│   │   └── settings/
│   │       └── page.tsx            # 系統設定頁
│   ├── components/
│   │   ├── sidebar.tsx             # 側邊欄導航
│   │   ├── page-header.tsx         # 通用頁面標題元件
│   │   ├── dashboard/              # Dashboard 相關元件
│   │   │   ├── MessageList.tsx     # 訊息列表
│   │   │   ├── MessageCard.tsx     # 訊息卡片
│   │   │   ├── MessageActions.tsx  # 訊息操作按鈕
│   │   │   └── MessageStatusBadge.tsx  # 訊息狀態 Badge
│   │   ├── seo/                    # SEO 相關元件
│   │   │   ├── CookieConsent.tsx   # Cookie 同意提示
│   │   │   ├── GoogleAnalytics.tsx # GA 追蹤
│   │   │   ├── HrefLangTags.tsx    # 多語系 hreflang
│   │   │   └── VerificationMeta.tsx # 驗證 meta tag
│   │   ├── ui/                     # shadcn/ui 基礎元件
│   │   └── wizard/                 # 訊息建立精靈元件
│   │       ├── MessageWizard.tsx   # 精靈主元件
│   │       ├── WizardProgress.tsx  # 步驟進度指示器
│   │       ├── StepRecipient.tsx   # Step 1: 收件人
│   │       ├── StepContent.tsx     # Step 2: 內容編輯
│   │       ├── StepMedia.tsx       # Step 3: 媒體上傳
│   │       ├── StepPreview.tsx     # Step 4: 預覽
│   │       └── StepConfirm.tsx     # Step 5: 確認送出
│   ├── hooks/
│   │   └── useAutoSave.ts          # 自動儲存 Hook
│   ├── lib/
│   │   ├── api-client.ts           # 後端 API HTTP Client
│   │   ├── types.ts                # TypeScript 型別定義
│   │   ├── use-polling.ts          # Polling Hook
│   │   ├── utils.ts                # 工具函數（cn() 等）
│   │   ├── seo/                    # SEO 工具模組
│   │   └── supabase/               # Supabase Client
│   │       ├── client.ts           # 瀏覽器端 Client
│   │       └── types.ts            # Supabase 型別
│   └── stores/
│       └── wizardStore.ts          # 訊息精靈 Zustand Store
├── public/                         # 靜態資源
├── components.json                 # shadcn/ui 設定
├── eslint.config.mjs               # ESLint 設定
├── next.config.ts                  # Next.js 設定
├── package.json
├── postcss.config.mjs              # PostCSS 設定（Tailwind）
└── tsconfig.json                   # TypeScript 設定
```

## 頁面功能說明

### `/` - 首頁

自動重導向至 `/conversations`。

### `/conversations` - 對話列表

管理所有客人的對話記錄。

```
+----------------------------------------------------------+
| 對話管理                              [重新整理]          |
| 查看客人的對話列表，接手或交回 AI 管理                     |
+----------------------------------------------------------+
| [搜尋客人名稱...]         [全部] [AI 處理中] [人工接手中]  |
+----------------------------------------------------------+
| [avatar] 王小明          LINE        3 分鐘前    [AI]     |
| [avatar] 陳美麗          LINE        1 小時前    [人工]   |
| [avatar] 張大偉          LINE        2 天前      [AI]     |
+----------------------------------------------------------+
```

功能特色：
- 搜尋：依客人名稱或 `channel_user_id` 即時篩選
- 狀態篩選：「全部」/「AI 處理中」/「人工接手中」三個 filter
- 渠道顯示：顯示 LINE 等渠道 Badge
- 相對時間：顯示「剛剛」、「N 分鐘前」、「N 小時前」等
- 自動更新：每 10 秒 polling 重新取得列表

### `/conversations/[id]` - 對話詳情

查看完整對話訊息歷史，並可接管或交回 AI。

```
+----------------------------------------------------------+
| [<] 王小明    LINE    LINE: U1234...    [AI 模式]         |
|                                         [接手對話]        |
+----------------------------------------------------------+
|                                                           |
|  [客人] 請問有空房嗎？                            14:30   |
|                                                           |
|          有的，目前還有雙人房可以預訂喔！ [AI]    14:30   |
|                                                           |
|  [客人] 價格多少？                                14:31   |
|                                                           |
|          雙人房一晚 NT$2,800 [AI]                 14:31   |
|                                                           |
+----------------------------------------------------------+
| 目前由 AI 管理對話，點擊「接手對話」可切換為人工模式       |
+----------------------------------------------------------+
```

功能特色：
- 訊息氣泡：不同角色（user/assistant/owner）有不同樣式
  - `user`（客人）：靠左對齊，灰色背景
  - `assistant`（AI）：靠右對齊，藍色背景
  - `owner`（人工）：靠右對齊，主色調背景
- **接手對話**：點擊後切換為 Human 模式，AI 暫停回覆
- **交回 AI**：點擊後切換回 AI 模式，由 AI 繼續處理
- 人工模式下可輸入並發送訊息（Enter 送出，Shift+Enter 換行）
- 自動更新：每 5 秒 polling 重新取得訊息
- 自動捲動：新訊息進來時自動捲至底部

### `/documents` - 知識庫管理

上傳與管理 RAG 訓練用文件。

```
+----------------------------------------------------------+
| 文件管理                              [重新整理]          |
| 上傳與管理 RAG 訓練文件                                   |
+----------------------------------------------------------+
| +------------------------------------------------------+ |
| |                                                      | |
| |          拖拽檔案至此或點擊上傳                        | |
| |          支援 PDF、TXT、DOCX 格式                     | |
| |                                                      | |
| +------------------------------------------------------+ |
+----------------------------------------------------------+
| 檔案名稱          | 類型  | Chunk 數 | 上傳時間  |       |
|--------------------+-------+----------+-----------+-------|
| 房型介紹.pdf       | pdf   | 12       | 2024/3/15 | [刪]  |
| 常見問答.txt       | txt   | 8        | 2024/3/10 | [刪]  |
| 交通指南.docx      | docx  | 5        | 2024/3/08 | [刪]  |
+----------------------------------------------------------+
```

功能特色：
- 上傳方式：拖拉（drag & drop）或點擊選擇檔案
- 支援格式：PDF、TXT、DOCX
- 批次上傳：可同時選取多個檔案
- 文件列表：顯示檔名、類型 Badge、chunk 數量、上傳時間
- 刪除確認：點擊刪除按鈕後彈出 Dialog 確認
- 自動更新：每 15 秒 polling 重新取得列表

### `/settings` - 系統設定

管理 LLM、渠道與 Google 服務串接設定，分為四個 Tab：

- **LLM 設定**：選擇 Provider（Claude / Gemini）並設定 API Key
- **渠道設定**：設定 LINE Messaging API 憑證（Channel ID、Channel Secret、Access Token）
- **Google 串接**：啟用/停用 Google Calendar 及 Google Sheets 整合
- **系統提示詞**：自訂 AI 助手的 system prompt，定義回覆行為與風格

所有機密欄位（API Key、Secret、Token）支援顯示/隱藏切換，已設定的欄位會顯示「已設定」標記。

### `/dashboard` - 訊息管理

管理透過精靈建立的訊息，可查看所有已建立的訊息並建立新訊息。

### `/dashboard/create` - 建立新訊息

透過 5 步驟精靈建立訊息：收件人 -> 內容編輯 -> 媒體上傳 -> 預覽 -> 確認送出。精靈狀態使用 Zustand 管理，並透過 `persist` middleware 自動儲存草稿至 localStorage。

## 核心模組

### API Client（`lib/api-client.ts`）

封裝所有後端 API 呼叫的 HTTP Client，提供 `get`、`post`、`delete`、`upload` 四種方法：

```typescript
import { apiClient } from "@/lib/api-client";

// GET 請求
const conversations = await apiClient.get<Conversation[]>("/conversations");

// POST 請求（JSON body）
await apiClient.post(`/conversations/${id}/takeover`);
await apiClient.post(`/conversations/${id}/messages`, { content: "你好" });

// DELETE 請求
await apiClient.delete(`/documents/${id}`);

// 檔案上傳（FormData）
const formData = new FormData();
formData.append("file", file);
await apiClient.upload<Document>("/documents/upload", formData);
```

錯誤處理：非 2xx 回應會拋出 `ApiError`，包含 HTTP status 和錯誤訊息。204 回應會回傳 `undefined`。

### Polling Hook（`lib/use-polling.ts`）

用於定時輪詢更新資料的自訂 Hook：

```typescript
import { usePolling } from "@/lib/use-polling";

const { data, error, isLoading, refetch } = usePolling<Conversation[]>({
  fetcher: () => apiClient.get("/conversations"),
  interval: 10000,  // 每 10 秒更新（預設）
  enabled: true,    // 是否啟用（預設 true）
});
```

各頁面的 polling 間隔：
| 頁面 | 間隔 |
|------|------|
| 對話列表 (`/conversations`) | 10 秒 |
| 對話詳情 (`/conversations/[id]`) | 5 秒 |
| 文件列表 (`/documents`) | 15 秒 |

### 型別定義（`lib/types.ts`）

所有對應後端資料模型的 TypeScript 介面：

```typescript
type ConversationStatus = "ai" | "human";
type MessageRole = "user" | "assistant" | "system" | "owner";
type ChannelType = "line";

interface Conversation {
  id: string;
  channel: ChannelType;
  channel_user_id: string;
  display_name: string | null;
  status: ConversationStatus;
  is_active: boolean;
  last_message_at: string | null;
  created_at: string;
}

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  llm_model: string | null;
  created_at: string;
}

interface ConversationDetail extends Conversation {
  messages: Message[];
}

interface Document {
  id: string;
  filename: string;
  content_type: string;
  chunk_count: number;
  created_at: string;
}

interface SettingsResponse {
  llm_provider: "claude" | "gemini";
  llm_api_key_set: boolean;
  line_channel_id: string;
  line_channel_secret_set: boolean;
  line_access_token_set: boolean;
  google_calendar_enabled: boolean;
  google_sheets_enabled: boolean;
}
```

### Zustand Store（`stores/wizardStore.ts`）

訊息建立精靈的狀態管理，使用 `zustand/persist` middleware 將草稿存入 localStorage（key: `wizard-draft`）：

```typescript
import { useWizardStore } from "@/stores/wizardStore";

// 在元件中使用
const { currentStep, nextStep, prevStep, recipient, setRecipient, reset } =
  useWizardStore();
```

精靈共 5 個步驟（`WizardStep: 1 | 2 | 3 | 4 | 5`），管理收件人資料、內容、媒體檔案等狀態。

## UI 元件

### shadcn/ui

使用 New York style，透過 CLI 加入元件：

```bash
npx shadcn add button    # 加入 Button 元件
npx shadcn add dialog    # 加入 Dialog 元件
```

目前已使用的 shadcn/ui 元件：
`alert` / `avatar` / `badge` / `button` / `card` / `dialog` / `dropdown-menu` / `input` / `label` / `scroll-area` / `select` / `separator` / `sheet` / `sonner` / `switch` / `table` / `tabs` / `textarea`

設定檔為專案根目錄下的 `components.json`。

### 版面配置（Layout）

Root Layout 採用固定側邊欄 + 主內容區的雙欄式設計：

```
+----------+--------------------------------------------+
|          |                                            |
| Sidebar  |              主內容區                       |
| (w-264)  |         (container max-w-6xl p-6)          |
|          |                                            |
| 對話管理  |                                            |
| 文件管理  |                                            |
| 設定      |                                            |
|          |                                            |
+----------+--------------------------------------------+
| v0.1.0   |                                            |
+----------+--------------------------------------------+
```

- 側邊欄（`Sidebar`）：固定寬度 264px，包含導航連結和版本號
- 主內容區：可捲動，最大寬度 6xl
- Toaster：全域 Sonner toast 通知

## 後端 API 對接

前端透過 `apiClient` 呼叫後端 REST API，主要端點：

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/conversations` | 取得對話列表 |
| GET | `/conversations/:id` | 取得對話詳情（含訊息） |
| POST | `/conversations/:id/takeover` | 接手對話 |
| POST | `/conversations/:id/release` | 交回 AI |
| POST | `/conversations/:id/messages` | 發送人工訊息 |
| GET | `/documents` | 取得文件列表 |
| POST | `/documents/upload` | 上傳文件（FormData） |
| DELETE | `/documents/:id` | 刪除文件 |
| GET | `/settings` | 取得設定 |
| POST | `/settings` | 更新設定 |
| GET | `/settings/system-prompt` | 取得系統提示詞 |
| POST | `/settings/system-prompt` | 更新系統提示詞 |

## 部署

### Vercel 部署

本專案使用 Vercel 部署，需要設定以下環境變數：

| 環境變數 | 說明 |
|----------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_API_BASE_URL` | 生產環境後端 API URL（如 `https://api.example.com/api/v1`） |

### GitHub Actions CD

自動部署需要在 GitHub Repository 設定以下 Secrets：

| Secret | 說明 |
|--------|------|
| `VERCEL_TOKEN` | Vercel API Token |
| `VERCEL_ORG_ID` | Vercel Organization ID |
| `VERCEL_PROJECT_ID` | Vercel Project ID |

## 開發規範

- **TypeScript**：啟用 strict mode，所有新增程式碼須有完整型別定義
- **路由**：使用 Next.js App Router，不使用 Pages Router
- **ESLint**：使用 `eslint-config-next` 預設規則
- **圖片**：使用 Next.js `Image` 元件取代原生 `<img>` 標籤
- **元件庫**：新增 UI 元件優先使用 shadcn/ui（`npx shadcn add <component>`）
- **樣式**：使用 Tailwind CSS utility classes，搭配 `cn()` 工具函數合併 class
- **語系**：HTML lang 設為 `zh-TW`，UI 文字使用繁體中文
