"""Tests for channel adapter registry."""

from unittest.mock import MagicMock, patch

import pytest

from app.channels.base import ChannelAdapter, ChannelType

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_adapter(channel_type: ChannelType) -> ChannelAdapter:
    """Create a mock ChannelAdapter with the given channel_type."""
    adapter = MagicMock(spec=ChannelAdapter)
    adapter.channel_type = channel_type
    return adapter


# ---------------------------------------------------------------------------
# register_adapter / get_adapter / get_available_channels
# ---------------------------------------------------------------------------


class TestRegisterAndGetAdapter:
    """Tests for register_adapter and get_adapter."""

    def setup_method(self):
        """Clear the global adapter registry before each test."""
        from app.channels import registry

        registry._adapters.clear()

    def test_register_and_get_adapter(self):
        """Should register an adapter and retrieve it by channel type."""
        from app.channels.registry import get_adapter, register_adapter

        adapter = _make_adapter(ChannelType.LINE)
        register_adapter(adapter)

        result = get_adapter(ChannelType.LINE)
        assert result is adapter

    def test_get_adapter_raises_for_unregistered(self):
        """Should raise ValueError when no adapter is registered for the type."""
        from app.channels.registry import get_adapter

        with pytest.raises(ValueError, match="No adapter registered"):
            get_adapter(ChannelType.LINE)

    def test_get_available_channels_empty(self):
        """Should return empty list when no adapters registered."""
        from app.channels.registry import get_available_channels

        assert get_available_channels() == []

    def test_get_available_channels_after_registration(self):
        """Should return registered channel types."""
        from app.channels.registry import get_available_channels, register_adapter

        adapter = _make_adapter(ChannelType.LINE)
        register_adapter(adapter)

        channels = get_available_channels()
        assert ChannelType.LINE in channels

    def test_register_overwrites_existing(self):
        """Registering a second adapter for the same type should overwrite."""
        from app.channels.registry import get_adapter, register_adapter

        adapter1 = _make_adapter(ChannelType.LINE)
        adapter2 = _make_adapter(ChannelType.LINE)
        register_adapter(adapter1)
        register_adapter(adapter2)

        result = get_adapter(ChannelType.LINE)
        assert result is adapter2


# ---------------------------------------------------------------------------
# init_adapters
# ---------------------------------------------------------------------------


class TestInitAdapters:
    """Tests for init_adapters startup registration."""

    def setup_method(self):
        """Clear the global adapter registry before each test."""
        from app.channels import registry

        registry._adapters.clear()

    @patch("app.core.config.settings")
    def test_registers_line_when_configured(self, mock_settings):
        """Should register LINE adapter when secrets are provided."""
        mock_settings.line_channel_secret = "secret"
        mock_settings.line_channel_access_token = "token"

        mock_adapter = _make_adapter(ChannelType.LINE)

        from app.channels.registry import get_available_channels, init_adapters

        with patch("app.channels.line.adapter.LINEChannelAdapter", return_value=mock_adapter):
            init_adapters()

        assert ChannelType.LINE in get_available_channels()

    @patch("app.core.config.settings")
    def test_skips_line_when_not_configured(self, mock_settings):
        """Should not register LINE adapter when secrets are empty."""
        mock_settings.line_channel_secret = ""
        mock_settings.line_channel_access_token = ""

        from app.channels.registry import get_available_channels, init_adapters

        init_adapters()

        assert get_available_channels() == []

    @patch("app.core.config.settings")
    def test_skips_line_when_secret_missing(self, mock_settings):
        """Should not register LINE adapter when only token is set."""
        mock_settings.line_channel_secret = ""
        mock_settings.line_channel_access_token = "token"

        from app.channels.registry import get_available_channels, init_adapters

        init_adapters()

        assert get_available_channels() == []
