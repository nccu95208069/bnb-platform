"""Shared test fixtures and configuration."""

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.channels.base import ChannelType
from app.core.auth import verify_admin_token
from app.core.database import get_db
from app.models.conversation import Conversation, ConversationStatus, Message, MessageRole

# ---------------------------------------------------------------------------
# Database fixtures (mock-based, no aiosqlite required)
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_db_session():
    """Provide a mock async database session.

    This avoids needing aiosqlite or a real PostgreSQL for unit tests.
    Integration tests requiring a real DB should use testcontainers.
    """
    session = AsyncMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    session.close = AsyncMock()
    session.flush = AsyncMock()
    session.add = MagicMock()
    session.add_all = MagicMock()
    session.delete = AsyncMock()
    session.get = AsyncMock(return_value=None)
    session.execute = AsyncMock()
    session.refresh = AsyncMock()

    # Support async context manager usage
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=False)

    return session


# ---------------------------------------------------------------------------
# FastAPI app / TestClient fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def app(mock_db_session):
    """Create a FastAPI app with test database override."""
    with patch("app.core.config.settings") as mock_settings:
        mock_settings.is_production = False
        mock_settings.app_env = "testing"
        mock_settings.app_debug = False
        mock_settings.line_channel_secret = "test-channel-secret"
        mock_settings.line_channel_access_token = "test-access-token"
        mock_settings.has_line_channel = True
        mock_settings.has_any_channel = True
        mock_settings.anthropic_api_key = "test-anthropic-key"
        mock_settings.anthropic_model = "claude-sonnet-4-5-20250929"
        mock_settings.google_gemini_api_key = "test-gemini-key"
        mock_settings.gemini_model = "gemini-2.0-flash"
        mock_settings.embedding_model = "text-embedding-3-small"
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50
        mock_settings.database_url = "sqlite+aiosqlite://"

        from app.main import create_app

        test_app = create_app()

        async def _override_get_db() -> AsyncGenerator[None, None]:
            yield mock_db_session

        test_app.dependency_overrides[get_db] = _override_get_db
        test_app.dependency_overrides[verify_admin_token] = lambda: {"sub": "test-admin"}

        yield test_app

        test_app.dependency_overrides.clear()


@pytest.fixture()
async def client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client for testing FastAPI endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


# ---------------------------------------------------------------------------
# Mock external service fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def mock_line_api():
    """Mock LINE Messaging API client."""
    mock = MagicMock()
    mock.reply_message = AsyncMock(return_value=None)
    mock.push_message = AsyncMock(return_value=None)
    mock.get_profile = AsyncMock(
        return_value=MagicMock(
            display_name="Test User",
            user_id="U1234567890abcdef",
            picture_url="https://example.com/avatar.png",
        )
    )
    return mock


@pytest.fixture()
def mock_anthropic_client():
    """Mock Anthropic (Claude) API client."""
    mock = MagicMock()

    mock_response = MagicMock()
    mock_response.content = [MagicMock(text="This is a test response from Claude.")]
    mock_response.usage = MagicMock(input_tokens=100, output_tokens=50)
    mock_response.model = "claude-sonnet-4-5-20250929"

    mock.messages = MagicMock()
    mock.messages.create = AsyncMock(return_value=mock_response)

    return mock


@pytest.fixture()
def mock_gemini_client():
    """Mock Google Gen AI client."""
    mock = MagicMock()

    mock_response = MagicMock()
    mock_response.text = "This is a test response from Gemini."
    mock_response.usage_metadata = MagicMock(
        prompt_token_count=80,
        candidates_token_count=40,
    )

    mock.aio.models.generate_content = AsyncMock(return_value=mock_response)

    return mock


@pytest.fixture()
def mock_google_calendar():
    """Mock Google Calendar API client."""
    mock = MagicMock()
    mock.events = MagicMock(return_value=mock)
    mock.list = MagicMock(return_value=mock)
    mock.execute = MagicMock(
        return_value={
            "items": [
                {
                    "id": "event-123",
                    "summary": "Test Booking",
                    "start": {"dateTime": "2025-06-01T14:00:00+08:00"},
                    "end": {"dateTime": "2025-06-01T15:00:00+08:00"},
                }
            ]
        }
    )
    return mock


