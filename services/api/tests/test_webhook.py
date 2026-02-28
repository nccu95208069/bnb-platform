"""Tests for the multi-channel webhook dispatcher."""

from unittest.mock import AsyncMock, MagicMock, patch

from httpx import AsyncClient

from app.channels.base import ChannelType, IncomingMessage, OutgoingMessage

# ---------------------------------------------------------------------------
# Endpoint-level tests (HTTP layer)
# ---------------------------------------------------------------------------


class TestWebhookEndpoint:
    """Tests for POST /api/v1/webhook/{channel_name}."""

    @patch("app.api.endpoints.webhook.AIBrain")
    @patch("app.api.endpoints.webhook.get_adapter")
    async def test_valid_channel_returns_ok(
        self,
        mock_get_adapter: MagicMock,
        MockBrain: MagicMock,
        client: AsyncClient,
    ):
        """Webhook should return 200 with status ok for valid channel requests."""
        mock_adapter = AsyncMock()
        mock_adapter.parse_webhook.return_value = []
        mock_get_adapter.return_value = mock_adapter

        response = await client.post(
            "/api/v1/webhook/line",
            content=b'{"events":[]}',
            headers={"X-Line-Signature": "valid-sig"},
        )
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    async def test_unknown_channel_returns_error(self, client: AsyncClient):
        """Webhook should return error for unknown channel names."""
        response = await client.post(
            "/api/v1/webhook/unknown",
            content=b"{}",
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "error"
        assert "unknown" in data["detail"].lower()

    @patch("app.api.endpoints.webhook.AIBrain")
    @patch("app.api.endpoints.webhook.get_adapter")
    async def test_messages_processed_through_brain(
        self,
        mock_get_adapter: MagicMock,
        MockBrain: MagicMock,
        client: AsyncClient,
    ):
        """Each parsed message should be processed by AIBrain."""
        incoming1 = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Hello",
            message_type="text",
        )
        incoming2 = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U456",
            text="Hi",
            message_type="text",
        )

        mock_adapter = AsyncMock()
        mock_adapter.parse_webhook.return_value = [incoming1, incoming2]
        mock_get_adapter.return_value = mock_adapter

        mock_brain_instance = AsyncMock()
        mock_brain_instance.handle_message.return_value = None
        MockBrain.return_value = mock_brain_instance

        response = await client.post(
            "/api/v1/webhook/line",
            content=b'{"events":[]}',
            headers={"X-Line-Signature": "valid-sig"},
        )
        assert response.status_code == 200
        assert mock_brain_instance.handle_message.await_count == 2

    @patch("app.api.endpoints.webhook.AIBrain")
    @patch("app.api.endpoints.webhook.get_adapter")
    async def test_outgoing_message_sent_via_adapter(
        self,
        mock_get_adapter: MagicMock,
        MockBrain: MagicMock,
        client: AsyncClient,
    ):
        """When brain returns an OutgoingMessage, it should be sent via adapter."""
        incoming = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Hello",
            message_type="text",
            reply_token="token-1",
        )
        outgoing = OutgoingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Hi there!",
            reply_token="token-1",
        )

        mock_adapter = AsyncMock()
        mock_adapter.parse_webhook.return_value = [incoming]
        mock_get_adapter.return_value = mock_adapter

        mock_brain_instance = AsyncMock()
        mock_brain_instance.handle_message.return_value = outgoing
        MockBrain.return_value = mock_brain_instance

        response = await client.post(
            "/api/v1/webhook/line",
            content=b'{"events":[]}',
            headers={"X-Line-Signature": "valid-sig"},
        )
        assert response.status_code == 200
        mock_adapter.send_message.assert_awaited_once_with(outgoing)

    @patch("app.api.endpoints.webhook.AIBrain")
    @patch("app.api.endpoints.webhook.get_adapter")
    async def test_message_error_does_not_crash_webhook(
        self,
        mock_get_adapter: MagicMock,
        MockBrain: MagicMock,
        client: AsyncClient,
    ):
        """An exception in one message should not crash the entire webhook."""
        incoming1 = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Hello",
            message_type="text",
        )
        incoming2 = IncomingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U456",
            text="Hi",
            message_type="text",
        )

        mock_adapter = AsyncMock()
        mock_adapter.parse_webhook.return_value = [incoming1, incoming2]
        mock_get_adapter.return_value = mock_adapter

        mock_brain_instance = AsyncMock()
        mock_brain_instance.handle_message.side_effect = [Exception("boom"), None]
        MockBrain.return_value = mock_brain_instance

        response = await client.post(
            "/api/v1/webhook/line",
            content=b'{"events":[]}',
            headers={"X-Line-Signature": "valid-sig"},
        )
        assert response.status_code == 200
        assert mock_brain_instance.handle_message.await_count == 2

    @patch("app.api.endpoints.webhook.AIBrain")
    @patch("app.api.endpoints.webhook.get_adapter")
    async def test_empty_messages_list(
        self,
        mock_get_adapter: MagicMock,
        MockBrain: MagicMock,
        client: AsyncClient,
    ):
        """Webhook with no parsed messages should return ok."""
        mock_adapter = AsyncMock()
        mock_adapter.parse_webhook.return_value = []
        mock_get_adapter.return_value = mock_adapter

        response = await client.post(
            "/api/v1/webhook/line",
            content=b'{"events":[]}',
            headers={"X-Line-Signature": "valid-sig"},
        )
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
