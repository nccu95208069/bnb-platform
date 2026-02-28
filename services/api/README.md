# BnB AI Concierge API

多渠道 AI 民宿智能客服後端服務。接收來自 LINE 等通訊平台的訊息，透過 RAG（Retrieval-Augmented Generation）結合知識庫與 LLM 自動回覆房客問題，並提供管理後台 API 讓民宿主人即時介入對話。

## 技術棧

| 分類 | 技術 |
|------|------|
| 語言 / 框架 | Python 3.12, FastAPI 0.115+ |
| 資料驗證 | Pydantic v2, pydantic-settings |
| ORM / 資料庫 | SQLAlchemy 2 (asyncio) + asyncpg, PostgreSQL 16, pgvector |
| 資料庫遷移 | Alembic |
| LLM | Anthropic Claude (claude-sonnet-4-5-20250929), Google Gemini (gemini-2.0-flash) |
| Embedding | OpenAI text-embedding-3-small (1536 維) |
| 通訊渠道 | LINE Bot SDK 3.14+ |
| 建構系統 | hatchling |
| 測試 | pytest + pytest-asyncio + pytest-cov |
| Linting | ruff, mypy (strict) |

## 目錄結構

```
services/api/
├── app/
│   ├── main.py                  # FastAPI 應用程式入口
│   ├── api/
│   │   ├── router.py            # 路由聚合
│   │   └── endpoints/
│   │       ├── health.py        # 健康檢查
│   │       ├── webhook.py       # 渠道 webhook 接收
│   │       ├── conversations.py # 對話管理 API
│   │       └── documents.py     # 文件管理 API
│   ├── channels/
│   │   ├── base.py              # ChannelAdapter ABC 與資料型別
│   │   ├── registry.py          # 適配器註冊與查詢
│   │   └── line/
│   │       └── adapter.py       # LINE 渠道實作
│   ├── core/
│   │   ├── config.py            # pydantic-settings 應用設定
│   │   └── database.py          # async engine 與 session factory
│   ├── models/
│   │   ├── base.py              # Base, UUIDMixin, TimestampMixin
│   │   ├── conversation.py      # Conversation, Message
│   │   └── document.py          # Document, DocumentChunk
│   ├── schemas/
│   │   ├── conversation.py      # ConversationOut, MessageOut, SendMessageRequest
│   │   └── document.py          # DocumentOut
│   └── services/
│       ├── ai_brain.py          # 訊息調度中樞
│       ├── conversation.py      # 對話 CRUD
│       ├── llm.py               # LLM 多供應商服務
│       ├── rag.py               # RAG 管線（切塊 / embedding / 檢索）
│       └── google_integration.py
├── alembic/                     # DB 遷移腳本
├── tests/                       # pytest 測試（117 tests）
├── Dockerfile
├── docker-compose.yml
└── pyproject.toml
```

## 核心架構

### Channel Adapter Pattern

系統透過適配器模式抽象不同的通訊渠道，新增渠道時不需修改核心業務邏輯。

`app/channels/base.py` 定義了核心介面與資料型別：

```python
class ChannelType(str, enum.Enum):
    LINE = "line"

@dataclass
class IncomingMessage:
    channel: ChannelType
    channel_user_id: str
    display_name: str | None = None
    text: str | None = None
    message_type: str = "text"  # text, image, sticker, follow, unfollow
    raw_event: object | None = None
    reply_token: str | None = None

@dataclass
class OutgoingMessage:
    channel: ChannelType
    channel_user_id: str
    text: str
    reply_token: str | None = None  # 有值時使用 reply，否則使用 push

class ChannelAdapter(ABC):
    channel_type: ChannelType

    async def parse_webhook(self, request: Request) -> list[IncomingMessage]: ...
    async def send_message(self, message: OutgoingMessage) -> None: ...
```

應用程式啟動時，`lifespan` 會呼叫 `init_adapters()` 根據環境變數中的 API key 條件式註冊可用的渠道適配器。

### AIBrain -- 訊息調度中樞

`app/services/ai_brain.py` 是渠道無關的訊息處理核心，負責調度對話管理、RAG 與 LLM。

**處理流程：**

```
IncomingMessage
  ├── text:     取得/建立對話 → 儲存使用者訊息 → 檢查模式
  │               ├── AI 模式:    RAG 建立上下文 → LLM 生成回覆 → 儲存回覆 → OutgoingMessage
  │               └── HUMAN 模式: 不自動回覆（等待管理員）
  ├── image:    回覆「目前僅支援文字訊息」
  ├── sticker:  回覆「收到貼圖」
  ├── follow:   建立對話 + 傳送歡迎訊息
  └── unfollow: 記錄 log，不回覆
```

