"""Tests for Google Calendar and Sheets integration service."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helper: build chained Google API mock (service.resource().method().execute())
# ---------------------------------------------------------------------------


def _make_calendar_service_mock(events_items: list[dict] | None = None):
    """Build a mock Google Calendar service with chained method calls."""
    mock = MagicMock()
    execute_result = {"items": events_items or []}
    mock.events.return_value.list.return_value.execute.return_value = execute_result
    return mock


def _make_sheets_service_mock(values: list[list[str]] | None = None):
    """Build a mock Google Sheets service with chained method calls."""
    mock = MagicMock()
    execute_result = {"values": values or []}
    mock.spreadsheets.return_value.values.return_value.get.return_value.execute.return_value = (
        execute_result
    )
    return mock


# ---------------------------------------------------------------------------
# GoogleCalendarService tests
# ---------------------------------------------------------------------------


class TestGoogleCalendarCheckAvailability:
    """Tests for GoogleCalendarService.check_availability."""

    @patch("app.services.google_integration._get_calendar_service")
    @patch("app.services.google_integration.settings")
    async def test_returns_available_when_no_events(self, mock_settings, mock_get_svc):
        """Should return is_available=True when no events exist in the range."""
        mock_settings.google_calendar_id = "cal-123"
        mock_get_svc.return_value = _make_calendar_service_mock(events_items=[])

        from app.services.google_integration import GoogleCalendarService

        svc = GoogleCalendarService()
        result = await svc.check_availability("2025-07-01", "2025-07-03")

        assert result["is_available"] is True
        assert result["bookings"] == []
        assert result["date_from"] == "2025-07-01"
        assert result["date_to"] == "2025-07-03"

    @patch("app.services.google_integration._get_calendar_service")
    @patch("app.services.google_integration.settings")
    async def test_returns_bookings_when_events_exist(self, mock_settings, mock_get_svc):
        """Should return bookings and is_available=False when events exist."""
        mock_settings.google_calendar_id = "cal-123"
        events = [
            {
                "summary": "Room A - Guest",
                "start": {"dateTime": "2025-07-01T14:00:00+08:00"},
                "end": {"dateTime": "2025-07-02T11:00:00+08:00"},
                "description": "Booking for guest X",
            }
        ]
        mock_get_svc.return_value = _make_calendar_service_mock(events_items=events)

        from app.services.google_integration import GoogleCalendarService

        svc = GoogleCalendarService()
        result = await svc.check_availability("2025-07-01", "2025-07-03")

        assert result["is_available"] is False
        assert len(result["bookings"]) == 1
        assert result["bookings"][0]["summary"] == "Room A - Guest"

    @patch("app.services.google_integration._get_calendar_service")
    @patch("app.services.google_integration.settings")
    async def test_filters_by_room_type(self, mock_settings, mock_get_svc):
        """Should filter bookings by room_type when provided."""
        mock_settings.google_calendar_id = "cal-123"
        events = [
            {
                "summary": "Room A - Guest 1",
                "start": {"date": "2025-07-01"},
                "end": {"date": "2025-07-02"},
            },
            {
                "summary": "Room B - Guest 2",
                "start": {"date": "2025-07-01"},
                "end": {"date": "2025-07-03"},
            },
        ]
        mock_get_svc.return_value = _make_calendar_service_mock(events_items=events)

        from app.services.google_integration import GoogleCalendarService

        svc = GoogleCalendarService()
        result = await svc.check_availability("2025-07-01", "2025-07-03", room_type="Room A")

        assert len(result["bookings"]) == 1
        assert result["bookings"][0]["summary"] == "Room A - Guest 1"
        assert result["room_type"] == "Room A"

    @patch("app.services.google_integration._get_calendar_service")
    @patch("app.services.google_integration.settings")
    async def test_room_type_filter_case_insensitive(self, mock_settings, mock_get_svc):
        """room_type filter should be case-insensitive."""
        mock_settings.google_calendar_id = "cal-123"
        events = [
            {
                "summary": "DELUXE SUITE - Guest",
                "start": {"dateTime": "2025-07-01T14:00:00+08:00"},
                "end": {"dateTime": "2025-07-02T11:00:00+08:00"},
            },
        ]
        mock_get_svc.return_value = _make_calendar_service_mock(events_items=events)

        from app.services.google_integration import GoogleCalendarService

        svc = GoogleCalendarService()
        result = await svc.check_availability(
            "2025-07-01", "2025-07-03", room_type="deluxe suite"
        )

        assert len(result["bookings"]) == 1

    @patch("app.services.google_integration._get_calendar_service")
    @patch("app.services.google_integration.settings")
    async def test_event_uses_date_fallback(self, mock_settings, mock_get_svc):
        """Should handle events with 'date' key instead of 'dateTime'."""
        mock_settings.google_calendar_id = "cal-123"
        events = [
            {
                "summary": "All day booking",
                "start": {"date": "2025-07-01"},
                "end": {"date": "2025-07-02"},
            },
        ]
        mock_get_svc.return_value = _make_calendar_service_mock(events_items=events)

        from app.services.google_integration import GoogleCalendarService

        svc = GoogleCalendarService()
        result = await svc.check_availability("2025-07-01", "2025-07-03")

        assert result["bookings"][0]["start"] == "2025-07-01"
        assert result["bookings"][0]["end"] == "2025-07-02"


class TestGoogleCalendarUpcomingBookings:
    """Tests for GoogleCalendarService.get_upcoming_bookings."""

    @patch("app.services.google_integration._get_calendar_service")
    @patch("app.services.google_integration.settings")
    async def test_returns_upcoming_bookings(self, mock_settings, mock_get_svc):
        """Should delegate to check_availability and return bookings list."""
        mock_settings.google_calendar_id = "cal-123"
        events = [
            {
                "summary": "Upcoming stay",
                "start": {"dateTime": "2025-07-10T14:00:00+08:00"},
                "end": {"dateTime": "2025-07-12T11:00:00+08:00"},
                "description": "2 nights",
            }
        ]
        mock_get_svc.return_value = _make_calendar_service_mock(events_items=events)

        from app.services.google_integration import GoogleCalendarService

        svc = GoogleCalendarService()
        bookings = await svc.get_upcoming_bookings(days=30)

        assert len(bookings) == 1
        assert bookings[0]["summary"] == "Upcoming stay"

    @patch("app.services.google_integration._get_calendar_service")
    @patch("app.services.google_integration.settings")
    async def test_returns_empty_list_when_no_bookings(self, mock_settings, mock_get_svc):
        """Should return empty list when no upcoming bookings."""
        mock_settings.google_calendar_id = "cal-123"
        mock_get_svc.return_value = _make_calendar_service_mock(events_items=[])

        from app.services.google_integration import GoogleCalendarService

        svc = GoogleCalendarService()
        bookings = await svc.get_upcoming_bookings(days=7)

        assert bookings == []


# ---------------------------------------------------------------------------
# GoogleSheetsService tests
# ---------------------------------------------------------------------------


class TestGoogleSheetsRoomInfo:
    """Tests for GoogleSheetsService.get_room_info."""

    @patch("app.services.google_integration._get_sheets_service")
    @patch("app.services.google_integration.settings")
    async def test_returns_all_rooms(self, mock_settings, mock_get_svc):
        """Should return all rooms when no filter is applied."""
        mock_settings.google_sheet_id = "sheet-123"
        values = [
            ["room_type", "name", "description", "capacity", "amenities"],
            ["deluxe", "Deluxe Room", "A luxurious room", "4", "WiFi, AC"],
            ["standard", "Standard Room", "A cozy room", "2", "WiFi"],
        ]
        mock_get_svc.return_value = _make_sheets_service_mock(values=values)

        from app.services.google_integration import GoogleSheetsService

        svc = GoogleSheetsService()
        rooms = await svc.get_room_info()

        assert len(rooms) == 2
        assert rooms[0]["room_type"] == "deluxe"
        assert rooms[1]["room_type"] == "standard"

    @patch("app.services.google_integration._get_sheets_service")
    @patch("app.services.google_integration.settings")
    async def test_filters_by_room_type(self, mock_settings, mock_get_svc):
        """Should filter rooms by room_type."""
        mock_settings.google_sheet_id = "sheet-123"
        values = [
            ["room_type", "name", "description", "capacity", "amenities"],
            ["deluxe", "Deluxe Room", "Luxurious", "4", "WiFi, AC"],
            ["standard", "Standard Room", "Cozy", "2", "WiFi"],
        ]
        mock_get_svc.return_value = _make_sheets_service_mock(values=values)

        from app.services.google_integration import GoogleSheetsService

        svc = GoogleSheetsService()
        rooms = await svc.get_room_info(room_type="deluxe")

        assert len(rooms) == 1
        assert rooms[0]["name"] == "Deluxe Room"

    @patch("app.services.google_integration._get_sheets_service")
    @patch("app.services.google_integration.settings")
    async def test_room_type_filter_case_insensitive(self, mock_settings, mock_get_svc):
        """room_type filter should be case-insensitive."""
        mock_settings.google_sheet_id = "sheet-123"
        values = [
            ["room_type", "name"],
            ["Deluxe", "Deluxe Room"],
        ]
        mock_get_svc.return_value = _make_sheets_service_mock(values=values)

        from app.services.google_integration import GoogleSheetsService

        svc = GoogleSheetsService()
        rooms = await svc.get_room_info(room_type="DELUXE")

        assert len(rooms) == 1

    @patch("app.services.google_integration._get_sheets_service")
    @patch("app.services.google_integration.settings")
    async def test_returns_empty_when_no_data(self, mock_settings, mock_get_svc):
        """Should return empty list when spreadsheet has no data."""
        mock_settings.google_sheet_id = "sheet-123"
        mock_get_svc.return_value = _make_sheets_service_mock(values=[])

        from app.services.google_integration import GoogleSheetsService

        svc = GoogleSheetsService()
        rooms = await svc.get_room_info()

        assert rooms == []


class TestGoogleSheetsPricing:
    """Tests for GoogleSheetsService.get_pricing."""

    @patch("app.services.google_integration._get_sheets_service")
    @patch("app.services.google_integration.settings")
    async def test_returns_pricing_data(self, mock_settings, mock_get_svc):
        """Should return parsed pricing rows."""
        mock_settings.google_sheet_id = "sheet-123"
        values = [
            ["room_type", "weekday_price", "weekend_price", "holiday_price", "notes"],
            ["deluxe", "3000", "4000", "5000", "Peak season"],
            ["standard", "2000", "2500", "3500", ""],
        ]
        mock_get_svc.return_value = _make_sheets_service_mock(values=values)

        from app.services.google_integration import GoogleSheetsService

        svc = GoogleSheetsService()
        pricing = await svc.get_pricing()

        assert len(pricing) == 2
        assert pricing[0]["room_type"] == "deluxe"
        assert pricing[0]["weekday_price"] == "3000"
        assert pricing[1]["room_type"] == "standard"

    @patch("app.services.google_integration._get_sheets_service")
    @patch("app.services.google_integration.settings")
    async def test_returns_empty_when_no_pricing(self, mock_settings, mock_get_svc):
        """Should return empty list when no pricing data exists."""
        mock_settings.google_sheet_id = "sheet-123"
        mock_get_svc.return_value = _make_sheets_service_mock(values=[])

        from app.services.google_integration import GoogleSheetsService

        svc = GoogleSheetsService()
        pricing = await svc.get_pricing()

        assert pricing == []


# ---------------------------------------------------------------------------
# execute_tool tests
# ---------------------------------------------------------------------------


class TestExecuteTool:
    """Tests for the execute_tool dispatcher."""

    @patch("app.services.google_integration.GoogleCalendarService")
    async def test_execute_check_availability(self, MockCalSvc):
        """Should dispatch to GoogleCalendarService.check_availability."""
        mock_svc = AsyncMock()
        mock_svc.check_availability.return_value = {"is_available": True, "bookings": []}
        MockCalSvc.return_value = mock_svc

        from app.services.google_integration import execute_tool

        result = await execute_tool(
            "check_availability", {"date_from": "2025-07-01", "date_to": "2025-07-03"}
        )

        parsed = json.loads(result)
        assert parsed["is_available"] is True
        mock_svc.check_availability.assert_awaited_once_with(
            date_from="2025-07-01", date_to="2025-07-03"
        )

    @patch("app.services.google_integration.GoogleSheetsService")
    async def test_execute_get_room_info(self, MockSheetsSvc):
        """Should dispatch to GoogleSheetsService.get_room_info."""
        mock_svc = AsyncMock()
        mock_svc.get_room_info.return_value = [{"room_type": "deluxe"}]
        MockSheetsSvc.return_value = mock_svc

        from app.services.google_integration import execute_tool

        result = await execute_tool("get_room_info", {"room_type": "deluxe"})

        parsed = json.loads(result)
        assert len(parsed) == 1
        assert parsed[0]["room_type"] == "deluxe"

    @patch("app.services.google_integration.GoogleSheetsService")
    async def test_execute_get_pricing(self, MockSheetsSvc):
        """Should dispatch to GoogleSheetsService.get_pricing."""
        mock_svc = AsyncMock()
        mock_svc.get_pricing.return_value = [{"room_type": "standard", "weekday_price": "2000"}]
        MockSheetsSvc.return_value = mock_svc

        from app.services.google_integration import execute_tool

        result = await execute_tool("get_pricing", {})

        parsed = json.loads(result)
        assert len(parsed) == 1

    async def test_execute_unknown_tool_returns_error(self):
        """Should return JSON error for unknown tool names."""
        from app.services.google_integration import execute_tool

        result = await execute_tool("nonexistent_tool", {})

        parsed = json.loads(result)
        assert "error" in parsed
        assert "Unknown tool" in parsed["error"]

    @patch("app.services.google_integration.GoogleCalendarService")
    async def test_execute_tool_filters_disallowed_params(self, MockCalSvc):
        """Should strip parameters not in the allowed set."""
        mock_svc = AsyncMock()
        mock_svc.check_availability.return_value = {"is_available": True, "bookings": []}
        MockCalSvc.return_value = mock_svc

        from app.services.google_integration import execute_tool

        await execute_tool(
            "check_availability",
            {"date_from": "2025-07-01", "date_to": "2025-07-03", "evil_param": "drop me"},
        )

        # Only allowed params should have been passed
        mock_svc.check_availability.assert_awaited_once_with(
            date_from="2025-07-01", date_to="2025-07-03"
        )


# ---------------------------------------------------------------------------
# Credential / service builder tests
# ---------------------------------------------------------------------------


class TestCredentialsAndServiceBuilders:
    """Tests for _get_credentials, _get_calendar_service, _get_sheets_service."""

    @patch("app.services.google_integration.settings")
    @patch("app.services.google_integration.service_account.Credentials.from_service_account_file")
    def test_get_credentials(self, mock_from_file, mock_settings):
        """Should call from_service_account_file with the configured path."""
        mock_settings.google_service_account_json = "/path/to/creds.json"
        mock_from_file.return_value = MagicMock()

        from app.services.google_integration import _get_credentials

        creds = _get_credentials()

        mock_from_file.assert_called_once_with(
            "/path/to/creds.json",
            scopes=[
                "https://www.googleapis.com/auth/calendar.readonly",
                "https://www.googleapis.com/auth/spreadsheets.readonly",
            ],
        )
        assert creds is not None

    @patch("app.services.google_integration.build")
    @patch("app.services.google_integration._get_credentials")
    def test_get_calendar_service_builds_correctly(self, mock_creds, mock_build):
        """Should build a calendar v3 service."""
        mock_creds.return_value = MagicMock()
        mock_build.return_value = MagicMock()

        from app.services.google_integration import _get_calendar_service

        # Clear the lru_cache to get fresh behavior
        _get_calendar_service.cache_clear()

        svc = _get_calendar_service()

        mock_build.assert_called_once_with("calendar", "v3", credentials=mock_creds.return_value)
        assert svc is not None

        _get_calendar_service.cache_clear()

    @patch("app.services.google_integration.build")
    @patch("app.services.google_integration._get_credentials")
    def test_get_sheets_service_builds_correctly(self, mock_creds, mock_build):
        """Should build a sheets v4 service."""
        mock_creds.return_value = MagicMock()
        mock_build.return_value = MagicMock()

        from app.services.google_integration import _get_sheets_service

        _get_sheets_service.cache_clear()

        svc = _get_sheets_service()

        mock_build.assert_called_once_with("sheets", "v4", credentials=mock_creds.return_value)
        assert svc is not None

        _get_sheets_service.cache_clear()
