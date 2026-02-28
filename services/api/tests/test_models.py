"""Tests for SQLAlchemy models (schema validation only, no DB required)."""

from app.models.conversation import Conversation, ConversationStatus, Message, MessageRole
from app.models.document import Document, DocumentChunk


class TestConversationModel:
    """Tests for the Conversation model."""

    def test_conversation_status_values(self):
        """ConversationStatus enum should have AI and HUMAN values."""
        assert ConversationStatus.AI.value == "ai"
        assert ConversationStatus.HUMAN.value == "human"

    def test_message_role_values(self):
        """MessageRole enum should have all expected values."""
        assert MessageRole.USER.value == "user"
        assert MessageRole.ASSISTANT.value == "assistant"
        assert MessageRole.SYSTEM.value == "system"
        assert MessageRole.OWNER.value == "owner"

    def test_conversation_tablename(self):
        """Conversation model should map to 'conversations' table."""
        assert Conversation.__tablename__ == "conversations"

    def test_message_tablename(self):
        """Message model should map to 'messages' table."""
        assert Message.__tablename__ == "messages"


class TestDocumentModel:
    """Tests for the Document model."""

    def test_document_tablename(self):
        """Document model should map to 'documents' table."""
        assert Document.__tablename__ == "documents"

    def test_document_chunk_tablename(self):
        """DocumentChunk model should map to 'document_chunks' table."""
        assert DocumentChunk.__tablename__ == "document_chunks"