管理員透過 `send_owner_message()` 可直接對特定對話發送訊息，系統會查詢對話的渠道與使用者 ID，透過對應的 adapter 發送。

### LLM Service

`app/services/llm.py` 實作多供應商 LLM 服務，支援自動 fallback：

- **主要供應商**：Anthropic Claude (`claude-sonnet-4-5-20250929`)
- **備用供應商**：Google Gemini (`gemini-2.0-flash`)
- 當主要供應商失敗時自動切換至備用供應商
- 根據環境變數中的 API key 動態初始化可用供應商

```python
llm_service.generate(
    messages=[{"role": "user", "content": "..."}],
    system_prompt="...",   # 可選，預設使用 BNB_SYSTEM_PROMPT
    provider=None,         # 可選，強制指定供應商
) -> LLMResponse(content, model, input_tokens, output_tokens, provider)
```

系統內建 `BNB_SYSTEM_PROMPT`，將 AI 定位為民宿智能客服角色，使用繁體中文、親切語氣回覆。

### RAG Service

`app/services/rag.py` 處理文件知識庫的建立與檢索：

**文件攝取（Ingestion）**：
1. 文字切塊：固定大小 512 字元，重疊 50 字元
2. 透過 OpenAI API 產生 embedding 向量（text-embedding-3-small, 1536 維）
3. 儲存至 PostgreSQL + pgvector

**語意檢索（Retrieval）**：
1. 將查詢文字轉為 embedding
2. 使用 cosine distance 在 pgvector 中搜尋最相近的 chunks（預設 top_k=3）
3. 組裝成格式化的上下文字串注入 LLM system prompt

## 資料模型

### Conversation

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | UUID (PK) | 自動產生 |
| `channel` | Enum(ChannelType) | 通訊渠道（LINE） |
| `channel_user_id` | String(255), indexed | 渠道端使用者 ID |
| `display_name` | String(255), nullable | 使用者顯示名稱 |
| `status` | Enum(AI, HUMAN) | 目前回覆模式 |
| `is_active` | Boolean | 對話是否啟用 |
| `last_message_at` | DateTime(tz) | 最後訊息時間 |
| `messages` | relationship | 一對多關聯 Message（cascade delete） |

### Message

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | UUID (PK) | 自動產生 |
| `conversation_id` | UUID (FK -> conversations, CASCADE) | 所屬對話 |
| `role` | Enum(user, assistant, system, owner) | 發送者角色 |
| `content` | Text | 訊息內容 |
| `llm_model` | String(100), nullable | 使用的 LLM 模型名稱 |
| `token_usage` | Integer, nullable | Token 使用量 |

### Document

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | UUID (PK) | 自動產生 |
| `filename` | String(500) | 原始檔案名稱 |
| `content_type` | String(100) | MIME type |
| `content` | Text | 文件全文 |
| `chunk_count` | Integer | 切塊數量 |
| `chunks` | relationship | 一對多關聯 DocumentChunk（cascade delete） |

### DocumentChunk

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | UUID (PK) | 自動產生 |
| `document_id` | UUID (FK -> documents, CASCADE) | 所屬文件 |
| `content` | Text | 切塊文字內容 |
| `chunk_index` | Integer | 切塊索引 |
| `embedding` | Vector(1536) | pgvector embedding 向量 |

## API Endpoints

### 健康檢查

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/health` | 服務健康檢查 |

### Webhook

| 方法 | 路徑 | 說明 |
|------|------|------|
| `POST` | `/api/v1/webhook/{channel_name}` | 接收渠道 webhook 事件 |

LINE webhook 路徑為 `/api/v1/webhook/line`，會驗證 LINE signature 後解析事件並交給 AIBrain 處理。

### 對話管理

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/api/v1/conversations` | 列出對話（支援 `?status=ai\|human` 篩選） |
| `GET` | `/api/v1/conversations/{id}` | 取得對話詳情（含所有訊息） |
| `POST` | `/api/v1/conversations/{id}/takeover` | 接管對話（切換為 HUMAN 模式） |
| `POST` | `/api/v1/conversations/{id}/release` | 釋放對話（交回 AI 模式） |
| `POST` | `/api/v1/conversations/{id}/messages` | 管理員對該對話發送訊息 |

### 文件管理

