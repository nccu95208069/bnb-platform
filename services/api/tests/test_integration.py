"""Integration tests for conversation management, RAG pipeline, and human takeover."""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.channels.base import ChannelType
from app.models.conversation import ConversationStatus, MessageRole
from app.services.conversation import ConversationService
from app.services.rag import RAGService

# ---------------------------------------------------------------------------
# ConversationService tests
# ---------------------------------------------------------------------------


class TestConversationServiceGetOrCreate:
    """Tests for get_or_create_conversation."""

    async def test_creates_new_conversation_when_none_exists(self, mock_db_session):
        """Should create a new conversation if no active one exists for the user."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        await service.get_or_create_conversation(
            channel=ChannelType.LINE,
            channel_user_id="Uuser123",
            display_name="Test User",
        )

        # Should have added a new conversation to the session
        mock_db_session.add.assert_called_once()
        added = mock_db_session.add.call_args[0][0]
        assert added.channel == ChannelType.LINE
        assert added.channel_user_id == "Uuser123"
        assert added.display_name == "Test User"
        assert added.status == ConversationStatus.AI
        mock_db_session.flush.assert_awaited_once()

    async def test_returns_existing_conversation(self, mock_db_session):
        """Should return the existing active conversation."""
        existing = MagicMock()
        existing.channel = ChannelType.LINE
        existing.channel_user_id = "Uuser123"
        existing.status = ConversationStatus.AI
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = existing
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        result = await service.get_or_create_conversation(
            channel=ChannelType.LINE,
            channel_user_id="Uuser123",
        )

        assert result is existing
        mock_db_session.add.assert_not_called()


class TestConversationServiceAddMessage:
    """Tests for add_message."""

    async def test_adds_user_message(self, mock_db_session):
        """Should add a user message and flush to get the ID."""
        service = ConversationService(mock_db_session)
        conv_id = uuid.uuid4()

        await service.add_message(conv_id, MessageRole.USER, "Hello!")

        mock_db_session.add.assert_called_once()
        added = mock_db_session.add.call_args[0][0]
        assert added.conversation_id == conv_id
        assert added.role == MessageRole.USER
        assert added.content == "Hello!"
        mock_db_session.flush.assert_awaited_once()

    async def test_adds_assistant_message_with_token_usage(self, mock_db_session):
        """Should store assistant message with LLM model and token count."""
        service = ConversationService(mock_db_session)
        conv_id = uuid.uuid4()

        await service.add_message(
            conv_id,
            MessageRole.ASSISTANT,
            "Welcome!",
            llm_model="claude-sonnet-4-5-20250929",
            token_usage=150,
        )

        added = mock_db_session.add.call_args[0][0]
        assert added.role == MessageRole.ASSISTANT
        assert added.llm_model == "claude-sonnet-4-5-20250929"
        assert added.token_usage == 150


class TestConversationServiceHistory:
    """Tests for get_conversation_history."""

    async def test_returns_formatted_history(self, mock_db_session):
        """Should return messages in LLM-compatible format."""
        msg1 = MagicMock()
        msg1.role = MessageRole.USER
        msg1.content = "Hello"
        msg2 = MagicMock()
        msg2.role = MessageRole.ASSISTANT
        msg2.content = "Hi there"

        # The query returns DESC order; the code reverses them
        mock_result = MagicMock()
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = [msg2, msg1]  # DESC order from DB
        mock_result.scalars.return_value = mock_scalars
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        history = await service.get_conversation_history(uuid.uuid4())

        assert len(history) == 2
        assert history[0] == {"role": "user", "content": "Hello"}
        assert history[1] == {"role": "assistant", "content": "Hi there"}

    async def test_filters_system_messages(self, mock_db_session):
        """System messages should not appear in history."""
        msg1 = MagicMock()
        msg1.role = MessageRole.SYSTEM
        msg1.content = "System init"
        msg2 = MagicMock()
        msg2.role = MessageRole.USER
        msg2.content = "Hello"

        mock_result = MagicMock()
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = [msg1, msg2]
        mock_result.scalars.return_value = mock_scalars
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        history = await service.get_conversation_history(uuid.uuid4())

        assert len(history) == 1
        assert history[0]["content"] == "Hello"

    async def test_owner_messages_mapped_to_user_role(self, mock_db_session):
        """OWNER messages should be mapped to 'user' role in LLM format."""
        msg1 = MagicMock()
        msg1.role = MessageRole.OWNER
        msg1.content = "I'm the owner"

        mock_result = MagicMock()
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = [msg1]
        mock_result.scalars.return_value = mock_scalars
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        history = await service.get_conversation_history(uuid.uuid4())

        assert len(history) == 1
        assert history[0]["role"] == "user"


# ---------------------------------------------------------------------------
# Human takeover flow tests
# ---------------------------------------------------------------------------


class TestHumanTakeover:
    """Tests for the takeover/release flow."""

    async def test_takeover_switches_to_human_mode(self, mock_db_session):
        """Takeover should set conversation status to HUMAN."""
        conv = MagicMock()
        conv.status = ConversationStatus.AI

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = conv
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        result = await service.takeover(uuid.uuid4())

        assert result.status == ConversationStatus.HUMAN
        mock_db_session.flush.assert_awaited()

    async def test_release_switches_back_to_ai_mode(self, mock_db_session):
        """Release should set conversation status back to AI."""
        conv = MagicMock()
        conv.status = ConversationStatus.HUMAN

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = conv
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        result = await service.release(uuid.uuid4())

        assert result.status == ConversationStatus.AI
        mock_db_session.flush.assert_awaited()

    async def test_takeover_raises_for_missing_conversation(self, mock_db_session):
        """Takeover on a nonexistent conversation should raise ValueError."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        with pytest.raises(ValueError, match="not found"):
            await service.takeover(uuid.uuid4())

    async def test_release_raises_for_missing_conversation(self, mock_db_session):
        """Release on a nonexistent conversation should raise ValueError."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        with pytest.raises(ValueError, match="not found"):
            await service.release(uuid.uuid4())

    async def test_is_ai_mode_returns_true_for_ai_conversation(self, mock_db_session):
        """is_ai_mode should return True when status is AI."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = ConversationStatus.AI
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        assert await service.is_ai_mode(uuid.uuid4()) is True

    async def test_is_ai_mode_returns_false_for_human_conversation(self, mock_db_session):
        """is_ai_mode should return False when status is HUMAN."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = ConversationStatus.HUMAN
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        assert await service.is_ai_mode(uuid.uuid4()) is False


# ---------------------------------------------------------------------------
# Conversation listing tests
# ---------------------------------------------------------------------------


class TestConversationListing:
    """Tests for listing and detail views."""

    async def test_list_conversations(self, mock_db_session):
        """list_conversations should return all active conversations."""
        conv1 = MagicMock()
        conv2 = MagicMock()
        mock_result = MagicMock()
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = [conv1, conv2]
        mock_result.scalars.return_value = mock_scalars
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        result = await service.list_conversations()
        assert len(result) == 2

    async def test_list_conversations_filtered_by_status(self, mock_db_session):
        """list_conversations with status filter should query correctly."""
        mock_result = MagicMock()
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = []
        mock_result.scalars.return_value = mock_scalars
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        result = await service.list_conversations(status=ConversationStatus.HUMAN)
        assert result == []
        mock_db_session.execute.assert_awaited_once()

    async def test_get_conversation_detail_returns_none_for_missing(self, mock_db_session):
        """get_conversation_detail should return None if conversation not found."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        service = ConversationService(mock_db_session)
        result = await service.get_conversation_detail(uuid.uuid4())
        assert result is None


