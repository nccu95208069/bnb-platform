"""Multi-channel messaging abstraction layer."""

from app.channels.base import ChannelAdapter, ChannelType, IncomingMessage, OutgoingMessage
from app.channels.registry import get_adapter, init_adapters, register_adapter

__all__ = [
    "ChannelAdapter",
    "ChannelType",
    "IncomingMessage",
    "OutgoingMessage",
    "get_adapter",
    "init_adapters",
    "register_adapter",
]
