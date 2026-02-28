"""Tests for API endpoints: conversations, documents, and owner messaging."""

import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

from httpx import AsyncClient

from app.models.conversation import ConversationStatus, MessageRole
from tests.conftest import make_conversation, make_message

# ---------------------------------------------------------------------------
# Conversation List: GET /api/v1/conversations
# ---------------------------------------------------------------------------


class TestListConversations:
    """Tests for GET /api/v1/conversations."""

    async def test_list_conversations_empty(self, client: AsyncClient, mock_db_session):
        """Should return empty list when no conversations exist."""
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_db_session.execute.return_value = mock_result

        response = await client.get("/api/v1/conversations")
        assert response.status_code == 200
        assert response.json() == []

    async def test_list_conversations_returns_data(self, client: AsyncClient, mock_db_session):
        """Should return conversations when they exist."""
        conv = make_conversation(status=ConversationStatus.AI)
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [conv]
        mock_db_session.execute.return_value = mock_result

        response = await client.get("/api/v1/conversations")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["channel_user_id"] == conv.channel_user_id
        assert data[0]["status"] == "ai"

    async def test_list_conversations_filter_by_status(self, client: AsyncClient, mock_db_session):
        """Should accept status query parameter."""
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_db_session.execute.return_value = mock_result

        response = await client.get("/api/v1/conversations?status=human")
        assert response.status_code == 200

    async def test_list_conversations_invalid_status(self, client: AsyncClient):
        """Should return 422 for invalid status value."""
        response = await client.get("/api/v1/conversations?status=invalid")
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Conversation Detail: GET /api/v1/conversations/{id}
# ---------------------------------------------------------------------------