# ---------------------------------------------------------------------------
# RAGService text splitting tests
# ---------------------------------------------------------------------------


class TestRAGServiceSplitting:
    """Tests for RAG document chunking."""

    @patch("app.services.rag.settings")
    def test_short_text_returns_single_chunk(self, mock_settings, mock_db_session):
        """Text shorter than chunk_size should return a single chunk."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50

        service = RAGService(mock_db_session)
        chunks = service._split_text("Short text")
        assert len(chunks) == 1
        assert chunks[0] == "Short text"

    @patch("app.services.rag.settings")
    def test_long_text_split_into_overlapping_chunks(self, mock_settings, mock_db_session):
        """Text longer than chunk_size should be split into overlapping chunks."""
        mock_settings.chunk_size = 10
        mock_settings.chunk_overlap = 3

        service = RAGService(mock_db_session)
        text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        chunks = service._split_text(text)

        assert len(chunks) > 1
        # Each chunk (except possibly last) should be at most chunk_size
        for chunk in chunks[:-1]:
            assert len(chunk) <= 10

    @patch("app.services.rag.settings")
    def test_empty_chunks_are_filtered(self, mock_settings, mock_db_session):
        """Empty chunks should be filtered out."""
        mock_settings.chunk_size = 5
        mock_settings.chunk_overlap = 0

        service = RAGService(mock_db_session)
        chunks = service._split_text("Hello")
        assert all(c.strip() for c in chunks)


# ---------------------------------------------------------------------------
# RAGService document operations tests
# ---------------------------------------------------------------------------


class TestRAGServiceDocumentOps:
    """Tests for RAG document ingestion and management."""

    @patch("app.services.rag.settings")
    async def test_ingest_document_creates_chunks(self, mock_settings, mock_db_session):
        """ingest_document should create a Document and its chunks."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50
        mock_settings.openai_api_key = "test-key"
        mock_settings.embedding_model = "text-embedding-3-small"

        service = RAGService(mock_db_session)

        # Mock embedding generation
        service._generate_embeddings = AsyncMock(return_value=[[0.1] * 1536])

        await service.ingest_document(
            filename="test.txt",
            content="Short test content",
            content_type="text/plain",
        )

        # Document should be added
        assert mock_db_session.add.call_count >= 2  # document + at least 1 chunk
        mock_db_session.flush.assert_awaited()

    @patch("app.services.rag.settings")
    async def test_delete_document_returns_true_when_found(self, mock_settings, mock_db_session):
        """delete_document should return True and delete when document exists."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50

        mock_doc = MagicMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_doc
        mock_db_session.execute.return_value = mock_result

        service = RAGService(mock_db_session)
        result = await service.delete_document(uuid.uuid4())

        assert result is True
        mock_db_session.delete.assert_awaited_once_with(mock_doc)
        mock_db_session.flush.assert_awaited()

    @patch("app.services.rag.settings")
    async def test_delete_document_returns_false_when_not_found(
        self, mock_settings, mock_db_session
    ):
        """delete_document should return False when document doesn't exist."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        service = RAGService(mock_db_session)
        result = await service.delete_document(uuid.uuid4())

        assert result is False
        mock_db_session.delete.assert_not_awaited()

    @patch("app.services.rag.settings")
    async def test_list_documents(self, mock_settings, mock_db_session):
        """list_documents should return all documents."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50

        doc1 = MagicMock()
        doc2 = MagicMock()
        mock_result = MagicMock()
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = [doc1, doc2]
        mock_result.scalars.return_value = mock_scalars
        mock_db_session.execute.return_value = mock_result

        service = RAGService(mock_db_session)
        result = await service.list_documents()
        assert len(result) == 2


# ---------------------------------------------------------------------------
# RAGService context building tests
# ---------------------------------------------------------------------------


class TestRAGServiceContextBuilding:
    """Tests for RAG context building for LLM."""

    @patch("app.services.rag.settings")
    async def test_build_context_returns_empty_when_no_chunks(self, mock_settings, mock_db_session):
        """build_context should return empty string when no relevant chunks found."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50

        service = RAGService(mock_db_session)
        service.search = AsyncMock(return_value=[])

        result = await service.build_context("any query")
        assert result == ""

    @patch("app.services.rag.settings")
    async def test_build_context_formats_chunks(self, mock_settings, mock_db_session):
        """build_context should format chunks with numbered labels."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50

        chunk1 = MagicMock()
        chunk1.content = "Room A is available."
        chunk2 = MagicMock()
        chunk2.content = "Checkout is at 11 AM."

        service = RAGService(mock_db_session)
        service.search = AsyncMock(return_value=[chunk1, chunk2])

        result = await service.build_context("What rooms are available?")
        assert "[資料 1]" in result
        assert "Room A is available." in result
        assert "[資料 2]" in result
        assert "Checkout is at 11 AM." in result


# ---------------------------------------------------------------------------
# RAGService embedding generation tests
# ---------------------------------------------------------------------------


class TestRAGServiceEmbeddings:
    """Tests for embedding generation."""

    @patch("app.services.rag.settings")
    @patch("app.services.rag.httpx.AsyncClient")
    async def test_generate_embeddings_calls_api(
        self, MockHttpClient, mock_settings, mock_db_session
    ):
        """_generate_embeddings should call the OpenAI embeddings API."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50
        mock_settings.openai_api_key = "test-key"
        mock_settings.embedding_model = "text-embedding-3-small"

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "data": [
                {"embedding": [0.1] * 1536},
                {"embedding": [0.2] * 1536},
            ]
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockHttpClient.return_value = mock_client

        service = RAGService(mock_db_session)
        result = await service._generate_embeddings(["text1", "text2"])

        assert len(result) == 2
        assert len(result[0]) == 1536
        mock_client.post.assert_awaited_once()

    @patch("app.services.rag.settings")
    @patch("app.services.rag.httpx.AsyncClient")
    async def test_generate_embeddings_propagates_http_errors(
        self, MockHttpClient, mock_settings, mock_db_session
    ):
        """HTTP errors from the embedding API should propagate."""
        mock_settings.chunk_size = 512
        mock_settings.chunk_overlap = 50
        mock_settings.openai_api_key = "test-key"
        mock_settings.embedding_model = "text-embedding-3-small"

        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = Exception("API error")

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockHttpClient.return_value = mock_client

        service = RAGService(mock_db_session)
        with pytest.raises(Exception, match="API error"):
            await service._generate_embeddings(["text"])


