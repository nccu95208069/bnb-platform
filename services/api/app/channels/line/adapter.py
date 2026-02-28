"""LINE Messaging API channel adapter."""

import logging

from fastapi import HTTPException, Request
from linebot.v3 import WebhookParser
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    AsyncApiClient,
    AsyncMessagingApi,
    Configuration,
    PushMessageRequest,
    ReplyMessageRequest,
    TextMessage,
)
from linebot.v3.webhooks import (
    FollowEvent,
    ImageMessageContent,
    MessageEvent,
    StickerMessageContent,
    TextMessageContent,
    UnfollowEvent,
)

from app.channels.base import ChannelAdapter, ChannelType, IncomingMessage, OutgoingMessage
from app.core.config import settings

logger = logging.getLogger(__name__)


class LINEChannelAdapter(ChannelAdapter):
    """Adapter for LINE Messaging API."""

    channel_type = ChannelType.LINE

    def __init__(self) -> None:
        self._parser = WebhookParser(settings.line_channel_secret)
        self._config = Configuration(access_token=settings.line_channel_access_token)

    async def parse_webhook(self, request: Request) -> list[IncomingMessage]:
        """Parse LINE webhook events into IncomingMessage objects."""
        body = await request.body()
        body_text = body.decode("utf-8")

        signature = request.headers.get("X-Line-Signature", "")
        if not signature:
            raise HTTPException(status_code=400, detail="Missing X-Line-Signature header")

        try:
            events = self._parser.parse(body_text, signature)
        except InvalidSignatureError:
            logger.warning("Invalid LINE signature received")
            raise HTTPException(status_code=400, detail="Invalid signature")

        messages: list[IncomingMessage] = []
        for event in events:
            parsed = self._parse_event(event)
            if parsed is not None:
                messages.append(parsed)

        return messages

    def _parse_event(self, event: object) -> IncomingMessage | None:
        """Convert a LINE SDK event into an IncomingMessage."""
        if isinstance(event, MessageEvent):
            return self._parse_message_event(event)
        elif isinstance(event, FollowEvent):
            return IncomingMessage(
                channel=ChannelType.LINE,
                channel_user_id=event.source.user_id,
                message_type="follow",
                reply_token=event.reply_token,
                raw_event=event,
            )
        elif isinstance(event, UnfollowEvent):
            return IncomingMessage(
                channel=ChannelType.LINE,
                channel_user_id=event.source.user_id,
                message_type="unfollow",
                raw_event=event,
            )
        else:
            logger.info("Unhandled LINE event type: %s", type(event).__name__)
            return None

    def _parse_message_event(self, event: MessageEvent) -> IncomingMessage:
        """Convert a LINE MessageEvent into an IncomingMessage."""
        user_id = event.source.user_id

        if isinstance(event.message, TextMessageContent):
            return IncomingMessage(
                channel=ChannelType.LINE,
                channel_user_id=user_id,
                text=event.message.text,
                message_type="text",
                reply_token=event.reply_token,
                raw_event=event,
            )
        elif isinstance(event.message, ImageMessageContent):
            return IncomingMessage(
                channel=ChannelType.LINE,
                channel_user_id=user_id,
                message_type="image",
                reply_token=event.reply_token,
                raw_event=event,
            )
        elif isinstance(event.message, StickerMessageContent):
            return IncomingMessage(
                channel=ChannelType.LINE,
                channel_user_id=user_id,
                message_type="sticker",
                reply_token=event.reply_token,
                raw_event=event,
            )
        else:
            return IncomingMessage(
                channel=ChannelType.LINE,
                channel_user_id=user_id,
                message_type="unsupported",
                reply_token=event.reply_token,
                raw_event=event,
            )

    async def send_message(self, message: OutgoingMessage) -> None:
        """Send a message via LINE Messaging API."""
        async with AsyncApiClient(self._config) as api_client:
            line_api = AsyncMessagingApi(api_client)

            if message.reply_token:
                await line_api.reply_message(
                    ReplyMessageRequest(
                        reply_token=message.reply_token,
                        messages=[TextMessage(text=message.text)],
                    )
                )
            else:
                await line_api.push_message(
                    PushMessageRequest(
                        to=message.channel_user_id,
                        messages=[TextMessage(text=message.text)],
                    )
                )
