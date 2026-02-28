"""Tests for the LINE channel adapter."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.webhooks import (
    FollowEvent,
    ImageMessageContent,
    MessageEvent,
    StickerMessageContent,
    TextMessageContent,
    UnfollowEvent,
)

from app.channels.base import ChannelType, OutgoingMessage
from app.channels.line.adapter import LINEChannelAdapter


@pytest.fixture()
def adapter():
    """Create a LINE adapter with mocked parser and config."""
    with patch("app.channels.line.adapter.settings") as mock_settings:
        mock_settings.line_channel_secret = "test-secret"
        mock_settings.line_channel_access_token = "test-token"
        a = LINEChannelAdapter()
    return a


# ---------------------------------------------------------------------------
# parse_webhook tests
# ---------------------------------------------------------------------------


class TestParseWebhook:
    """Tests for LINEChannelAdapter.parse_webhook()."""

    async def test_missing_signature_raises_400(self, adapter):
        """Missing X-Line-Signature header should raise HTTPException."""
        request = AsyncMock()
        request.body = AsyncMock(return_value=b'{"events":[]}')
        request.headers = {}

        with pytest.raises(HTTPException) as exc_info:
            await adapter.parse_webhook(request)
        assert exc_info.value.status_code == 400

    async def test_invalid_signature_raises_400(self, adapter):
        """Invalid signature should raise HTTPException."""
        request = AsyncMock()
        request.body = AsyncMock(return_value=b'{"events":[]}')
        request.headers = {"X-Line-Signature": "bad-sig"}

        with patch.object(adapter, "_parser") as mock_parser:
            mock_parser.parse.side_effect = InvalidSignatureError("bad")
            with pytest.raises(HTTPException) as exc_info:
                await adapter.parse_webhook(request)
            assert exc_info.value.status_code == 400

    async def test_text_message_event_parsed(self, adapter):
        """Text message event should be parsed into IncomingMessage."""
        event = MagicMock(spec=MessageEvent)
        event.source = MagicMock()
        event.source.user_id = "U123"
        event.reply_token = "reply-1"
        event.message = MagicMock(spec=TextMessageContent)
        event.message.text = "Hello"

        request = AsyncMock()
        request.body = AsyncMock(return_value=b'{"events":[]}')
        request.headers = {"X-Line-Signature": "valid"}

        with patch.object(adapter, "_parser") as mock_parser:
            mock_parser.parse.return_value = [event]
            messages = await adapter.parse_webhook(request)

        assert len(messages) == 1
        msg = messages[0]
        assert msg.channel == ChannelType.LINE
        assert msg.channel_user_id == "U123"
        assert msg.text == "Hello"
        assert msg.message_type == "text"
        assert msg.reply_token == "reply-1"

    async def test_image_message_event_parsed(self, adapter):
        """Image message event should have message_type='image'."""
        event = MagicMock(spec=MessageEvent)
        event.source = MagicMock()
        event.source.user_id = "U123"
        event.reply_token = "reply-1"
        event.message = MagicMock(spec=ImageMessageContent)

        request = AsyncMock()
        request.body = AsyncMock(return_value=b'{"events":[]}')
        request.headers = {"X-Line-Signature": "valid"}

        with patch.object(adapter, "_parser") as mock_parser:
            mock_parser.parse.return_value = [event]
            messages = await adapter.parse_webhook(request)

        assert len(messages) == 1
        assert messages[0].message_type == "image"

    async def test_sticker_message_event_parsed(self, adapter):
        """Sticker message event should have message_type='sticker'."""
        event = MagicMock(spec=MessageEvent)
        event.source = MagicMock()
        event.source.user_id = "U123"
        event.reply_token = "reply-1"
        event.message = MagicMock(spec=StickerMessageContent)

        request = AsyncMock()
        request.body = AsyncMock(return_value=b'{"events":[]}')
        request.headers = {"X-Line-Signature": "valid"}

        with patch.object(adapter, "_parser") as mock_parser:
            mock_parser.parse.return_value = [event]
            messages = await adapter.parse_webhook(request)

        assert len(messages) == 1
        assert messages[0].message_type == "sticker"

    async def test_follow_event_parsed(self, adapter):
        """Follow event should have message_type='follow'."""
        event = MagicMock(spec=FollowEvent)
        event.source = MagicMock()
        event.source.user_id = "U999"
        event.reply_token = "follow-token"

        request = AsyncMock()
        request.body = AsyncMock(return_value=b'{"events":[]}')
        request.headers = {"X-Line-Signature": "valid"}

        with patch.object(adapter, "_parser") as mock_parser:
            mock_parser.parse.return_value = [event]
            messages = await adapter.parse_webhook(request)

        assert len(messages) == 1
        msg = messages[0]
        assert msg.message_type == "follow"
        assert msg.channel_user_id == "U999"

    async def test_unfollow_event_parsed(self, adapter):
        """Unfollow event should have message_type='unfollow'."""
        event = MagicMock(spec=UnfollowEvent)
        event.source = MagicMock()
        event.source.user_id = "U123"

        request = AsyncMock()
        request.body = AsyncMock(return_value=b'{"events":[]}')
        request.headers = {"X-Line-Signature": "valid"}

        with patch.object(adapter, "_parser") as mock_parser:
            mock_parser.parse.return_value = [event]
            messages = await adapter.parse_webhook(request)

        assert len(messages) == 1
        assert messages[0].message_type == "unfollow"

    async def test_unknown_event_type_skipped(self, adapter):
        """Unknown event types should be silently skipped."""
        event = MagicMock()

        request = AsyncMock()
        request.body = AsyncMock(return_value=b'{"events":[]}')
        request.headers = {"X-Line-Signature": "valid"}

        with patch.object(adapter, "_parser") as mock_parser:
            mock_parser.parse.return_value = [event]
            messages = await adapter.parse_webhook(request)

        assert len(messages) == 0


# ---------------------------------------------------------------------------
# send_message tests
# ---------------------------------------------------------------------------


class TestSendMessage:
    """Tests for LINEChannelAdapter.send_message()."""

    @patch("app.channels.line.adapter.AsyncMessagingApi")
    @patch("app.channels.line.adapter.AsyncApiClient")
    async def test_reply_message_when_reply_token_present(
        self, MockApiClient, MockMessagingApi, adapter
    ):
        """Should use reply_message when reply_token is set."""
        mock_api_client = AsyncMock()
        MockApiClient.return_value = mock_api_client
        mock_api_client.__aenter__ = AsyncMock(return_value=mock_api_client)
        mock_api_client.__aexit__ = AsyncMock(return_value=False)

        mock_api = AsyncMock()
        MockMessagingApi.return_value = mock_api

        msg = OutgoingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Hello!",
            reply_token="token-123",
        )
        await adapter.send_message(msg)

        mock_api.reply_message.assert_awaited_once()
        call_args = mock_api.reply_message.call_args[0][0]
        assert call_args.reply_token == "token-123"
        assert call_args.messages[0].text == "Hello!"

    @patch("app.channels.line.adapter.AsyncMessagingApi")
    @patch("app.channels.line.adapter.AsyncApiClient")
    async def test_push_message_when_no_reply_token(
        self, MockApiClient, MockMessagingApi, adapter
    ):
        """Should use push_message when no reply_token."""
        mock_api_client = AsyncMock()
        MockApiClient.return_value = mock_api_client
        mock_api_client.__aenter__ = AsyncMock(return_value=mock_api_client)
        mock_api_client.__aexit__ = AsyncMock(return_value=False)

        mock_api = AsyncMock()
        MockMessagingApi.return_value = mock_api

        msg = OutgoingMessage(
            channel=ChannelType.LINE,
            channel_user_id="U123",
            text="Owner message",
        )
        await adapter.send_message(msg)

        mock_api.push_message.assert_awaited_once()
        call_args = mock_api.push_message.call_args[0][0]
        assert call_args.to == "U123"
        assert call_args.messages[0].text == "Owner message"