# ---------------------------------------------------------------------------
# Full conversation flow (end-to-end mock test)
# ---------------------------------------------------------------------------


class TestFullConversationFlow:
    """End-to-end flow tests simulating a full conversation cycle via AIBrain."""

    @patch("app.services.ai_brain.RAGService")
    @patch("app.services.ai_brain.llm_service")
    @patch("app.services.ai_brain.ConversationService")
    async def test_full_ai_conversation_flow(
        self,
        MockConvService,
        mock_llm,
        MockRAG,
        mock_db_session,
    ):
        """Simulate: user sends message -> RAG context built -> LLM responds -> reply returned."""
        from app.channels.base import ChannelType, IncomingMessage
        from app.services.ai_brain import AIBrain
        from tests.conftest import make_conversation

        conv = make_conversation()
        mock_conv = AsyncMock()
        mock_conv.get_or_create_conversation.return_value = conv
        mock_conv.add_message.return_value = MagicMock()
        mock_conv.is_ai_mode.return_value = True
        mock_conv.get_conversation_history.return_value = [
            {"role": "user", "content": "What rooms are available?"}
        ]
        MockConvService.return_value = mock_conv

        mock_rag = AsyncMock()
        mock_rag.build_context.return_value = "[資料 1]\nRoom A: 2000/night, available"
        MockRAG.return_value = mock_rag

        llm_resp = MagicMock()
        llm_resp.content = "We have Room A available at 2000/night!"
        llm_resp.model = "claude-sonnet-4-5-20250929"
        llm_resp.input_tokens = 200
        llm_resp.output_tokens = 50
        mock_llm.generate = AsyncMock(return_value=llm_resp)

        brain = AIBrain(mock_db_session)
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="Uguest001",
            text="What rooms are available?",
            message_type="text",
            reply_token="reply-token-flow",
        )
        result = await brain.handle_message(incoming)

        # Verify the full flow
        mock_conv.get_or_create_conversation.assert_awaited_once()
        mock_conv.add_message.assert_any_await(
            conv.id, MessageRole.USER, "What rooms are available?"
        )
        mock_rag.build_context.assert_awaited_once_with("What rooms are available?")
        mock_llm.generate.assert_awaited_once()
        assert result is not None
        assert result.text == "We have Room A available at 2000/night!"
        assert result.reply_token == "reply-token-flow"

    @patch("app.services.ai_brain.ConversationService")
    async def test_human_takeover_flow(
        self,
        MockConvService,
        mock_db_session,
    ):
        """Simulate: AI mode -> takeover -> message stored without auto-reply."""
        from app.channels.base import ChannelType, IncomingMessage
        from app.services.ai_brain import AIBrain
        from tests.conftest import make_conversation

        conv = make_conversation(status=ConversationStatus.HUMAN)
        mock_conv = AsyncMock()
        mock_conv.get_or_create_conversation.return_value = conv
        mock_conv.add_message.return_value = MagicMock()
        mock_conv.is_ai_mode.return_value = False
        MockConvService.return_value = mock_conv

        brain = AIBrain(mock_db_session)
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="Uguest002",
            text="I need help with my booking",
            message_type="text",
        )
        result = await brain.handle_message(incoming)

        # Message stored but no reply returned
        mock_conv.add_message.assert_awaited_once()
        assert result is None