@pytest.fixture()
def mock_google_sheets():
    """Mock Google Sheets API client."""
    mock = MagicMock()
    mock.spreadsheets = MagicMock(return_value=mock)
    mock.values = MagicMock(return_value=mock)
    mock.get = MagicMock(return_value=mock)
    mock.execute = MagicMock(
        return_value={
            "values": [
                ["Room", "Price", "Available"],
                ["Room A", "2000", "Yes"],
                ["Room B", "3000", "No"],
            ]
        }
    )
    return mock


# ---------------------------------------------------------------------------
# Sample data factories
# ---------------------------------------------------------------------------


def make_conversation(
    *,
    id: uuid.UUID | None = None,
    channel: ChannelType = ChannelType.LINE,
    channel_user_id: str = "U1234567890abcdef",
    display_name: str = "Test User",
    status: ConversationStatus = ConversationStatus.AI,
    is_active: bool = True,
) -> MagicMock:
    """Build a mock Conversation object (not a real ORM instance)."""
    conv = MagicMock()
    conv.id = id or uuid.uuid4()
    conv.channel = channel
    conv.channel_user_id = channel_user_id
    conv.display_name = display_name
    conv.status = status
    conv.is_active = is_active
    conv.last_message_at = datetime.now(tz=UTC)
    conv.created_at = datetime.now(tz=UTC)
    conv.updated_at = datetime.now(tz=UTC)
    conv.messages = []
    return conv


def make_message(
    *,
    conversation_id: uuid.UUID,
    role: MessageRole = MessageRole.USER,
    content: str = "Hello",
    llm_model: str | None = None,
    token_usage: int | None = None,
) -> MagicMock:
    """Build a mock Message object (not a real ORM instance)."""
    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.conversation_id = conversation_id
    msg.role = role
    msg.content = content
    msg.llm_model = llm_model
    msg.token_usage = token_usage
    msg.created_at = datetime.now(tz=UTC)
    msg.updated_at = datetime.now(tz=UTC)
    return msg


@pytest.fixture()
def sample_conversation_id() -> uuid.UUID:
    """Return a fixed UUID for testing."""
    return uuid.UUID("12345678-1234-5678-1234-567812345678")


@pytest.fixture()
def sample_conversation(sample_conversation_id) -> Conversation:
    """Return a sample conversation object."""
    return make_conversation(id=sample_conversation_id)


@pytest.fixture()
def sample_messages(sample_conversation) -> list[Message]:
    """Return sample messages for a conversation."""
    return [
        make_message(
            conversation_id=sample_conversation.id,
            role=MessageRole.USER,
            content="Hello, I want to book a room.",
        ),
        make_message(
            conversation_id=sample_conversation.id,
            role=MessageRole.ASSISTANT,
            content="Welcome! Let me help you with booking.",
            llm_model="claude-sonnet-4-5-20250929",
            token_usage=150,
        ),
    ]


# ---------------------------------------------------------------------------
# LINE webhook event fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def line_text_message_event() -> dict:
    """Return a LINE text message webhook event payload."""
    return {
        "destination": "U1234567890abcdef",
        "events": [
            {
                "type": "message",
                "message": {
                    "type": "text",
                    "id": "msg-001",
                    "text": "Hello, I want to book a room.",
                },
                "timestamp": int(datetime.now(tz=UTC).timestamp() * 1000),
                "source": {
                    "type": "user",
                    "userId": "U1234567890abcdef",
                },
                "replyToken": "test-reply-token-001",
                "mode": "active",
            }
        ],
    }


@pytest.fixture()
def line_follow_event() -> dict:
    """Return a LINE follow (friend add) webhook event payload."""
    return {
        "destination": "U1234567890abcdef",
        "events": [
            {
                "type": "follow",
                "timestamp": int(datetime.now(tz=UTC).timestamp() * 1000),
                "source": {
                    "type": "user",
                    "userId": "Unewuser999",
                },
                "replyToken": "test-reply-token-002",
                "mode": "active",
            }
        ],
    }


@pytest.fixture()
def line_unfollow_event() -> dict:
    """Return a LINE unfollow event payload."""
    return {
        "destination": "U1234567890abcdef",
        "events": [
            {
                "type": "unfollow",
                "timestamp": int(datetime.now(tz=UTC).timestamp() * 1000),
                "source": {
                    "type": "user",
                    "userId": "U1234567890abcdef",
                },
                "mode": "active",
            }
        ],
    }
