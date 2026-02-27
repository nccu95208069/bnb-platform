"""Channel adapter registry: register, lookup, and initialize adapters."""

import logging

from app.channels.base import ChannelAdapter, ChannelType

logger = logging.getLogger(__name__)

_adapters: dict[ChannelType, ChannelAdapter] = {}


def register_adapter(adapter: ChannelAdapter) -> None:
    """Register a channel adapter."""
    _adapters[adapter.channel_type] = adapter
    logger.info("Registered channel adapter: %s", adapter.channel_type.value)


def get_adapter(channel_type: ChannelType) -> ChannelAdapter:
    """Get a registered adapter by channel type.

    Raises:
        ValueError: If no adapter is registered for the given channel type.
    """
    adapter = _adapters.get(channel_type)
    if adapter is None:
        raise ValueError(f"No adapter registered for channel: {channel_type.value}")
    return adapter


def get_available_channels() -> list[ChannelType]:
    """Return list of channel types that have registered adapters."""
    return list(_adapters.keys())


def init_adapters() -> None:
    """Initialize and register all configured channel adapters.

    Called during application startup. Only registers adapters
    for channels that have the required configuration set.
    """
    from app.core.config import settings

    if settings.line_channel_secret and settings.line_channel_access_token:
        from app.channels.line.adapter import LINEChannelAdapter

        register_adapter(LINEChannelAdapter())
    else:
        logger.info("LINE channel not configured, skipping registration")

    if not _adapters:
        logger.warning("No channel adapters registered. Configure at least one channel.")