class TestGetConversation:
    """Tests for GET /api/v1/conversations/{id}."""

    async def test_get_conversation_found(self, client: AsyncClient, mock_db_session):
        """Should return conversation with messages when found."""
        conv_id = uuid.uuid4()
        conv = make_conversation(id=conv_id, status=ConversationStatus.AI)
        msg = make_message(conversation_id=conv_id, role=MessageRole.USER, content="Hi")
        conv.messages = [msg]

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = conv
        mock_db_session.execute.return_value = mock_result

        response = await client.get(f"/api/v1/conversations/{conv_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(conv_id)
        assert data["status"] == "ai"
        assert len(data["messages"]) == 1
        assert data["messages"][0]["content"] == "Hi"

    async def test_get_conversation_not_found(self, client: AsyncClient, mock_db_session):
        """Should return 404 when conversation does not exist."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        fake_id = uuid.uuid4()
        response = await client.get(f"/api/v1/conversations/{fake_id}")
        assert response.status_code == 404
        assert response.json()["detail"] == "Conversation not found"

    async def test_get_conversation_invalid_uuid(self, client: AsyncClient):
        """Should return 422 for invalid UUID format."""
        response = await client.get("/api/v1/conversations/not-a-uuid")
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Takeover: POST /api/v1/conversations/{id}/takeover
# ---------------------------------------------------------------------------


class TestTakeoverConversation:
    """Tests for POST /api/v1/conversations/{id}/takeover."""

    async def test_takeover_success(self, client: AsyncClient, mock_db_session):
        """Should switch conversation to HUMAN mode."""
        conv_id = uuid.uuid4()
        conv = make_conversation(id=conv_id, status=ConversationStatus.HUMAN)

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = conv
        mock_db_session.execute.return_value = mock_result

        response = await client.post(f"/api/v1/conversations/{conv_id}/takeover")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(conv_id)

    async def test_takeover_not_found(self, client: AsyncClient, mock_db_session):
        """Should return 404 when conversation does not exist."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        fake_id = uuid.uuid4()
        response = await client.post(f"/api/v1/conversations/{fake_id}/takeover")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Release: POST /api/v1/conversations/{id}/release
# ---------------------------------------------------------------------------


class TestReleaseConversation:
    """Tests for POST /api/v1/conversations/{id}/release."""

    async def test_release_success(self, client: AsyncClient, mock_db_session):
        """Should switch conversation back to AI mode."""
        conv_id = uuid.uuid4()
        conv = make_conversation(id=conv_id, status=ConversationStatus.AI)

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = conv
        mock_db_session.execute.return_value = mock_result

        response = await client.post(f"/api/v1/conversations/{conv_id}/release")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == str(conv_id)

    async def test_release_not_found(self, client: AsyncClient, mock_db_session):
        """Should return 404 when conversation does not exist."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        fake_id = uuid.uuid4()
        response = await client.post(f"/api/v1/conversations/{fake_id}/release")
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Send Owner Message: POST /api/v1/conversations/{id}/messages
# ---------------------------------------------------------------------------


class TestSendOwnerMessage:
    """Tests for POST /api/v1/conversations/{id}/messages."""

    @patch("app.api.endpoints.conversations.AIBrain")
    @patch("app.api.endpoints.conversations.ConversationService")
    async def test_send_message_success(
        self, MockConvService, MockBrain, client: AsyncClient, mock_db_session
    ):
        """Should store message and send via channel adapter when in HUMAN mode."""
        conv_id = uuid.uuid4()
        conv = make_conversation(id=conv_id, status=ConversationStatus.HUMAN)
        msg = make_message(
            conversation_id=conv_id,
            role=MessageRole.OWNER,
            content="We have rooms available.",
        )

        mock_svc = AsyncMock()
        mock_svc.get_conversation_detail.return_value = conv
        mock_svc.add_message.return_value = msg
        MockConvService.return_value = mock_svc

        mock_brain = AsyncMock()
        mock_brain.send_owner_message = AsyncMock()
        MockBrain.return_value = mock_brain

        response = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"content": "We have rooms available."},
        )

        assert response.status_code == 200

    async def test_send_message_not_found(self, client: AsyncClient, mock_db_session):
        """Should return 404 when conversation does not exist."""
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db_session.execute.return_value = mock_result

        fake_id = uuid.uuid4()
        response = await client.post(
            f"/api/v1/conversations/{fake_id}/messages",
            json={"content": "Hello"},
        )
        assert response.status_code == 404

    async def test_send_message_not_human_mode(self, client: AsyncClient, mock_db_session):
        """Should return 400 when conversation is not in HUMAN mode."""
        conv_id = uuid.uuid4()
        conv = make_conversation(id=conv_id, status=ConversationStatus.AI)

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = conv
        mock_db_session.execute.return_value = mock_result

        response = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"content": "Hello"},
        )
        assert response.status_code == 400
        assert "HUMAN mode" in response.json()["detail"]

    async def test_send_message_empty_content(self, client: AsyncClient, mock_db_session):
        """Should validate that content is provided."""
        conv_id = uuid.uuid4()
        response = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Document Upload: POST /api/v1/documents/upload
# ---------------------------------------------------------------------------


class TestUploadDocument:
    """Tests for POST /api/v1/documents/upload."""

    @patch("app.api.endpoints.documents._process_document_task", new_callable=AsyncMock)
    @patch("app.api.endpoints.documents.RAGService")
    async def test_upload_txt_success(
        self, mock_rag_cls, _mock_process, client: AsyncClient, mock_db_session
    ):
        """Should accept and process a TXT file."""
        doc_mock = MagicMock()
        doc_mock.id = uuid.uuid4()
        doc_mock.filename = "test.txt"
        doc_mock.content_type = "text/plain"
        doc_mock.chunk_count = 1
        doc_mock.status = "pending"
        doc_mock.error_message = None
        doc_mock.created_at = datetime.now(tz=UTC)

        mock_rag = AsyncMock()
        mock_rag.create_document.return_value = doc_mock
        mock_rag_cls.return_value = mock_rag

        response = await client.post(
            "/api/v1/documents/upload",
            files={"files": ("test.txt", b"Hello world content", "text/plain")},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["filename"] == "test.txt"
        assert data[0]["status"] == "pending"

    async def test_upload_unsupported_type(self, client: AsyncClient):
        """Should reject unsupported file types with 400."""
        response = await client.post(
            "/api/v1/documents/upload",
            files={"files": ("test.jpg", b"image data", "image/jpeg")},
        )
        assert response.status_code == 400
        assert "Unsupported file type" in response.json()["detail"]

    @patch("app.api.endpoints.documents.RAGService")
    async def test_upload_empty_file(self, mock_rag_cls, client: AsyncClient, mock_db_session):
        """Should reject files with no extractable text."""
        response = await client.post(
            "/api/v1/documents/upload",
            files={"files": ("empty.txt", b"", "text/plain")},
        )
        assert response.status_code == 400
        assert "no extractable text" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Document List: GET /api/v1/documents
# ---------------------------------------------------------------------------


class TestListDocuments:
    """Tests for GET /api/v1/documents."""

    @patch("app.api.endpoints.documents.RAGService")
    async def test_list_documents_empty(self, mock_rag_cls, client: AsyncClient, mock_db_session):
        """Should return empty list when no documents exist."""
        mock_rag = AsyncMock()
        mock_rag.list_documents.return_value = []
        mock_rag_cls.return_value = mock_rag

        response = await client.get("/api/v1/documents")
        assert response.status_code == 200
        assert response.json() == []

    @patch("app.api.endpoints.documents.RAGService")
    async def test_list_documents_returns_data(
        self, mock_rag_cls, client: AsyncClient, mock_db_session
    ):
        """Should return documents when they exist."""
        doc = MagicMock()
        doc.id = uuid.uuid4()
        doc.filename = "info.txt"
        doc.content_type = "text/plain"
        doc.chunk_count = 3
        doc.status = "completed"
        doc.error_message = None
        doc.created_at = datetime.now(tz=UTC)

        mock_rag = AsyncMock()
        mock_rag.list_documents.return_value = [doc]
        mock_rag_cls.return_value = mock_rag

        response = await client.get("/api/v1/documents")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["filename"] == "info.txt"


# ---------------------------------------------------------------------------
# Document Delete: DELETE /api/v1/documents/{id}
# ---------------------------------------------------------------------------


class TestDeleteDocument:
    """Tests for DELETE /api/v1/documents/{id}."""

    @patch("app.api.endpoints.documents.RAGService")
    async def test_delete_success(self, mock_rag_cls, client: AsyncClient, mock_db_session):
        """Should return success when document is deleted."""
        mock_rag = AsyncMock()
        mock_rag.delete_document.return_value = True
        mock_rag_cls.return_value = mock_rag

        doc_id = uuid.uuid4()
        response = await client.delete(f"/api/v1/documents/{doc_id}")
        assert response.status_code == 200
        assert response.json() == {"status": "deleted"}

    @patch("app.api.endpoints.documents.RAGService")
    async def test_delete_not_found(self, mock_rag_cls, client: AsyncClient, mock_db_session):
        """Should return 404 when document does not exist."""
        mock_rag = AsyncMock()
        mock_rag.delete_document.return_value = False
        mock_rag_cls.return_value = mock_rag

        doc_id = uuid.uuid4()
        response = await client.delete(f"/api/v1/documents/{doc_id}")
        assert response.status_code == 404
        assert response.json()["detail"] == "Document not found"

    async def test_delete_invalid_uuid(self, client: AsyncClient):
        """Should return 422 for invalid UUID format."""
        response = await client.delete("/api/v1/documents/not-a-uuid")
        assert response.status_code == 422