| 方法 | 路徑 | 說明 |
|------|------|------|
| `POST` | `/api/v1/documents/upload` | 上傳文件（支援 TXT / PDF / DOCX） |
| `GET` | `/api/v1/documents` | 列出所有文件 |
| `DELETE` | `/api/v1/documents/{id}` | 刪除文件及其所有 chunks |

## 環境變數

建立 `.env` 檔案於 `services/api/` 目錄下：

```bash
# === 應用程式 ===
APP_ENV=development          # development | production
APP_DEBUG=false
APP_HOST=0.0.0.0
APP_PORT=8000
CORS_ORIGINS=                # 生產環境必填，逗號分隔的允許來源

# === 資料庫 ===
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/bnb_linebot

# === LINE Bot ===
LINE_CHANNEL_SECRET=         # LINE Messaging API channel secret
LINE_CHANNEL_ACCESS_TOKEN=   # LINE Messaging API access token

# === LLM - Anthropic Claude（主要） ===
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

# === LLM - Google Gemini（備用） ===
GOOGLE_GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash

# === Google 整合（Calendar / Sheets） ===
GOOGLE_SERVICE_ACCOUNT_JSON= # Service account JSON 字串
GOOGLE_CALENDAR_ID=
GOOGLE_SHEET_ID=

# === RAG / Embedding ===
OPENAI_API_KEY=              # OpenAI API key（embedding 用）
EMBEDDING_MODEL=text-embedding-3-small
CHUNK_SIZE=512
CHUNK_OVERLAP=50
```

### 生產環境驗證

當 `APP_ENV=production` 時，啟動時會自動驗證以下必要設定，缺少任一項會拋出 `ValueError` 中止啟動：

- 至少一個通訊渠道已設定（`LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN`）
- 至少一個 LLM API key（`ANTHROPIC_API_KEY` 或 `GOOGLE_GEMINI_API_KEY`）
- `CORS_ORIGINS` 已設定

開發環境下所有設定皆為選填，CORS 預設允許所有來源。生產環境未設定 `CORS_ORIGINS` 時不允許任何跨域請求。

## 開發指南

### 安裝

```bash
# 安裝專案（含 dev 依賴）
pip install -e ".[dev]"
```

### Lint / Format

```bash
# 檢查程式碼風格與錯誤
ruff check app tests

# 檢查格式
ruff format --check app tests

# 自動修正
ruff check --fix app tests
ruff format app tests

# 型別檢查
mypy app
```

### 測試

```bash
# 執行所有測試（含覆蓋率報告）
pytest --tb=short -q --cov=app --cov-report=term-missing
```

測試使用 `pytest-asyncio`（`asyncio_mode = "auto"`），不需要手動標記 async 測試函式。

### 資料庫

```bash
# 啟動本機 PostgreSQL（Docker）
docker-compose up db

# 執行資料庫遷移
alembic upgrade head

# 建立新的遷移腳本
alembic revision --autogenerate -m "描述"
```

## Docker

### docker-compose（推薦開發使用）

```bash
# 啟動所有服務（API + PostgreSQL）
docker-compose up

# 背景執行
docker-compose up -d
```

### 單獨建構映像

```bash
docker build -t bnb-api .
```

### 已知問題

> **Dockerfile 缺少 README.md COPY**：`pyproject.toml` 宣告了 `readme = "README.md"`，但 Dockerfile 的 build stage 只 COPY 了 `pyproject.toml`，導致 `pip install` 時 hatchling 找不到 README 檔案而失敗。
>
> 修復方式：在 Dockerfile 的 `COPY pyproject.toml ./` 後加入 `COPY README.md ./`。

## 應用程式生命週期

應用程式透過 FastAPI 的 `lifespan` 管理啟動與關閉：

- **啟動**：呼叫 `init_adapters()` 註冊已設定的渠道適配器
- **關閉**：呼叫 `engine.dispose()` 釋放資料庫連線池

生產環境下 Swagger 文件（`/docs`、`/redoc`）會自動停用。

## 擴充指南：新增渠道

1. 在 `app/channels/` 建立新目錄（例如 `facebook/`）
2. 實作 `ChannelAdapter` 子類別，包含 `parse_webhook()` 與 `send_message()`
3. 在 `ChannelType` enum 新增對應值
4. 在 `registry.py` 的 `init_adapters()` 加入條件式 `register_adapter()` 呼叫
5. 在 `config.py` 加入對應的 API key 設定欄位

範例結構：

```
app/channels/facebook/
└── adapter.py   # FacebookChannelAdapter(ChannelAdapter)
```

核心業務邏輯（AIBrain, LLMService, RAGService）無需修改，新渠道會自動接入現有的 AI 回覆管線。
