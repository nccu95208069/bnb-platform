"""Tests for the AI Brain service."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.channels.base import ChannelType, IncomingMessage, OutgoingMessage
from app.models.conversation import ConversationStatus, MessageRole
from app.services.ai_brain import AIBrain
from tests.conftest import make_conversation


@pytest.fixture()
def brain(mock_db_session):
    """Create an AIBrain instance with a mocked DB session."""
    return AIBrain(mock_db_session)


# ---------------------------------------------------------------------------
# handle_message tests
# ---------------------------------------------------------------------------


class TestHandleMessage:
    """Tests for AIBrain.handle_message() routing."""

    @patch.object(AIBrain, "_handle_text", new_callable=AsyncMock)
    async def test_routes_text_message(self, mock_handle_text, brain):
        """Text messages should be routed to _handle_text."""
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Hello",
            message_type="text",
        )
        mock_handle_text.return_value = None
        await brain.handle_message(incoming)
        mock_handle_text.assert_awaited_once_with(incoming)

    async def test_image_message_returns_reply(self, brain):
        """Image messages should return a polite text-only notice."""
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            message_type="image",
            reply_token="token-1",
        )
        result = await brain.handle_message(incoming)
        assert result is not None
        assert "圖片" in result.text
        assert result.reply_token == "token-1"

    async def test_sticker_message_returns_reply(self, brain):
        """Sticker messages should return a friendly help prompt."""
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            message_type="sticker",
            reply_token="token-1",
        )
        result = await brain.handle_message(incoming)
        assert result is not None
        assert "貼圖" in result.text

    @patch.object(AIBrain, "_handle_follow", new_callable=AsyncMock)
    async def test_routes_follow_message(self, mock_handle_follow, brain):
        """Follow messages should be routed to _handle_follow."""
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            message_type="follow",
        )
        mock_handle_follow.return_value = None
        await brain.handle_message(incoming)
        mock_handle_follow.assert_awaited_once_with(incoming)

    async def test_unfollow_returns_none(self, brain):
        """Unfollow messages should return None (no reply)."""
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            message_type="unfollow",
        )
        result = await brain.handle_message(incoming)
        assert result is None

    async def test_unsupported_type_returns_none(self, brain):
        """Unsupported message types should return None."""
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            message_type="video",
        )
        result = await brain.handle_message(incoming)
        assert result is None


# ---------------------------------------------------------------------------
# _handle_text tests
# ---------------------------------------------------------------------------


class TestHandleText:
    """Tests for text message handling with LLM and RAG."""

    @patch("app.services.ai_brain.RAGService")
    @patch("app.services.ai_brain.llm_service")
    @patch("app.services.ai_brain.ConversationService")
    async def test_ai_mode_triggers_llm(
        self, MockConvService, mock_llm, MockRAG, mock_db_session
    ):
        """In AI mode, text should trigger LLM generation and return reply."""
        conv = make_conversation()
        mock_conv = AsyncMock()
        mock_conv.get_or_create_conversation.return_value = conv
        mock_conv.add_message.return_value = MagicMock()
        mock_conv.is_ai_mode.return_value = True
        mock_conv.get_conversation_history.return_value = [
            {"role": "user", "content": "Hello"}
        ]
        MockConvService.return_value = mock_conv

        mock_rag = AsyncMock()
        mock_rag.build_context.return_value = ""
        MockRAG.return_value = mock_rag

        llm_response = MagicMock()
        llm_response.content = "Hi! How can I help?"
        llm_response.model = "claude-sonnet-4-5-20250929"
        llm_response.input_tokens = 50
        llm_response.output_tokens = 20
        mock_llm.generate = AsyncMock(return_value=llm_response)

        brain = AIBrain(mock_db_session)
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Hello",
            message_type="text",
            reply_token="token-1",
        )
        result = await brain.handle_message(incoming)

        assert result is not None
        assert result.text == "Hi! How can I help?"
        assert result.reply_token == "token-1"
        mock_conv.add_message.assert_any_await(conv.id, MessageRole.USER, "Hello")
        mock_llm.generate.assert_awaited_once()
        assert mock_conv.add_message.await_count == 2

    @patch("app.services.ai_brain.RAGService")
    @patch("app.services.ai_brain.llm_service")
    @patch("app.services.ai_brain.ConversationService")
    async def test_human_mode_no_auto_reply(
        self, MockConvService, mock_llm, MockRAG, mock_db_session
    ):
        """In HUMAN mode, text should be stored but not auto-replied."""
        conv = make_conversation(status=ConversationStatus.HUMAN)
        mock_conv = AsyncMock()
        mock_conv.get_or_create_conversation.return_value = conv
        mock_conv.add_message.return_value = MagicMock()
        mock_conv.is_ai_mode.return_value = False
        MockConvService.return_value = mock_conv

        brain = AIBrain(mock_db_session)
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Help me",
            message_type="text",
        )
        result = await brain.handle_message(incoming)

        assert result is None
        mock_conv.add_message.assert_awaited_once()
        mock_llm.generate.assert_not_called()

    @patch("app.services.ai_brain.RAGService")
    @patch("app.services.ai_brain.llm_service")
    @patch("app.services.ai_brain.ConversationService")
    async def test_llm_failure_sends_fallback(
        self, MockConvService, mock_llm, MockRAG, mock_db_session
    ):
        """When LLM fails, a fallback error message should be returned."""
        conv = make_conversation()
        mock_conv = AsyncMock()
        mock_conv.get_or_create_conversation.return_value = conv
        mock_conv.add_message.return_value = MagicMock()
        mock_conv.is_ai_mode.return_value = True
        mock_conv.get_conversation_history.return_value = [
            {"role": "user", "content": "Hi"}
        ]
        MockConvService.return_value = mock_conv

        mock_rag = AsyncMock()
        mock_rag.build_context.return_value = ""
        MockRAG.return_value = mock_rag

        mock_llm.generate = AsyncMock(side_effect=RuntimeError("All providers failed"))

        brain = AIBrain(mock_db_session)
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Hi",
            message_type="text",
            reply_token="token-1",
        )
        result = await brain.handle_message(incoming)

        assert result is not None
        assert "抱歉" in result.text

    @patch("app.services.ai_brain.RAGService")
    @patch("app.services.ai_brain.llm_service")
    @patch("app.services.ai_brain.ConversationService")
    async def test_rag_context_appended_to_system_prompt(
        self, MockConvService, mock_llm, MockRAG, mock_db_session
    ):
        """When RAG returns context, it should be in the system prompt."""
        conv = make_conversation()
        mock_conv = AsyncMock()
        mock_conv.get_or_create_conversation.return_value = conv
        mock_conv.add_message.return_value = MagicMock()
        mock_conv.is_ai_mode.return_value = True
        mock_conv.get_conversation_history.return_value = [
            {"role": "user", "content": "What rooms?"}
        ]
        MockConvService.return_value = mock_conv

        mock_rag = AsyncMock()
        mock_rag.build_context.return_value = "[資料 1]\nRoom A is available."
        MockRAG.return_value = mock_rag

        llm_response = MagicMock()
        llm_response.content = "Room A is available!"
        llm_response.model = "claude-sonnet-4-5-20250929"
        llm_response.input_tokens = 100
        llm_response.output_tokens = 30
        mock_llm.generate = AsyncMock(return_value=llm_response)

        brain = AIBrain(mock_db_session)
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="What rooms?",
            message_type="text",
            reply_token="token-1",
        )
        await brain.handle_message(incoming)

        call_kwargs = mock_llm.generate.call_args[1]
        assert "相關的民宿資料" in call_kwargs["system_prompt"]
        assert "Room A is available" in call_kwargs["system_prompt"]


# ---------------------------------------------------------------------------
# _handle_follow tests
# ---------------------------------------------------------------------------


class TestHandleFollow:
    """Tests for follow event handling."""

    @patch("app.services.ai_brain.ConversationService")
    async def test_follow_creates_conversation_and_sends_welcome(
        self, MockConvService, mock_db_session
    ):
        """Follow should create conversation and return welcome message."""
        mock_conv = AsyncMock()
        mock_conv.get_or_create_conversation.return_value = make_conversation()
        MockConvService.return_value = mock_conv

        brain = AIBrain(mock_db_session)
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="Unew123",
            message_type="follow",
            reply_token="follow-token",
        )
        result = await brain.handle_message(incoming)

        assert result is not None
        assert "歡迎" in result.text
        assert result.reply_token == "follow-token"
        mock_conv.get_or_create_conversation.assert_awaited_once()


# ---------------------------------------------------------------------------
# send_owner_message tests
# ---------------------------------------------------------------------------


class TestSendOwnerMessage:
    """Tests for sending owner messages through channel adapters."""

    @patch("app.services.ai_brain.get_adapter")
    @patch("app.services.ai_brain.ConversationService")
    async def test_sends_via_correct_adapter(
        self, MockConvService, mock_get_adapter, mock_db_session
    ):
        """Owner message should be sent via the conversation's channel adapter."""
        conv = make_conversation(
            channel=ChannelType.LINE,
            channel_user_id="U123",
        )
        mock_conv = AsyncMock()
        mock_conv.get_conversation_detail.return_value = conv
        MockConvService.return_value = mock_conv

        mock_adapter = AsyncMock()
        mock_get_adapter.return_value = mock_adapter

        brain = AIBrain(mock_db_session)
        await brain.send_owner_message(conv.id, "Hello from owner")

        mock_get_adapter.assert_called_once_with(ChannelType.LINE)
        mock_adapter.send_message.assert_awaited_once()
        sent_msg = mock_adapter.send_message.call_args[0][0]
        assert sent_msg.text == "Hello from owner"
        assert sent_msg.channel_user_id == "U123"

    @patch("app.services.ai_brain.ConversationService")
    async def test_raises_for_missing_conversation(
        self, MockConvService, mock_db_session
    ):
        """Should raise ValueError if conversation not found."""
        mock_conv = AsyncMock()
        mock_conv.get_conversation_detail.return_value = None
        MockConvService.return_value = mock_conv

        brain = AIBrain(mock_db_session)
        with pytest.raises(ValueError, match="not found"):
            await brain.send_owner_message(
                "12345678-1234-5678-1234-567812345678", "Hello"
            )
