"""Channel abstraction: base types and adapter interface."""

import enum
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from fastapi import Request


class ChannelType(str, enum.Enum):
    """Supported messaging channels."""

    LINE = "line"


@dataclass
class IncomingMessage:
    """Channel-agnostic representation of an incoming message."""

    channel: ChannelType
    channel_user_id: str
    display_name: str | None = None
    text: str | None = None
    message_type: str = "text"  # text, image, sticker, follow, unfollow, etc.
    raw_event: object | None = field(default=None, repr=False)
    reply_token: str | None = None  # For channels that use reply tokens (e.g. LINE)


@dataclass
class OutgoingMessage:
    """Channel-agnostic representation of an outgoing message."""

    channel: ChannelType
    channel_user_id: str
    text: str
    reply_token: str | None = None  # If set, use reply instead of push


class ChannelAdapter(ABC):
    """Abstract base class for channel adapters.

    Each channel (LINE, Facebook, etc.) implements this interface to:
    1. Validate and parse incoming webhooks into IncomingMessage objects
    2. Send outgoing messages through the channel's API
    """

    channel_type: ChannelType

    @abstractmethod
    async def parse_webhook(self, request: Request) -> list[IncomingMessage]:
        """Parse a raw webhook request into a list of IncomingMessage objects.

        Args:
            request: The raw FastAPI request from the webhook.

        Returns:
            List of parsed incoming messages.

        Raises:
            HTTPException: If the webhook signature is invalid.
        """
        ...

    @abstractmethod
    async def send_message(self, message: OutgoingMessage) -> None:
        """Send a message through this channel.

        Uses reply (if reply_token is available) or push.

        Args:
            message: The outgoing message to send.
        """
        ...
