# BnB Platform

BnB AI Concierge — 民宿 AI 客服平台，支援 LINE 等多通道整合。

## 專案結構

```
services/api/     # FastAPI backend (Python 3.12)
frontend/         # Next.js 16 dashboard (React 19, TypeScript)
.github/workflows # CI/CD (GitHub Actions)
```

## 快速指令

### Backend (`services/api/`)

```bash
pip install -e ".[dev]"                    # 安裝依賴
docker-compose up                          # 啟動 API + PostgreSQL
pytest                                     # 跑測試
pytest --cov=app --cov-report=term-missing # 跑測試 + coverage
ruff check .                               # Lint
ruff format .                              # Format
alembic upgrade head                       # 跑 migration
```

### Frontend (`frontend/`)

```bash
npm install     # 安裝依賴
npm run dev     # 啟動 dev server (port 3000)
npm run lint    # ESLint
npm run build   # TypeScript check + build
```

## 程式碼風格

### Python

- Line length: 100
- Ruff rules: E, F, I, N, UP, B, SIM (ignore B008, UP042)
- Async/await everywhere (AsyncSession, async endpoints)
- Type hints required (strict mypy)
- Enum pattern: `class MyStatus(str, enum.Enum)`
- Models use `UUIDMixin`, `TimestampMixin` from `app/models/base.py`
- Services 接收 `db: AsyncSession` in `__init__`

### TypeScript

- Path alias: `@/*` → `./src/*`
- Components: PascalCase class, kebab-case filename
- UI: shadcn/ui (`src/components/ui/`), icons from `lucide-react`
- State: Zustand (`src/stores/`)
- API: `apiClient` from `src/lib/api-client.ts`
- Toast: `sonner`

### 共通

- **UI 語言：繁體中文 (zh-TW)**
- Commit message: conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`)
- 不要自動 commit，除非使用者要求

## 架構

### Backend

- **Channel Adapter Pattern**: `ChannelAdapter` base → LINE adapter → registry
- **Service Layer**: AIBrain → ConversationService / RAGService / LLMService
- **Auth**: Supabase JWT (HS256) via `verify_admin_token` dependency
- **Background Tasks**: FastAPI `BackgroundTasks` for async document processing
- **DB**: PostgreSQL 16 + pgvector, SQLAlchemy 2.0 async, Alembic migrations

### Frontend

- **Route Groups**: `(main)/` 公開頁面, `admin/` 後台管理
- **Auth**: Supabase email/password, AuthGuard component
- **API Client**: 自動帶 Supabase JWT header

### Message Flow

```
Webhook → ChannelAdapter.parse_webhook → AIBrain.handle_message
→ RAG context → LLM reply → ChannelAdapter.send_message
```

## API Endpoints

- `POST /api/v1/webhook/{channel}` — 訊息入口
- `GET/POST/PATCH /api/v1/conversations/*` — 對話管理
- `POST /api/v1/documents/upload` — 文件上傳 (auth required)
- `GET /api/v1/documents` — 文件列表
- `DELETE /api/v1/documents/{id}` — 刪除文件 (auth required)
- `GET /health` — 健康檢查

## 測試

- Backend: pytest + pytest-asyncio, mock DB sessions (no real DB needed)
- `conftest.py` overrides `get_db` and `verify_admin_token` dependencies
- Coverage 目標: >95%

## 部署

- **Frontend**: Vercel (push to main 自動部署)
- **Backend**: Docker image → GHCR (`ghcr.io/nccu95208069/bnb-platform/api`)
- **CI**: ruff + pytest (backend), eslint + build (frontend)
